"""Эндпоинты прогноза отдают артефакты агента в контракте фронтенда. Без БД и ML-стека."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import forecast
from app.errors import AppError
from windcast.config import FORECASTS_DIR, REPORTS_DIR


@pytest.fixture(scope="module")
def client():
    app = FastAPI()

    @app.exception_handler(AppError)
    async def _app_error(_, exc: AppError):
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=exc.http_status, content={"code": exc.code})

    app.include_router(forecast.router, prefix="/api/v1")
    return TestClient(app)


def test_turbines(client):
    r = client.get("/api/v1/turbines")
    assert r.status_code == 200
    assert {t["id"] for t in r.json()} == {"T1", "T2"}


def test_origin_normalization():
    assert forecast._normalize_origin("2026-02-07") == "2026-02-07T00:00:00Z"
    assert forecast._normalize_origin("2026-02-07T00:00:00.000Z") == "2026-02-07T00:00:00Z"
    assert forecast._normalize_origin("2026-02-07 06:00") == "2026-02-07T06:00:00Z"


@pytest.mark.skipif(not (REPORTS_DIR / "backtest_frontend.json").exists(), reason="нет бэктеста")
def test_metrics_shape(client):
    body = client.get("/api/v1/metrics").json()
    assert {"period", "metrics", "daily", "by_horizon"} <= body.keys()
    assert any(m["selected"] for m in body["metrics"])
    assert len(body["by_horizon"]) == 48


@pytest.mark.skipif(not (FORECASTS_DIR / "2026-02-07.json").exists(), reason="нет прогона агента")
def test_test_period_forecast_has_agent_trace(client):
    body = client.get("/api/v1/forecast/latest", params={"origin": "2026-02-07T00:00:00"}).json()
    assert body["forecast_origin"] == "2026-02-07T00:00:00Z"
    assert len(body["predictions"]) == 48
    p = body["predictions"][0]
    assert p["p10"] <= p["p50"] <= p["p90"]
    assert body["agent_steps"] and body["explanation"]
    assert body["versions"][0]["forecast_origin"] == "2026-02-07T00:00:00Z"


@pytest.mark.skipif(not (FORECASTS_DIR / "backtest_runs.json").exists(), reason="нет бэктеста")
def test_backtest_origin_has_actuals(client):
    body = client.get("/api/v1/forecast/latest", params={"origin": "2025-12-15"}).json()
    assert body["backtest"] is True
    assert any(p["actual"] is not None for p in body["predictions"])


def test_unknown_origin_is_404(client):
    r = client.get("/api/v1/forecast/latest", params={"origin": "2019-01-01"})
    assert r.status_code == 404


def test_invalid_date_is_422(client):
    assert client.get("/api/v1/forecast/latest", params={"origin": "../bad"}).status_code == 422


def test_other_station_cannot_receive_nurly_model(client):
    assert client.get("/api/v1/forecast/latest", params={
        "origin": "2026-02-07", "station_id": "other",
    }).status_code == 404


def test_horizon_is_respected_without_mutating_saved_run(client, monkeypatch):
    monkeypatch.setenv("WINDCAST_LIVE", "0")
    short = client.post("/api/v1/forecast/run", json={
        "forecast_origin": "2026-02-07", "horizon": 24,
    }).json()
    assert short["horizon"] == len(short["predictions"]) == 24
    full = client.get("/api/v1/forecast/latest", params={"origin": "2026-02-07"}).json()
    assert full["horizon"] == len(full["predictions"]) == 48


def test_origin_offset_is_converted_to_utc():
    assert forecast._normalize_origin("2026-02-07T05:00:00+05:00") == "2026-02-07T00:00:00Z"


BIDS = FORECASTS_DIR.parent / "bids"


@pytest.mark.skipif(not (BIDS / "2026-02-07").exists(), reason="нет черновиков заявок")
def test_bid_download(client):
    body = client.get("/api/v1/bids/2026-02-07").json()
    assert body["operational_day"] == "2026-02-07" and len(body["hours"]) == 24
    r = client.get("/api/v1/bids/2026-02-07/file", params={"format": "pdf"})
    assert r.status_code == 200 and r.content[:4] == b"%PDF"
    assert client.get("/api/v1/bids/2026-02-07/file", params={"format": "exe"}).status_code == 422
    assert client.get("/api/v1/bids/..%2F..%2Fetc/file").status_code == 404


EXPLAIN = FORECASTS_DIR.parent / "explain"


@pytest.mark.skipif(not (EXPLAIN / "2026-02-07.json").exists(), reason="нет объяснений")
def test_explain_endpoint(client):
    body = client.get("/api/v1/explain", params={"origin": "2026-02-07T06:00:00"}).json()
    assert body["origin"] == "2026-02-07T06:00:00Z"
    assert len(body["hours"]) == 42 and body["summary"]
    assert body["revision"]["summary"]
    assert [v["origin"][11:16] for v in body["versions"]][0] == "00:00"
    g = client.get("/api/v1/explain/global").json()
    assert g["weather_models"] and g["power_curve"]["curves"]
    other = client.get("/api/v1/explain", params={"origin": "2026-02-07", "station_id": "x"})
    assert other.status_code == 404
