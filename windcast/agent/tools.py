"""Инструменты агента. Каждый возвращает JSON-совместимый результат — это и есть
«факты», из которых строятся решения и отчёт."""

from __future__ import annotations

import numpy as np
import pandas as pd

from windcast.config import NWP_MODELS, NWP_PUBLICATION_DELAY_H
from windcast.features import HUB_MODELS, inference_frame
from windcast.pipeline import Forecaster, station_view
from windcast.weather import day_for_horizon, load_archive

RAMP_THRESHOLD = 0.30  # доля номинала за 3 ч — порог «резкого перепада» для диспетчера
WIDE_INTERVAL = 0.45  # ширина P10–P90, выше которой прогнозу на этот час мало доверия
REVISION_MAE = 0.03  # средний сдвиг P50, при котором выпускается ревизия
REVISION_MAX = 0.12  # или максимальный сдвиг в отдельный час


def list_available_runs(as_of: pd.Timestamp) -> dict:
    """Самый свежий выпуск погоды, гарантированно опубликованный к as_of."""
    latest_init = (as_of - pd.Timedelta(hours=NWP_PUBLICATION_DELAY_H)).floor("6h")
    return {
        "as_of": str(as_of),
        "latest_run_init": str(latest_init),
        "publication_delay_h": NWP_PUBLICATION_DELAY_H,
        "models": list(NWP_MODELS),
    }


def fetch_weather(
    origin: pd.Timestamp, horizon: int = 48, archive: pd.DataFrame | None = None
) -> tuple[pd.DataFrame, dict]:
    archive = load_archive() if archive is None else archive
    x = inference_frame(origin, horizon, archive)
    one = x[x["turbine"] == x["turbine"].iloc[0]]
    per_model = {}
    for m in HUB_MODELS:
        vals = []
        for t, d in zip(one.index, one["nwp_day"], strict=True):
            col = f"{m}|wind_speed_100m|d{int(d)}"
            vals.append(archive[col].get(t, np.nan) if col in archive else np.nan)
        per_model[m] = float(np.mean(~np.isnan(vals)))
    return x, {
        "hours": int(len(one)),
        "nwp_days_used": sorted({int(d) for d in one["nwp_day"]}),
        "max_available_at": str(one["available_at"].max()),
        "hub_models_coverage": per_model,
        "hub_models_ok": [m for m, c in per_model.items() if c >= 0.95],
    }


def qa_check(x: pd.DataFrame, weather_meta: dict) -> dict:
    one = x[x["turbine"] == x["turbine"].iloc[0]]
    issues, warnings = [], []
    if one["ens_ws100_mean"].isna().any():
        issues.append(f"нет ветра ни от одной модели в {int(one['ens_ws100_mean'].isna().sum())} ч")
    if not one["ens_ws100_mean"].dropna().between(0, 45).all():
        issues.append("ветер вне физического диапазона 0–45 м/с")
    if not one["temp"].dropna().between(-50, 50).all():
        issues.append("температура вне диапазона −50…50 °C")
    ok_models = weather_meta["hub_models_ok"]
    if len(ok_models) < 2:
        issues.append(f"доступно погодных моделей: {len(ok_models)} — ансамбль не собрать")
    elif len(ok_models) < len(HUB_MODELS):
        missing = sorted(set(HUB_MODELS) - set(ok_models))
        warnings.append(f"нет данных {', '.join(missing)} — ансамбль перевешен на остальные")
    spread = one["ens_ws100_std"]
    disagree = int((spread > 2.5).sum())
    if disagree:
        warnings.append(f"погодные модели расходятся больше 2.5 м/с в {disagree} ч")
    icing = int(one["icing_risk"].sum())
    if icing:
        warnings.append(f"риск обледенения в {icing} ч (t −8…+1 °C, влажность ≥ 90%)")
    return {
        "ok": not issues,
        "issues": issues,
        "warnings": warnings,
        "disagreement_hours": disagree,
        "icing_hours": icing,
        "mean_spread_ms": round(float(spread.mean()), 2),
    }


def run_forecast(
    fc: Forecaster, origin: pd.Timestamp, horizon: int = 48, archive: pd.DataFrame | None = None
) -> pd.DataFrame:
    return fc.predict(origin, horizon, archive)


