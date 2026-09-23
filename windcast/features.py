"""Признаки для пары (час t, «день назад» выпуска N).

Признаки зависят только от (t, N), поэтому обучение и прогноз используют одну и ту же
функцию: при обучении берутся все t для N = 1..3, при прогнозе из момента T — строки
с N = N(t − T). Соседние часы берутся только из прошлого (t−1…t−3): у будущих соседей
при том же N выпуск может оказаться опубликованным позже T.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from windcast.config import NWP_MAX_DAY, SCADA_UTC_OFFSET_H, TURBINES
from windcast.weather import day_for_horizon, latest_issue_bound, load_archive, nwp_by_day

HUB_MODELS = ("ecmwf_aifs025_single", "ecmwf_ifs025", "icon_seamless", "gfs_seamless")
TURBINE_CODE = {t.id: i for i, t in enumerate(TURBINES)}


def _air_density(pressure_hpa: pd.Series, temp_c: pd.Series) -> pd.Series:
    return pressure_hpa * 100 / (287.05 * (temp_c + 273.15))


def weather_features(nwp: pd.DataFrame) -> pd.DataFrame:
    """nwp — срез одного N: колонки `<model>|<var>`. Индекс — час UTC (непрерывный)."""
    nwp = nwp.asfreq("1h")
    f = pd.DataFrame(index=nwp.index)

    def col(model: str, var: str) -> pd.Series:
        name = f"{model}|{var}"
        return nwp[name] if name in nwp else pd.Series(np.nan, index=nwp.index)

    hub = pd.DataFrame({m: col(m, "wind_speed_100m") for m in HUB_MODELS})
    surf_models = sorted({c.split("|")[0] for c in nwp.columns if c.endswith("|wind_speed_10m")})
    surf = pd.DataFrame({m: col(m, "wind_speed_10m") for m in surf_models})

    for m in HUB_MODELS:
        short = m.split("_")[0] + ("_ai" if "aifs" in m else "")
        f[f"ws100_{short}"] = hub[m]
        f[f"ws10_{short}"] = col(m, "wind_speed_10m")
        f[f"ws120_{short}"] = col(m, "wind_speed_120m")
        d = np.deg2rad(col(m, "wind_direction_100m"))
        f[f"dir_sin_{short}"] = np.sin(d)
        f[f"dir_cos_{short}"] = np.cos(d)
    for m in surf_models:
        if m not in HUB_MODELS:
            f[f"ws10_{m.split('_')[0]}"] = surf[m]

    # Ансамбль: среднее точнее любой одной модели (r=0.78 против 0.74 у лучшей),
    # а разброс — естественная мера неопределённости.
    f["ens_ws100_mean"] = hub.mean(axis=1)
    f["ens_ws100_median"] = hub.median(axis=1)
    f["ens_ws100_std"] = hub.std(axis=1)
    f["ens_ws100_n"] = hub.notna().sum(axis=1)
    f["ens_ws10_mean"] = surf.mean(axis=1)
    f["ens_ws10_std"] = surf.std(axis=1)
    f["ens_ws100_cube"] = f["ens_ws100_mean"] ** 3

    u = pd.concat(
        [hub[m] * -np.sin(np.deg2rad(col(m, "wind_direction_100m"))) for m in HUB_MODELS], axis=1
    ).mean(axis=1)
    v = pd.concat(
        [hub[m] * -np.cos(np.deg2rad(col(m, "wind_direction_100m"))) for m in HUB_MODELS], axis=1
    ).mean(axis=1)
    ens_dir = (np.rad2deg(np.arctan2(-u, -v)) + 360) % 360
    f["ens_dir"] = ens_dir
    f["ens_dir_sin"] = np.sin(np.deg2rad(ens_dir))
    f["ens_dir_cos"] = np.cos(np.deg2rad(ens_dir))

    # Сдвиг ветра по высоте — прокси устойчивости атмосферы (ночная инверсия зимой).
    ws10 = col("ecmwf_ifs025", "wind_speed_10m").clip(lower=0.3)
    f["shear_alpha"] = np.log(
        col("ecmwf_ifs025", "wind_speed_100m").clip(lower=0.3) / ws10
    ) / np.log(10)

    temp = pd.concat([col(m, "temperature_2m") for m in HUB_MODELS], axis=1).mean(axis=1)
    press = pd.concat([col(m, "surface_pressure") for m in HUB_MODELS], axis=1).mean(axis=1)
    rh = pd.concat([col(m, "relative_humidity_2m") for m in HUB_MODELS], axis=1).mean(axis=1)
    gust = pd.concat([col(m, "wind_gusts_10m") for m in HUB_MODELS], axis=1).mean(axis=1)
    f["temp"] = temp
    f["pressure"] = press
    f["rh"] = rh
    f["gust"] = gust
    f["gust_factor"] = gust / f["ens_ws10_mean"].clip(lower=0.5)
    f["air_density"] = _air_density(press, temp)
    f["icing_risk"] = ((temp.between(-8, 1)) & (rh >= 90)).astype(float)

    # Только прошлые соседи — см. докстринг модуля.
    ens = f["ens_ws100_mean"]
    f["ens_ws100_lag1"] = ens.shift(1)
    f["ens_ws100_diff1"] = ens - ens.shift(1)
    f["ens_ws100_roll3"] = ens.rolling(3, min_periods=1).mean()

    local = f.index + pd.Timedelta(hours=SCADA_UTC_OFFSET_H)
    f["hour_sin"] = np.sin(2 * np.pi * local.hour / 24)
    f["hour_cos"] = np.cos(2 * np.pi * local.hour / 24)
    f["doy_sin"] = np.sin(2 * np.pi * local.dayofyear / 365.25)
    f["doy_cos"] = np.cos(2 * np.pi * local.dayofyear / 365.25)
    return f.astype("float32")


def _with_turbines(f: pd.DataFrame) -> pd.DataFrame:
    frames = []
    for tid, code in TURBINE_CODE.items():
        x = f.copy()
        x["turbine"] = tid
        x["turbine_code"] = code
        frames.append(x)
    return pd.concat(frames)


def training_frame(archive: pd.DataFrame | None = None) -> pd.DataFrame:
    """Все (t, N, турбина) с целевыми полями SCADA. Строки без факта не отбрасываются —
    это решает модель (часть моделей учится на ветре, часть на мощности)."""
    from windcast.scada import load_all

    archive = load_archive() if archive is None else archive
    scada = load_all()[["ws", "power", "temp", "usable", "downtime", "curtailed", "expected_power"]]
    scada = scada.rename(columns={"ws": "obs_ws", "power": "obs_power", "temp": "obs_temp"})
    frames = []
    for day in range(1, NWP_MAX_DAY + 1):
        f = weather_features(nwp_by_day(day, archive))
        f["nwp_day"] = day
        frames.append(_with_turbines(f))
    x = pd.concat(frames)
    x.index.name = "time"
    x = x.reset_index().merge(scada.reset_index(), on=["time", "turbine"], how="left")
    for flag in ("usable", "downtime", "curtailed"):
        x[flag] = x[flag].astype("boolean").fillna(False).astype(bool)
    return x.set_index("time").sort_index()


def inference_frame(
    origin: pd.Timestamp, horizon: int = 48, archive: pd.DataFrame | None = None
) -> pd.DataFrame:
    """Признаки прогноза, выпущенного в origin, на часы origin+1 … origin+horizon."""
    archive = load_archive() if archive is None else archive
    origin = pd.Timestamp(origin)
    times = pd.date_range(origin + pd.Timedelta(hours=1), periods=horizon, freq="1h")
    h = np.arange(1, horizon + 1)
    days = day_for_horizon(h)
    window = slice(times[0] - pd.Timedelta(hours=6), times[-1])

    parts = []
    for day in sorted(set(days.tolist())):
        f = weather_features(nwp_by_day(day, archive).loc[window])
        sel = times[days == day]
        part = f.reindex(sel)
        part["nwp_day"] = day
        parts.append(part)
    x = pd.concat(parts).sort_index()
    x["horizon_h"] = h
    x["available_at"] = [latest_issue_bound(t, int(d)) for t, d in zip(times, days, strict=True)]
    x.index.name = "time"
    return _with_turbines(x)


FEATURE_EXCLUDE = {
    "turbine",
    "available_at",
    "horizon_h",
    "obs_ws",
    "obs_power",
    "obs_temp",
    "usable",
    "downtime",
    "curtailed",
    "expected_power",
}


def feature_columns(frame: pd.DataFrame) -> list[str]:
    return [c for c in frame.columns if c not in FEATURE_EXCLUDE]
