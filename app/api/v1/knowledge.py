from typing import Literal

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field

from app.ai.embedder import build_embedder
from app.cache.ratelimit import check_rate_limit
from app.config import settings
from app.deps import RedisDep, SessionDep, UserDep, require_role
from app.models import KnowledgeDocument
from app.rag.pipeline import RAGPipeline

router = APIRouter(prefix="/knowledge", tags=["knowledge"])


class DocumentIn(BaseModel):
    title: str = Field(min_length=1, max_length=512)
    # Ограничение обязательно: документ индексируется синхронно внутри запроса.
    content: str = Field(min_length=1, max_length=settings.KNOWLEDGE_MAX_CHARS)
    source: str | None = None
    lang: str = "ru"
    # Категория документа: regulation / manual / tariff / faq …
    # По ней retrieval умеет сужать поиск (context.doc_kind в запросе).
    kind: str | None = Field(default=None, max_length=64)
    # private — документ виден только загрузившему; public — всей платформе.
    # Безопасный вариант по умолчанию: расширять доступ нужно осознанно.
    visibility: Literal["private", "public"] = "private"
    meta: dict = Field(default_factory=dict)


class DocumentOut(BaseModel):
    document_id: str
    title: str
    chunks: int


class SearchHit(BaseModel):
    doc_id: str
    title: str
    content: str
    similarity: float


@router.post(
    "/documents",
    response_model=DocumentOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_role("EXPERT"))],
)
async def add_document(
    body: DocumentIn, session: SessionDep, redis: RedisDep, user: UserDep
) -> DocumentOut:
    await check_rate_limit(redis, f"knowledge:{user.id}", settings.RATE_LIMIT_USER)

    document = KnowledgeDocument(
        title=body.title,
        source=body.source,
        lang=body.lang,
        kind=body.kind,
        owner_id=user.id,
        visibility=body.visibility,
        meta=body.meta,
    )
    session.add(document)
    await session.flush()

    rag = RAGPipeline(session, build_embedder())
    chunks = await rag.index_document(document.id, body.content)
    return DocumentOut(document_id=str(document.id), title=document.title, chunks=chunks)


@router.get("/search", response_model=list[SearchHit])
async def search(
    session: SessionDep,
    redis: RedisDep,
    user: UserDep,
    q: str = Query(min_length=1, max_length=2000),
) -> list[SearchHit]:
    """Retrieval без вызова LLM.

    На демо показывает жюри, на основании каких документов система отвечает —
    наглядное доказательство, что это RAG, а не обёртка над чатом.
    """
    # Каждый вызов считает эмбеддинг — при внешнем провайдере это прямые
    # деньги, поэтому эндпоинт тоже под лимитом.
    await check_rate_limit(redis, f"search:{user.id}", settings.RATE_LIMIT_USER)

    embedder = build_embedder()
    rag = RAGPipeline(session, embedder)
    docs = await rag.retrieve(await embedder.embed(q), owner_id=str(user.id))
    return [
        SearchHit(
            doc_id=d.doc_id,
            title=d.title,
            content=d.content[:500],
            similarity=round(d.similarity, 4),
        )
        for d in docs
    ]