def analyze(pred: pd.DataFrame) -> dict:
    st = station_view(pred)
    p50 = st["q50"]
    # Соседние часы одного перепада склеиваются в одно событие с максимальной амплитудой.
    ramps = []
    prev_dir = None
    for t, v in p50.diff(3).items():
        direction = None if pd.isna(v) or abs(v) < RAMP_THRESHOLD else ("up" if v > 0 else "down")
        if direction and direction == prev_dir:
            if abs(v) > abs(ramps[-1]["delta"]):
                ramps[-1].update({"time": str(t), "delta": round(float(v), 3)})
        elif direction:
            ramps.append({"time": str(t), "delta": round(float(v), 3), "direction": direction})
        prev_dir = direction
    width = st["q90"] - st["q10"]
    wide = [str(t) for t in width[width > WIDE_INTERVAL].index]
    local_day = (st.index + pd.Timedelta(hours=5)).date
    energy = st.groupby(local_day)["mean"].sum()
    return {
        "mean_p50": round(float(p50.mean()), 3),
        "max_p50": round(float(p50.max()), 3),
        "min_p50": round(float(p50.min()), 3),
        "peak_time": str(p50.idxmax()),
        "energy_equiv_hours": {str(k): round(float(v), 1) for k, v in energy.items()},
        "ramps": ramps[:10],
        "n_ramps": len(ramps),
        "wide_interval_hours": len(wide),
        "mean_width80": round(float(width.mean()), 3),
        "vs_raw_nwp_curve": round(float((st["q50"] - st["raw_nwp_curve"]).mean()), 3),
        "wind_bias_correction_ms": round(float((st["wind_corrected"] - st["wind_nwp"]).mean()), 2),
    }


def critic(pred: pd.DataFrame, horizon: int) -> dict:
    problems = []
    q = pred[["q05", "q10", "q25", "q50", "q75", "q90", "q95"]].to_numpy()
    if np.isnan(q).any():
        problems.append("пропуски в квантилях")
    if (np.diff(q, axis=1) < -1e-9).any():
        problems.append("квантили пересекаются")
    if (q < 0).any() or (q > 1).any():
        problems.append("выход за [0, 1] номинала")
    n_hours = pred.index.nunique()
    if n_hours != horizon:
        problems.append(f"часов в прогнозе {n_hours}, ожидалось {horizon}")
    gap = float(np.nanmean(np.abs(pred["cas_q50"] - pred["dir_q50"])))
    warnings = []
    if gap > 0.15:
        warnings.append(f"каскад и прямая модель расходятся в среднем на {gap:.2f} номинала")
    return {
        "ok": not problems,
        "problems": problems,
        "warnings": warnings,
        "model_gap": round(gap, 3),
    }


def compare_with_previous(new: pd.DataFrame, prev: pd.DataFrame | None) -> dict:
    if prev is None:
        return {"is_revision": False, "first_issue": True}
    a = station_view(new)["q50"]
    b = station_view(prev)["q50"]
    common = a.index.intersection(b.index)
    delta = a.loc[common] - b.loc[common]
    mean_abs = float(delta.abs().mean())
    max_abs = float(delta.abs().max())
    worst = delta.abs().idxmax()
    material = mean_abs >= REVISION_MAE or max_abs >= REVISION_MAX
    return {
        "is_revision": True,
        "material": bool(material),
        "hours_compared": int(len(common)),
        "mean_abs_change": round(mean_abs, 3),
        "max_abs_change": round(max_abs, 3),
        "max_change_time": str(worst),
        "energy_change": round(float(delta.sum()), 2),
    }


def fresher_data_available(prev_origin: pd.Timestamp, new_origin: pd.Timestamp, targets) -> int:
    """Сколько целевых часов получили более свежий выпуск погоды при сдвиге момента прогноза."""
    count = 0
    for t in targets:
        h_old = int((t - prev_origin) / pd.Timedelta(hours=1))
        h_new = int((t - new_origin) / pd.Timedelta(hours=1))
        if h_new >= 1 and day_for_horizon(h_new) < day_for_horizon(h_old):
            count += 1
    return count
