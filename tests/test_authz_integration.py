"""Интеграционные проверки границ доступа — с настоящей базой.

Запускаются только при доступной БД, поэтому быстрый CI они не тормозят:

    make test-integration          # внутри поднятого стека
    pytest tests/test_authz_integration.py

Это те проверки, которые отвечают на вопрос «а как вы убедились, что
пользователь не прочитает чужое». Раньше их не было ни одной.
"""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

pytestmark = pytest.mark.integration


@pytest.fixture
async def client():
    """Клиент к приложению поверх настоящей базы.

    Фикстура пофункциональная намеренно: pytest-asyncio даёт каждому тесту
    собственный event loop, а пул соединений SQLAlchemy и клиент Redis
    привязываются к тому loop, в котором были созданы. Общая на модуль
    фикстура падала с «attached to a different loop» на втором тесте.
    """
    from sqlalchemy import text

    from app.db import engine
    from app.deps import close_redis
    from app.main import app

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 — причина неважна, важна доступность
        pytest.skip(f"база недоступна, интеграционные тесты пропущены: {exc}")

    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        await engine.dispose()
        await close_redis()


def _fake_ip() -> str:
    """Свой адрес на каждую регистрацию.

    Регистрация ограничена по источнику, а все тесты приходят с одного и того
    же адреса — без этого они упирались в собственный rate limit. Заодно
    проверяется, что ограничение действительно считает по X-Forwarded-For.
    """
    n = uuid.uuid4().int
    return f"203.0.113.{n % 254 + 1}" if n % 2 else f"198.51.100.{n % 254 + 1}"


async def _register(client: AsyncClient) -> tuple[str, str]:
    """Создаёт нового пользователя и возвращает его токен и email."""
    # Не .test/.local: email-validator отклоняет зарезервированные домены.
    email = f"probe-{uuid.uuid4().hex[:12]}@hackalem-probe.kz"
    response = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Passw0rd!-test", "full_name": "T"},
        headers={"X-Forwarded-For": _fake_ip()},
    )
    assert response.status_code == 201, response.text
    return response.json()["access_token"], email


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def test_user_cannot_read_foreign_entity(client):
    token_a, _ = await _register(client)
    token_b, _ = await _register(client)

    created = await client.post(
        "/api/v1/entities", json={"name": "секретный объект"}, headers=_auth(token_a)
    )
    assert created.status_code == 201
    entity_id = created.json()["id"]

    own = await client.get(f"/api/v1/entities/{entity_id}", headers=_auth(token_a))
    assert own.status_code == 200

    foreign = await client.get(f"/api/v1/entities/{entity_id}", headers=_auth(token_b))
    assert foreign.status_code == 403, "чужой объект не должен читаться"


async def test_foreign_entity_is_absent_from_listing(client):
    token_a, _ = await _register(client)
    token_b, _ = await _register(client)

    await client.post(
        "/api/v1/entities", json={"name": "только для A"}, headers=_auth(token_a)
    )
    listing = await client.get("/api/v1/entities", headers=_auth(token_b))
    assert listing.status_code == 200
    assert listing.json()["items"] == []


async def test_user_cannot_read_foreign_job(client):
    token_a, _ = await _register(client)
    token_b, _ = await _register(client)

    created = await client.post(
        "/api/v1/analysis",
        json={"type": "authz_probe", "payload": {"query": "проверка"}},
        headers=_auth(token_a),
    )
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]

    foreign = await client.get(f"/api/v1/jobs/{job_id}", headers=_auth(token_b))
    assert foreign.status_code == 403


async def test_idempotency_key_is_scoped_to_user(client):
    """Один и тот же ключ у разных пользователей — разные задачи, а не чужая."""
    token_a, _ = await _register(client)
    token_b, _ = await _register(client)
    key = f"probe-{uuid.uuid4().hex[:8]}"

    first = await client.post(
        "/api/v1/analysis",
        json={"type": "authz_probe", "payload": {}},
        headers={**_auth(token_a), "Idempotency-Key": key},
    )
    second = await client.post(
        "/api/v1/analysis",
        json={"type": "authz_probe", "payload": {}},
        headers={**_auth(token_b), "Idempotency-Key": key},
    )
    assert first.status_code == 202 and second.status_code == 202
    assert first.json()["job_id"] != second.json()["job_id"]


