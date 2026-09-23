-- Выполняется один раз при инициализации пустого тома PostgreSQL.
-- Держим расширения здесь, а не только в миграциях: если эксперт поднимет
-- проект на чистой машине, всё заведётся даже до применения Alembic.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "vector";     -- pgvector: semantic cache + RAG
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- hybrid search (опционально)
