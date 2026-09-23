"""Physical and API invariants; tests do not use a database or external weather."""

from datetime import UTC, datetime, timedelta

import httpx
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.v1 import wind
from app.config import settings
from app.deps import current_user, get_session
from app.errors import ServiceUnavailable, register_error_handlers
from app.wind import weather as provider
from app.wind.model import hub_weather, simulate, turbine_power
from app.wind.schemas import SimulationRequest, WeatherForecast, WeatherHour
from app.wind.turbines import turbine_catalog

START = datetime(2026, 9, 24, tzinfo=UTC)


def weather(speed=8.0, hours=48):
    return WeatherForecast(
        retrieved_at=START - timedelta(hours=1),
        grid_latitude=51.6, grid_longitude=73.1, elevation_m=450,
        hours=[WeatherHour(
            time=START + timedelta(hours=i), wind_10m_ms=speed, wind_80m_ms=speed,
            wind_120m_ms=speed, wind_180m_ms=speed,
            temperature_2m_c=15, surface_pressure_hpa=1013.25,
        ) for i in range(hours)],
    )


def request(**changes):
    return SimulationRequest(**{
        "latitude": 51.62, "longitude": 73.1, "turbine_id": turbine_catalog()[0].id,
        **changes,
    })


@pytest.mark.parametrize("turbine", turbine_catalog(), ids=lambda t: t.id)
def test_curve_preserves_reference_values_and_actual_wind_shutdown(turbine):
    speed, expected = next((v, p) for v, p in turbine.curve if v == 8)
    result = turbine_power(turbine, np.array([speed]), np.array([1.225]))
    assert result[0] == pytest.approx(expected)
    for density in [0.8, 1.225, 1.5]:
        actual = turbine_power(turbine, np.array([0, 18, turbine.high_wind_zero_ms, 40.]),
                               np.full(4, density))
        assert actual[0] == 0
        assert 0 < actual[1] <= turbine.rated_power_kw
        assert actual[2] == actual[3] == 0


def test_density_affects_subrated_output_and_height_uses_weather_levels():
    turbine = turbine_catalog()[0]
    power = turbine_power(turbine, np.array([6., 6.]), np.array([1., 1.3]))
    assert power[1] > power[0]
    hour = weather().hours[0].model_copy(update={"wind_80m_ms": 6, "wind_120m_ms": 10})
    assert hub_weather(hour, 80)[0] == 6
    assert hub_weather(hour, 120)[0] == 10
    assert 6 < hub_weather(hour, 100)[0] < 10
    assert hub_weather(hour, 120)[1] < hub_weather(hour, 80)[1]


def test_energy_units_losses_and_period():
    result = simulate(request(loss_percent=10), weather())
    assert len(result.hours) == 48
    assert result.forecast_end - result.forecast_start == timedelta(hours=48)
    assert result.net_energy_kwh == pytest.approx(sum(h.energy_kwh for h in result.hours))
    assert result.net_energy_kwh == pytest.approx(result.gross_energy_kwh * 0.9, abs=0.05)
    assert result.capacity_factor == pytest.approx(
        result.net_energy_kwh / (48 * result.turbine.rated_power_kw), abs=0.00001
    )
    assert result.calibrated is False
    assert result.weather_run_issued_at is None
    assert simulate(request(), weather(0)).net_energy_kwh == 0


def test_incomplete_or_gapped_weather_is_not_silently_zero_filled():
    with pytest.raises(ValueError):
        simulate(request(), weather(hours=47))
    data = weather()
    data.hours[2].time += timedelta(hours=1)
    with pytest.raises(ValueError):
        simulate(request(), data)


def payload(start=START, hours=48):
    data = weather(hours=hours)
    return {
        "latitude": 51.6, "longitude": 73.1, "elevation": 450, "utc_offset_seconds": 0,
        "hourly_units": {v: unit for v, (_, unit) in provider.VARIABLES.items()},
        "hourly": {
            "time": [(start + timedelta(hours=i)).isoformat() for i in range(hours)],
            **{v: [getattr(h, name) for h in data.hours]
               for v, (name, _) in provider.VARIABLES.items()},
        },
    }


