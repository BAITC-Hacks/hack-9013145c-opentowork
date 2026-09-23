import asyncio
import json
import os
import signal
import socket
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select, text

from app.ai.embedder import build_embedder
from app.ai.orchestrator import AIOrchestrator
from app.ai.providers import build_provider, close_http_client
from app.ai.schemas import AIRequest
from app.cache.semantic import SemanticCache
from app.config import settings
from app.db import SessionLocal
from app.deps import get_redis
from app.errors import AIProviderError
from app.models import Analysis, Job
from app.observability import JOB_DURATION, JOBS, QUEUE_DEPTH, log, setup_logging
from app.queue.redis_queue import JobQueue
from app.rag.pipeline import RAGPipeline

ALIVE_FILE = Path("/tmp/worker_alive")
_shutdown = asyncio.Event()

# Ошибки, которые имеет смысл повторить: сеть, таймаут, временная недоступность
# провайдера. Всё остальное повторять бессмысленно — это дефект данных или кода.
RETRYABLE = (AIProviderError, TimeoutError, ConnectionError, OSError)


TERMINAL = {"COMPLETED", "FAILED", "CANCELLED"}

# Захват задачи одним UPDATE: два воркера с одним сообщением (reclaim при долгой
# обработке) не могут оба перевести её в PROCESSING. Зависшую PROCESSING после
# падения воркера можно забрать, когда аренда старше таймаута видимости.
CLAIM_SQL = text(
    """
    UPDATE jobs
    SET status = 'PROCESSING', progress = 10, attempts = attempts + 1, updated_at = now()
    WHERE id = :id
      AND (status = 'PENDING'
           OR (status = 'PROCESSING'
               AND updated_at < now() - make_interval(secs => :lease)))
    RETURNING attempts
    """
)


def _handle_signal(*_):
    log.info("worker_shutdown_requested")
    _shutdown.set()


async def handle_job(job_id: str, job_type: str, payload: dict) -> bool:
    """Обработка одной задачи. Возвращает True, если её можно подтвердить.

    False означает «повторить»: сообщение остаётся неподтверждённым и вернётся
    через `reclaim_stale` по истечении таймаута видимости.
    """
    started = time.perf_counter()

    async with SessionLocal() as session:
        attempts = await session.scalar(
            CLAIM_SQL,
            {"id": uuid.UUID(job_id), "lease": settings.QUEUE_VISIBILITY_TIMEOUT * 0.9},
        )
        await session.commit()
        if attempts is None:
            status = await session.scalar(
                select(Job.status).where(Job.id == uuid.UUID(job_id))
            )
            if status is None:
                log.warning("job_not_found", job_id=job_id)
                return True
            if status in TERMINAL:
                # Повторная доставка после сохранения результата, но до XACK:
                # модель второй раз не зовём, Analysis не дублируем.
                log.info("job_already_final_skip", job_id=job_id, status=status)
                return True
            # Задачу держит другой воркер. Не подтверждаем: он сам сделает XACK
            # по этому же сообщению, а если умрёт — аренда истечёт.
            log.info("job_claimed_elsewhere_skip", job_id=job_id)
            return False

    try:
        async with SessionLocal() as session:
            redis = await get_redis()
            embedder = build_embedder()
            orchestrator = AIOrchestrator(
                llm=build_provider(),
                embedder=embedder,
                cache=SemanticCache(session, redis, embedder.model_name),
                rag=RAGPipeline(session, embedder),
            )

            query = payload.get("query") or f"Выполни анализ типа {job_type}"
            result = await orchestrator.run(
                AIRequest(
                    query=query,
                    context=payload.get("context", {}),
                    # Без владельца изоляция кэша по пользователю не работала
                    # в асинхронном пути: задача уходила в общий раздел кэша.
                    user_id=payload.get("user_id"),
                )
            )

            job = await session.get(Job, uuid.UUID(job_id), with_for_update=True)
            # Задачу могли отменить, пока работала модель, или её забрал другой
            # воркер после истечения аренды — тогда писать результат не нам.
            if not _still_ours(job, attempts):
                log.info("job_left_processing_skip", job_id=job_id, status=job.status)
                await session.commit()
                # Задачу держит новый воркер — подтверждать сообщение будет он.
                return job.status != "PROCESSING"

            job.progress = 90
            job.result = {
                "answer": result.answer.model_dump(mode="json"),
                "meta": result.meta.model_dump(mode="json"),
            }

            if entity_id := payload.get("entity_id"):
                session.add(
                    Analysis(
                        entity_id=uuid.UUID(entity_id),
                        type=job_type,
                        status="completed",
                        result=result.answer.model_dump(mode="json"),
                        model=result.meta.model,
                        confidence=result.answer.confidence,
                        needs_expert_review=result.answer.needs_expert_review,
                    )
                )

            job.status = "COMPLETED"
            job.progress = 100
            job.finished_at = datetime.now(UTC)
            await session.commit()

        JOBS.labels(job_type, "COMPLETED").inc()
        log.info("job_completed", job_id=job_id, type=job_type, attempts=attempts)
        return True

    except RETRYABLE as exc:
        # Транзиентная ошибка: НЕ подтверждаем, задача вернётся через reclaim.
        # Раньше любая такая ошибка делала задачу терминально FAILED.
        if attempts < settings.JOB_MAX_ATTEMPTS:
            log.warning(
                "job_retry_scheduled", job_id=job_id, attempt=attempts, error=str(exc)
            )
            async with SessionLocal() as session:
                job = await session.get(Job, uuid.UUID(job_id), with_for_update=True)
                if _still_ours(job, attempts):
                    job.status = "PENDING"
                    job.error = f"попытка {attempts}: {str(exc)[:500]}"
                    await session.commit()
            JOBS.labels(job_type, "RETRY").inc()
            return False
        await _mark_failed(job_id, f"исчерпаны попытки ({attempts}): {exc}", attempts)
        JOBS.labels(job_type, "FAILED").inc()
        return True

    except Exception as exc:
        log.exception("job_failed", job_id=job_id, error=str(exc))
        await _mark_failed(job_id, str(exc), attempts)
        JOBS.labels(job_type, "FAILED").inc()
        return True

    finally:
        JOB_DURATION.labels(job_type).observe(time.perf_counter() - started)


