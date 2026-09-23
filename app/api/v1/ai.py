import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.ai.embedder import build_embedder
from app.ai.orchestrator import AIOrchestrator
from app.ai.providers import build_provider, reference_cost
from app.ai.schemas import AIAnswer, AIMeta, AIRequest
from app.cache.ratelimit import check_rate_limit
from app.cache.semantic import SemanticCache
from app.config import settings
from app.deps import RedisDep, SessionDep, UserDep
from app.errors import NotFound, ValidationFailed
from app.models import AIRequestLog, Conversation, Feedback, Message
from app.rag.pipeline import RAGPipeline

router = APIRouter(prefix="/ai", tags=["ai"])


class ChatIn(BaseModel):
    query: str = Field(min_length=1, max_length=8000)
    context: dict = Field(default_factory=dict)
    conversation_id: str | None = None


class ChatOut(BaseModel):
    request_id: str
    answer: AIAnswer
    meta: AIMeta


class MessageOut(BaseModel):
    role: str
    content: str
    meta: dict
    created_at: str


class ConversationOut(BaseModel):
    id: str
    title: str | None
    messages: list[MessageOut]


class FeedbackIn(BaseModel):
    request_id: str
    rating: int = Field(ge=-1, le=1)
    reason: str | None = Field(default=None, max_length=1000)


class StatsOut(BaseModel):
    total_requests: int
    cache_hits: int
    hit_rate: float
    avg_latency_live_ms: int
    avg_latency_cached_ms: int
    degraded: int
    cache_entries: int
    saved_usd_estimate: float
    spent_usd: float
    llm_mode: str
    window_hours: int
    note: str


def build_orchestrator(session, redis) -> AIOrchestrator:
    embedder = build_embedder()
    return AIOrchestrator(
        llm=build_provider(),
        embedder=embedder,
        cache=SemanticCache(session, redis, embedder.model_name),
        rag=RAGPipeline(session, embedder),
    )


@router.post("/chat", response_model=ChatOut)
async def chat(
    body: ChatIn, session: SessionDep, redis: RedisDep, user: UserDep
) -> ChatOut:
    await check_rate_limit(redis, f"ai:{user.id}", settings.RATE_LIMIT_AI)

    orchestrator = build_orchestrator(session, redis)
    result = await orchestrator.run(
        AIRequest(query=body.query, context=body.context, user_id=str(user.id))
    )

    conversation_id = None
    if body.conversation_id:
        try:
            requested = uuid.UUID(body.conversation_id)
        except ValueError as exc:
            # Раньше некорректная строка давала 500 вместо понятного 422.
            raise ValidationFailed("conversation_id must be a UUID") from exc
        conversation = await session.get(Conversation, requested)
        if conversation is None or conversation.user_id != user.id:
            raise NotFound("Conversation not found")
        conversation_id = conversation.id
    else:
        conversation = Conversation(user_id=user.id, title=body.query[:80])
        session.add(conversation)
        await session.flush()
        conversation_id = conversation.id

    session.add(Message(conversation_id=conversation_id, role="user", content=body.query))
    session.add(
        Message(
            conversation_id=conversation_id,
            role="assistant",
            content=result.answer.summary,
            meta=result.meta.model_dump(mode="json"),
        )
    )

    log_entry = AIRequestLog(
        user_id=user.id,
        query=body.query,
        context=body.context,
        source=result.meta.source,
        model=result.meta.model,
        prompt_tokens=result.meta.tokens.get("prompt", 0),
        completion_tokens=result.meta.tokens.get("completion", 0),
        latency_ms=result.meta.latency_ms,
        degraded=result.meta.degraded,
    )
    session.add(log_entry)
    await session.flush()

    return ChatOut(request_id=str(log_entry.id), answer=result.answer, meta=result.meta)


