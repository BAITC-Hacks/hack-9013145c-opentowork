"""Прогноз на реальной погоде для любой точки и любого момента, включая «сейчас».

Погода — тот же Open-Meteo Previous Runs, на котором обучена модель, но окно
запрашивается на лету под нужные координаты и даты. Таблица приводится к формату
`load_archive()`, поэтому признаки и правило «какой выпуск виден» (day_for_horizon)
остаются общими с обучением и бэктестом.

Станция кейса (Нурлы) считается обученной моделью через граф агента. Для остальных
ВЭС истории турбин нет, модель к ним не переносится: прогноз = ансамбль ветра на 100 м
через эмпирическую кривую мощности Нурлы. Это честно помечено в model_version.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.parse
import urllib.request
from datetime import UTC, datetime

import numpy as np
import pandas as pd

from windcast.config import MODELS_DIR, NWP_MAX_DAY, NWP_MODELS, NWP_VARIABLES
from windcast.features import inference_frame
from windcast.weather import API_URL

CURVE_VERSION = "nwp-ensemble+power-curve-v1"
SOLAR_VERSION = "pv-physical-v1"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
HISTORICAL_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"

# Окно «сейчас» меняется с каждым выпуском (раз в 6 ч), архивные — никогда.
LIVE_TTL_S = 30 * 60
_cache: dict[tuple, tuple[float, pd.DataFrame]] = {}
_lock = threading.Lock()


def now_origin() -> pd.Timestamp:
    """Момент выпуска живого прогноза — начало текущего часа UTC (naive, как весь windcast)."""
    return pd.Timestamp(datetime.now(UTC).replace(tzinfo=None)).floor("h")


def _get_json(url: str, retries: int = 3) -> dict:
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:  # noqa: S310 — фиксированный https
                return json.load(resp)
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("unreachable")


def _cached(key: tuple, is_live: bool, load) -> pd.DataFrame:
    with _lock:
        hit = _cache.get(key)
        if hit and (not is_live or time.time() - hit[0] < LIVE_TTL_S):
            return hit[1]
    df = load()
    with _lock:
        if len(_cache) > 256:
            _cache.clear()
        _cache[key] = (time.time(), df)
    return df


def fetch_window(lat: float, lon: float, origin: pd.Timestamp, horizon: int = 48) -> pd.DataFrame:
    """Previous Runs всех моделей одним запросом → колонки `<model>|<var>|d<N>`."""
    lat, lon = round(lat, 3), round(lon, 3)
    start = (origin - pd.Timedelta(hours=12)).date()
    end = (origin + pd.Timedelta(hours=horizon + 1)).date()
    is_live = origin >= now_origin() - pd.Timedelta(hours=6)

    def load() -> pd.DataFrame:
        hourly = [f"{v}_previous_day{d}" for v in NWP_VARIABLES for d in range(1, NWP_MAX_DAY + 1)]
        params = {
            "latitude": lat,
            "longitude": lon,
            "hourly": ",".join(hourly),
            "models": ",".join(NWP_MODELS),
            "start_date": str(start),
            "end_date": str(end),
            "wind_speed_unit": "ms",
            "timezone": "GMT",
        }
        payload = _get_json(f"{API_URL}?{urllib.parse.urlencode(params)}")
        raw = pd.DataFrame(payload["hourly"])
        raw["time"] = pd.to_datetime(raw["time"])
        raw = raw.set_index("time")
        cols = {}
        for col in raw.columns:
            # «wind_speed_100m_previous_day2_ecmwf_ifs025» → «ecmwf_ifs025|wind_speed_100m|d2»
            var, rest = col.split("_previous_day", 1)
            day, model = rest.split("_", 1)
            cols[col] = f"{model}|{var}|d{day}"
        return raw.rename(columns=cols).dropna(axis=1, how="all").astype("float32").sort_index()

    return _cached(("nwp", lat, lon, str(start), str(end)), is_live, load)


# ─── Нурлы: обученная модель через граф агента ────────────────────────────────

_forecaster = None


def forecaster():
    global _forecaster
    if _forecaster is None:
        from windcast.agent.runner import _load_or_train

        _forecaster = _load_or_train()
    return _forecaster


def ml_run(lat: float, lon: float, origin: pd.Timestamp, horizon: int, reason: str) -> dict:
    from windcast.agent import graph
    from windcast.agent.runner import forecast_run_json

    t0 = time.time()
    archive = fetch_window(lat, lon, origin, horizon)
    fetch_ms = int((time.time() - t0) * 1000)
    run = graph.run(forecaster(), origin, horizon, reason=reason, archive=archive)
    doc = forecast_run_json(run, horizon)
    doc["agent_steps"].insert(
        1,
        {
            "agent": "Сборщик погоды",
            "action": f"запрос Open-Meteo Previous Runs для {lat:.3f}, {lon:.3f}",
            "status": "ok",
            "duration_ms": fetch_ms,
            "detail": "",
        },
    )
    doc["live"] = True
    doc["method"] = "ml"
    return doc


# ─── Остальные ВЭС: ансамбль ветра через кривую мощности ─────────────────────


def _curve() -> tuple[np.ndarray, np.ndarray]:
    data = json.loads((MODELS_DIR / "power_curve.json").read_text(encoding="utf-8"))
    return np.asarray(data["ws"], float), np.asarray(data["power"], float)


def curve_run(
    lat: float, lon: float, origin: pd.Timestamp, horizon: int, unit_ids: list[str]
) -> dict:
    t0 = time.time()
    archive = fetch_window(lat, lon, origin, horizon)
    fetch_ms = int((time.time() - t0) * 1000)
    t1 = time.time()
    x = inference_frame(origin, horizon, archive)
    x = x[x["turbine"] == x["turbine"].iloc[0]]
    ws_grid, pw_grid = _curve()

    ws = x["ens_ws100_mean"].to_numpy(float)
    spread = x["ens_ws100_std"].fillna(0).to_numpy(float)
    h = x["horizon_h"].to_numpy(float)
    # Разброс моделей занижает реальную ошибку ветра; добавляем ошибку, растущую с
    # горизонтом (эвристика, не калибровка: истории этой станции у нас нет).
    sigma = np.sqrt(spread**2 + (0.12 * ws + 0.02 * h) ** 2)
    p50 = np.interp(ws, ws_grid, pw_grid)
    p10 = np.interp(np.clip(ws - 1.2816 * sigma, 0, None), ws_grid, pw_grid)
    p90 = np.interp(ws + 1.2816 * sigma, ws_grid, pw_grid)
    missing = int(np.isnan(ws).sum())

    points = []
    for i, t in enumerate(x.index):
        if np.isnan(ws[i]):
            continue
        v = round(float(p50[i]), 4)
        points.append(
            {
                "forecast_for": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "horizon_h": int(h[i]),
                "p10": round(float(min(p10[i], p50[i])), 4),
                "p50": v,
                "p90": round(float(max(p90[i], p50[i])), 4),
                "baseline": None,
                "actual": None,
                "wind_speed": round(float(ws[i]), 2),
                "wind_speed_nwp": round(float(ws[i]), 2),
                "wind_spread": round(float(spread[i]), 2),
                "wind_dir": round(float(x["ens_dir"].iloc[i]), 0),
                "temperature": round(float(x["temp"].iloc[i]), 1),
                "icing_risk": bool(x["icing_risk"].iloc[i] > 0),
                "nwp_day": int(x["nwp_day"].iloc[i]),
                "per_turbine": {u: v for u in unit_ids},
            }
        )
    n_models = int(np.nanmax(x["ens_ws100_n"].to_numpy(float))) if len(x) else 0
    steps = [
        {
            "agent": "Сборщик погоды",
            "action": f"Open-Meteo Previous Runs для {lat:.3f}, {lon:.3f}: "
            f"{n_models} моделей с ветром на 100 м",
            "status": "ok" if n_models >= 2 else "warn",
            "duration_ms": fetch_ms,
        },
        {
            "agent": "Контроль качества",
            "action": f"нет погоды в {missing} ч" if missing else "данные в норме",
            "status": "warn" if missing else "ok",
            "duration_ms": 0,
        },
        {
            "agent": "Прогнозист",
            "action": "ансамбль ветра → кривая мощности (истории турбин этой станции нет, "
            "ML-модель к ней не переносится)",
            "status": "ok",
            "duration_ms": int((time.time() - t1) * 1000),
        },
    ]
    return {
        "forecast_id": f"curve-{lat:.3f}-{lon:.3f}-{origin:%Y%m%d%H}",
        "forecast_origin": origin.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "horizon": horizon,
        "model_version": CURVE_VERSION,
        "weather_provider": "Open-Meteo Previous Runs: " + ", ".join(NWP_MODELS),
        "weather_run": str((origin - pd.Timedelta(hours=6)).floor("6h")),
        "created_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "predictions": points,
        "agent_steps": steps,
        "explanation": (
            f"Прогноз по реальной погоде: среднее {n_models} моделей на высоте 100 м, "
            "пересчитанное через эмпирическую кривую мощности ВЭС Нурлы. "
            "Диапазон P10–P90 — разброс моделей плюс ошибка, растущая с горизонтом."
        ),
        "degraded": missing > 0,
        "live": True,
        "method": "curve",
    }


# ─── СЭС: облачность и радиация через физическую модель ─────────────────────


def solar_run(
    lat: float, lon: float, origin: pd.Timestamp, horizon: int, unit_ids: list[str]
) -> dict:
    """Выработка панелей из прогноза радиации Open-Meteo: P ≈ GHI/1000 · PR · темп. поправка."""
    t0 = time.time()
    lat, lon = round(lat, 3), round(lon, 3)
    start = (origin - pd.Timedelta(hours=1)).date()
    end = (origin + pd.Timedelta(hours=horizon + 1)).date()
    is_live = origin >= now_origin() - pd.Timedelta(hours=6)

    def load() -> pd.DataFrame:
        params = {
            "latitude": lat,
            "longitude": lon,
            "hourly": "shortwave_radiation,cloud_cover,temperature_2m,"
            "wind_speed_10m,wind_direction_10m",
            "start_date": str(start),
            "end_date": str(end),
            "wind_speed_unit": "ms",
            "timezone": "GMT",
        }
        url = FORECAST_URL if is_live else HISTORICAL_URL
        payload = _get_json(f"{url}?{urllib.parse.urlencode(params)}")
        df = pd.DataFrame(payload["hourly"])
        df["time"] = pd.to_datetime(df["time"])
        return df.set_index("time").astype("float32")

    wx = _cached(("pv", lat, lon, str(start), str(end)), is_live, load)
    fetch_ms = int((time.time() - t0) * 1000)
    times = pd.date_range(origin + pd.Timedelta(hours=1), periods=horizon, freq="1h")
    wx = wx.reindex(times)
    points = []
    for h, (t, row) in enumerate(wx.iterrows(), start=1):
        if pd.isna(row["shortwave_radiation"]):
            continue
        ghi = float(row["shortwave_radiation"])
        temp = float(row["temperature_2m"])
        cloud = float(row["cloud_cover"]) / 100
        # 0.85 — типовой performance ratio; −0.4%/°C нагрева модуля выше 25 °C.
        p50 = min(1.0, max(0.0, ghi / 1000 * 0.85 * (1 - 0.004 * (temp + ghi / 40 - 25))))
        spread = p50 * (0.06 + 0.25 * cloud) * (1 + h / 48)
        points.append(
            {
                "forecast_for": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "horizon_h": h,
                "p10": round(max(0.0, p50 - spread), 4),
                "p50": round(p50, 4),
                "p90": round(min(1.0, p50 + spread), 4),
                "baseline": None,
                "actual": None,
                "wind_speed": round(float(row["wind_speed_10m"]), 2),
                "wind_dir": round(float(row["wind_direction_10m"]), 0),
                "temperature": round(temp, 1),
                "cloud_cover": round(cloud, 2),
                "per_turbine": {u: round(p50, 4) for u in unit_ids},
            }
        )
    return {
        "forecast_id": f"pv-{lat:.3f}-{lon:.3f}-{origin:%Y%m%d%H}",
        "forecast_origin": origin.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "horizon": horizon,
        "model_version": SOLAR_VERSION,
        "weather_provider": "Open-Meteo " + ("Forecast" if is_live else "Historical Forecast"),
        "weather_run": str((origin - pd.Timedelta(hours=6)).floor("6h")),
        "created_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "predictions": points,
        "agent_steps": [
            {
                "agent": "Сборщик погоды",
                "action": f"радиация и облачность Open-Meteo для {lat:.3f}, {lon:.3f}",
                "status": "ok",
                "duration_ms": fetch_ms,
            },
            {
                "agent": "Прогнозист",
                "action": "физическая модель панелей: радиация × PR 0.85 × температурная поправка",
                "status": "ok",
                "duration_ms": 0,
            },
        ],
        "explanation": "Выработка панелей из прогноза солнечной радиации и температуры Open-Meteo.",
        "degraded": len(points) < horizon,
        "live": True,
        "method": "solar",
    }


# ─── Сводка по всем станциям: один запрос на все точки ───────────────────────


def curve_overview(sites: list[tuple[float, float]], horizon: int = 48) -> list[dict]:
    """Ветер на 100 м по всем точкам одним запросом Open-Meteo Forecast (best_match).

    Previous Runs по 36 станциям — это 36 тяжёлых запросов по 5–10 с; для сводки
    хватает свежего выпуска, а подробный прогноз станции считается отдельно.
    """
    if not sites:
        return []
    origin = now_origin()
    key = ("overview", tuple((round(a, 3), round(b, 3)) for a, b in sites), str(origin), horizon)

    def load() -> pd.DataFrame:
        params = {
            "latitude": ",".join(f"{a:.3f}" for a, _ in sites),
            "longitude": ",".join(f"{b:.3f}" for _, b in sites),
            "hourly": "wind_speed_100m,wind_direction_100m,temperature_2m",
            "forecast_days": 4,
            "wind_speed_unit": "ms",
            "timezone": "GMT",
        }
        payload = _get_json(f"{FORECAST_URL}?{urllib.parse.urlencode(params)}")
        payload = payload if isinstance(payload, list) else [payload]
        frames = []
        for i, loc in enumerate(payload):
            df = pd.DataFrame(loc["hourly"])
            df["time"] = pd.to_datetime(df["time"])
            df["site"] = i
            frames.append(df)
        return pd.concat(frames)

    wx = _cached(key, True, load)
    ws_grid, pw_grid = _curve()
    times = pd.date_range(origin + pd.Timedelta(hours=1), periods=horizon, freq="1h")
    out = []
    for i in range(len(sites)):
        d = wx[wx["site"] == i].set_index("time").reindex(times)
        ws = d["wind_speed_100m"].to_numpy(float)
        out.append(
            {
                "times": [t.strftime("%Y-%m-%dT%H:%M:%SZ") for t in times],
                "wind_speed": [None if np.isnan(v) else round(float(v), 2) for v in ws],
                "wind_dir": [
                    None if np.isnan(v) else round(float(v)) for v in d["wind_direction_100m"]
                ],
                "p50": [
                    None if np.isnan(v) else round(float(np.interp(v, ws_grid, pw_grid)), 4)
                    for v in ws
                ],
            }
        )
    return out


_ml_cache: dict[tuple, tuple[float, dict]] = {}


def ml_run_cached(lat: float, lon: float, origin: pd.Timestamp, horizon: int, reason: str) -> dict:
    key = (round(lat, 3), round(lon, 3), str(origin), horizon)
    hit = _ml_cache.get(key)
    if hit and time.time() - hit[0] < LIVE_TTL_S:
        return hit[1]
    doc = ml_run(lat, lon, origin, horizon, reason)
    if len(_ml_cache) > 64:
        _ml_cache.clear()
    _ml_cache[key] = (time.time(), doc)
    return doc
