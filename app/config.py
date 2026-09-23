from functools import lru_cache
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Значения, которые нельзя выпускать за пределы dev. Список сверяется
# на старте: приложение падает, а не работает с чужим известным секретом.
INSECURE_DEFAULTS = {
    "JWT_SECRET": {"change-me-in-production", "REPLACE_ME", ""},
    "S3_ACCESS_KEY": {"minioadmin", "REPLACE_ME", ""},
    "S3_SECRET_KEY": {"minioadmin", "REPLACE_ME", ""},
}
MIN_SECRET_LENGTH = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=True)

    APP_NAME: str = "hackalem-api"
    APP_ENV: Literal["dev", "staging", "prod"] = "dev"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = True
    WIND_WEATHER_URL: str = "https://api.open-meteo.com/v1/forecast"
    WIND_WEATHER_TIMEOUT_S: float = 20.0
    WIND_WEATHER_CACHE_TTL_S: int = 900
    WIND_WEATHER_CACHE_SIZE: int = 128
    # По умолчанию ВЫКЛЮЧЕН. Сид создаёт учётку с паролем из README — включать
    # только там, где это осознанно нужно (docker-compose, локальный кластер).
    SEED_ON_START: bool = False

    DATABASE_URL: str = "postgresql+asyncpg://app:app@localhost:5432/app"
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 5
    DB_POOL_TIMEOUT: int = 30

    REDIS_URL: str = "redis://localhost:6379/0"
    QUEUE_NAME: str = "ai_jobs"
    QUEUE_VISIBILITY_TIMEOUT: int = 600
    # Поток подрезается до этого размера, иначе Redis растёт до OOM.
    QUEUE_MAX_LEN: int = 100_000
    # Сколько задач воркер ведёт одновременно. Нагрузка упирается в ожидание
    # ответа модели, а не в процессор, поэтому одна задача за раз оставляла
    # event loop простаивать и превращала HPA в способ платить за простой.
    WORKER_CONCURRENCY: int = 8
    JOB_MAX_ATTEMPTS: int = 3
    JOB_RECOVERY_INTERVAL_S: int = 120

    S3_ENDPOINT: str = "http://localhost:9000"
    S3_BUCKET: str = "uploads"
    S3_ACCESS_KEY: str = "minioadmin"
    S3_SECRET_KEY: str = "minioadmin"
    S3_REGION: str = "us-east-1"
    MAX_FILE_SIZE_MB: int = 20

    LLM_MODE: Literal["live", "mock"] = "mock"
    LLM_PRIMARY: str = "anthropic:claude-sonnet-5"
    LLM_FALLBACK: str = "anthropic:claude-haiku-4-5-20251001"
    LLM_API_KEY: str = ""
    LLM_TIMEOUT_S: float = 30.0
    LLM_MAX_RETRIES: int = 2
    LLM_MAX_OUTPUT_TOKENS: int = 2048

    EMBEDDING_PROVIDER: str = "mock"
    EMBEDDING_MODEL: str = "text-embedding-3-small"
    EMBEDDING_DIM: int = 1536
    EMBEDDING_API_KEY: str = ""

    SEMANTIC_CACHE_ENABLED: bool = True
    SEMANTIC_CACHE_THRESHOLD: float = 0.92
    SEMANTIC_CACHE_TTL: int = 86400
    SEMANTIC_CACHE_MAX_ROWS: int = 50000
    EXACT_CACHE_TTL: int = 3600
    # ВАЖНО: любое поле контекста, по которому фильтруется retrieval
    # (`language`, `doc_kind` — см. RAGPipeline.retrieve), обязано быть здесь.
    # Иначе кэш отдаст ответ, построенный на другом наборе документов.
    CACHE_CONTEXT_FIELDS: str = "language,region,doc_kind"
    PROMPT_VERSION: str = "v1"

    # user   — ключ кэша включает владельца запроса (по умолчанию). Ответ,
    #          построенный на данных одного пользователя, не может уйти другому.
    # global — общий кэш на всю платформу, выше hit rate. Включать только когда
    #          доказано, что ответы строятся исключительно на общедоступных
    #          документах и не содержат ничего от конкретного пользователя.
    SEMANTIC_CACHE_SCOPE: Literal["global", "user"] = "user"
    CACHE_PURGE_INTERVAL_S: int = 300

    # Локальный хэш-эмбеддер даёт ту же разделимость, но в другой шкале:
    # парафраз ≈ 0.60, релевантный чанк ≈ 0.30, нерелевантное ≈ 0.00.
    # Поэтому в offline-режиме применяются отдельные пороги; при подключении
    # настоящей модели эмбеддингов автоматически берутся основные.
    SEMANTIC_CACHE_THRESHOLD_LOCAL: float = 0.50
    RAG_MIN_SIMILARITY_LOCAL: float = 0.20

    RAG_ENABLED: bool = True
    RAG_TOP_K: int = 5
    RAG_CANDIDATES: int = 20
    RAG_MIN_SIMILARITY: float = 0.5
    RAG_CHUNK_SIZE: int = 800
    RAG_CHUNK_OVERLAP: int = 120
    # Размер списка кандидатов HNSW. Должен превышать LIMIT тем сильнее, чем
    # избирательнее WHERE: фильтр применяется после обхода индекса.
    HNSW_EF_SEARCH: int = 200
    # Документ индексируется синхронно в запросе, поэтому размер ограничен.
    KNOWLEDGE_MAX_CHARS: int = 500_000

    VALIDATION_MAX_ATTEMPTS: int = 2
    INPUT_MAX_CHARS: int = 8000
    # context дословно уходит в промпт, поэтому ограничивается наравне с query.
    CONTEXT_MAX_CHARS: int = 2000
    INJECTION_GUARD_ENABLED: bool = True

    JWT_SECRET: str = "change-me-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 60
    REFRESH_EXPIRE_DAYS: int = 7
    CORS_ORIGINS: str = "http://localhost:3000,http://localhost:5173"

    RATE_LIMIT_ANON: int = 20
    RATE_LIMIT_USER: int = 100
    RATE_LIMIT_AI: int = 20
    RATE_LIMIT_LOGIN: int = 10
    # Живой пересчёт прогноза/объяснения ВЭС: модель + Open-Meteo, запусков в минуту.
    RATE_LIMIT_FORECAST_LIVE: int = 6

    LOG_LEVEL: str = "INFO"
    LOG_FORMAT: Literal["json", "console"] = "json"
    METRICS_ENABLED: bool = True
    # Сводка считается за окно, а не по всей истории таблицы.
    STATS_WINDOW_HOURS: int = 24

    # Почасовой ветер по координатам станции (направление, порывы, 10/100 м).
    # Для прошедших дат — архив прогнозов, чтобы не показывать факт как прогноз.
    WEATHER_FORECAST_URL: str = "https://api.open-meteo.com/v1/forecast"
    WEATHER_ARCHIVE_URL: str = "https://historical-forecast-api.open-meteo.com/v1/forecast"
    WEATHER_TIMEOUT: float = 8.0
    WEATHER_CACHE_SECONDS: int = 900

    DEMO_USER_EMAIL: str = "demo@demo.kz"
    DEMO_USER_PASSWORD: str = "demo1234"
    # НЕ ADMIN: роль ADMIN обходит проверку владельца в authorize_owner,
    # то есть публично известная демо-учётка читала бы данные всех пользователей.
    # EXPERT достаточно, чтобы наполнять базу знаний, и не даёт доступа к чужому.
    DEMO_USER_ROLE: Literal["USER", "OPERATOR", "EXPERT"] = "EXPERT"

    @model_validator(mode="after")
    def _forbid_insecure_defaults_outside_dev(self) -> "Settings":
        """Падать на старте, а не работать с общеизвестным секретом.

        JWT_SECRET подписывает токены симметрично (HS256). Значение из шаблона
        лежит в репозитории, поэтому любой, кто его видел, выпишет себе токен
        с произвольными `sub` и `role`. Раньше это принималось молча.
        """
        if self.APP_ENV == "dev":
            return self

        problems: list[str] = []
        for field, forbidden in INSECURE_DEFAULTS.items():
            value = getattr(self, field, "")
            if value in forbidden:
                problems.append(f"{field} оставлен значением по умолчанию")

        if len(self.JWT_SECRET) < MIN_SECRET_LENGTH:
            problems.append(
                f"JWT_SECRET короче {MIN_SECRET_LENGTH} символов "
                f"(сейчас {len(self.JWT_SECRET)})"
            )
        if self.SEED_ON_START:
            problems.append(
                "SEED_ON_START=true создаст учётку с паролем из README"
            )
        if self.LLM_MODE == "live" and not self.LLM_API_KEY:
            problems.append("LLM_MODE=live, но LLM_API_KEY пуст")

        if problems:
            listed = "".join(f"\n  - {problem}" for problem in problems)
            raise ValueError(
                f"Небезопасная конфигурация при APP_ENV={self.APP_ENV}:{listed}"
                "\nСгенерировать секрет: openssl rand -hex 32"
            )
        return self

    @property
    def uses_local_embeddings(self) -> bool:
        return not (self.EMBEDDING_PROVIDER == "openai" and bool(self.EMBEDDING_API_KEY))

    @property
    def cache_threshold(self) -> float:
        return (
            self.SEMANTIC_CACHE_THRESHOLD_LOCAL
            if self.uses_local_embeddings
            else self.SEMANTIC_CACHE_THRESHOLD
        )

    @property
    def rag_min_similarity(self) -> float:
        return (
            self.RAG_MIN_SIMILARITY_LOCAL
            if self.uses_local_embeddings
            else self.RAG_MIN_SIMILARITY
        )

    @property
    def cache_context_fields(self) -> list[str]:
        return sorted(f.strip() for f in self.CACHE_CONTEXT_FIELDS.split(",") if f.strip())

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
