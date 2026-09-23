"""Почасовой ветер у станции из Open-Meteo: сила, направление, порывы, сдвиг по высоте.

Модель прогноза мощности берёт только скорость на 100 м; оператору же нужно видеть,
откуда дует, какие порывы и насколько ветер у земли отличается от ветра у ротора.

Проверка проекта не должна зависеть от внешних API (п. 5.6.6), поэтому тестовый
период станции кейса лежит снимком в data/wind_snapshot.json — его собирает
`python -m app.wind.weather`. Остальное запрашивается на лету и кэшируется.
"""

import json
import math
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from app.config import settings

VARIABLES = (
    "wind_speed_10m",
    "wind_speed_100m",
    "wind_direction_10m",
    "wind_direction_100m",
    "wind_gusts_10m",
    "temperature_2m",
)
SNAPSHOT = Path(__file__).parent / "data" / "wind_snapshot.json"
# Архив прогнозов догоняет реальное время с задержкой; свежее берём из обычного API.
ARCHIVE_LAG = timedelta(days=3)

_cache: dict[tuple, tuple[float, list[dict]]] = {}


def _snapshot() -> dict:
    try:
        return json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def beaufort(v: float) -> int:
    # Границы шкалы Бофорта в м/с (ВМО).
    edges = (0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7)
    return next((i for i, e in enumerate(edges) if v < e), 12)


def shear_alpha(v10: float | None, v100: float | None) -> float | None:
    """Показатель степенного профиля: v(h) ∝ h^α. Над ровной степью ≈ 0.14."""
    if not v10 or not v100 or v10 < 0.5:
        return None
    return round(math.log(v100 / v10) / math.log(10), 2)


def _rows(payload: dict) -> list[dict]:
    h = payload["hourly"]
    out = []
    for i, ts in enumerate(h["time"]):
        v10, v100 = h["wind_speed_10m"][i], h["wind_speed_100m"][i]
        if v100 is None:
            continue
        out.append(
            {
                "time": f"{ts}:00Z" if len(ts) == 16 else ts,
                "speed_10m": v10,
                "speed_100m": v100,
                "dir_10m": h["wind_direction_10m"][i],
                "dir_100m": h["wind_direction_100m"][i],
                "gust_10m": h["wind_gusts_10m"][i],
                "temperature": h["temperature_2m"][i],
                "beaufort": beaufort(v100),
                "shear_alpha": shear_alpha(v10, v100),
            }
        )
    return out


def fetch(lat: float, lon: float, start: datetime, hours: int) -> tuple[list[dict], str]:
    end = start + timedelta(hours=hours - 1)
    archive = end < datetime.now(UTC).replace(tzinfo=None) - ARCHIVE_LAG
    url = settings.WEATHER_ARCHIVE_URL if archive else settings.WEATHER_FORECAST_URL
    params = {
        "latitude": round(lat, 4),
        "longitude": round(lon, 4),
        "hourly": ",".join(VARIABLES),
        "wind_speed_unit": "ms",
        "timezone": "GMT",
        "start_hour": start.strftime("%Y-%m-%dT%H:%M"),
        "end_hour": end.strftime("%Y-%m-%dT%H:%M"),
    }
    key = (url, *params.values())
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < settings.WEATHER_CACHE_SECONDS:
        return hit[1], "archive" if archive else "forecast"
    resp = httpx.get(url, params=params, timeout=settings.WEATHER_TIMEOUT)
    resp.raise_for_status()
    rows = _rows(resp.json())
    _cache[key] = (time.monotonic(), rows)
    return rows, "archive" if archive else "forecast"


def from_snapshot(station_id: str, start: datetime, hours: int) -> list[dict] | None:
    rows = _snapshot().get(station_id)
    if not rows:
        return None
    lo = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    hi = (start + timedelta(hours=hours - 1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    picked = [r for r in rows if lo <= r["time"] <= hi]
    return picked if len(picked) == hours else None


def build_snapshot() -> None:
    """Тестовый период кейса (31.01–01.03.2026) для ВЭС Нурлы — в репозиторий."""
    catalog = json.loads((Path(__file__).parent / "data" / "kz_wind_farms.json").read_text())
    farm = next(f for f in catalog["farms"] if f["id"] == "nurly")
    start = datetime(2026, 1, 31, 1)
    rows, _ = fetch(farm["lat"], farm["lon"], start, 30 * 24)
    SNAPSHOT.write_text(json.dumps({"nurly": rows}, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(rows)} часов → {SNAPSHOT}")


if __name__ == "__main__":
    build_snapshot()
