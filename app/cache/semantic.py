import hashlib
import json
import re
from datetime import UTC, datetime, timedelta

import redis.asyncio as aioredis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.embedder import current_model_name
from app.ai.schemas import AIAnswer, AIRequest, AIResult
from app.config import settings
from app.observability import (
    AI_CACHE_HITS,
    AI_CACHE_MISSES,
    AI_CACHE_SIMILARITY,
    log,
)

_WS_RE = re.compile(r"\s+")

# См. пояснение в app/rag/pipeline.py: под фильтром HNSW нужно расширять
# список кандидатов, иначе кэш начинает тихо промахиваться по мере роста.
# SET LOCAL не принимает биндинг-параметры, поэтому значение подставляется
# через set_config: третий аргумент true ограничивает действие транзакцией.
EF_SEARCH_SQL = text("SELECT set_config('hnsw.ef_search', :ef, true)")

SEARCH_SQL = text(
    """
    SELECT id, response, model, prompt_tokens, completion_tokens,
           1 - (embedding <=> (:embedding)::vector) AS similarity
    FROM semantic_cache
    WHERE context_key = :context_key
      AND prompt_version = :prompt_version
      AND embedding_model = :embedding_model
      AND expires_at > now()
    ORDER BY embedding <=> (:embedding)::vector
    LIMIT 1
    """
)

INSERT_SQL = text(
    """
    INSERT INTO semantic_cache
        (id, query_text, embedding, response, context_key, context, model,
         prompt_version, embedding_model, hit_count, prompt_tokens,
         completion_tokens, created_at, expires_at)
    VALUES
        (gen_random_uuid(), :query_text, (:embedding)::vector, (:response)::jsonb,
         :context_key, (:context)::jsonb, :model, :prompt_version,
         :embedding_model, 0, :prompt_tokens, :completion_tokens,
         now(), :expires_at)
    """
)

BUMP_SQL = text("UPDATE semantic_cache SET hit_count = hit_count + 1 WHERE id = :id")

PURGE_SQL = text("DELETE FROM semantic_cache WHERE expires_at < now()")

# Вытесняем самые холодные записи: сначала редко используемые, среди них — старые.
TRIM_SQL = text(
    """
    DELETE FROM semantic_cache
    WHERE id IN (
        SELECT id FROM semantic_cache
        ORDER BY hit_count ASC, created_at ASC
        OFFSET :keep
    )
    """
)

STATS_SQL = text(
    """
    SELECT count(*)                                        AS entries,
           coalesce(sum(hit_count), 0)                     AS hits,
           coalesce(sum(hit_count * prompt_tokens), 0)     AS saved_prompt_tokens,
           coalesce(sum(hit_count * completion_tokens), 0) AS saved_completion_tokens
    FROM semantic_cache
    WHERE expires_at > now()
    """
)


def normalize(query: str) -> str:
    return _WS_RE.sub(" ", query.strip().lower())