@pytest.mark.parametrize("fault", ["null", "unit", "gap", "duplicate", "short", "nan"])
def test_provider_rejects_incomplete_or_mislabelled_data(fault):
    data = payload()
    if fault == "null":
        data["hourly"]["wind_speed_80m"][5] = None
    elif fault == "nan":
        data["hourly"]["wind_speed_80m"][5] = float("nan")
    elif fault == "unit":
        data["hourly_units"]["wind_speed_80m"] = "km/h"
    elif fault == "gap":
        data["hourly"]["time"][4] = (START + timedelta(days=3)).isoformat()
    elif fault == "duplicate":
        data["hourly"]["time"][4] = data["hourly"]["time"][3]
    else:
        data["hourly"]["surface_pressure"].pop()
    with pytest.raises((ValueError, KeyError, ValidationError)):
        provider.parse_weather(data, START, 48, START)


async def test_weather_cache_and_failure(monkeypatch):
    provider._cache.clear()
    calls = []

    def handle(req):
        calls.append(req)
        assert req.url.params["wind_speed_unit"] == "ms"
        assert req.url.params["timezone"] == "GMT"
        return httpx.Response(200, json=payload(provider.next_hour(datetime.now(UTC))))

    original = httpx.AsyncClient
    monkeypatch.setattr(provider.httpx, "AsyncClient", lambda **kw: original(
        transport=httpx.MockTransport(handle), **kw
    ))
    first = await provider.fetch_weather(51.62, 73.1, 48)
    second = await provider.fetch_weather(51.62, 73.1, 48)
    assert first == second and len(calls) == 1
    await provider.fetch_weather(50, 73.1, 48)
    assert len(calls) == 2
    monkeypatch.setattr(settings, "WIND_WEATHER_CACHE_SIZE", 1)
    await provider.fetch_weather(49, 73.1, 48)
    assert len(provider._cache) == 1
    provider._cache.clear()
    monkeypatch.setattr(provider.httpx, "AsyncClient", lambda **kw: original(
        transport=httpx.MockTransport(lambda req: httpx.Response(503)), **kw
    ))
    with pytest.raises(ServiceUnavailable):
        await provider.fetch_weather(51.62, 73.1, 48)
    assert not provider._cache


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(wind.router, prefix="/api/v1")
    register_error_handlers(app)
    app.dependency_overrides[current_user] = lambda: object()

    async def forecast(*args):
        return weather(hours=args[2])

    monkeypatch.setattr(wind, "fetch_weather", forecast)
    with TestClient(app) as test_client:
        yield test_client


def test_api_catalog_and_simulate(client):
    catalog = client.get("/api/v1/wind/turbine-models")
    assert catalog.status_code == 200 and len(catalog.json()) == 3
    result = client.post("/api/v1/wind/simulate", json=request().model_dump())
    assert result.status_code == 200
    assert len(result.json()["hours"]) == 48
    assert result.json()["net_energy_kwh"] > 0
    body = request(horizon_hours=24).model_dump()
    result = client.post("/api/v1/wind/simulate", json=body)
    assert len(result.json()["hours"]) == 24


@pytest.mark.parametrize("changes,status", [
    ({"latitude": 91}, 422), ({"longitude": -181}, 422),
    ({"loss_percent": 101}, 422), ({"hub_height_m": 100}, 422),
    ({"horizon_hours": 8760}, 422), ({"turbine_id": "missing"}, 404),
    ({"latitude": "nan"}, 422), ({"origin": "2026-02-01"}, 422),
])
def test_api_input_errors(client, changes, status):
    body = request().model_dump() | changes
    response = client.post("/api/v1/wind/simulate", json=body)
    assert response.status_code == status
    assert "request_id" in response.json()["error"]


def test_api_failure_is_not_a_demo_forecast(client, monkeypatch):
    async def unavailable(*args):
        raise ServiceUnavailable("Weather unavailable")

    monkeypatch.setattr(wind, "fetch_weather", unavailable)
    response = client.post("/api/v1/wind/simulate", json=request().model_dump())
    assert response.status_code == 503
    assert "hours" not in response.json()


def test_api_requires_authentication(client):
    client.app.dependency_overrides.pop(current_user)
    client.app.dependency_overrides[get_session] = lambda: None
    assert client.get("/api/v1/wind/turbine-models").status_code == 401
    assert client.post("/api/v1/wind/simulate", json=request().model_dump()).status_code == 401
