"""Интерпретация прогноза: почему модель выдала именно это число.

Три уровня:
  1. Разбор по шагам каскада для каждого часа: сырой прогноз погоды → поправка ветра →
     кривая мощности → учёт неопределённости → ансамбль с прямой моделью.
  2. Вклады признаков (TreeSHAP, встроен в LightGBM: `pred_contrib=True`). Для деревьев
     вклады точные и аддитивные: база + сумма вкладов = предсказание. Признаки сведены
     в группы, понятные диспетчеру.
  3. Почему изменился прогноз между версиями: разница вкладов по группам и какая
     погодная модель сдвинулась сильнее.

Всё считается из обученного Forecaster и прогона агента — без внешних сервисов.
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

from windcast.config import ARTIFACTS, FORECASTS_DIR, REPORTS_DIR, SCADA_UTC_OFFSET_H
from windcast.features import HUB_MODELS, inference_frame, training_frame
from windcast.weather import load_archive

EXPLAIN_DIR = ARTIFACTS / "explain"

# Группы признаков: подпись для человека → правило по имени признака.
GROUPS: list[tuple[str, str, tuple[str, ...]]] = [
    (
        "wind_level",
        "Прогноз ветра",
        (
            "ws100_",
            "ws10_",
            "ws120_",
            "ens_ws100_mean",
            "ens_ws100_median",
            "ens_ws10_mean",
            "ens_ws100_cube",
        ),
    ),
    ("wind_trend", "Тенденция ветра", ("ens_ws100_lag1", "ens_ws100_diff1", "ens_ws100_roll3")),
    (
        "disagreement",
        "Расхождение погодных моделей",
        ("ens_ws100_std", "ens_ws10_std", "ens_ws100_n"),
    ),
    ("direction", "Направление ветра", ("dir_", "ens_dir")),
    ("stability", "Устойчивость атмосферы и порывы", ("shear_alpha", "gust")),
    (
        "thermo",
        "Температура, влажность, давление",
        ("temp", "rh", "air_density", "pressure", "icing_risk"),
    ),
    ("diurnal", "Время суток", ("hour_",)),
    ("season", "Сезон", ("doy_",)),
    ("lead", "Давность выпуска погоды", ("nwp_day",)),
    ("turbine", "Турбина", ("turbine_code",)),
]
GROUP_LABEL = {k: label for k, label, _ in GROUPS}

MODEL_LABEL = {
    "ecmwf_aifs025_single": "ECMWF AIFS (нейросеть)",
    "ecmwf_ifs025": "ECMWF IFS",
    "icon_seamless": "ICON (DWD)",
    "gfs_seamless": "GFS (NOAA)",
}


def group_of(feature: str) -> str:
    for key, _, prefixes in GROUPS:
        if any(feature == p or feature.startswith(p) for p in prefixes):
            return key
    return "wind_level"


def _group_contrib(contrib: np.ndarray, features: list[str]) -> pd.DataFrame:
    """contrib: (n, len(features)+1) из pred_contrib → (n, групп) + колонка base."""
    df = pd.DataFrame(contrib[:, :-1], columns=features)
    out = df.T.groupby([group_of(f) for f in features]).sum().T
    out["base"] = contrib[:, -1]
    return out


def _curve_slope(fc, ws: np.ndarray, temp: np.ndarray, code: np.ndarray) -> np.ndarray:
    """dP/dws кривой мощности — чтобы перевести вклад в ветер (м/с) во вклад в мощность."""
    up = fc.cascade.curve.predict(ws + 0.5, temp, code)
    dn = fc.cascade.curve.predict(np.clip(ws - 0.5, 0, None), temp, code)
    return (up - dn) / 1.0


def explain_origin(
    fc, origin: pd.Timestamp, horizon: int = 48, archive: pd.DataFrame | None = None
) -> dict:
    """Почасовое объяснение прогноза из момента origin (уровень станции = среднее турбин).
    archive — та же погода, на которой считался прогноз (живой прогноз передаёт свою)."""
    origin = pd.Timestamp(origin)
    archive = load_archive() if archive is None else archive
    x = inference_frame(origin, horizon, archive)
    pred = fc.predict(origin, horizon, archive)
    feats = fc.features

    mos = fc.cascade.mos.models[0.5].booster_
    direct = fc.direct.models[0.5].booster_
    wind_c = _group_contrib(mos.predict(x[feats], pred_contrib=True), feats)
    pow_c = _group_contrib(direct.predict(x[feats], pred_contrib=True), feats)
    wind_c.index = pow_c.index = x.index

    slope = _curve_slope(
        fc,
        pred["wind_corrected"].to_numpy(),
        x["temp"].to_numpy(float),
        x["turbine_code"].to_numpy(float),
    )
    wind_in_power = wind_c.drop(columns="base").mul(slope, axis=0)

    per = pd.DataFrame(
        {
            "raw_wind": x["ens_ws100_mean"].to_numpy(),
            "wind_spread": x["ens_ws100_std"].to_numpy(),
            "corrected_wind": pred["wind_corrected"].to_numpy(),
            "wind_p10": pred["wind_q10"].to_numpy(),
            "wind_p90": pred["wind_q90"].to_numpy(),
            "raw_curve": pred["raw_nwp_curve"].to_numpy(),
            "after_correction": pred["cas_naive_curve"].to_numpy(),
            "cascade_p50": pred["cas_q50"].to_numpy(),
            "cascade_mean": pred["cas_mean"].to_numpy(),
            "direct_p50": pred["dir_q50"].to_numpy(),
            "final_p50": pred["q50"].to_numpy(),
            "final_p10": pred["q10"].to_numpy(),
            "final_p90": pred["q90"].to_numpy(),
            "nwp_day": x["nwp_day"].to_numpy(),
            "horizon_h": x["horizon_h"].to_numpy(),
            "temp": x["temp"].to_numpy(),
        },
        index=x.index,
    )
    # Погодные модели по отдельности — видно, кто «тянет» ансамбль.
    for m in HUB_MODELS:
        vals = []
        for t, d in zip(x.index, x["nwp_day"], strict=True):
            col = f"{m}|wind_speed_100m|d{int(d)}"
            vals.append(archive[col].get(t, np.nan) if col in archive else np.nan)
        per[f"nwp_{m}"] = vals

    g = per.groupby(level=0).mean()
    wc = wind_c.groupby(level=0).mean()
    wp = wind_in_power.groupby(level=0).mean()
    pc = pow_c.groupby(level=0).mean()
    weights = fc.state.weights

    hours = []
    for t in g.index:
        r = g.loc[t]
        w = weights.get(int(r["nwp_day"]), 0.5)
        groups = []
        for key in wc.columns.drop("base"):
            groups.append(
                {
                    "group": key,
                    "label": GROUP_LABEL.get(key, key),
                    "wind_ms": round(float(wc.loc[t, key]), 3),
                    "power_via_wind": round(float(wp.loc[t, key]), 4),
                    "power_direct": round(float(pc.loc[t, key]) if key in pc.columns else 0.0, 4),
                }
            )
        groups.sort(key=lambda z: -abs(z["wind_ms"]))
        hours.append(
            {
                "time": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "local": (t + pd.Timedelta(hours=SCADA_UTC_OFFSET_H)).strftime("%d.%m %H:%M"),
                "horizon_h": int(r["horizon_h"]),
                "nwp_day": int(r["nwp_day"]),
                "steps": [
                    {
                        "key": "raw",
                        "label": "Сырой прогноз погоды → кривая мощности",
                        "power": round(float(r["raw_curve"]), 4),
                        "wind": round(float(r["raw_wind"]), 2),
                    },
                    {
                        "key": "corrected",
                        "label": "Поправка ветра под площадку → кривая",
                        "power": round(float(r["after_correction"]), 4),
                        "wind": round(float(r["corrected_wind"]), 2),
                    },
                    {
                        "key": "uncertainty",
                        "label": "Учёт неопределённости ветра (Монте-Карло, P50)",
                        "power": round(float(r["cascade_p50"]), 4),
                    },
                    {
                        "key": "final",
                        "label": f"Ансамбль: каскад {w:.0%} + прямая модель {1 - w:.0%}",
                        "power": round(float(r["final_p50"]), 4),
                    },
                ],
                "direct_p50": round(float(r["direct_p50"]), 4),
                "cascade_mean": round(float(r["cascade_mean"]), 4),
                "interval": [round(float(r["final_p10"]), 4), round(float(r["final_p90"]), 4)],
                "wind": {
                    "raw": round(float(r["raw_wind"]), 2),
                    "spread": round(float(r["wind_spread"]), 2),
                    "corrected": round(float(r["corrected_wind"]), 2),
                    "p10": round(float(r["wind_p10"]), 2),
                    "p90": round(float(r["wind_p90"]), 2),
                    "base": round(float(wc.loc[t, "base"]), 2),
                    "by_model": {
                        MODEL_LABEL[m]: (
                            None if pd.isna(r[f"nwp_{m}"]) else round(float(r[f"nwp_{m}"]), 2)
                        )
                        for m in HUB_MODELS
                    },
                },
                "groups": groups,
                "temp": round(float(r["temp"]), 1),
            }
        )

    # Итог по всему прогнозу: средний модуль вклада группы.
    overall = []
    for key in wc.columns.drop("base"):
        overall.append(
            {
                "group": key,
                "label": GROUP_LABEL.get(key, key),
                "mean_abs_wind_ms": round(float(wc[key].abs().mean()), 3),
                "mean_wind_ms": round(float(wc[key].mean()), 3),
                "mean_abs_power_direct": round(
                    float(pc[key].abs().mean()) if key in pc else 0.0, 4
                ),
            }
        )
    overall.sort(key=lambda z: -z["mean_abs_wind_ms"])
    return {
        "origin": origin.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "hours": hours,
        "overall": overall,
        "summary": summary_text(hours, overall),
    }


def summary_text(hours: list[dict], overall: list[dict]) -> str:
    top = [o for o in overall if o["mean_abs_wind_ms"] >= 0.05][:3]
    raw = np.mean([h["wind"]["raw"] for h in hours])
    diff = np.array([h["wind"]["corrected"] - h["wind"]["raw"] for h in hours])
    parts = [
        f"Погодные модели обещали в среднем {raw:.1f} м/с на высоте ступицы; модель "
        f"поправляла ветер под площадку в среднем на {np.abs(diff).mean():.1f} м/с за час "
        f"(вниз до {diff.min():+.1f}, вверх до {diff.max():+.1f} м/с)."
    ]
    if top:
        parts.append(
            "Сильнее всего на поправку влияли: "
            + ", ".join(
                f"{o['label'].lower()} (±{o['mean_abs_wind_ms']:.2f} м/с в среднем)" for o in top
            )
            + "."
        )
    big = max(hours, key=lambda h: abs(h["steps"][1]["power"] - h["steps"][0]["power"]))
    d = big["steps"][1]["power"] - big["steps"][0]["power"]
    parts.append(
        f"Самая большая поправка — {big['local']}: {d:+.0%} номинала относительно сырого прогноза "
        f"({big['wind']['raw']:.1f} → {big['wind']['corrected']:.1f} м/с)."
    )
    return " ".join(parts)


def explain_revision(prev: dict, new: dict, top_hours: int = 5) -> dict:
    """Почему изменился прогноз: часы с наибольшим сдвигом и что в них поменялось."""
    ph = {h["time"]: h for h in prev["hours"]}
    rows = []
    for h in new["hours"]:
        o = ph.get(h["time"])
        if not o:
            continue
        dp = h["steps"][-1]["power"] - o["steps"][-1]["power"]
        og = {g["group"]: g["wind_ms"] for g in o["groups"]}
        dg = sorted(
            (
                {
                    "label": g["label"],
                    "delta_wind_ms": round(g["wind_ms"] - og.get(g["group"], 0), 3),
                }
                for g in h["groups"]
            ),
            key=lambda z: -abs(z["delta_wind_ms"]),
        )
        dm = {
            m: (
                None
                if (h["wind"]["by_model"][m] is None or o["wind"]["by_model"][m] is None)
                else round(h["wind"]["by_model"][m] - o["wind"]["by_model"][m], 2)
            )
            for m in h["wind"]["by_model"]
        }
        rows.append(
            {
                "time": h["time"],
                "local": h["local"],
                "delta_power": round(dp, 4),
                "was": o["steps"][-1]["power"],
                "now": h["steps"][-1]["power"],
                "raw_wind_change": round(h["wind"]["raw"] - o["wind"]["raw"], 2),
                "model_wind_change": dm,
                "group_changes": dg[:4],
            }
        )
    rows.sort(key=lambda z: -abs(z["delta_power"]))
    if not rows:
        return {"from": prev["origin"], "to": new["origin"], "hours": [], "summary": ""}
    worst = rows[0]
    movers = sorted(
        ((m, v) for m, v in worst["model_wind_change"].items() if v is not None),
        key=lambda z: -abs(z[1]),
    )
    text = (
        f"Сильнее всего изменился час {worst['local']}: {worst['was']:.0%} → {worst['now']:.0%} "
        f"номинала. Прогноз ветра в нём сдвинулся на {worst['raw_wind_change']:+.1f} м/с"
    )
    if movers:
        text += ", больше всех — " + ", ".join(f"{m} ({v:+.1f} м/с)" for m, v in movers[:2])
    text += "."
    return {
        "from": prev["origin"],
        "to": new["origin"],
        "hours": rows[:top_hours],
        "summary": text,
        "mean_abs_change": round(float(np.mean([abs(r["delta_power"]) for r in rows])), 4),
    }


def global_explain(fc) -> dict:
    """Модель в целом: кривая мощности, важность групп, доверие к погодным моделям."""
    grid = np.round(np.arange(0, 25.01, 0.5), 2)
    curves = {}
    for label, t in (("зима, −15 °C", -15.0), ("лето, +25 °C", 25.0)):
        vals = [
            fc.cascade.curve.predict(grid, np.full_like(grid, t), np.full_like(grid, c))
            for c in (0.0, 1.0)
        ]
        curves[label] = np.round(np.mean(vals, axis=0), 4).tolist()

    def importance(booster) -> list[dict]:
        imp = pd.Series(booster.feature_importance("gain"), index=fc.features)
        grp = imp.groupby([group_of(f) for f in fc.features]).sum()
        grp = grp / grp.sum()
        return [
            {"group": k, "label": GROUP_LABEL.get(k, k), "share": round(float(v), 4)}
            for k, v in grp.sort_values(ascending=False).items()
        ]

    # Доверие к погодным моделям: насколько каждая попадает в измеренный ветер на площадке.
    tf = training_frame()
    tf = tf[(tf.index < fc.until) & (tf["nwp_day"] == 1)].dropna(subset=["obs_ws"])
    archive = load_archive()
    trust = []
    for m in HUB_MODELS:
        s = archive.get(f"{m}|wind_speed_100m|d1")
        if s is None:
            continue
        j = pd.DataFrame(
            {"f": s.reindex(tf.index).to_numpy(), "o": tf["obs_ws"].to_numpy()}
        ).dropna()
        if len(j) < 100:
            continue
        trust.append(
            {
                "model": MODEL_LABEL[m],
                "hours": int(len(j) // 2),
                "corr": round(float(j["f"].corr(j["o"])), 3),
                "mae_ms": round(float((j["f"] - j["o"]).abs().mean()), 2),
                "bias_ms": round(float((j["f"] - j["o"]).mean()), 2),
            }
        )
    ens = pd.DataFrame(
        {"f": tf["ens_ws100_mean"].to_numpy(), "o": tf["obs_ws"].to_numpy()}
    ).dropna()
    trust.append(
        {
            "model": "Ансамбль (среднее)",
            "hours": int(len(ens) // 2),
            "corr": round(float(ens["f"].corr(ens["o"])), 3),
            "mae_ms": round(float((ens["f"] - ens["o"]).abs().mean()), 2),
            "bias_ms": round(float((ens["f"] - ens["o"]).mean()), 2),
        }
    )
    trust.sort(key=lambda z: -z["corr"])

    calib = {}
    path = REPORTS_DIR / "backtest_summary.json"
    if path.exists():
        s = json.loads(path.read_text(encoding="utf-8"))
        ens_row = next(r for r in s["turbine_level"] if r["model"] == "ensemble")
        calib = {
            "reliability": s["reliability"],
            "cov80": ens_row.get("cov80"),
            "cov90": ens_row.get("cov90"),
            "by_horizon": [
                {
                    "h": int(r["horizon_h"]),
                    "ensemble": round(r["ensemble"], 4),
                    "raw": round(r["raw_nwp_curve"], 4),
                }
                for r in s["by_horizon"]
            ],
        }
    return {
        "power_curve": {"ws": grid.tolist(), "curves": curves},
        "importance_wind_correction": importance(fc.cascade.mos.models[0.5].booster_),
        "importance_direct": importance(fc.direct.models[0.5].booster_),
        "weather_models": trust,
        "ensemble_weights": {str(k): v for k, v in fc.state.weights.items()},
        "calibration": calib,
        "trained_until": str(fc.until),
    }


def export_test_period(fc=None) -> dict:
    """Объяснения для всех версий прогноза тестового периода + глобальная картина."""
    from windcast.agent.runner import _load_or_train

    fc = fc or _load_or_train()
    EXPLAIN_DIR.mkdir(parents=True, exist_ok=True)
    n = 0
    for path in sorted(FORECASTS_DIR.glob("2026-*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        versions = [v for v in doc["versions"] if "skipped" not in v]
        out = {"day": doc["day"], "versions": []}
        prev = None
        for v in versions:
            origin = pd.Timestamp(v["forecast_origin"].rstrip("Z"))
            e = explain_origin(fc, origin, v["horizon"])
            e.update({"forecast_id": v["forecast_id"], "published": v["published"]})
            if prev is not None:
                e["revision"] = explain_revision(prev, e)
            if v["published"]:
                prev = e
            out["versions"].append(e)
            n += 1
        (EXPLAIN_DIR / f"{doc['day']}.json").write_text(
            json.dumps(out, ensure_ascii=False), encoding="utf-8"
        )
    (EXPLAIN_DIR / "global.json").write_text(
        json.dumps(global_explain(fc), ensure_ascii=False), encoding="utf-8"
    )
    return {"versions": n}
