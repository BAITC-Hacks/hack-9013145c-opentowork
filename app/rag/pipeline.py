import re

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.embedder import Embedder
from app.ai.schemas import RetrievedDoc
from app.config import settings
from app.observability import log

# HNSW применяет WHERE уже ПОСЛЕ обхода индекса. При ef_search по умолчанию
# (40) ближайшие кандидаты легко оказываются целиком из чужого языка или
# чужого владельца, и запрос вернёт пусто при наличии подходящей записи —
# молча, без единой ошибки. Поэтому перед фильтрованным поиском список
# кандидатов расширяется.
# SET LOCAL не принимает биндинг-параметры, поэтому значение подставляется
# через set_config: третий аргумент true ограничивает действие транзакцией.
EF_SEARCH_SQL = text("SELECT set_config('hnsw.ef_search', :ef, true)")

# :lang и :kind необязательные: NULL означает «не фильтровать». Касты ::text
# обязательны — без них asyncpg не может вывести тип NULL-параметра.
SEARCH_SQL = text(
    """
    SELECT c.id,
           c.content,
           c.document_id,
           d.title,
           1 - (c.embedding <=> (:embedding)::vector) AS similarity
    FROM knowledge_chunks c
    JOIN knowledge_documents d ON d.id = c.document_id
    WHERE c.embedding_model = :embedding_model
      AND (CAST(:lang AS text) IS NULL OR d.lang = CAST(:lang AS text))
      AND (CAST(:kind AS text) IS NULL OR d.kind = CAST(:kind AS text))
      AND (d.visibility = 'public' OR d.owner_id = CAST(:owner AS uuid))
    ORDER BY c.embedding <=> (:embedding)::vector
    LIMIT :limit
    """
)

_PARA_RE = re.compile(r"\n\s*\n")


def chunk_text(
    content: str,
    size: int = settings.RAG_CHUNK_SIZE,
    overlap: int = settings.RAG_CHUNK_OVERLAP,
) -> list[str]:
    """Режет по абзацам, добирая до целевого размера, с перекрытием между кусками."""
    paragraphs = [p.strip() for p in _PARA_RE.split(content) if p.strip()]
    chunks: list[str] = []
    buffer = ""

    for para in paragraphs:
        if len(buffer) + len(para) + 2 <= size:
            buffer = f"{buffer}\n\n{para}" if buffer else para
            continue
        if buffer:
            chunks.append(buffer)
        if len(para) <= size:
            buffer = para
            continue
        for i in range(0, len(para), size - overlap):
            piece = para[i : i + size]
            if piece.strip():
                chunks.append(piece.strip())
        buffer = ""

    if buffer:
        chunks.append(buffer)

    if overlap and len(chunks) > 1:
        overlapped = [chunks[0]]
        for prev, cur in zip(chunks, chunks[1:], strict=False):
            overlapped.append((prev[-overlap:] + "\n" + cur).strip())
        return overlapped
    return chunks


class RAGPipeline:
    def __init__(self, session: AsyncSession, embedder: Embedder):
        self.session = session
        self.embedder = embedder

    async def retrieve(
        self,
        embedding: list[float],
        context: dict | None = None,
        owner_id: str | None = None,
    ) -> list[RetrievedDoc]:
        """Ищет релевантные куски базы знаний.

        `context` сужает поиск: `language` ограничивает корпус языком документа,
        `doc_kind` — категорией. Без этого в промпт попадают документы на чужом
        языке и из чужого раздела, как только база знаний перестаёт быть
        однородной.

        `owner_id` ограничивает выдачу общедоступными документами и личными
        документами запрашивающего. Раньше фильтра по владельцу не было вообще:
        любой загруженный документ становился общим для всех пользователей.

        Поля, которые здесь фильтруют, обязаны входить в `CACHE_CONTEXT_FIELDS`:
        иначе два запроса с разным фильтром получат один и тот же ответ из кэша,
        собранный по чужому набору документов.
        """
        if not settings.RAG_ENABLED:
            return []

        context = context or {}
        lang = str(context.get("language") or "").strip().lower() or None
        kind = str(context.get("doc_kind") or "").strip().lower() or None
        params = {
            "embedding": str(embedding),
            "limit": settings.RAG_CANDIDATES,
            "lang": lang,
            "kind": kind,
            "owner": owner_id,
            "embedding_model": self.embedder.model_name,
        }

        await self.session.execute(EF_SEARCH_SQL, {"ef": str(settings.HNSW_EF_SEARCH)})
        rows = (await self.session.execute(SEARCH_SQL, params)).mappings().all()

        # Фильтр по языку не должен превращаться в «ответа нет»: если под язык
        # запроса документов не нашлось, повторяем поиск по всему корпусу.
        # Владельца при этом НЕ ослабляем — это граница доступа, а не удобство.
        if not rows and (lang or kind):
            log.info("rag_filter_fallback", lang=lang, kind=kind)
            rows = (
                await self.session.execute(
                    SEARCH_SQL, {**params, "lang": None, "kind": None}
                )
            ).mappings().all()

        docs = [
            RetrievedDoc(
                doc_id=str(row["document_id"]),
                title=row["title"],
                content=row["content"],
                similarity=float(row["similarity"]),
            )
            for row in rows
            if float(row["similarity"]) >= settings.rag_min_similarity
        ]

        if not docs:
            log.info("rag_no_relevant_docs", candidates=len(rows))
            return []

        # Дедуп по документу, чтобы в промпт не попали 5 кусков одного текста
        seen: set[str] = set()
        unique: list[RetrievedDoc] = []
        for doc in docs:
            if doc.doc_id in seen:
                continue
            seen.add(doc.doc_id)
            unique.append(doc)
            if len(unique) >= settings.RAG_TOP_K:
                break
        return unique

    async def index_document(self, document_id, content: str) -> int:
        from app.models import KnowledgeChunk

        chunks = chunk_text(content)
        if not chunks:
            return 0

        # Одним запросом на пачку вместо запроса на каждый кусок: документ
        # в сотню чанков раньше означал сотню последовательных HTTP-вызовов.
        embeddings = await self.embedder.embed_many(chunks)

        for ord_, (chunk, embedding) in enumerate(zip(chunks, embeddings, strict=True)):
            self.session.add(
                KnowledgeChunk(
                    document_id=document_id,
                    ord=ord_,
                    content=chunk,
                    embedding=embedding,
                    # Без этого вектор неотличим от вектора другой модели
                    # той же размерности.
                    embedding_model=self.embedder.model_name,
                )
            )
        await self.session.flush()
        return len(chunks)
