"""Пошаговый бэктест по протоколу кейса.

Каждый месяц модели переобучаются на данных строго до начала месяца, затем каждый день
в 00 UTC (05:00 местного) выпускается прогноз на 48 ч — ровно как будет в феврале 2026.
Веса ансамбля и калибровка интервалов на месяц M берутся только из прогнозов месяцев < M.
"""

from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd

from windcast.config import REPORTS_DIR
from windcast.features import training_frame
from windcast.metrics import QCOLS, summarize, summarize_probabilistic
from windcast.models.ensemble import calibrate
from windcast.pipeline import Forecaster, attach_actuals, station_view

MODELS = {
    "ensemble": "q50",
    "cascade": "cas_q50",
    "direct": "dir_q50",
    "raw_nwp_curve": "raw_nwp_curve",
    "persistence": "persistence",
    "climatology": "climatology",
}
LABELS = {
    "ensemble": "Итоговая: каскад + калибровка",
    "cascade": "Каскад: поправка ветра → кривая",
    "direct": "Прямая LightGBM",
    "raw_nwp_curve": "Сырой прогноз ветра + кривая",
    "persistence": "Как вчера",
    "climatology": "Климатология",
}


def run(first_month: str = "2025-02", last_month: str = "2026-01", log=print) -> pd.DataFrame:
    tf = training_frame()
    months = pd.period_range(first_month, last_month, freq="M")
    history = pd.DataFrame()
    all_preds = []
    for month in months:
        start = month.start_time
        end = (month + 1).start_time
        t0 = time.time()
        fc = Forecaster(until=start).fit(tf)
        # Последние 48-часовые выпуски прошлого месяца заходят в новый:
        # их факты ещё неизвестны в момент переобучения.
        fc.state = calibrate(history, before=start) if len(history) else fc.state
        origins = pd.date_range(start, end - pd.Timedelta(days=1), freq="D")
        preds = []
        for origin in origins:
            p = fc.predict(origin)
            p["origin"] = origin
            preds.append(p)
        month_pred = attach_actuals(pd.concat(preds))
        month_pred["month"] = str(month)
        all_preds.append(month_pred)
        history = pd.concat([history, month_pred])
        mae = np.nanmean(np.abs(month_pred["actual"] - month_pred["q50"]))
        log(
            f"{month}: обучение {fc.fit_seconds:.0f} с, выпусков {len(origins)}, "
            f"MAE итога {mae:.4f}, всего {time.time() - t0:.0f} с"
        )
    return pd.concat(all_preds)


def operational_day(pred: pd.DataFrame) -> dict:
    """Метрики для суток заявки — те цифры, что идут в README.

    Уровень станции: среднее двух турбин, только часы, где факт есть у обеих.
    • Почасовые (горизонты 19–43 выпуска 00 UTC — это сутки D по Астане плюс час запаса):
        mae = mean(|факт − прогноз|),  accuracy = 1 − mae  (доля номинала).
    • Суточная выработка: для каждого выпуска сумма по горизонтам 19–42 — ровно 24 часа
      операционных суток D (00:00–24:00 по Астане); только полные сутки (все 24 часа с фактом).
        energy_accuracy = 1 − mean(|E_факт − E_прогноз|) / 24,
        energy_bias_pct = (ΣE_прогноз − ΣE_факт) / ΣE_факт · 100.
      E — в «часах номинала», поэтому деление на 24 даёт долю номинала за сутки.
    Точность = 1 − MAE считается по всем часам, включая штиль, где прогноз нуля тривиален;
    другие определения точности (например, относительно факта) дадут другие числа.
    Ориентир из ТЗ energy_accuracy ≈ 0.947 здесь не воспроизводится (получается ≈ 0.908):
    по определению выше сутки — ровно 24 часа суток заявки по станции; ориентир, вероятно,
    считался по другим суткам или с другим знаменателем.
    """
    d = pred.dropna(subset=["actual"])
    g = d.groupby([d.index, "origin"])
    st = g[["q50", "raw_nwp_curve", "actual", "horizon_h"]].mean()
    st = st[g["actual"].count() == d["turbine"].nunique()]
    st = st.reset_index()
    hourly = st[st["horizon_h"].between(19, 43)]
    out = {"hours": int(len(hourly))}
    for key, col in (("model", "q50"), ("raw_nwp_curve", "raw_nwp_curve")):
        mae = float(np.mean(np.abs(hourly["actual"] - hourly[col])))
        out[key] = {"mae": round(mae, 4), "accuracy": round(1 - mae, 4)}
    day = st[st["horizon_h"].between(19, 42)]
    e = day.groupby("origin").agg(
        n=("actual", "size"),
        fact=("actual", "sum"),
        q50=("q50", "sum"),
        raw=("raw_nwp_curve", "sum"),
    )
    e = e[e["n"] == 24]
    out["daily_energy"] = {"days": int(len(e))}
    for key, col in (("model", "q50"), ("raw_nwp_curve", "raw")):
        out["daily_energy"][key] = {
            "energy_accuracy": round(float(1 - np.mean(np.abs(e["fact"] - e[col])) / 24), 4),
            "energy_bias_pct": round(
                float((e[col].sum() - e["fact"].sum()) / e["fact"].sum() * 100), 2
            ),
        }
    return out


