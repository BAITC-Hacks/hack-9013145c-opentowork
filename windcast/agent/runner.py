"""Прогон агента: один день с пересчётами по выпускам погоды и весь тестовый период.

Прогноз суток D выпускается в 00 UTC (05:00 местного) на 48 ч. В 06, 12 и 18 UTC
публикуются новые выпуски погодных моделей — агент проверяет, стали ли для целевых
часов доступны более свежие данные, пересчитывает и выпускает ревизию, если прогноз
изменился существенно.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pandas as pd

from windcast.agent import graph
from windcast.agent.tools import fresher_data_available
from windcast.config import (
    FORECASTS_DIR,
    MODELS_DIR,
    REPORTS_DIR,
    TEST_FIRST_ORIGIN,
    TEST_LAST_ORIGIN,
)
from windcast.models.ensemble import calibrate
from windcast.pipeline import MODEL_VERSION, Forecaster, station_view

WEATHER_PROVIDER = "Open-Meteo Previous Runs: ECMWF IFS, ECMWF AIFS, ICON, GFS, UKMO, GEM, CMA"


def train_final(until: str = TEST_FIRST_ORIGIN) -> dict:
    """Финальная модель: обучение строго до первого момента прогноза тестового периода.
    Веса ансамбля и калибровка — по прогнозам бэктеста, тоже только до этого момента."""
    until_ts = pd.Timestamp(until)
    fc = Forecaster(until=until_ts).fit()
    bt_path = REPORTS_DIR / "backtest_predictions.parquet"
    if bt_path.exists():
        bt = pd.read_parquet(bt_path)
        bt = bt[bt.index < until_ts]
        fc.state = calibrate(bt)
    path = fc.save()
    # Кривая мощности станции для what-if в API — без ML-стека в образе API.
    (MODELS_DIR / "power_curve.json").write_text(
        json.dumps({"ws": [float(v) for v in fc.raw_curve.ws],
                    "power": [float(v) for v in fc.raw_curve.pw]}),
        encoding="utf-8",
    )
    return {
        "model": path,
        "until": str(until_ts),
        "train_rows": fc.n_train,
        "fit_seconds": round(fc.fit_seconds, 1),
        "weights": fc.state.weights,
        "widen80": fc.state.widen80,
        "calibrated_on": fc.state.calibrated_on,
    }


def _load_or_train() -> Forecaster:
    if (MODELS_DIR / "forecaster.pkl").exists():
        return Forecaster.load()
    train_final()
    return Forecaster.load()


def _points(pred: pd.DataFrame) -> list[dict]:
    st = station_view(pred)
    pts = []
    for t, row in st.iterrows():
        pts.append(
            {
                "forecast_for": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "horizon_h": int(row["horizon_h"]),
                "p10": round(float(row["q10"]), 4),
                "p50": round(float(row["q50"]), 4),
                "p90": round(float(row["q90"]), 4),
                "p05": round(float(row["q05"]), 4),
                "p95": round(float(row["q95"]), 4),
                "mean": round(float(row["mean"]), 4),
                "baseline": round(float(row["raw_nwp_curve"]), 4),
                "persistence": None
                if pd.isna(row["persistence"])
                else round(float(row["persistence"]), 4),
                "actual": None
                if pd.isna(row.get("actual", float("nan")))
                else round(float(row["actual"]), 4),
                "wind_speed": round(float(row["wind_corrected"]), 2),
                "wind_speed_nwp": round(float(row["wind_nwp"]), 2),
                "wind_spread": round(float(row["wind_nwp_spread"]), 2),
                "wind_dir": round(float(row["wind_dir"]), 0),
                "temperature": round(float(row["temperature"]), 1),
                "icing_risk": bool(row["icing_risk"] > 0),
                "nwp_day": int(row["nwp_day"]),
                "per_turbine": row["per_turbine"],
            }
        )
    return pts


def forecast_run_json(run: graph.AgentRun, horizon: int) -> dict:
    """Формат ForecastRun из frontend/src/api.ts (+ служебные поля агента)."""
    return {
        "forecast_id": run.run_id,
        "forecast_origin": run.origin.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "horizon": horizon,
        "model_version": MODEL_VERSION,
        "weather_provider": WEATHER_PROVIDER,
        "weather_run": run.facts["weather_runs"]["latest_run_init"],
        "created_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "predictions": _points(run.prediction),
        "agent_steps": run.steps,
        "explanation": run.report,
        "report_source": run.report_source,
        "published": run.published,
        "degraded": run.degraded,
        "facts": json.loads(json.dumps(run.facts, default=str)),
    }


def run_agent_day(
    day: pd.Timestamp, runs=(0, 6, 12, 18), fc: Forecaster | None = None, verbose: bool = False
) -> dict:
    fc = fc or _load_or_train()
    day = pd.Timestamp(day).normalize()
    end = day + pd.Timedelta(hours=48)
    versions, published_pred, prev_origin = [], None, None
    for h in runs:
        origin = day + pd.Timedelta(hours=h)
        horizon = int((end - origin) / pd.Timedelta(hours=1))
        if prev_origin is not None:
            targets = pd.date_range(origin + pd.Timedelta(hours=1), end, freq="1h")
            fresh = fresher_data_available(prev_origin, origin, targets)
            if fresh == 0:
                versions.append(
                    {
                        "origin": str(origin),
                        "skipped": "новых выпусков погоды для целевых часов нет",
                    }
                )
                continue
            reason = f"вышел новый выпуск погоды: свежее данные для {fresh} ч"
        else:
            reason = "плановый выпуск на следующие 48 ч"
        run = graph.run(fc, origin, horizon, previous=published_pred, reason=reason)
        doc = forecast_run_json(run, horizon)
        versions.append(doc)
        if run.published:
            published_pred = run.prediction
        prev_origin = origin
        if verbose:
            print(
                f"\n=== {origin} UTC | {'ОПУБЛИКОВАН' if run.published else 'не опубликован'} ==="
            )
            for s in run.steps:
                print(f"  [{s['status']:>4}] {s['agent']}: {s['action']}")
            print("  Отчёт:", run.report)
    return {"day": str(day.date()), "versions": versions}


def _submission_rows(day_doc: dict) -> list[dict]:
    rows = []
    for v in day_doc["versions"]:
        if "skipped" in v:
            continue
        for p in v["predictions"]:
            rows.append(
                {
                    "issue_time_utc": v["forecast_origin"],
                    "target_time_utc": p["forecast_for"],
                    "target_time_local": (
                        pd.Timestamp(p["forecast_for"]) + pd.Timedelta(hours=5)
                    ).strftime("%Y-%m-%d %H:%M"),
                    "horizon_h": p["horizon_h"],
                    "published": v["published"],
                    "p10": p["p10"],
                    "p50": p["p50"],
                    "p90": p["p90"],
                    "mean": p["mean"],
                    "p50_T1": p["per_turbine"].get("T1"),
                    "p50_T2": p["per_turbine"].get("T2"),
                    "wind_speed_corrected": p["wind_speed"],
                    "wind_speed_nwp": p["wind_speed_nwp"],
                }
            )
    return rows


def run_test_period(
    first: str = TEST_FIRST_ORIGIN, last: str = TEST_LAST_ORIGIN, verbose: bool = False
) -> dict:
    fc = _load_or_train()
    FORECASTS_DIR.mkdir(parents=True, exist_ok=True)
    index, rows = [], []
    for day in pd.date_range(first, last, freq="D"):
        doc = run_agent_day(day, fc=fc)
        (FORECASTS_DIR / f"{day.date()}.json").write_text(
            json.dumps(doc, ensure_ascii=False), encoding="utf-8"
        )
        rows += _submission_rows(doc)
        pub = [v for v in doc["versions"] if v.get("published")]
        index.append(
            {
                "day": str(day.date()),
                "versions": len([v for v in doc["versions"] if "skipped" not in v]),
                "revisions_published": max(0, len(pub) - 1),
                "mean_p50": pub[-1]["facts"]["analysis"]["mean_p50"] if pub else None,
                "ramps": pub[-1]["facts"]["analysis"]["n_ramps"] if pub else None,
            }
        )
        if verbose:
            print(
                f"{day.date()}: версий {index[-1]['versions']}, "
                f"ревизий {index[-1]['revisions_published']}, средняя P50 {index[-1]['mean_p50']}"
            )
    sub = pd.DataFrame(rows)
    sub.to_csv(FORECASTS_DIR / "test_period_all_versions.csv", index=False)
    official = sub[sub["issue_time_utc"].str.endswith("T00:00:00Z")]
    official.to_csv(FORECASTS_DIR / "test_period_forecast.csv", index=False)
    (FORECASTS_DIR / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return {"days": len(index), "rows": len(sub), "official_rows": len(official)}
