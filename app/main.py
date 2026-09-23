import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import text

from app.ai.providers import close_http_client
from app.api.v1.router import api_router
from app.config import settings
from app.db import engine
from app.deps import close_redis, get_redis
from app.errors import register_error_handlers
from app.files.storage import ensure_bucket
from app.middleware import RequestContextMiddleware
from app.observability import log, setup_logging

setup_logging()


@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info(
        "app_startup",
        env=settings.APP_ENV,
        version=settings.APP_VERSION,
        llm_mode=settings.LLM_MODE,
        semantic_cache=settings.SEMANTIC_CACHE_ENABLED,
    )
    try:
        await asyncio.to_thread(ensure_bucket)
    except Exception as exc:
        log.warning("bucket_init_skipped", error=str(exc))
    yield
    await close_http_client()
    await close_redis()
    await engine.dispose()
    log.info("app_shutdown")


# В проде схема API наружу не отдаётся: она описывает все эндпоинты,
# параметры и формы запросов — бесплатная карта для атакующего.
_expose_docs = settings.APP_ENV != "prod" or settings.DEBUG

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    docs_url="/docs" if _expose_docs else None,
    redoc_url=None,
    openapi_url="/openapi.json" if _expose_docs else None,
    lifespan=lifespan,
)

app.add_middleware(RequestContextMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

register_error_handlers(app)
app.include_router(api_router)


@app.get("/health", tags=["system"])
async def health() -> dict:
    """Liveness: только «процесс жив».

    Внешние зависимости здесь намеренно не проверяются — иначе просадка БД
    заставит Kubernetes перезапускать поды вместо вывода их из балансировки.
    """
    return {"status": "ok", "version": settings.APP_VERSION, "env": settings.APP_ENV}


@app.get("/ready", tags=["system"])
async def ready() -> JSONResponse:
    checks: dict[str, bool] = {}

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["database"] = True
    except Exception as exc:
        log.warning("readiness_db_failed", error=str(exc))
        checks["database"] = False

    try:
        redis = await get_redis()
        await redis.ping()
        checks["redis"] = True
    except Exception as exc:
        log.warning("readiness_redis_failed", error=str(exc))
        checks["redis"] = False

    ok = all(checks.values())
    return JSONResponse({"ready": ok, "checks": checks}, status_code=200 if ok else 503)


@app.get("/metrics", tags=["system"])
async def metrics() -> PlainTextResponse:
    if not settings.METRICS_ENABLED:
        return PlainTextResponse("metrics disabled", status_code=404)
    return PlainTextResponse(generate_latest().decode(), media_type=CONTENT_TYPE_LATEST)
