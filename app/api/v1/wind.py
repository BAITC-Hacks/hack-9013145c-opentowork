from fastapi import APIRouter

from app.deps import UserDep
from app.wind.model import simulate
from app.wind.schemas import (
    ReferenceTurbine,
    SimulationRequest,
    SimulationResponse,
    TurbineSpec,
)
from app.wind.turbines import reference_catalog, resolve_turbine, turbine_catalog
from app.wind.weather import fetch_weather

router = APIRouter(prefix="/wind", tags=["wind simulation"])


@router.get("/turbine-models", response_model=list[TurbineSpec])
async def models(_: UserDep):
    return turbine_catalog()


@router.get("/reference-turbines", response_model=list[ReferenceTurbine])
async def reference_models(_: UserDep):
    """Оборудование действующих ВЭС Казахстана: паспорт и источник, без расчёта выработки."""
    return reference_catalog()


@router.post("/simulate", response_model=SimulationResponse)
async def simulation(request: SimulationRequest, _: UserDep):
    resolve_turbine(request)
    weather = await fetch_weather(request.latitude, request.longitude, request.horizon_hours)
    return simulate(request, weather)