def _still_ours(job: Job | None, attempts: int) -> bool:
    """Аренда наша, пока задача в PROCESSING с нашим номером попытки.

    Номер попытки — fencing token: воркер, чья аренда истекла, не перетрёт
    ни результат, ни статус того, кто забрал задачу после него."""
    return job is not None and job.status == "PROCESSING" and job.attempts == attempts


async def _mark_failed(job_id: str, error: str, attempts: int) -> None:
    async with SessionLocal() as session:
        job = await session.get(Job, uuid.UUID(job_id), with_for_update=True)
        # Отмену, чужую аренду и уже сохранённый результат не перетираем ошибкой.
        if _still_ours(job, attempts):
            job.status = "FAILED"
            job.error = error[:2000]
            job.finished_at = datetime.now(UTC)
            await session.commit()


async def process_message(queue: JobQueue, message_id: str, fields: dict) -> None:
    """Обработать сообщение и решить его судьбу: подтвердить, повторить или отбросить."""
    try:
        payload = json.loads(fields.get("payload", "{}"))
    except json.JSONDecodeError as exc:
        await queue.dead_letter(message_id, fields, f"битый payload: {exc}")
        return

    delivered = await queue.delivery_count(message_id)
    if delivered > settings.JOB_MAX_ATTEMPTS:
        await queue.dead_letter(
            message_id, fields, f"выдавалось {delivered} раз без успеха"
        )
        return

    if await handle_job(fields["job_id"], fields["type"], payload):
        await queue.ack(message_id)


async def purge_cache_if_due(last_purge: float, redis) -> float:
    """Чистка просроченного кэша живёт в воркере, а не в API.

    API должен оставаться stateless и одинаковым во всех репликах; фоновая
    уборка в нём привязала бы работу к конкретному поду.

    Блокировка нужна, чтобы тяжёлую сортировку таблицы делал один воркер,
    а не все двадцать одновременно.
    """
    if time.monotonic() - last_purge < settings.CACHE_PURGE_INTERVAL_S:
        return last_purge

    lock_acquired = await redis.set(
        "lock:cache_purge", "1", nx=True, ex=settings.CACHE_PURGE_INTERVAL_S
    )
    if not lock_acquired:
        return time.monotonic()

    try:
        async with SessionLocal() as session:
            await SemanticCache(session, redis).purge_expired()
            await session.commit()
    except Exception as exc:
        log.warning("cache_purge_failed", error=str(exc))
    return time.monotonic()


RECOVER_SQL = text(
    """
    SELECT id, type, payload FROM jobs
    WHERE status = 'PENDING'
      AND attempts = 0
      AND created_at < now() - make_interval(secs => :age)
    LIMIT 50
    """
)


async def recover_orphaned_jobs(queue: JobQueue, last_run: float) -> float:
    """Возвращает в очередь задачи, которые в неё не попали.

    Строка задачи фиксируется до постановки в очередь. Если процесс умер
    между этими шагами, задача навсегда осталась бы в PENDING без сообщения.
    """
    if time.monotonic() - last_run < settings.JOB_RECOVERY_INTERVAL_S:
        return last_run
    try:
        async with SessionLocal() as session:
            rows = (
                await session.execute(
                    RECOVER_SQL, {"age": settings.JOB_RECOVERY_INTERVAL_S}
                )
            ).mappings().all()
            for row in rows:
                await queue.enqueue(row["id"], row["type"], row["payload"] or {})
                log.warning("orphaned_job_requeued", job_id=str(row["id"]))
    except Exception as exc:
        log.warning("job_recovery_failed", error=str(exc))
    return time.monotonic()


async def run_worker() -> None:
    setup_logging()
    consumer = f"{socket.gethostname()}-{os.getpid()}"
    redis = await get_redis()
    queue = JobQueue(redis)
    await queue.ensure_group()
    concurrency = max(1, settings.WORKER_CONCURRENCY)
    log.info(
        "worker_started", consumer=consumer, stream=queue.stream, concurrency=concurrency
    )
    last_purge = time.monotonic()
    last_recovery = time.monotonic()

    while not _shutdown.is_set():
        await asyncio.to_thread(ALIVE_FILE.touch)
        try:
            last_purge = await purge_cache_if_due(last_purge, redis)
            last_recovery = await recover_orphaned_jobs(queue, last_recovery)
            QUEUE_DEPTH.set(await queue.depth())

            messages = await queue.reclaim_stale(consumer)
            if not messages:
                messages = await queue.read(consumer, count=concurrency, block_ms=5000)

            # Задачи почти всё время ждут ответа модели, а не считают.
            # Последовательная обработка оставляла event loop простаивать и
            # упирала пропускную способность пода в одну задачу за раз.
            if messages:
                await asyncio.gather(
                    *(process_message(queue, mid, fields) for mid, fields in messages),
                    return_exceptions=True,
                )
        except Exception as exc:
            log.exception("worker_loop_error", error=str(exc))
            await asyncio.sleep(2)

    await close_http_client()
    log.info("worker_stopped", consumer=consumer)


def main() -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handle_signal)
    loop.run_until_complete(run_worker())


if __name__ == "__main__":
    main()
