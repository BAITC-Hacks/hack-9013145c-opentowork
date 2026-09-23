import json
import uuid

import redis.asyncio as aioredis

from app.config import settings
from app.observability import log

GROUP = "workers"


class JobQueue:
    """Очередь на Redis Streams: at-least-once, с подтверждением и переносом зависших.

    At-least-once обеспечивается тем, что `ack` вызывается только после успешной
    обработки. Неподтверждённое сообщение остаётся в PEL и через
    `QUEUE_VISIBILITY_TIMEOUT` забирается `reclaim_stale` — это и есть механизм
    повторной попытки. Исчерпавшие лимит попыток уходят в отдельный поток
    несработавших задач, а не теряются.
    """

    def __init__(self, redis: aioredis.Redis, stream: str | None = None):
        self.redis = redis
        self.stream = stream or settings.QUEUE_NAME
        self.dead_stream = f"{self.stream}:dead"

    async def ensure_group(self) -> None:
        try:
            await self.redis.xgroup_create(self.stream, GROUP, id="0", mkstream=True)
        except aioredis.ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    async def enqueue(self, job_id: uuid.UUID | str, job_type: str, payload: dict) -> str:
        message_id = await self.redis.xadd(
            self.stream,
            {
                "job_id": str(job_id),
                "type": job_type,
                "payload": json.dumps(payload, ensure_ascii=False),
            },
            # Без ограничения поток растёт бесконечно: XACK убирает запись из
            # списка необработанных, но не из самого потока, и Redis доходит
            # до OOM. approximate=True — подрезка по границе блока, она дешёвая.
            maxlen=settings.QUEUE_MAX_LEN,
            approximate=True,
        )
        log.info("job_enqueued", job_id=str(job_id), type=job_type, message_id=message_id)
        return message_id

    async def read(self, consumer: str, count: int = 1, block_ms: int = 5000) -> list[tuple]:
        try:
            entries = await self.redis.xreadgroup(
                GROUP, consumer, {self.stream: ">"}, count=count, block=block_ms
            )
        except aioredis.TimeoutError:
            # Истёк блокирующий таймаут — задач просто нет, это не ошибка.
            return []
        if not entries:
            return []
        return entries[0][1]

    async def reclaim_stale(self, consumer: str, min_idle_ms: int | None = None) -> list[tuple]:
        """Забирает задачи умершего воркера, иначе они висят вечно.

        Этот же путь работает как повтор: задача, которую не подтвердили
        из-за временной ошибки, вернётся сюда по истечении таймаута.
        """
        min_idle = min_idle_ms or settings.QUEUE_VISIBILITY_TIMEOUT * 1000
        _, messages, _ = await self.redis.xautoclaim(
            self.stream, GROUP, consumer, min_idle_time=min_idle, start_id="0-0", count=10
        )
        if messages:
            log.warning("jobs_reclaimed", count=len(messages))
        return messages

    async def delivery_count(self, message_id: str) -> int:
        """Сколько раз сообщение уже выдавалось потребителям.

        Redis считает это сам — хранить счётчик попыток отдельно не нужно.
        """
        pending = await self.redis.xpending_range(
            self.stream, GROUP, min=message_id, max=message_id, count=1
        )
        return int(pending[0]["times_delivered"]) if pending else 1

    async def ack(self, message_id: str) -> None:
        await self.redis.xack(self.stream, GROUP, message_id)

    async def dead_letter(self, message_id: str, fields: dict, reason: str) -> None:
        """Терминально несработавшая задача — в отдельный поток, а не в никуда."""
        await self.redis.xadd(
            self.dead_stream,
            {**fields, "reason": reason[:500], "original_id": message_id},
            maxlen=settings.QUEUE_MAX_LEN,
            approximate=True,
        )
        await self.ack(message_id)
        log.error("job_dead_lettered", message_id=message_id, reason=reason[:200])

    async def depth(self) -> int:
        """Сколько задач ждёт обработки: невыданные + взятые, но не подтверждённые.

        XLEN не подходит: он считает все записи за всё время, включая давно
        обработанные, и автомасштабирование по нему залипло бы на максимуме.
        """
        try:
            groups = await self.redis.xinfo_groups(self.stream)
        except aioredis.ResponseError:
            return 0
        for group in groups:
            if group.get("name") == GROUP:
                lag = group.get("lag") or 0
                pending = group.get("pending") or 0
                return int(lag) + int(pending)
        return 0
