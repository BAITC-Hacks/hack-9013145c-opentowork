"""feedback, честный учёт стоимости кэша, идемпотентность в границах пользователя

Revision ID: 0002
Revises: 0001
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Глобально уникальный ключ идемпотентности позволял одному пользователю
    # получить задачу другого, просто угадав ключ. Уникальность — по паре.
    op.execute("ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_idempotency_key_key")
    op.create_unique_constraint(
        "uq_jobs_user_idempotency", "jobs", ["user_id", "idempotency_key"]
    )

    # Реальная стоимость оригинального вызова: попадание в кэш экономит ровно её.
    op.add_column(
        "semantic_cache",
        sa.Column("prompt_tokens", sa.Integer, nullable=False, server_default="0"),
    )
    op.add_column(
        "semantic_cache",
        sa.Column("completion_tokens", sa.Integer, nullable=False, server_default="0"),
    )

    # Категория документа: позволяет ограничить retrieval нужным подмножеством
    # базы знаний (регламенты / инструкции / тарифы), а не искать по всему корпусу.
    op.add_column("knowledge_documents", sa.Column("kind", sa.String(64)))
    op.create_index(
        "ix_knowledge_documents_lang_kind", "knowledge_documents", ["lang", "kind"]
    )

    op.create_table(
        "feedback",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("ai_request_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("ai_requests.id", ondelete="CASCADE")),
        sa.Column("rating", sa.Integer, nullable=False),
        sa.Column("reason", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
    )
    op.create_index("ix_feedback_user_id", "feedback", ["user_id"])
    op.create_index("ix_feedback_ai_request_id", "feedback", ["ai_request_id"])


def downgrade() -> None:
    op.drop_table("feedback")
    op.drop_index("ix_knowledge_documents_lang_kind", table_name="knowledge_documents")
    op.drop_column("knowledge_documents", "kind")
    op.drop_column("semantic_cache", "completion_tokens")
    op.drop_column("semantic_cache", "prompt_tokens")
    op.drop_constraint("uq_jobs_user_idempotency", "jobs", type_="unique")
    op.create_unique_constraint(
        "jobs_idempotency_key_key", "jobs", ["idempotency_key"]
    )
