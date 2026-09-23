"""Copilot привязан к серверному выпуску, без БД, сети и ML-зависимостей."""

from unittest.mock import AsyncMock

import pytest

from app.ai.orchestrator import AIOrchestrator
from app.ai.providers import MockProvider
from app.ai.schemas import AIRequest
from app.config import settings
from app.errors import NotFound, ValidationFailed
from app.wind.copilot import evidence
from app.wind.forecast_store import remember


def make_run(run_id, power=0.4):
    return {
        "forecast_id": run_id, "forecast_origin": "2026-02-07T00:00:00Z", "horizon": 4,
        "predictions": [
            {"forecast_for": f"2026-02-07T0{h}:00:00Z", "p50": power,
             "p10": power - 0.1, "p90": power + 0.1, "wind_speed": 8.0}
            for h in range(1, 5)
        ],
    }


def test_evidence_uses_server_run_and_horizon():
    remember(make_run("test-evidence"))
    answer, docs, tools = evidence("Когда пик?", {"forecast_id": "test-evidence", "horizon": 2})
    assert "горизонт 2 ч" in answer.summary
    assert "40.0%" in answer.summary
    assert "0.80" in answer.summary
    assert docs[0].content == answer.summary
    assert answer.sources[0].doc_id == "test-evidence"
    assert tools == ["forecast.load", "forecast.analyze"]


def test_what_if_calls_real_simulation(monkeypatch):
    from app.api.v1 import forecast

    remember(make_run("test-scenario"))
    monkeypatch.setattr(forecast, "_curve", lambda: ([0, 10], [0, 1]))
    answer, _, tools = evidence("Ветер на 15% слабее", {"forecast_id": "test-scenario"})
    assert "simulation.wind_change" in tools
    assert "с 1.60 до 1.12" in answer.summary
    with pytest.raises(ValidationFailed):
        evidence("Ветер на 80% слабее", {"forecast_id": "test-scenario"})


def test_unknown_run_does_not_invent_forecast():
    with pytest.raises(NotFound):
        evidence("Когда пик?", {"forecast_id": "missing-forecast-copilot"})


async def test_forecast_chat_bypasses_semantic_cache(monkeypatch):
    monkeypatch.setattr(settings, "LLM_MODE", "mock")
    remember(make_run("test-chat-a", 0.3))
    remember(make_run("test-chat-b", 0.7))
    cache = AsyncMock()
    llm = AsyncMock(spec=MockProvider)
    orchestrator = AIOrchestrator(llm, AsyncMock(), cache, AsyncMock())
    results = [await orchestrator.run(AIRequest(
        query="Когда пик?", context={"forecast_id": rid},
    )) for rid in ("test-chat-a", "test-chat-b")]
    assert "30.0%" in results[0].answer.summary
    assert "70.0%" in results[1].answer.summary
    assert all(not r.cacheable for r in results)
    assert all(r.meta.model == "windcast-tools-v1" for r in results)
    cache.get_exact.assert_not_called()
    cache.get_semantic.assert_not_called()
    llm.generate.assert_not_called()
