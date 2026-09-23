"""CRUD доменных сущностей.

ПЕРЕИМЕНОВАТЬ ПОД КЕЙС 23.09: entities → farms / patients / shipments / vacancies.
Структура (список с курсором, проверка владельца, JSONB-атрибуты) остаётся той же.
"""

import base64
import binascii
import uuid
from datetime import datetime

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select, tuple_

from app.deps import SessionDep, UserDep, authorize_owner
from app.errors import NotFound, ValidationFailed
from app.models import DomainEntity

router = APIRouter(prefix="/entities", tags=["entities"])


class EntityIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    kind: str | None = Field(default=None, max_length=64)
    attributes: dict = Field(default_factory=dict)


class EntityPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    kind: str | None = Field(default=None, max_length=64)
    attributes: dict | None = None


class EntityOut(BaseModel):
    id: str
    name: str
    kind: str | None
    attributes: dict
    created_at: str


class EntityPage(BaseModel):
    items: list[EntityOut]
    next_cursor: str | None = None
    has_more: bool = False


def _encode_cursor(entity: DomainEntity) -> str:
    raw = f"{entity.created_at.isoformat()}|{entity.id}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        created_at, _, entity_id = raw.rpartition("|")
        return datetime.fromisoformat(created_at), uuid.UUID(entity_id)
    except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
        raise ValidationFailed("Invalid cursor") from exc


def _to_out(entity: DomainEntity) -> EntityOut:
    return EntityOut(
        id=str(entity.id),
        name=entity.name,
        kind=entity.kind,
        attributes=entity.attributes,
        created_at=entity.created_at.isoformat(),
    )


@router.get("", response_model=EntityPage)
async def list_entities(
    session: SessionDep,
    user: UserDep,
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = None,
) -> EntityPage:
    stmt = (
        select(DomainEntity)
        .where(DomainEntity.owner_id == user.id)
        .order_by(DomainEntity.created_at.desc(), DomainEntity.id.desc())
        .limit(limit + 1)
    )
    # Keyset, а не OFFSET: страница не «съезжает», когда во время листания
    # добавляется новая запись, и запрос не деградирует на длинном списке.
    if cursor:
        created_at, entity_id = _decode_cursor(cursor)
        stmt = stmt.where(
            tuple_(DomainEntity.created_at, DomainEntity.id) < (created_at, entity_id)
        )

    rows = list((await session.scalars(stmt)).all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    return EntityPage(
        items=[_to_out(row) for row in rows],
        next_cursor=_encode_cursor(rows[-1]) if rows and has_more else None,
        has_more=has_more,
    )


@router.post("", response_model=EntityOut, status_code=status.HTTP_201_CREATED)
async def create_entity(body: EntityIn, session: SessionDep, user: UserDep) -> EntityOut:
    entity = DomainEntity(
        owner_id=user.id, name=body.name, kind=body.kind, attributes=body.attributes
    )
    session.add(entity)
    await session.flush()
    return _to_out(entity)


@router.get("/{entity_id}", response_model=EntityOut)
async def get_entity(entity_id: uuid.UUID, session: SessionDep, user: UserDep) -> EntityOut:
    entity = await session.get(DomainEntity, entity_id)
    if entity is None:
        raise NotFound("Entity not found")
    authorize_owner(user, entity.owner_id)
    return _to_out(entity)


@router.patch("/{entity_id}", response_model=EntityOut)
async def update_entity(
    entity_id: uuid.UUID, body: EntityPatch, session: SessionDep, user: UserDep
) -> EntityOut:
    entity = await session.get(DomainEntity, entity_id)
    if entity is None:
        raise NotFound("Entity not found")
    authorize_owner(user, entity.owner_id)

    # exclude_unset, а не exclude_none: иначе явно переданный null неотличим
    # от непереданного поля, и очистить `kind` через PATCH было невозможно.
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(entity, field, value)
    await session.flush()
    return _to_out(entity)


@router.delete("/{entity_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entity(entity_id: uuid.UUID, session: SessionDep, user: UserDep) -> None:
    entity = await session.get(DomainEntity, entity_id)
    if entity is None:
        raise NotFound("Entity not found")
    authorize_owner(user, entity.owner_id)
    await session.delete(entity)
