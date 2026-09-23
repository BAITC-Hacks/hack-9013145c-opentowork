import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.config import settings
from app.errors import Unauthorized
from app.observability import log

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


# Хэш заведомо несуществующего пароля. Нужен, чтобы «пользователь не найден»
# стоил столько же времени, сколько «неверный пароль»: иначе время ответа
# выдаёт, зарегистрирован ли email.
_DUMMY_HASH = _hasher.hash("nonexistent-user-placeholder")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False
    except (VerificationError, InvalidHashError) as exc:
        # Битый хэш в базе — это не «неверный пароль», а поломка данных,
        # и раньше она молча пряталась за общим except Exception.
        log.error("password_hash_unusable", error=str(exc))
        return False


def waste_password_time() -> None:
    """Сжечь столько же времени, сколько занял бы настоящий verify."""
    try:
        _hasher.verify(_DUMMY_HASH, "wrong")
    except Exception:
        pass


def create_token(
    user_id: uuid.UUID, role: str, kind: Literal["access", "refresh"] = "access"
) -> str:
    now = datetime.now(UTC)
    lifetime = (
        timedelta(minutes=settings.JWT_EXPIRE_MINUTES)
        if kind == "access"
        else timedelta(days=settings.REFRESH_EXPIRE_DAYS)
    )
    payload = {
        "sub": str(user_id),
        "role": role,
        "type": kind,
        "iat": int(now.timestamp()),
        "exp": int((now + lifetime).timestamp()),
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str, expected: Literal["access", "refresh"] = "access") -> dict:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.ExpiredSignatureError as exc:
        raise Unauthorized("Token expired") from exc
    except jwt.PyJWTError as exc:
        raise Unauthorized("Invalid token") from exc

    if payload.get("type") != expected:
        raise Unauthorized("Wrong token type")
    return payload
