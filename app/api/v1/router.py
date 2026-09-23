from fastapi import APIRouter

from app.api.v1 import (
    ai,
    auth,
    entities,
    files,
    forecast,
    jobs,
    knowledge,
    predictions,
    solar,
    stations,
    wind,
)

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(auth.router)
api_router.include_router(entities.router)
api_router.include_router(ai.router)
api_router.include_router(jobs.router)
api_router.include_router(files.router)
api_router.include_router(knowledge.router)
api_router.include_router(solar.router)
api_router.include_router(forecast.router)
api_router.include_router(stations.router)
api_router.include_router(predictions.router)
api_router.include_router(wind.router)
