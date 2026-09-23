import asyncio
import hashlib
import json
import re
import time
from typing import Protocol

import httpx

from app.ai.schemas import LLMResponse
from app.config import settings
from app.errors import AIProviderError
from app.observability import AI_LLM_ERRORS, log

_http_client: httpx.AsyncClient | None = None
_http_lock = asyncio.Lock()


async def get_http_client() -> httpx.AsyncClient:
    """Один клиент на процесс: keep-alive вместо TLS-handshake на каждый вызов."""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        async with _http_lock:
            if _http_client is None or _http_client.is_closed:
                _http_client = httpx.AsyncClient(
                    timeout=settings.LLM_TIMEOUT_S,
                    limits=httpx.Limits(
                        max_connections=50, max_keepalive_connections=20
                    ),
                )
    return _http_client


async def close_http_client() -> None:
    global _http_client
    if _http_client is not None and not _http_client.is_closed:
        await _http_client.aclose()
    _http_client = None

# Прайс-лист Anthropic, USD за 1M токенов: (вход, выход).
# Ключ — префикс идентификатора модели, чтобы датированные снапшоты
# (claude-haiku-4-5-20251001) попадали в ту же строку, что и базовый id.
PRICING: dict[str, tuple[float, float]] = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    # Локальная заглушка не стоит ничего. Ноль здесь — принципиально: иначе
    # offline-демо рисовало бы в метриках несуществующие доллары.
    "mock-model-v1": (0.0, 0.0),
}
DEFAULT_PRICE = (3.0, 15.0)


def price_of(model: str) -> tuple[float, float]:
    name = model.split(":")[-1]
    for prefix, price in PRICING.items():
        if name.startswith(prefix):
            return price
    return DEFAULT_PRICE


def estimate_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    """Фактическая стоимость вызова по прайсу провайдера."""
    inp, out = price_of(model)
    return (prompt_tokens * inp + completion_tokens * out) / 1_000_000


def reference_cost(prompt_tokens: int, completion_tokens: int) -> float:
    """Во что тот же объём обошёлся бы на боевой модели из `LLM_PRIMARY`.

    Нужна для честного ответа на вопрос «сколько это стоит в проде», когда демо
    идёт в offline-режиме: реальный расход там ноль, и выдавать его за экономию
    было бы враньём. Эта цифра всегда подписывается как оценка.
    """
    inp, out = price_of(settings.LLM_PRIMARY)
    return (prompt_tokens * inp + completion_tokens * out) / 1_000_000


class LLMProvider(Protocol):
    name: str

    async def generate(
        self,
        *,
        prompt: str,
        system: str | None = None,
        schema_hint: str | None = None,
        model: str | None = None,
        timeout_s: float = 30.0,
    ) -> LLMResponse: ...


def _extract_json(text: str) -> dict | None:
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    raw = fence.group(1) if fence else None
    if raw is None:
        start, end = text.find("{"), text.rfind("}")
        raw = text[start : end + 1] if start != -1 and end > start else None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