@router.post("/feedback", status_code=status.HTTP_201_CREATED)
async def leave_feedback(body: FeedbackIn, session: SessionDep, user: UserDep) -> dict:
    """Оценка ответа пользователем.

    Замыкает петлю: запросы с отрицательной оценкой — готовый список того, что
    нужно починить правилом в `app/domain/rules.py` или документом в базе знаний.
    """
    try:
        request_id = uuid.UUID(body.request_id)
    except ValueError as exc:
        raise ValidationFailed("request_id must be a UUID") from exc

    log_entry = await session.get(AIRequestLog, request_id)
    if log_entry is None or log_entry.user_id != user.id:
        raise NotFound("AI request not found")

    session.add(
        Feedback(
            user_id=user.id,
            ai_request_id=request_id,
            rating=body.rating,
            reason=body.reason,
        )
    )
    return {"status": "accepted"}


@router.get("/stats", response_model=StatsOut)
async def stats(session: SessionDep, redis: RedisDep, user: UserDep) -> StatsOut:
    """Сводка для демо: сколько запросов сняли с модели кэш и во что это обошлось.

    Считается по журналу `ai_requests`, а не по счётчикам в памяти процесса,
    поэтому цифры переживают рестарт и одинаковы на всех репликах.
    """
    await check_rate_limit(redis, f"stats:{user.id}", settings.RATE_LIMIT_USER)

    cached = AIRequestLog.source.in_(("exact_cache", "semantic_cache"))
    since = datetime.now(UTC) - timedelta(hours=settings.STATS_WINDOW_HOURS)

    # Один проход вместо шести отдельных полных сканов, и только за окно:
    # раньше каждый вызов агрегировал всю таблицу целиком за всю историю.
    row = (
        await session.execute(
            select(
                func.count().label("total"),
                func.count().filter(cached).label("hits"),
                func.count().filter(AIRequestLog.degraded.is_(True)).label("degraded"),
                func.avg(AIRequestLog.latency_ms).filter(~cached).label("avg_live"),
                func.avg(AIRequestLog.latency_ms).filter(cached).label("avg_cached"),
                func.coalesce(func.sum(AIRequestLog.prompt_tokens), 0).label("pt"),
                func.coalesce(func.sum(AIRequestLog.completion_tokens), 0).label("ct"),
            ).where(AIRequestLog.created_at >= since)
        )
    ).mappings().one()

    total = row["total"] or 0
    hits = row["hits"] or 0
    degraded = row["degraded"] or 0
    avg_live = row["avg_live"] or 0
    avg_cached = row["avg_cached"] or 0

    cache_stats = await SemanticCache(session, redis).stats()
    saved = reference_cost(
        int(cache_stats.get("saved_prompt_tokens", 0)),
        int(cache_stats.get("saved_completion_tokens", 0)),
    )
    spent_prompt, spent_completion = row["pt"], row["ct"]

    return StatsOut(
        total_requests=total,
        cache_hits=hits,
        hit_rate=round(hits / total, 4) if total else 0.0,
        avg_latency_live_ms=int(avg_live),
        avg_latency_cached_ms=int(avg_cached),
        degraded=degraded,
        cache_entries=int(cache_stats.get("entries", 0)),
        saved_usd_estimate=round(saved, 4),
        spent_usd=round(reference_cost(int(spent_prompt), int(spent_completion)), 4),
        llm_mode=settings.LLM_MODE,
        window_hours=settings.STATS_WINDOW_HOURS,
        note=(
            f"За последние {settings.STATS_WINDOW_HOURS} ч. Оценка по тарифу "
            f"{settings.LLM_PRIMARY}: столько стоили бы токены, снятые кэшем. "
            f"В режиме mock фактический расход равен нулю."
        ),
    )


@router.get("/conversations/{conversation_id}", response_model=ConversationOut)
async def get_conversation(
    conversation_id: uuid.UUID, session: SessionDep, user: UserDep
) -> ConversationOut:
    conversation = await session.get(Conversation, conversation_id)
    if conversation is None or conversation.user_id != user.id:
        raise NotFound("Conversation not found")

    messages = (
        await session.scalars(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at)
        )
    ).all()

    return ConversationOut(
        id=str(conversation.id),
        title=conversation.title,
        messages=[
            MessageOut(
                role=m.role,
                content=m.content,
                meta=m.meta,
                created_at=m.created_at.isoformat(),
            )
            for m in messages
        ],
    )
