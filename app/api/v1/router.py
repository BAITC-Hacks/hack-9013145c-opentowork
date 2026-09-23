from fastapi import APIRouter

from app.api.v1 import ai, auth, entities, files, jobs, knowledge, solar

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(auth.router)
api_router.include_router(entities.router)
api_router.include_router(ai.router)
api_router.include_router(jobs.router)
api_router.include_router(files.router)
api_router.include_router(knowledge.router)
api_router.include_router(solar.router)
