from fastapi import APIRouter, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select

from app.auth.security import (
    create_token,
    decode_token,
    hash_password,
    verify_password,
    waste_password_time,
)
from app.cache.ratelimit import check_rate_limit, client_ip
from app.config import settings
from app.deps import RedisDep, SessionDep, UserDep
from app.errors import Conflict, Unauthorized
from app.models import User

router = APIRouter(tags=["auth"])


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    full_name: str | None = Field(default=None, max_length=255)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    id: str
    email: str
    full_name: str | None
    role: str


class RefreshIn(BaseModel):
    refresh_token: str


@router.post("/auth/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterIn, request: Request, session: SessionDep, redis: RedisDep
) -> TokenOut:
    await check_rate_limit(redis, f"register:ip:{client_ip(request)}", settings.RATE_LIMIT_ANON)

    existing = await session.scalar(select(User).where(User.email == body.email))
    if existing:
        raise Conflict("Email already registered")

    user = User(
        email=body.email,
        password_hash=hash_password(body.password),
        full_name=body.full_name,
        role="USER",
    )
    session.add(user)
    await session.flush()
    return TokenOut(
        access_token=create_token(user.id, user.role),
        refresh_token=create_token(user.id, user.role, "refresh"),
    )


@router.post("/auth/login", response_model=TokenOut)
async def login(
    body: LoginIn, request: Request, session: SessionDep, redis: RedisDep
) -> TokenOut:
    # Два измерения: по email — от подбора пароля к одному аккаунту,
    # по IP — от password spraying, когда один пароль пробуют по многим адресам.
    await check_rate_limit(redis, f"login:{body.email}", settings.RATE_LIMIT_LOGIN)
    await check_rate_limit(
        redis, f"login:ip:{client_ip(request)}", settings.RATE_LIMIT_LOGIN * 3
    )

    user = await session.scalar(select(User).where(User.email == body.email))
    if user is None:
        # Ответ должен занимать столько же времени, сколько при неверном пароле,
        # иначе по задержке видно, зарегистрирован ли email.
        waste_password_time()
        raise Unauthorized("Invalid email or password")
    if not verify_password(body.password, user.password_hash):
        raise Unauthorized("Invalid email or password")
    if not user.is_active:
        raise Unauthorized("User is inactive")

    return TokenOut(
        access_token=create_token(user.id, user.role),
        refresh_token=create_token(user.id, user.role, "refresh"),
    )


@router.post("/auth/refresh", response_model=TokenOut)
async def refresh(
    body: RefreshIn, request: Request, session: SessionDep, redis: RedisDep
) -> TokenOut:
    import uuid

    # Ключ по самому токену ничего не ограничивал: у каждой попытки он свой.
    await check_rate_limit(
        redis, f"refresh:ip:{client_ip(request)}", settings.RATE_LIMIT_ANON
    )

    payload = decode_token(body.refresh_token, expected="refresh")
    user = await session.get(User, uuid.UUID(payload["sub"]))
    if user is None or not user.is_active:
        raise Unauthorized("User not found or inactive")

    return TokenOut(
        access_token=create_token(user.id, user.role),
        refresh_token=create_token(user.id, user.role, "refresh"),
    )


@router.get("/users/me", response_model=UserOut)
async def me(user: UserDep) -> UserOut:
    return UserOut(
        id=str(user.id), email=user.email, full_name=user.full_name, role=user.role
    )
