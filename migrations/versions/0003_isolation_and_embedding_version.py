"""изоляция базы знаний, версия эмбеддера, счётчик попыток задачи

Revision ID: 0003
Revises: 0002
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Всё, что уже лежит в базе, получено локальным хэш-эмбеддером: до этой
# миграции другого варианта в проекте не было.
LEGACY_EMBEDDER = "local-hash-v1"


def upgrade() -> None:
    # Отличить временный сбой от терминального без этого поля было нельзя:
    # любая сетевая ошибка сразу делала задачу FAILED.
    op.add_column(
        "jobs", sa.Column("attempts", sa.Integer, nullable=False, server_default="0")
    )

    # Владелец и видимость документа. Раньше фильтра по владельцу в retrieval
    # не было вовсе — любой загруженный документ немедленно становился общим.
    op.add_column(
        "knowledge_documents",
        sa.Column(
            "owner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
        ),
    )
    op.add_column(
        "knowledge_documents",
        sa.Column("visibility", sa.String(16), nullable=False, server_default="private"),
    )
    # Уже существующие документы создавались как общая база знаний —
    # сохраняем это поведение явно, а не меняем смысл данных задним числом.
    op.execute("UPDATE knowledge_documents SET visibility = 'public'")
    op.create_index(
        "ix_knowledge_documents_owner", "knowledge_documents", ["owner_id", "visibility"]
    )

    # Векторы разных моделей имеют одинаковую размерность и несравнимы между
    # собой. Без дискриминатора смена провайдера эмбеддингов молча превращала
    # базу знаний и кэш в шум.
    op.add_column(
        "knowledge_chunks",
        sa.Column(
            "embedding_model",
            sa.String(64),
            nullable=False,
            server_default=LEGACY_EMBEDDER,
        ),
    )
    op.create_index(
        "ix_knowledge_chunks_embedding_model", "knowledge_chunks", ["embedding_model"]
    )
    op.add_column(
        "semantic_cache",
        sa.Column(
            "embedding_model",
            sa.String(64),
            nullable=False,
            server_default=LEGACY_EMBEDDER,
        ),
    )

    # Индекс поиска по кэшу теперь включает все поля фильтра, иначе planner
    # отбрасывает часть условий уже после обхода.
    op.drop_index("ix_semantic_cache_lookup", table_name="semantic_cache")
    op.create_index(
        "ix_semantic_cache_lookup",
        "semantic_cache",
        ["context_key", "prompt_version", "embedding_model", "expires_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_semantic_cache_lookup", table_name="semantic_cache")
    op.create_index(
        "ix_semantic_cache_lookup", "semantic_cache", ["context_key", "expires_at"]
    )
    op.drop_column("semantic_cache", "embedding_model")
    op.drop_index("ix_knowledge_chunks_embedding_model", table_name="knowledge_chunks")
    op.drop_column("knowledge_chunks", "embedding_model")
    op.drop_index("ix_knowledge_documents_owner", table_name="knowledge_documents")
    op.drop_column("knowledge_documents", "visibility")
    op.drop_column("knowledge_documents", "owner_id")
    op.drop_column("jobs", "attempts")
