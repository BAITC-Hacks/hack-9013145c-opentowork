from collections import OrderedDict
from datetime import UTC, datetime, timedelta
from time import monotonic

import httpx
from pydantic import ValidationError

from app.config import settings
from app.errors import ServiceUnavailable
from app.wind.schemas import WeatherForecast, WeatherHour

VARIABLES = {
    "wind_speed_10m": ("wind_10m_ms", "m/s"),
    "wind_speed_80m": ("wind_80m_ms", "m/s"),
    "wind_speed_120m": ("wind_120m_ms", "m/s"),
    "wind_speed_180m": ("wind_180m_ms", "m/s"),
    "temperature_2m": ("temperature_2m_c", "°C"),
    "surface_pressure": ("surface_pressure_hpa", "hPa"),
}
_cache: OrderedDict[tuple, tuple[float, WeatherForecast]] = OrderedDict()


def next_hour(now: datetime) -> datetime:
    # Always start with a complete future hour, even when called exactly at HH:00.
    return now.astimezone(UTC).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)


def parse_weather(
    payload: dict, start: datetime, horizon: int, retrieved_at: datetime
) -> WeatherForecast:
    hourly = payload["hourly"]
    units = payload["hourly_units"]
    if payload.get("utc_offset_seconds") != 0:
        raise ValueError("Weather must be in UTC")
    for variable, (_, expected) in VARIABLES.items():
        if units.get(variable) != expected:
            raise ValueError(f"Unexpected unit for {variable}")
        if len(hourly[variable]) != len(hourly["time"]):
            raise ValueError("Unequal weather array lengths")
    indices: dict[datetime, int] = {}
    for i, raw in enumerate(hourly["time"]):
        time = datetime.fromisoformat(raw)
        time = time.replace(tzinfo=UTC) if time.tzinfo is None else time.astimezone(UTC)
        if time in indices:
            raise ValueError("Duplicate weather hour")
        indices[time] = i
    hours = []
    for offset in range(horizon):
        time = start + timedelta(hours=offset)
        index = indices[time]
        hours.append(WeatherHour(time=time, **{
            name: hourly[variable][index] for variable, (name, _) in VARIABLES.items()
        }))
    return WeatherForecast(
        retrieved_at=retrieved_at,
        grid_latitude=payload["latitude"],
        grid_longitude=payload["longitude"],
        elevation_m=payload["elevation"],
        hours=hours,
    )


async def fetch_weather(latitude: float, longitude: float, horizon: int) -> WeatherForecast:
    now = datetime.now(UTC)
    start = next_hour(now)
    key = (latitude, longitude, start, horizon)
    cached = _cache.get(key)
    if cached and monotonic() - cached[0] < settings.WIND_WEATHER_CACHE_TTL_S:
        _cache.move_to_end(key)
        return cached[1]
    try:
        async with httpx.AsyncClient(timeout=settings.WIND_WEATHER_TIMEOUT_S) as client:
            response = await client.get(settings.WIND_WEATHER_URL, params={
                "latitude": latitude,
                "longitude": longitude,
                "hourly": ",".join(VARIABLES),
                "wind_speed_unit": "ms",
                "temperature_unit": "celsius",
                "timezone": "GMT",
                "forecast_days": 4,
            })
            response.raise_for_status()
            result = parse_weather(response.json(), start, horizon, datetime.now(UTC))
    except (httpx.HTTPError, ValueError, KeyError, TypeError, IndexError, ValidationError) as exc:
        raise ServiceUnavailable(
            "Не удалось получить полный прогноз погоды. Повторите расчёт позже."
        ) from exc
    _cache[key] = (monotonic(), result)
    _cache.move_to_end(key)
    while len(_cache) > max(0, settings.WIND_WEATHER_CACHE_SIZE):
        _cache.popitem(last=False)
    return result
