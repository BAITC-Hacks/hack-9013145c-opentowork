"""Прогноз выработки ВЭС: отдаёт результаты агента windcast фронтенду.

API не тянет ML-стек: агент и модели запускаются через `python -m windcast ...`,
а сюда попадают готовые артефакты (JSON) из artifacts/. Так образ API остаётся
лёгким, а прогноз, показанный на демо, — ровно тот, что лежит в репозитории.
Живой пересчёт включается `WINDCAST_LIVE=1`, если в окружении установлен extra [ml].
"""

import json
import os
from copy import deepcopy
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app.errors import NotFound, ValidationFailed
from windcast.config import FORECASTS_DIR, MODELS_DIR, REPORTS_DIR, TURBINES

router = APIRouter(tags=["forecast"])


def _read(path: Path) -> dict | list:
    if not path.exists():
        raise NotFound(f"нет артефакта {path.name} — запустите python -m windcast test-period")
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=64)
def _day(day: str) -> dict | None:
    path = FORECASTS_DIR / f"{day}.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


@lru_cache(maxsize=1)
def _backtest_runs() -> dict:
    path = FORECASTS_DIR / "backtest_runs.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _normalize_origin(origin: str) -> str:
    try:
        dt = datetime.fromisoformat(origin.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationFailed("origin: ожидается дата ISO 8601") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _with_versions(doc: dict, chosen: dict) -> dict:
    out = dict(chosen)
    out["versions"] = [
        {
            "forecast_origin": v["forecast_origin"],
            "published": v["published"],
            "revision": v["facts"].get("revision", {}),
            "points": [
                {"forecast_for": p["forecast_for"], "p50": p["p50"]} for p in v["predictions"]
            ],
        }
        for v in doc["versions"]
        if "skipped" not in v
    ]
    out.pop("facts", None)
    out["facts"] = chosen.get("facts", {})
    return out


def _find_run(origin_iso: str) -> dict:
    day = origin_iso[:10]
    doc = _day(day)
    if doc:
        runs = [v for v in doc["versions"] if "skipped" not in v]
        exact = [v for v in runs if v["forecast_origin"] == origin_iso]
        if exact:
            return _with_versions(doc, exact[0])
        published = [v for v in runs if v["published"] and v["forecast_origin"] <= origin_iso]
        if published:
            return _with_versions(doc, published[-1])
    bt = _backtest_runs().get(origin_iso)
    if bt:
        return deepcopy(bt)
    raise NotFound(f"нет прогноза на момент {origin_iso}")


class Turbine(BaseModel):
    id: str
    name: str
    lat: float
    lon: float


@router.get("/turbines", response_model=list[Turbine])
async def turbines() -> list[Turbine]:
    return [Turbine(id=t.id, name=t.name, lat=t.lat, lon=t.lon) for t in TURBINES]


@router.get("/forecast/latest")
async def forecast_latest(
    origin: str = Query(..., max_length=32),
    horizon: int = Query(48, ge=1, le=48),
    station_id: str = Query("nurly", max_length=64),
) -> dict:
    if station_id != "nurly":
        raise NotFound("Эта модель обучена только для Нурлы")
    return _trim(_find_run(_normalize_origin(origin)), horizon)


def _trim(run: dict, horizon: int) -> dict:
    run = deepcopy(run)
    run["predictions"] = run["predictions"][:horizon]
    run["horizon"] = len(run["predictions"])
    return run


@router.get("/forecast/days")
async def forecast_days() -> list:
    return _read(FORECASTS_DIR / "index.json")


class RunIn(BaseModel):
    station_id: str = Field(default="nurly", max_length=64)
    forecast_origin: str = Field(max_length=32)
    horizon: int = Field(default=48, ge=1, le=48)


def _live_run(origin_iso: str, horizon: int) -> dict:
    import pandas as pd

    from windcast.agent import graph
    from windcast.agent.runner import _load_or_train, forecast_run_json

    run = graph.run(
        _load_or_train(),
        pd.Timestamp(origin_iso.rstrip("Z")),
        horizon,
        reason="ручной запуск из интерфейса",
    )
    doc = forecast_run_json(run, horizon)
    doc["live"] = True
    from app.wind.forecast_store import remember

    return remember(doc)


@router.post("/forecast/run")
async def forecast_run(body: RunIn) -> dict:
    if body.station_id != "nurly":
        raise NotFound("Эта модель обучена только для Нурлы")
    origin_iso = _normalize_origin(body.forecast_origin)
    if os.getenv("WINDCAST_LIVE") == "1":
        try:
            return await run_in_threadpool(_live_run, origin_iso, body.horizon)
        except ImportError:
            pass  # ML-стек не установлен — отдаём сохранённый прогон агента
    run = _trim(_find_run(origin_iso), body.horizon)
    run["live"] = False
    return run


@router.get("/metrics")
async def metrics() -> dict:
    return _read(REPORTS_DIR / "backtest_frontend.json")


@router.get("/metrics/full")
async def metrics_full() -> dict:
    return _read(REPORTS_DIR / "backtest_summary.json")


class SimulationIn(BaseModel):
    forecast_id: str = Field(max_length=64)
    wind_change_pct: float = Field(ge=-50, le=50)
    horizon: int = Field(default=48, ge=1, le=48)


@lru_cache(maxsize=1)
def _curve() -> tuple[list[float], list[float]]:
    data = _read(MODELS_DIR / "power_curve.json")
    return data["ws"], data["power"]


def _interp(x: float, xs: list[float], ys: list[float]) -> float:
    if x <= xs[0]:
        return ys[0]
    for i in range(1, len(xs)):
        if x <= xs[i]:
            w = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
            return ys[i - 1] + w * (ys[i] - ys[i - 1])
    return ys[-1]


@router.post("/simulation")
async def simulation(body: SimulationIn) -> dict:
    """What-if: «а если ветер будет на X% сильнее прогноза» — через кривую мощности станции."""
    run = _trim(find_by_id(body.forecast_id), body.horizon)
    return await run_in_threadpool(simulate_run, run, body.wind_change_pct)


def find_by_id(forecast_id: str) -> dict:
    from app.wind.forecast_store import recalled

    recent = recalled(forecast_id)
    if recent is not None:
        return recent
    for path in sorted(FORECASTS_DIR.glob("2026-*.json")):
        doc = _day(path.stem)
        for v in doc["versions"] if doc else []:
            if v.get("forecast_id") == forecast_id:
                return deepcopy(v)
    for v in _backtest_runs().values():
        if v.get("forecast_id") == forecast_id:
            return deepcopy(v)
    raise NotFound("Прогноз не найден. Обновите прогноз и повторите запрос.")


def simulate_run(run: dict, wind_change_pct: float) -> dict:
    if run.get("method") == "solar":
        raise ValidationFailed("Сценарий изменения ветра доступен только для ВЭС")
    xs, ys = _curve()
    k = 1 + wind_change_pct / 100
    pts = []
    for p in run["predictions"]:
        # Сдвигаем прогноз на разницу кривой, чтобы сохранить поправки модели сверх кривой.
        delta = _interp(p["wind_speed"] * k, xs, ys) - _interp(p["wind_speed"], xs, ys)
        pts.append(
            {
                "forecast_for": p["forecast_for"],
                "p50": round(min(1.0, max(0.0, p["p50"] + delta)), 4),
            }
        )
    return {
        "scenario": f"ветер {wind_change_pct:+.0f}% к прогнозу",
        "base_energy": round(sum(p["p50"] for p in run["predictions"]), 2),
        "scenario_energy": round(sum(p["p50"] for p in pts), 2),
        "points": pts,
    }