def summarize_backtest(pred: pd.DataFrame) -> dict:
    if "available_at" not in pred:  # пересчёт отчёта из сохранённого parquet
        pred = pred.assign(available_at=pd.NaT)
    d = pred.dropna(subset=["actual"])
    rows = []
    for key, col in MODELS.items():
        s = summarize(d, col)
        s_usable = summarize(
            d[d["actual_usable"].astype("boolean").fillna(False).astype(bool)], col
        )
        row = {"model": key, "label": LABELS[key], **s, "mae_available": s_usable["mae"]}
        prefix = {"ensemble": "", "cascade": "cas_", "direct": "dir_"}.get(key)
        if prefix is not None:
            row.update(summarize_probabilistic(d, prefix))
        rows.append(row)
    ref = next(r for r in rows if r["model"] == "raw_nwp_curve")["mae"]
    pers = next(r for r in rows if r["model"] == "persistence")["mae"]
    for r in rows:
        r["skill_vs_raw_nwp"] = 1 - r["mae"] / ref
        r["skill_vs_persistence"] = 1 - r["mae"] / pers

    by_h = d.groupby("horizon_h").apply(
        lambda g: pd.Series({k: np.mean(np.abs(g["actual"] - g[c])) for k, c in MODELS.items()}),
        include_groups=False,
    )
    by_day = d.groupby("nwp_day").apply(
        lambda g: pd.Series({k: np.mean(np.abs(g["actual"] - g[c])) for k, c in MODELS.items()}),
        include_groups=False,
    )
    by_month = d.groupby("month").apply(
        lambda g: pd.Series({k: np.mean(np.abs(g["actual"] - g[c])) for k, c in MODELS.items()}),
        include_groups=False,
    )
    # Диаграмма надёжности: доля фактов ниже каждого квантиля.
    reliability = {c: float(np.mean(d["actual"] <= d[c])) for c in QCOLS}

    # Метрики станции (среднее турбин) — то, что сдаётся в график.
    station = []
    for origin, g in d.groupby("origin"):
        st = station_view(g)
        st["origin"] = origin
        station.append(st)
    st = pd.concat(station)
    station_rows = [{"model": k, **summarize(st, c)} for k, c in MODELS.items()]
    # Заявка в РФЦ идёт по станции: покрытие проверяем и на её уровне, а не только по турбинам.
    station_rows[0].update(summarize_probabilistic(st, ""))
    daily_loss = (
        d.assign(day=d["origin"])
        .groupby("day")
        .apply(
            lambda g: pd.Series(
                {k: np.mean(np.abs(g["actual"] - g[c])) for k, c in MODELS.items()}
            ),
            include_groups=False,
        )
    )
    significance = {
        k: diebold_mariano(daily_loss["ensemble"], daily_loss[k])
        for k in ("raw_nwp_curve", "persistence", "direct")
    }
    return {
        "period": f"{pred['month'].min()} — {pred['month'].max()}",
        "n_origins": int(pred["origin"].nunique()),
        "turbine_level": rows,
        "station_level": station_rows,
        "by_horizon": by_h.reset_index().to_dict("records"),
        "by_nwp_day": by_day.reset_index().to_dict("records"),
        "by_month": by_month.reset_index().to_dict("records"),
        "reliability": reliability,
        "significance": significance,
        "operational_day": operational_day(pred),
        "skill_by_month": {
            r["month"]: round(1 - r["ensemble"] / r["raw_nwp_curve"], 4)
            for r in by_month.reset_index().to_dict("records")
        },
        "daily": [
            {
                "date": str(o.date()),
                "mae": {k: float(np.mean(np.abs(g["actual"] - g[c]))) for k, c in MODELS.items()},
            }
            for o, g in d.groupby("origin")
        ],
    }


def diebold_mariano(loss_a: pd.Series, loss_b: pd.Series, lag: int = 2) -> dict:
    """Тест Diebold–Mariano: значимо ли модель A точнее модели B.
    На суточных ошибках, дисперсия с поправкой Ньюи–Уэста на автокорреляцию соседних дней
    (прогнозы на 48 ч перекрываются). p — односторонний: «A лучше B»."""
    import math

    diff = (loss_a - loss_b).dropna().to_numpy()
    n = len(diff)
    mean = diff.mean()
    c = diff - mean
    var = c @ c / n
    for k in range(1, lag + 1):
        var += 2 * (1 - k / (lag + 1)) * (c[k:] @ c[:-k]) / n
    stat = mean / math.sqrt(var / n)
    p = 0.5 * (1 + math.erf(stat / math.sqrt(2)))
    return {
        "days": int(n),
        "mean_diff": round(float(mean), 5),
        "dm_stat": round(float(stat), 2),
        "p_value": float(f"{p:.2g}"),
    }


