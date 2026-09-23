import logging
import sys
from contextvars import ContextVar

import structlog
from prometheus_client import Counter, Gauge, Histogram

from app.config import settings

request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")

SENSITIVE_KEYS = {
    "password", "password_hash", "token", "access_token", "refresh_token",
    "api_key", "llm_api_key", "secret", "authorization", "jwt_secret",
}


def redact(data: dict) -> dict:
    """Публичная обёртка над той же логикой — для ручного логирования словарей."""
    return _scrub(data)


def _add_request_id(_logger, _name, event_dict):
    event_dict["request_id"] = request_id_ctx.get()
    return event_dict


def _scrub(value, depth: int = 0):
    """Рекурсивно маскирует секреты. Плоская проверка пропускала вложенное:
    ключ внутри `context` или `payload` попадал в лог как есть."""
    if depth > 6:
        return value
    if isinstance(value, dict):
        return {
            k: ("***" if k.lower() in SENSITIVE_KEYS else _scrub(v, depth + 1))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_scrub(v, depth + 1) for v in value]
    return value


def _drop_sensitive(_logger, _name, event_dict):
    return _scrub(event_dict)


def setup_logging() -> None:
    logging.basicConfig(
        format="%(message)s", stream=sys.stdout, level=getattr(logging, settings.LOG_LEVEL, 20)
    )
    renderer = (
        structlog.processors.JSONRenderer()
        if settings.LOG_FORMAT == "json"
        else structlog.dev.ConsoleRenderer()
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            _add_request_id,
            _drop_sensitive,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, settings.LOG_LEVEL, 20)
        ),
        cache_logger_on_first_use=True,
    )


log = structlog.get_logger(service=settings.APP_NAME)


HTTP_REQUESTS = Counter(
    "http_requests_total", "HTTP requests", ["method", "path", "status"]
)
HTTP_LATENCY = Histogram(
    "http_request_duration_seconds", "HTTP latency", ["method", "path"]
)

AI_REQUESTS = Counter("ai_requests_total", "AI requests", ["source", "status"])
AI_LATENCY = Histogram("ai_latency_seconds", "AI stage latency", ["stage"])
AI_TOKENS = Counter("ai_tokens_total", "LLM tokens", ["model", "kind"])
AI_CACHE_HITS = Counter("ai_cache_hits_total", "Semantic cache hits", ["level"])
AI_CACHE_MISSES = Counter("ai_cache_misses_total", "Semantic cache misses")
AI_CACHE_SIMILARITY = Histogram(
    "ai_cache_similarity", "Similarity of cache lookups",
    buckets=[0.5, 0.7, 0.8, 0.85, 0.9, 0.92, 0.95, 0.97, 0.99, 1.0],
)
AI_VALIDATION_FAILURES = Counter(
    "ai_validation_failures_total", "Output validation failures", ["rule"]
)
AI_LLM_ERRORS = Counter("ai_llm_errors_total", "LLM provider errors", ["provider", "kind"])
AI_INJECTION_BLOCKED = Counter("ai_injection_blocked_total", "Blocked prompt injections")
AI_COST = Counter("ai_estimated_cost_usd_total", "Estimated LLM spend in USD")
AI_COST_SAVED = Counter("ai_estimated_cost_saved_usd_total", "Spend avoided via cache")

JOBS = Counter("jobs_total", "Jobs", ["type", "status"])
JOB_DURATION = Histogram("job_duration_seconds", "Job duration", ["type"])
# Gauge, а не Histogram: это мгновенное состояние очереди, по которому
# масштабируются воркеры. Раньше метрика была объявлена и ни разу не заполнена.
QUEUE_DEPTH = Gauge("queue_depth", "Задач ожидает обработки: невыданные + неподтверждённые")
