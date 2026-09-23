"""Справочник станций для выбора на карте. Сейчас только ВЭС."""

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.deps import SessionDep, UserDep
from app.errors import NotFound
from app.models import WindFarm

router = APIRouter(prefix="/stations", tags=["stations"])


class UnitOut(BaseModel):
    id: str
    name: str
    lat: float
    lon: float
    rated_mw: float | None
    model: str | None


class StationOut(BaseModel):
    id: str
    kind: str = "wind"
    name: str
    region: str
    lat: float | None
    lon: float | None
    location: str | None
    units: list[UnitOut]
    data: str
    note: str | None
    capacity_mw: float | None
    capacity_source: str | None
    operators: list[str]
    commissioned: str | None
    in_registry: bool
    osm: str | None


def _out(f: WindFarm) -> StationOut:
    return StationOut(
        id=f.id,
        name=f.name,
        region=f.region or "",
        lat=f.lat,
        lon=f.lon,
        location=f.location,
        units=[
            UnitOut(
                id=t.unit_id,
                name=f"Турбина {t.unit_id.removeprefix('T')}",
                lat=t.lat,
                lon=t.lon,
                rated_mw=t.rated_kw / 1000 if t.rated_kw else None,
                model=t.model,
            )
            for t in f.turbines
        ],
        data=f.data,
        note=f.note,
        capacity_mw=f.capacity_mw,
        capacity_source=f.capacity_source,
        operators=f.operators,
        commissioned=f.commissioned,
        in_registry=f.in_registry,
        osm=f.osm,
    )


@router.get("", response_model=list[StationOut])
async def list_stations(session: SessionDep, _: UserDep) -> list[StationOut]:
    # Сначала станции с данными, затем крупные — так список читается сверху вниз.
    farms = await session.scalars(
        select(WindFarm)
        .options(selectinload(WindFarm.turbines))
        .order_by(
            (WindFarm.data == "none"),
            WindFarm.lat.is_(None),
            WindFarm.capacity_mw.desc().nulls_last(),
            WindFarm.name,
        )
    )
    return [_out(f) for f in farms]


@router.get("/{station_id}", response_model=StationOut)
async def get_station(station_id: str, session: SessionDep, _: UserDep) -> StationOut:
    farm = await session.scalar(
        select(WindFarm).options(selectinload(WindFarm.turbines)).where(WindFarm.id == station_id)
    )
    if farm is None:
        raise NotFound("station not found")
    return _out(farm)