class SemanticCache:
    def __init__(
        self,
        session: AsyncSession,
        redis: aioredis.Redis,
        embedding_model: str | None = None,
    ):
        self.session = session
        self.redis = redis
        self.threshold = settings.cache_threshold
        self.ttl = settings.SEMANTIC_CACHE_TTL
        self.embedding_model = embedding_model or current_model_name()

    def context_key(self, context: dict, user_id: str | None = None) -> str:
        """Ключ изоляции кэша.

        Два текстуально похожих запроса не взаимозаменяемы, если различаются поля
        контекста (`CACHE_CONTEXT_FIELDS`). При `SEMANTIC_CACHE_SCOPE=user` в ключ
        добавляется владелец запроса: ответ, построенный на данных одного
        пользователя, физически не может быть отдан другому.
        """
        parts = [
            f"{field}={str(context.get(field, '')).strip().lower()}"
            for field in settings.cache_context_fields
        ]
        if settings.SEMANTIC_CACHE_SCOPE == "user":
            parts.append(f"user={user_id or 'anonymous'}")
        return "|".join(parts)

    def _exact_key(self, req: AIRequest) -> str:
        raw = "|".join(
            [
                normalize(req.query),
                self.context_key(req.context, req.user_id),
                settings.LLM_PRIMARY,
                settings.PROMPT_VERSION,
                self.embedding_model,
            ]
        )
        return "ai:exact:" + hashlib.sha256(raw.encode()).hexdigest()

    async def get_exact(self, req: AIRequest) -> AIResult | None:
        if not settings.SEMANTIC_CACHE_ENABLED:
            return None
        raw = await self.redis.get(self._exact_key(req))
        if not raw:
            return None
        AI_CACHE_HITS.labels(level="exact").inc()
        payload = json.loads(raw)
        result = AIResult(answer=AIAnswer.model_validate(payload["answer"]))
        result.meta.source = "exact_cache"
        result.meta.model = payload.get("model", "")
        result.meta.similarity = 1.0
        result.meta.saved_tokens = {
            "prompt": payload.get("prompt_tokens", 0),
            "completion": payload.get("completion_tokens", 0),
        }
        return result

    async def get_semantic(
        self, embedding: list[float], context: dict, user_id: str | None = None
    ) -> AIResult | None:
        if not settings.SEMANTIC_CACHE_ENABLED:
            return None
        await self.session.execute(
            EF_SEARCH_SQL, {"ef": str(settings.HNSW_EF_SEARCH)}
        )
        row = (
            await self.session.execute(
                SEARCH_SQL,
                {
                    "embedding": str(embedding),
                    "context_key": self.context_key(context, user_id),
                    "prompt_version": settings.PROMPT_VERSION,
                    "embedding_model": self.embedding_model,
                },
            )
        ).mappings().first()

        if row is None:
            AI_CACHE_MISSES.inc()
            return None

        similarity = float(row["similarity"])
        AI_CACHE_SIMILARITY.observe(similarity)
        if similarity < self.threshold:
            AI_CACHE_MISSES.inc()
            return None

        await self.session.execute(BUMP_SQL, {"id": row["id"]})
        AI_CACHE_HITS.labels(level="semantic").inc()
        log.info("semantic_cache_hit", similarity=round(similarity, 4))

        response = row["response"]
        if isinstance(response, str):
            response = json.loads(response)
        result = AIResult(answer=AIAnswer.model_validate(response))
        result.meta.source = "semantic_cache"
        result.meta.similarity = round(similarity, 4)
        result.meta.model = row["model"]
        result.meta.saved_tokens = {
            "prompt": row["prompt_tokens"] or 0,
            "completion": row["completion_tokens"] or 0,
        }
        return result

    async def put(self, req: AIRequest, embedding: list[float], result: AIResult) -> None:
        if not settings.SEMANTIC_CACHE_ENABLED or not result.cacheable:
            return

        answer_json = result.answer.model_dump(mode="json")
        expires_at = datetime.now(UTC) + timedelta(seconds=self.ttl)
        prompt_tokens = result.meta.tokens.get("prompt", 0)
        completion_tokens = result.meta.tokens.get("completion", 0)

        await self.session.execute(
            INSERT_SQL,
            {
                "query_text": req.query,
                "embedding": str(embedding),
                "response": json.dumps(answer_json, ensure_ascii=False),
                "context_key": self.context_key(req.context, req.user_id),
                "context": json.dumps(req.context, ensure_ascii=False),
                "model": result.meta.model or settings.LLM_PRIMARY,
                "prompt_version": settings.PROMPT_VERSION,
                "embedding_model": self.embedding_model,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "expires_at": expires_at,
            },
        )
        await self.redis.setex(
            self._exact_key(req),
            min(self.ttl, settings.EXACT_CACHE_TTL),
            json.dumps(
                {
                    "answer": answer_json,
                    "model": result.meta.model,
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                },
                ensure_ascii=False,
            ),
        )

    async def purge_expired(self) -> int:
        """Удаляет протухшее и подрезает таблицу до `SEMANTIC_CACHE_MAX_ROWS`.

        Без этого кэш растёт неограниченно: TTL сам по себе строки не удаляет,
        а HNSW-индекс по раздувшейся таблице деградирует.
        """
        removed = (await self.session.execute(PURGE_SQL)).rowcount or 0
        trimmed = (
            await self.session.execute(TRIM_SQL, {"keep": settings.SEMANTIC_CACHE_MAX_ROWS})
        ).rowcount or 0
        if removed or trimmed:
            log.info("semantic_cache_purged", expired=removed, trimmed=trimmed)
        return removed + trimmed

    async def stats(self) -> dict:
        row = (await self.session.execute(STATS_SQL)).mappings().first()
        return dict(row) if row else {}
