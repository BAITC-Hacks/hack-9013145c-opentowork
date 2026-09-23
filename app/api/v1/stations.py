"""Справочник станций для выбора на карте. Сейчас только ВЭС."""

from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.deps import SessionDep, UserDep
from app.errors import NotFound, ValidationFailed
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


class UnitSample(BaseModel):
    ts: str
    power: float
    wind_speed: float | None


def _scada_history(unit_id: str, start: str, end: str) -> list[UnitSample]:
    import pandas as pd

    from windcast.scada import load_hourly

    s = load_hourly(unit_id)
    lo = pd.Timestamp(start.rstrip("Z"))
    hi = pd.Timestamp(end.rstrip("Z"))
    s = s[(s.index >= lo) & (s.index < hi) & s["power"].notna()]
    return [
        UnitSample(
            ts=t.strftime("%Y-%m-%dT%H:%M:%SZ"),
            power=round(float(r["power"]), 4),
            wind_speed=None if pd.isna(r["ws"]) else round(float(r["ws"]), 2),
        )
        for t, r in s.iterrows()
    ]


@router.get("/{station_id}/units/{unit_id}/history", response_model=list[UnitSample])
async def unit_history(
    station_id: str,
    unit_id: str,
    session: SessionDep,
    _: UserDep,
    start: str = Query(..., alias="from", max_length=32),
    end: str = Query(..., alias="to", max_length=32),
) -> list[UnitSample]:
    """Фактическая почасовая SCADA турбины. Есть только у станции из датасета кейса."""
    from windcast.config import TURBINES

    farm = await session.get(WindFarm, station_id)
    if farm is None or farm.data != "history" or unit_id not in {t.id for t in TURBINES}:
        raise NotFound("у этого агрегата нет фактических данных")
    try:
        return await run_in_threadpool(_scada_history, unit_id, start, end)
    except ValueError as exc:
        raise ValidationFailed("from/to: ожидается ISO-время") from exc