class MockProvider:
    """Детерминированный провайдер для работы без ключей и интернета.

    Нужен не только для тестов: технический эксперт проверяет проект без ваших
    личных аккаунтов (п. 5.6.6), и это же страховка, если на площадке упадёт сеть.
    """

    name = "mock"

    async def generate(
        self,
        *,
        prompt: str,
        system: str | None = None,
        schema_hint: str | None = None,
        model: str | None = None,
        timeout_s: float = 30.0,
    ) -> LLMResponse:
        started = time.perf_counter()
        await asyncio.sleep(0.15)

        seed = hashlib.sha256(prompt.encode()).hexdigest()
        doc_ids = re.findall(r'id="([^"]+)"', prompt)
        question = prompt.strip().splitlines()[-1][:300] if prompt.strip() else ""

        payload = {
            "summary": (
                f"[MOCK] Ответ сгенерирован локально, без обращения к внешней модели. "
                f"Запрос: {question}"
            ),
            "possible_causes": ["Причина A (mock)", "Причина B (mock)"],
            "recommendations": [
                {
                    "title": "Проверить исходные данные",
                    "action": "Убедитесь, что входные параметры заполнены корректно.",
                    "priority": "medium",
                }
            ],
            "confidence": 0.5 + int(seed[:2], 16) % 40 / 100,
            "sources": [{"doc_id": d, "title": "knowledge base"} for d in doc_ids[:3]],
            "needs_expert_review": False,
        }
        prompt_tokens = max(1, len(prompt) // 4)
        completion_tokens = max(1, len(json.dumps(payload)) // 4)
        return LLMResponse(
            text=json.dumps(payload, ensure_ascii=False),
            parsed=payload,
            model="mock-model-v1",
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str, model: str):
        self.api_key = api_key
        self.model = model

    async def generate(
        self,
        *,
        prompt: str,
        system: str | None = None,
        schema_hint: str | None = None,
        model: str | None = None,
        timeout_s: float = 30.0,
    ) -> LLMResponse:
        started = time.perf_counter()
        body = {
            "model": model or self.model,
            "max_tokens": settings.LLM_MAX_OUTPUT_TOKENS,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            body["system"] = system

        try:
            client = await get_http_client()
            resp = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json=body,
                timeout=timeout_s,
            )
        except httpx.TimeoutException as exc:
            AI_LLM_ERRORS.labels(self.name, "timeout").inc()
            raise AIProviderError("LLM request timed out") from exc
        except httpx.HTTPError as exc:
            AI_LLM_ERRORS.labels(self.name, "network").inc()
            raise AIProviderError("LLM request failed") from exc

        if resp.status_code == 429:
            AI_LLM_ERRORS.labels(self.name, "ratelimit").inc()
            raise AIProviderError("LLM rate limit exceeded")
        if resp.status_code >= 400:
            AI_LLM_ERRORS.labels(self.name, "server").inc()
            log.error("llm_http_error", status=resp.status_code, body=resp.text[:300])
            raise AIProviderError(f"LLM returned {resp.status_code}")

        data = resp.json()
        text = "".join(block.get("text", "") for block in data.get("content", []))
        usage = data.get("usage", {})
        used_model = data.get("model", body["model"])
        prompt_tokens = usage.get("input_tokens", 0)
        completion_tokens = usage.get("output_tokens", 0)

        # Токены считает ТОЛЬКО оркестратор: он видит все попытки, включая
        # ретраи валидации, и работает одинаково для любого провайдера.
        # Инкремент здесь давал двойной учёт в live-режиме (в mock его не было,
        # поэтому на демо цифры сходились, а в проде были завышены вдвое).
        return LLMResponse(
            text=text,
            parsed=_extract_json(text),
            model=used_model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )


class FallbackProvider:
    """Пробует основного провайдера, при ошибке — запасного."""

    name = "fallback"

    def __init__(self, primary: LLMProvider, fallback: LLMProvider | None):
        self.primary = primary
        self.fallback = fallback

    async def generate(self, **kwargs) -> LLMResponse:
        try:
            return await self.primary.generate(**kwargs)
        except AIProviderError:
            if self.fallback is None:
                raise
            log.warning("llm_fallback", primary=self.primary.name, fallback=self.fallback.name)
            return await self.fallback.generate(**kwargs)


def _build_one(spec: str) -> LLMProvider:
    vendor, _, model = spec.partition(":")
    if settings.LLM_MODE == "mock" or not settings.LLM_API_KEY:
        return MockProvider()
    if vendor == "anthropic":
        return AnthropicProvider(settings.LLM_API_KEY, model or "claude-sonnet-5")
    log.warning("unknown_llm_vendor", vendor=vendor)
    return MockProvider()


def build_provider() -> LLMProvider:
    if settings.LLM_MODE == "mock" or not settings.LLM_API_KEY:
        log.info("llm_provider", mode="mock", reason="LLM_MODE=mock or no API key")
        return MockProvider()
    primary = _build_one(settings.LLM_PRIMARY)
    fallback = _build_one(settings.LLM_FALLBACK) if settings.LLM_FALLBACK else None
    return FallbackProvider(primary, fallback)