async def test_repeated_idempotency_key_returns_same_job(client):
    token, _ = await _register(client)
    key = f"probe-{uuid.uuid4().hex[:8]}"
    headers = {**_auth(token), "Idempotency-Key": key}

    first = await client.post(
        "/api/v1/analysis", json={"type": "authz_probe", "payload": {}}, headers=headers
    )
    second = await client.post(
        "/api/v1/analysis", json={"type": "authz_probe", "payload": {}}, headers=headers
    )
    assert first.json()["job_id"] == second.json()["job_id"]


async def _login_demo(client: AsyncClient) -> str | None:
    """Токен демо-учётки: только у неё есть роль EXPERT для загрузки документов."""
    from app.config import settings

    response = await client.post(
        "/api/v1/auth/login",
        json={
            "email": settings.DEMO_USER_EMAIL,
            "password": settings.DEMO_USER_PASSWORD,
        },
        headers={"X-Forwarded-For": _fake_ip()},
    )
    return response.json()["access_token"] if response.status_code == 200 else None


async def test_private_document_is_invisible_to_others(client):
    """Личный документ не должен попадать ни в поиск, ни в контекст ответа."""
    expert_token = await _login_demo(client)
    if expert_token is None:
        pytest.skip("демо-учётка отсутствует (SEED_ON_START=false)")
    other_token, _ = await _register(client)

    marker = f"кодовоеслово{uuid.uuid4().hex[:8]}"
    created = await client.post(
        "/api/v1/knowledge/documents",
        json={
            "title": "Личная записка",
            "content": f"Совершенно секретно. {marker} упоминается только здесь.",
            "visibility": "private",
        },
        headers=_auth(expert_token),
    )
    assert created.status_code == 201, created.text

    own = await client.get(
        f"/api/v1/knowledge/search?q={marker}", headers=_auth(expert_token)
    )
    foreign = await client.get(
        f"/api/v1/knowledge/search?q={marker}", headers=_auth(other_token)
    )
    assert own.status_code == 200
    assert foreign.status_code == 200
    assert foreign.json() == [], "личный документ виден чужому пользователю"


async def test_regular_user_cannot_publish_to_knowledge_base(client):
    """Наполнять общую базу знаний может только EXPERT и выше."""
    token, _ = await _register(client)
    response = await client.post(
        "/api/v1/knowledge/documents",
        json={"title": "Подделка", "content": "текст", "visibility": "public"},
        headers=_auth(token),
    )
    assert response.status_code == 403


async def test_cache_does_not_leak_between_users(client):
    """Ответ, собранный для одного пользователя, не отдаётся другому.

    При SEMANTIC_CACHE_SCOPE=user владелец входит в ключ кэша, поэтому второй
    пользователь обязан получить живой ответ, а не попадание в кэш.
    """
    from app.config import settings

    if settings.SEMANTIC_CACHE_SCOPE != "user":
        pytest.skip("тест осмыслен только при SEMANTIC_CACHE_SCOPE=user")

    token_a, _ = await _register(client)
    token_b, _ = await _register(client)
    query = f"вопрос об изоляции {uuid.uuid4().hex[:8]}"
    body = {"query": query, "context": {"language": "ru"}}

    first = await client.post("/api/v1/ai/chat", json=body, headers=_auth(token_a))
    assert first.status_code == 200, first.text
    repeat = await client.post("/api/v1/ai/chat", json=body, headers=_auth(token_a))
    assert repeat.json()["meta"]["source"] in ("exact_cache", "semantic_cache")

    other = await client.post("/api/v1/ai/chat", json=body, headers=_auth(token_b))
    assert other.status_code == 200
    assert other.json()["meta"]["source"] not in ("exact_cache", "semantic_cache"), (
        "чужой ответ отдан из кэша"
    )


async def test_unauthenticated_access_is_rejected(client):
    for path in ("/api/v1/entities", "/api/v1/ai/stats", "/api/v1/knowledge/search?q=x"):
        response = await client.get(path)
        assert response.status_code == 401, path
