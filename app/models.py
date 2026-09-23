import uuid
from datetime import UTC, datetime, timedelta

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.config import settings
from app.db import Base

DIM = settings.EMBEDDING_DIM


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _now() -> datetime:
    return datetime.now(UTC)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str | None] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(32), default="USER", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    entities: Mapped[list["DomainEntity"]] = relationship(back_populates="owner")


class DomainEntity(Base, TimestampMixin):
    """Плейсхолдер доменной сущности.

    Переименовать под кейс (Farm / Patient / Shipment / Vacancy). Поля, по которым
    фильтруете, выносите в колонки; остальное держите в attributes, чтобы не гонять
    миграции на каждое новое поле во время соревнования.
    """

    __tablename__ = "domain_entities"

    id: Mapped[uuid.UUID] = _uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str | None] = mapped_column(String(64), index=True)
    attributes: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    owner: Mapped[User] = relationship(back_populates="entities")
    analyses: Mapped[list["Analysis"]] = relationship(
        back_populates="entity", cascade="all, delete-orphan"
    )


class Analysis(Base, TimestampMixin):
    __tablename__ = "analyses"

    id: Mapped[uuid.UUID] = _uuid_pk()
    entity_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("domain_entities.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="PENDING", nullable=False)
    result: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    model: Mapped[str | None] = mapped_column(String(128))
    confidence: Mapped[float | None] = mapped_column(Float)
    needs_expert_review: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    entity: Mapped[DomainEntity | None] = relationship(back_populates="analyses")

    __table_args__ = (Index("ix_analyses_entity_created", "entity_id", "created_at"),)


class AIRequestLog(Base, TimestampMixin):
    __tablename__ = "ai_requests"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    query: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    source: Mapped[str] = mapped_column(String(32), default="live", nullable=False)
    model: Mapped[str | None] = mapped_column(String(128))
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    degraded: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class Conversation(Base, TimestampMixin):
    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    title: Mapped[str | None] = mapped_column(String(255))

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan"
    )


class Message(Base, TimestampMixin):
    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = _uuid_pk()
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")


class Job(Base, TimestampMixin):
    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="PENDING", nullable=False, index=True)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    result: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    # Сколько раз задачу брали в работу. Нужен, чтобы отличать временный сбой,
    # который стоит повторить, от терминального.
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Ключ идемпотентности уникален в границах пользователя: глобальная уникальность
    # позволяла бы одному пользователю получить чужую задачу, подобрав ключ.
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_jobs_user_idempotency"),
    )


class FileObject(Base, TimestampMixin):
    __tablename__ = "files"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    storage_key: Mapped[str] = mapped_column(String(512), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)


class KnowledgeDocument(Base, TimestampMixin):
    __tablename__ = "knowledge_documents"

    id: Mapped[uuid.UUID] = _uuid_pk()
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    source: Mapped[str | None] = mapped_column(String(512))
    lang: Mapped[str] = mapped_column(String(8), default="ru", nullable=False)
    # Категория: regulation / manual / tariff / faq … Retrieval умеет по ней
    # фильтровать, чтобы не искать регламент среди инструкций.
    kind: Mapped[str | None] = mapped_column(String(64))
    # Кто загрузил и кому виден. Без этих полей любой документ немедленно
    # становился общим для всех пользователей платформы.
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    visibility: Mapped[str] = mapped_column(
        String(16), default="private", nullable=False
    )
    meta: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    chunks: Mapped[list["KnowledgeChunk"]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )


class KnowledgeChunk(Base):
    __tablename__ = "knowledge_chunks"

    id: Mapped[uuid.UUID] = _uuid_pk()
    document_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("knowledge_documents.id", ondelete="CASCADE"), index=True, nullable=False
    )
    ord: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list[float]] = mapped_column(Vector(DIM), nullable=False)
    # Какой моделью получен вектор. Векторы разных моделей имеют одинаковую
    # размерность, но несравнимы: без этого поля смена провайдера эмбеддингов
    # молча превращала базу знаний в шум.
    embedding_model: Mapped[str] = mapped_column(
        String(64), default="local-hash-v1", nullable=False, index=True
    )
    meta: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    document: Mapped[KnowledgeDocument] = relationship(back_populates="chunks")


class SemanticCacheEntry(Base):
    __tablename__ = "semantic_cache"

    id: Mapped[uuid.UUID] = _uuid_pk()
    query_text: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list[float]] = mapped_column(Vector(DIM), nullable=False)
    response: Mapped[dict] = mapped_column(JSONB, nullable=False)
    context_key: Mapped[str] = mapped_column(String(512), nullable=False)
    context: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    prompt_version: Mapped[str] = mapped_column(String(32), default="v1", nullable=False)
    embedding_model: Mapped[str] = mapped_column(
        String(64), default="local-hash-v1", nullable=False
    )
    hit_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Токены, которые стоил оригинальный вызов модели. Каждое попадание в кэш
    # экономит ровно столько — метрика экономии считается по факту, а не по оценке.
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: _now() + timedelta(seconds=settings.SEMANTIC_CACHE_TTL),
        nullable=False,
    )

    __table_args__ = (
        Index(
            "ix_semantic_cache_lookup",
            "context_key",
            "prompt_version",
            "embedding_model",
            "expires_at",
        ),
    )


class Feedback(Base, TimestampMixin):
    """Оценка ответа пользователем.

    Замыкает петлю обратной связи: плохие ответы видны в метриках, а их запросы
    можно вытащить одним SELECT и превратить в правила `app/domain/rules.py`
    или в дополнительные документы базы знаний.
    """

    __tablename__ = "feedback"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    ai_request_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("ai_requests.id", ondelete="CASCADE"), index=True
    )
    rating: Mapped[int] = mapped_column(Integer, nullable=False)  # +1 / -1
    reason: Mapped[str | None] = mapped_column(Text)
