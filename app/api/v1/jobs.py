import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Header, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.cache.ratelimit import check_rate_limit
from app.config import settings
from app.deps import RedisDep, SessionDep, UserDep, authorize_owner
from app.errors import Conflict, NotFound, ServiceUnavailable, ValidationFailed
from app.models import DomainEntity, Job
from app.observability import JOBS, log
from app.queue.redis_queue import JobQueue

router = APIRouter(tags=["jobs"])


class AnalysisIn(BaseModel):
    entity_id: str | None = None
    type: str = Field(default="generic_analysis", max_length=64)
    payload: dict = Field(default_factory=dict)


class JobOut(BaseModel):
    job_id: str
    status: str
    progress: int = 0
    result: dict = Field(default_factory=dict)
    error: str | None = None


@router.post("/analysis", response_model=JobOut, status_code=status.HTTP_202_ACCEPTED)
async def create_analysis(
    body: AnalysisIn,
    session: SessionDep,
    redis: RedisDep,
    user: UserDep,
    response: Response,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JobOut:
    await check_rate_limit(redis, f"analysis:{user.id}", settings.RATE_LIMIT_USER)

    payload = dict(body.payload)
    # entity_id приходит и полем, и внутри payload; воркер пишет Analysis по
    # значению из payload, поэтому проверяем именно то, что до него дойдёт.
    entity_id = body.entity_id or payload.get("entity_id")
    if entity_id:
        try:
            entity_uuid = uuid.UUID(str(entity_id))
        except ValueError as exc:
            raise ValidationFailed("entity_id: ожидается UUID") from exc
        entity = await session.get(DomainEntity, entity_uuid)
        if entity is None:
            raise NotFound("Entity not found")
        authorize_owner(user, entity.owner_id)
        payload["entity_id"] = str(entity_uuid)
    # Владелец нужен воркеру, чтобы изоляция кэша по пользователю действовала
    # и в асинхронном пути, а не только в синхронном.
    payload["user_id"] = str(user.id)

    values = {
        "id": uuid.uuid4(),
        "user_id": user.id,
        "type": body.type,
        "status": "PENDING",
        "payload": payload,
        "idempotency_key": idempotency_key,
    }

    if idempotency_key:
        # ON CONFLICT, а не SELECT-потом-INSERT: два одновременных запроса с
        # одним ключом раньше давали IntegrityError и 500 вместо возврата
        # уже созданной задачи.
        stmt = (
            pg_insert(Job)
            .values(**values)
            .on_conflict_do_nothing(index_elements=["user_id", "idempotency_key"])
            .returning(Job.id)
        )
        inserted_id = await session.scalar(stmt)
        if inserted_id is None:
            existing = await session.scalar(
                select(Job).where(
                    Job.idempotency_key == idempotency_key,
                    Job.user_id == user.id,
                )
            )
            if existing is not None:
                response.headers["Location"] = f"/api/v1/jobs/{existing.id}"
                return JobOut(
                    job_id=str(existing.id),
                    status=existing.status,
                    progress=existing.progress,
                    result=existing.result,
                    error=existing.error,
                )
            raise Conflict("Idempotency key is in use")
        job_id = inserted_id
    else:
        job = Job(**values)
        session.add(job)
        await session.flush()
        job_id = job.id

    # Сначала фиксируем строку, потом ставим в очередь. Обратный порядок
    # (как было) при откате транзакции оставлял в очереди сообщение на
    # несуществующую задачу.
    await session.commit()

    queue = JobQueue(redis)
    try:
        await queue.ensure_group()
        await queue.enqueue(job_id, body.type, payload)
    except Exception as exc:
        # Компенсация: задача существует, но в очередь не попала.
        # Её подберёт восстановительный проход воркера, а клиенту честно
        # сообщаем, что приём не удался.
        log.error("enqueue_failed", job_id=str(job_id), error=str(exc))
        raise ServiceUnavailable("Не удалось поставить задачу в очередь") from exc

    JOBS.labels(body.type, "PENDING").inc()
    response.headers["Location"] = f"/api/v1/jobs/{job_id}"
    return JobOut(job_id=str(job_id), status="PENDING", progress=0)


@router.get("/jobs/{job_id}", response_model=JobOut)
async def get_job(job_id: uuid.UUID, session: SessionDep, user: UserDep) -> JobOut:
    job = await session.get(Job, job_id)
    if job is None:
        raise NotFound("Job not found")
    authorize_owner(user, job.user_id)

    return JobOut(
        job_id=str(job.id),
        status=job.status,
        progress=job.progress,
        result=job.result,
        error=job.error,
    )


@router.delete("/jobs/{job_id}", response_model=JobOut)
async def cancel_job(job_id: uuid.UUID, session: SessionDep, user: UserDep) -> JobOut:
    job = await session.get(Job, job_id)
    if job is None:
        raise NotFound("Job not found")
    authorize_owner(user, job.user_id)
    if job.status in {"COMPLETED", "FAILED"}:
        raise Conflict(f"Job already finished with status {job.status}")

    job.status = "CANCELLED"
    job.finished_at = datetime.now(UTC)
    await session.flush()
    JOBS.labels(job.type, "CANCELLED").inc()
    return JobOut(job_id=str(job.id), status=job.status, progress=job.progress)
