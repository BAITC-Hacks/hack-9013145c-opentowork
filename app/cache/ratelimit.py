import time
import uuid

import redis.asyncio as aioredis
from fastapi import Request

from app.errors import RateLimited


def client_ip(request: Request) -> str:
    """IP клиента с учётом обратного прокси.

    Лимит только по email из тела запроса не мешает password spraying:
    атакующий перебирает пароль по множеству аккаунтов, и на каждый приходится
    по одной попытке. Ограничение по источнику закрывает именно это.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def check_rate_limit(
    redis: aioredis.Redis, key: str, limit: int, window_s: int = 60
) -> None:
    """Sliding window на Redis — общий для всех реплик API.

    In-memory лимит умножался бы на число подов, поэтому счётчик только в Redis.
    """
    now = time.time()
    redis_key = f"rl:{key}"
    pipe = redis.pipeline()
    pipe.zremrangebyscore(redis_key, 0, now - window_s)
    pipe.zadd(redis_key, {uuid.uuid4().hex: now})
    pipe.zcard(redis_key)
    pipe.expire(redis_key, window_s)
    _, _, count, _ = await pipe.execute()

    if count > limit:
        raise RateLimited(
            f"Rate limit exceeded: {limit} requests per {window_s}s",
            {"limit": limit, "window_s": window_s, "retry_after": window_s},
        )
