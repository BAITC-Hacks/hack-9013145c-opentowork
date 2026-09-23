"""Ветер у станции в настоящий момент: расчёт модели и измерение ближайшей метеостанции.

Почасовой прогноз (station_weather) отвечает на вопрос «что будет»; оператору и
проверяющему нужно ещё «что сейчас» — чтобы сверить направление с реальностью.

- Open-Meteo `current` — текущее состояние погодной модели, шаг 15 минут, ветер на 10
  и 100 м. Это расчёт, а не измерение, зато в точке самой станции.
- METAR (NOAA aviationweather.gov) — измерения на аэродромах: ветер на 10 м, осреднение
  10 минут, выпуск раз в 30–60 минут. Ближайший аэродром бывает в десятках-сотнях км,
  поэтому расстояние возвращается вместе с данными.

Оба источника бесплатны и без ключа. Ответы кэшируются, чтобы не упираться в лимиты.
"""

import math
import time
from datetime import UTC, datetime

import httpx

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
METAR_URL = "https://aviationweather.gov/api/data/metar"
KNOT_MS = 0.514444
# Дальше этого аэродром уже не описывает ветер у станции — не показываем.
METAR_MAX_KM = 250
METAR_BOX_DEG = 3.0
MODEL_TTL_S = 300
METAR_TTL_S = 600

_cache: dict[tuple, tuple[float, object]] = {}


def _cached(key: tuple, ttl: float, fetch):
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    value = fetch()
    _cache[key] = (time.monotonic(), value)
    return value


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def parse_current(payload: dict) -> dict:
    c = payload["current"]
    return {
        "time": c["time"] + "Z",
        "wind_speed_10m": c.get("wind_speed_10m"),
        "wind_dir_10m": c.get("wind_direction_10m"),
        "wind_gusts_10m": c.get("wind_gusts_10m"),
        "wind_speed_100m": c.get("wind_speed_100m"),
        "wind_dir_100m": c.get("wind_direction_100m"),
        "grid_lat": payload.get("latitude"),
        "grid_lon": payload.get("longitude"),
    }


def model_now(lat: float, lon: float) -> dict:
    def fetch() -> dict:
        r = httpx.get(OPEN_METEO_URL, timeout=15, params={
            "latitude": lat,
            "longitude": lon,
            "current": "wind_speed_10m,wind_direction_10m,wind_gusts_10m,"
                       "wind_speed_100m,wind_direction_100m",
            "wind_speed_unit": "ms",
            "timezone": "GMT",
        })
        r.raise_for_status()
        return parse_current(r.json())

    return _cached(("model", round(lat, 3), round(lon, 3)), MODEL_TTL_S, fetch)


def nearest_observation(reports: list[dict], lat: float, lon: float) -> dict | None:
    """Ближайший аэродром с числовым направлением ветра (VRB и штиль без направления — мимо)."""
    best = None
    for m in reports:
        wdir, wspd = m.get("wdir"), m.get("wspd")
        if not isinstance(wdir, int | float) or not isinstance(wspd, int | float):
            continue
        if m.get("lat") is None or m.get("lon") is None:
            continue
        km = haversine_km(lat, lon, m["lat"], m["lon"])
        if km <= METAR_MAX_KM and (best is None or km < best[0]):
            best = (km, m)
    if best is None:
        return None
    km, m = best
    gust = m.get("wgst")
    return {
        "icao": m.get("icaoId"),
        "name": m.get("name"),
        "distance_km": round(km, 1),
        "time": m.get("reportTime") or m.get("obsTime"),
        "wind_dir_10m": float(m["wdir"]),
        "wind_speed_10m": round(m["wspd"] * KNOT_MS, 1),
        "wind_gusts_10m": round(gust * KNOT_MS, 1) if isinstance(gust, int | float) else None,
        "raw": m.get("rawOb"),
    }


def observed_now(lat: float, lon: float) -> dict | None:
    def fetch() -> list[dict]:
        d = METAR_BOX_DEG
        r = httpx.get(METAR_URL, timeout=15, params={
            "bbox": f"{lat - d},{lon - d * 1.5},{lat + d},{lon + d * 1.5}",
            "format": "json",
        })
        r.raise_for_status()
        return r.json() if r.content else []

    reports = _cached(("metar", round(lat, 1), round(lon, 1)), METAR_TTL_S, fetch)
    return nearest_observation(reports, lat, lon)


def wind_now(lat: float, lon: float) -> dict:
    """Оба источника; сбой одного не роняет другой."""
    out: dict = {"retrieved_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")}
    try:
        out["model"] = model_now(lat, lon)
    except (httpx.HTTPError, KeyError, ValueError):
        out["model"] = None
    try:
        out["observed"] = observed_now(lat, lon)
    except (httpx.HTTPError, KeyError, ValueError):
        out["observed"] = None
    return out
