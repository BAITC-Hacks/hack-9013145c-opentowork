"""Солнечный потенциал крыш района: рейтинг зданий под панели."""

from typing import Literal

from fastapi import APIRouter, Query
from starlette.concurrency import run_in_threadpool

from app.deps import UserDep
from app.solar.model import district_rooftops

router = APIRouter(prefix="/solar", tags=["solar"])


@router.get("/rooftops")
async def rooftops(
    _: UserDep,
    city: Literal["astana", "almaty", "shymkent"] = Query(
        default="astana", description="Город; расчёт для указанного центрального района"
    ),
) -> dict:
    # Расчёт чистый CPU (~0.4 с) и кэшируется после первого вызова; в потоке —
    # чтобы первый запрос не блокировал event loop.
    return await run_in_threadpool(district_rooftops, city)
