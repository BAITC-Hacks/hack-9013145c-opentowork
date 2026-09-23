import uuid
from collections.abc import AsyncGenerator
from typing import Annotated

import redis.asyncio as aioredis
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.security import decode_token
from app.config import settings
from app.db import get_session
from app.errors import Forbidden, Unauthorized
from app.models import User

_bearer = HTTPBearer(auto_error=False)
_redis: aioredis.Redis | None = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            socket_keepalive=True,
            health_check_interval=30,
        )
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


SessionDep = Annotated[AsyncSession, Depends(get_session)]
RedisDep = Annotated[aioredis.Redis, Depends(get_redis)]


async def current_user(
    session: SessionDep,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)] = None,
) -> User:
    if creds is None:
        raise Unauthorized("Missing bearer token")
    payload = decode_token(creds.credentials)
    user = await session.get(User, uuid.UUID(payload["sub"]))
    if user is None or not user.is_active:
        raise Unauthorized("User not found or inactive")
    return user


async def optional_user(
    session: SessionDep,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)] = None,
) -> User | None:
    if creds is None:
        return None
    try:
        return await current_user(session, creds)
    except Unauthorized:
        return None


UserDep = Annotated[User, Depends(current_user)]
OptionalUserDep = Annotated[User | None, Depends(optional_user)]

ROLE_ORDER = {"USER": 0, "OPERATOR": 1, "EXPERT": 2, "ADMIN": 3}


def require_role(minimum: str):
    async def _check(user: UserDep) -> User:
        if ROLE_ORDER.get(user.role, -1) < ROLE_ORDER[minimum]:
            raise Forbidden(f"Requires role {minimum} or higher")
        return user

    return _check


def authorize_owner(user: User, owner_id: uuid.UUID | None) -> None:
    """Владелец или ADMIN. Вызывать в сервисном слое, а не только в роутере.

    `owner_id=None` — объект осиротел (владельца удалили, FK со SET NULL).
    Такой объект доступен только ADMIN: раньше проверка владельца просто
    пропускалась, и файлы удалённого пользователя мог скачать кто угодно.
    """
    if user.role == "ADMIN":
        return
    if owner_id is None or user.id != owner_id:
        raise Forbidden("Not allowed to access this object")


async def get_request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "-")


async def lifespan_redis() -> AsyncGenerator[None, None]:
    yield
    await close_redis()
