import time

from pydantic import ValidationError

from app.ai.embedder import Embedder
from app.ai.guard import InputGuard
from app.ai.prompts import SYSTEM_PROMPT, build_prompt
from app.ai.providers import LLMProvider, estimate_cost, reference_cost
from app.ai.schemas import AIAnswer, AIRequest, AIResult, RetrievedDoc, SourceRef
from app.ai.validator import OutputValidator
from app.cache.semantic import SemanticCache
from app.config import settings
from app.errors import AIProviderError
from app.observability import (
    AI_COST,
    AI_COST_SAVED,
    AI_LATENCY,
    AI_REQUESTS,
    AI_TOKENS,
    log,
)
from app.rag.pipeline import RAGPipeline


class AIOrchestrator:
    """Единая точка входа для любой AI-операции.

    Порядок: guard → exact cache → embedding → semantic cache → RAG → LLM →
    валидация (с ретраем) → degraded-ответ при неудаче → запись в кэш.
    Бизнес-логика вызывает только run(), напрямую к провайдеру не ходит.
    """

    def __init__(
        self,
        llm: LLMProvider,
        embedder: Embedder,
        cache: SemanticCache,
        rag: RAGPipeline,
        validator: OutputValidator | None = None,
        guard: InputGuard | None = None,
    ):
        self.llm = llm
        self.embedder = embedder
        self.cache = cache
        self.rag = rag
        self.validator = validator or OutputValidator()
        self.guard = guard or InputGuard()

    async def run(self, req: AIRequest) -> AIResult:
        started = time.perf_counter()
        req = self.guard.check(req)

        if (hit := await self.cache.get_exact(req)) is not None:
            return self._finish_cache_hit(hit, started, level="exact_cache")

        with AI_LATENCY.labels(stage="embedding").time():
            embedding = await self.embedder.embed(req.query)

        with AI_LATENCY.labels(stage="semantic_cache").time():
            hit = await self.cache.get_semantic(embedding, req.context, req.user_id)
        if hit is not None:
            return self._finish_cache_hit(hit, started, level="semantic_cache")

        with AI_LATENCY.labels(stage="retrieval").time():
            docs = await self.rag.retrieve(embedding, req.context, owner_id=req.user_id)

        result = await self._generate_validated(req, docs)
        result.meta.latency_ms = int((time.perf_counter() - started) * 1000)
        result.meta.retrieved = len(docs)

        if result.cacheable:
            await self.cache.put(req, embedding, result)

        AI_REQUESTS.labels(
            source=result.meta.source, status="degraded" if result.meta.degraded else "ok"
        ).inc()
        return result

    def _finish_cache_hit(self, hit: AIResult, started: float, level: str) -> AIResult:
        """Экономия считается по токенам, которые реально стоил исходный вызов.

        В offline-режиме фактическая цена нулевая, поэтому для ответа на вопрос
        «сколько это экономит в проде» рядом кладётся оценка по боевой модели
        из `LLM_PRIMARY` — и она всегда подписана как оценка.
        """
        hit.meta.latency_ms = int((time.perf_counter() - started) * 1000)
        saved_prompt = hit.meta.saved_tokens.get("prompt", 0)
        saved_completion = hit.meta.saved_tokens.get("completion", 0)
        saved = estimate_cost(hit.meta.model or "", saved_prompt, saved_completion)
        if saved == 0.0:
            saved = reference_cost(saved_prompt, saved_completion)
        hit.meta.saved_usd = round(saved, 6)
        AI_COST_SAVED.inc(saved)
        AI_REQUESTS.labels(source=level, status="ok").inc()
        return hit

    async def _generate_validated(self, req: AIRequest, docs: list[RetrievedDoc]) -> AIResult:
        repair_hint: str | None = None
        last_model = ""
        retries = 0
        spent = 0.0

        for attempt in range(settings.VALIDATION_MAX_ATTEMPTS):
            prompt = build_prompt(req.query, docs, req.context, repair_hint)
            try:
                with AI_LATENCY.labels(stage="llm").time():
                    response = await self.llm.generate(
                        prompt=prompt,
                        system=SYSTEM_PROMPT,
                        timeout_s=settings.LLM_TIMEOUT_S,
                    )
            except AIProviderError as exc:
                log.error("llm_unavailable", error=str(exc), attempt=attempt)
                return self._degraded(docs, reason=f"provider_error: {exc}")

            last_model = response.model
            AI_TOKENS.labels(response.model, "prompt").inc(response.prompt_tokens)
            AI_TOKENS.labels(response.model, "completion").inc(response.completion_tokens)
            cost = estimate_cost(
                response.model, response.prompt_tokens, response.completion_tokens
            )
            spent += cost
            AI_COST.inc(cost)

            if response.parsed is None:
                repair_hint = "Ответ не является валидным JSON."
                retries += 1
                continue

            try:
                answer = AIAnswer.model_validate(response.parsed)
            except ValidationError as exc:
                repair_hint = f"Ответ не соответствует схеме: {str(exc)[:400]}"
                retries += 1
                continue

            with AI_LATENCY.labels(stage="validation").time():
                issues = self.validator.semantic_checks(
                    answer, docs, context=req.context, query=req.query
                )
            if issues:
                repair_hint = "; ".join(issues)[:400]
                retries += 1
                log.warning("output_validation_failed", issues=issues, attempt=attempt)
                continue

            result = AIResult(answer=answer, cacheable=True)
            result.meta.model = response.model
            result.meta.tokens = {
                "prompt": response.prompt_tokens,
                "completion": response.completion_tokens,
            }
            result.meta.cost_usd = round(spent, 6)
            result.meta.validation_retries = retries
            return result

        return self._degraded(
            docs, reason=repair_hint or "unknown", model=last_model, retries=retries,
            spent=spent,
        )

    def _degraded(
        self,
        docs: list[RetrievedDoc],
        reason: str,
        model: str = "",
        retries: int = 0,
        spent: float = 0.0,
    ) -> AIResult:
        """Никогда не отдаём пользователю невалидированный вывод модели."""
        log.warning("ai_degraded_response", reason=reason[:300])
        answer = AIAnswer(
            summary=(
                "Не удалось сформировать проверенный ответ на этот запрос. "
                "Ниже — релевантные материалы из базы знаний; рекомендуем проверку экспертом."
            ),
            possible_causes=[],
            recommendations=[],
            confidence=0.0,
            sources=[SourceRef(doc_id=d.doc_id, title=d.title) for d in docs[:3]],
            needs_expert_review=True,
        )
        result = AIResult(answer=answer, cacheable=False)
        result.meta.source = "degraded"
        result.meta.degraded = True
        result.meta.model = model
        result.meta.cost_usd = round(spent, 6)
        result.meta.validation_retries = retries
        return result