def frontend_summary(summary: dict) -> dict:
    """Формат BacktestSummary из frontend/src/api.ts."""
    return {
        "period": summary["period"],
        "metrics": [
            {
                "model": r["label"],
                "mae": round(r["mae"], 4),
                "rmse": round(r["rmse"], 4),
                "nmae": round(r["mae"], 4),
                "selected": r["model"] == "ensemble",
            }
            for r in summary["turbine_level"]
        ],
        "daily": [
            {"date": x["date"], "mae": {LABELS[k]: round(v, 4) for k, v in x["mae"].items()}}
            for x in summary["daily"]
        ],
        "by_horizon": [
            {"horizon_h": int(r["horizon_h"]), "mae": round(float(r["ensemble"]), 4)}
            for r in summary["by_horizon"]
        ],
    }


def save(pred: pd.DataFrame, summary: dict) -> None:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    keep = [
        "turbine",
        "origin",
        "month",
        "horizon_h",
        "nwp_day",
        "actual",
        "actual_usable",
        *QCOLS,
        "mean",
        *[v for v in MODELS.values() if v not in QCOLS],
        *[f"{m}_{c}" for m in ("cas", "dir") for c in (*QCOLS, "mean")],
        "cas_naive_curve",
        "wind_corrected",
        "wind_nwp",
        "wind_nwp_spread",
    ]
    cols = [c for c in dict.fromkeys(keep) if c in pred]
    pred[cols].to_parquet(REPORTS_DIR / "backtest_predictions.parquet")
    save_summary(summary)


def save_summary(summary: dict) -> None:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    (REPORTS_DIR / "backtest_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=1, default=float), encoding="utf-8"
    )
    (REPORTS_DIR / "backtest_frontend.json").write_text(
        json.dumps(frontend_summary(summary), ensure_ascii=False, indent=1), encoding="utf-8"
    )


def export_runs(pred: pd.DataFrame | None = None) -> int:
    """Прогнозы бэктеста в формате ForecastRun — для «машины времени» во фронтенде:
    на истории видно и прогноз, и факт."""
    from windcast.config import FORECASTS_DIR
    from windcast.features import inference_frame
    from windcast.pipeline import MODEL_VERSION

    if pred is None:
        pred = pd.read_parquet(REPORTS_DIR / "backtest_predictions.parquet")
    runs = {}
    for origin, g in pred.groupby("origin"):
        x = inference_frame(origin, 48)
        x = x[x["turbine"] == x["turbine"].iloc[0]]
        num = g.select_dtypes("number")
        st = num.groupby(level="time").mean()
        per = g.pivot_table(index=g.index, columns="turbine", values="q50")
        key = pd.Timestamp(origin).strftime("%Y-%m-%dT%H:%M:%SZ")
        pts = []
        for t, r in st.iterrows():
            pts.append(
                {
                    "forecast_for": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "horizon_h": int(r["horizon_h"]),
                    "p10": round(r["q10"], 4),
                    "p50": round(r["q50"], 4),
                    "p90": round(r["q90"], 4),
                    "p05": round(r["q05"], 4),
                    "p95": round(r["q95"], 4),
                    "baseline": round(r["raw_nwp_curve"], 4),
                    "persistence": None
                    if pd.isna(r["persistence"])
                    else round(r["persistence"], 4),
                    "actual": None if pd.isna(r["actual"]) else round(r["actual"], 4),
                    "wind_speed": round(r["wind_corrected"], 2),
                    "wind_speed_nwp": round(r["wind_nwp"], 2),
                    "wind_dir": round(float(x.loc[t, "ens_dir"]), 0) if t in x.index else 0.0,
                    "temperature": round(float(x.loc[t, "temp"]), 1) if t in x.index else 0.0,
                    "nwp_day": int(r["nwp_day"]),
                    "per_turbine": {c: round(float(per.loc[t, c]), 4) for c in per.columns},
                }
            )
        mae = float(np.nanmean(np.abs(st["actual"] - st["q50"])))
        runs[key] = {
            "forecast_id": f"bt-{key[:10]}",
            "forecast_origin": key,
            "horizon": 48,
            "model_version": MODEL_VERSION,
            "weather_provider": "Open-Meteo Previous Runs",
            "weather_run": str(pd.Timestamp(origin) - pd.Timedelta(hours=6)),
            "created_at": key,
            "predictions": pts,
            "backtest": True,
            "explanation": f"Бэктест: модель обучена на данных до {g['month'].iloc[0]}-01, "
            f"MAE этого выпуска по станции {mae:.3f} номинала.",
        }
    FORECASTS_DIR.mkdir(parents=True, exist_ok=True)
    (FORECASTS_DIR / "backtest_runs.json").write_text(
        json.dumps(runs, ensure_ascii=False, default=float), encoding="utf-8"
    )
    return len(runs)


def print_summary(summary: dict) -> None:
    df = pd.DataFrame(summary["turbine_level"]).set_index("label")
    cols = [
        "mae",
        "rmse",
        "bias",
        "mae_available",
        "skill_vs_raw_nwp",
        "skill_vs_persistence",
        "crps",
        "cov80",
        "cov90",
    ]
    print(df[[c for c in cols if c in df]].round(4).to_string())
    print("\nMAE по дню выпуска погоды:")
    print(pd.DataFrame(summary["by_nwp_day"]).round(4).to_string(index=False))
