import re
import uuid
from functools import lru_cache

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.config import settings
from app.errors import ValidationFailed
from app.observability import log

# Проверяем по сигнатуре файла, а не по расширению: расширение подделывается тривиально.
MAGIC_BYTES: list[tuple[bytes, str]] = [
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"%PDF", "application/pdf"),
    (b"PK\x03\x04", "application/zip"),
]


def detect_content_type(head: bytes) -> str | None:
    for signature, content_type in MAGIC_BYTES:
        if head.startswith(signature):
            return content_type
    if head[4:12] in (b"ftypavif", b"ftypheic", b"ftypmif1"):
        return "image/heic"
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_upload(data: bytes, filename: str) -> str:
    max_bytes = settings.MAX_FILE_SIZE_MB * 1024 * 1024
    if len(data) > max_bytes:
        raise ValidationFailed(f"File exceeds {settings.MAX_FILE_SIZE_MB} MB limit")
    if not data:
        raise ValidationFailed("Empty file")

    content_type = detect_content_type(data[:32])
    if content_type is None:
        raise ValidationFailed("Unsupported or unrecognized file type")
    return content_type


@lru_cache
def get_s3():
    return boto3.client(
        "s3",
        endpoint_url=settings.S3_ENDPOINT,
        aws_access_key_id=settings.S3_ACCESS_KEY,
        aws_secret_access_key=settings.S3_SECRET_KEY,
        region_name=settings.S3_REGION,
        config=Config(signature_version="s3v4"),
    )


def ensure_bucket() -> None:
    client = get_s3()
    try:
        client.head_bucket(Bucket=settings.S3_BUCKET)
    except ClientError:
        try:
            client.create_bucket(Bucket=settings.S3_BUCKET)
            log.info("bucket_created", bucket=settings.S3_BUCKET)
        except ClientError as exc:
            log.warning("bucket_create_failed", error=str(exc))


# Только то, что ломает ключ объекта или файловую систему. Белый список
# ASCII здесь не годится: он уничтожал кириллические имена целиком
# («отчёт.pdf» превращался в «pdf»), а это большинство файлов в проекте.
_PATH_SEP_RE = re.compile(r"[\\/]")
_UNSAFE_NAME_RE = re.compile(r'[\x00-\x1f\x7f"*:<>?|]+')


def safe_filename(filename: str) -> str:
    """Имя файла приходит от пользователя и уходит в ключ объекта.

    Без очистки туда попадают слэши и `..`, а значит структура ключей
    и presigned-ссылки управляются загружающим.
    """
    # Любой путь отбрасывается целиком — и POSIX, и Windows.
    name = _PATH_SEP_RE.split(filename)[-1]
    name = _UNSAFE_NAME_RE.sub("_", name).strip()
    # «.» и «..» — не имена файлов.
    if not name.strip("."):
        return "file"
    return name[:120]


def upload(data: bytes, filename: str, content_type: str) -> str:
    key = f"{uuid.uuid4().hex}/{safe_filename(filename)}"
    get_s3().put_object(
        Bucket=settings.S3_BUCKET, Key=key, Body=data, ContentType=content_type
    )
    return key


def presigned_url(key: str, expires_in: int = 3600) -> str:
    return get_s3().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.S3_BUCKET, "Key": key},
        ExpiresIn=expires_in,
    )
