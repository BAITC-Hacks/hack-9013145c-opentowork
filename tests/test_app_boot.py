"""Проверяет, что приложение вообще импортируется и стартует.

Этот тест ловит класс ошибок, невидимый для юнит-тестов бизнес-логики:
опечатки в конфигурации логгера, отсутствующие зависимости, битые импорты
роутеров. Без него такие поломки обнаруживаются только при docker compose up.
"""

from fastapi.testclient import TestClient


def test_logging_setup_does_not_raise():
    from app.observability import setup_logging

    setup_logging()


def test_app_imports_and_exposes_routes():
    from app.main import app

    paths = set(app.openapi()["paths"])
    for expected in (
        "/health",
        "/ready",
        "/metrics",
        "/api/v1/auth/login",
        "/api/v1/ai/chat",
        "/api/v1/analysis",
        "/api/v1/jobs/{job_id}",
        "/api/v1/knowledge/search",
    ):
        assert expected in paths, f"route missing: {expected}"


def test_health_endpoint_returns_ok():
    from app.main import app

    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"


def test_metrics_endpoint_exposes_prometheus_format():
    from app.main import app

    with TestClient(app) as client:
        response = client.get("/metrics")
        assert response.status_code == 200
        assert "ai_cache_hits_total" in response.text


def test_unauthenticated_request_is_rejected():
    from app.main import app

    with TestClient(app) as client:
        response = client.get("/api/v1/entities")
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "UNAUTHORIZED"


def test_new_demo_endpoints_are_exposed():
    from app.main import app

    paths = set(app.openapi()["paths"])
    for expected in ("/api/v1/ai/stats", "/api/v1/ai/feedback"):
        assert expected in paths, f"route missing: {expected}"


def test_entity_cursor_roundtrip():
    """Курсор пагинации должен переживать кодирование и расшифровываться обратно."""
    import uuid
    from datetime import UTC, datetime

    from app.api.v1.entities import _decode_cursor, _encode_cursor

    class Fake:
        created_at = datetime(2026, 9, 23, 13, 0, tzinfo=UTC)
        id = uuid.uuid4()

    created_at, entity_id = _decode_cursor(_encode_cursor(Fake()))
    assert created_at == Fake.created_at
    assert entity_id == Fake.id


def test_invalid_cursor_is_rejected_cleanly():
    from app.api.v1.entities import _decode_cursor
    from app.errors import ValidationFailed

    try:
        _decode_cursor("не-курсор")
    except ValidationFailed:
        return
    raise AssertionError("битый курсор должен давать ValidationFailed")
