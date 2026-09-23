import asyncio
import uuid

from fastapi import APIRouter, File, Request, UploadFile, status
from pydantic import BaseModel

from app.cache.ratelimit import check_rate_limit
from app.config import settings
from app.deps import RedisDep, SessionDep, UserDep, authorize_owner
from app.errors import NotFound, ValidationFailed
from app.files import storage
from app.models import FileObject

router = APIRouter(prefix="/files", tags=["files"])


class FileOut(BaseModel):
    file_id: str
    filename: str
    content_type: str
    size: int
    url: str | None = None


async def _read_capped(file: UploadFile, max_bytes: int) -> bytes:
    """Читает тело кусками и обрывается на превышении лимита.

    `await file.read()` без аргумента затягивал файл в память целиком и только
    потом сверялся с лимитом — то есть проверка срабатывала уже после того,
    как память была израсходована.
    """
    chunks: list[bytes] = []
    size = 0
    while chunk := await file.read(1024 * 1024):
        size += len(chunk)
        if size > max_bytes:
            raise ValidationFailed(
                f"File exceeds {settings.MAX_FILE_SIZE_MB} MB limit"
            )
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("", response_model=FileOut, status_code=status.HTTP_201_CREATED)
async def upload_file(
    request: Request,
    session: SessionDep,
    redis: RedisDep,
    user: UserDep,
    file: UploadFile = File(...),
) -> FileOut:
    await check_rate_limit(redis, f"upload:{user.id}", settings.RATE_LIMIT_USER)

    max_bytes = settings.MAX_FILE_SIZE_MB * 1024 * 1024
    # Объявленный Content-Length отсекаем до чтения вообще.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes:
        raise ValidationFailed(f"File exceeds {settings.MAX_FILE_SIZE_MB} MB limit")

    data = await _read_capped(file, max_bytes)
    content_type = storage.validate_upload(data, file.filename or "upload")
    # boto3 синхронный: прямой вызов из корутины вставал бы весь event loop
    # пода, а не один запрос.
    key = await asyncio.to_thread(
        storage.upload, data, file.filename or "upload", content_type
    )

    record = FileObject(
        user_id=user.id,
        storage_key=key,
        filename=file.filename or "upload",
        content_type=content_type,
        size=len(data),
    )
    session.add(record)
    await session.flush()

    return FileOut(
        file_id=str(record.id),
        filename=record.filename,
        content_type=record.content_type,
        size=record.size,
    )


@router.get("/{file_id}", response_model=FileOut)
async def get_file(file_id: uuid.UUID, session: SessionDep, user: UserDep) -> FileOut:
    record = await session.get(FileObject, file_id)
    if record is None:
        raise NotFound("File not found")
    authorize_owner(user, record.user_id)

    return FileOut(
        file_id=str(record.id),
        filename=record.filename,
        content_type=record.content_type,
        size=record.size,
        url=await asyncio.to_thread(storage.presigned_url, record.storage_key),
    )
