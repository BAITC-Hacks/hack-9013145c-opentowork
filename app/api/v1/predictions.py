"""Прогнозы на реальной погоде: любая станция, любой момент, включая «сейчас».

Станция с историей турбин (Нурлы) считается обученной моделью windcast, остальные
ВЭС — ансамблем погодных моделей через кривую мощности, СЭС — по радиации.
Погода запрашивается у Open-Meteo на лету, поэтому эндпоинты требуют ML-стек
(extra [ml], ставится в Docker-образ) и доступ в интернет.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.deps import SessionDep, UserDep
from app.errors import NotFound, ServiceUnavailable, ValidationFailed
from app.models import WindFarm
from app.solar.catalog import solar_farm

router = APIRouter(prefix="/predictions", tags=["predictions"])


async def _call(fn, *args):
    try:
        result = await run_in_threadpool(fn, *args)
        if isinstance(result, dict) and "forecast_id" in result:
            from app.wind.forecast_store import remember

            remember(result)
        return result
    except (OSError, ValueError, KeyError) as exc:
        # Open-Meteo недоступен или ответил не тем форматом — не 500, а понятная причина.
        raise ServiceUnavailable(f"погодный сервис недоступен: {type(exc).__name__}") from exc
    except RuntimeError as exc:
        from windcast.agent.graph import AgentFailure

        if isinstance(exc, AgentFailure):
            raise ServiceUnavailable(str(exc)) from exc
        raise


def _origin(origin: str | None):
    import pandas as pd

    from windcast.live import now_origin

    if not origin or origin == "now":
        return now_origin()
    try:
        ts = pd.Timestamp(origin.rstrip("Z"))
    except ValueError as exc:
        raise ValidationFailed("origin: ожидается ISO-время или now") from exc
    if ts.tzinfo is not None:
        ts = ts.tz_convert("UTC").tz_localize(None)
    # Архив прогнозов Open-Meteo начинается с 2024 года, будущего выпуска ещё нет.
    if ts < pd.Timestamp("2024-01-05") or ts > now_origin():
        raise ValidationFailed("origin вне доступного архива прогнозов (с 2024 года до сейчас)")
    return ts.floor("h")


def _rated_mw(farm: WindFarm) -> float | None:
    units = sum(t.rated_kw or 0 for t in farm.turbines) / 1000
    return units or farm.capacity_mw


async def _farm(session, station_id: str) -> WindFarm:
    farm = await session.scalar(
        select(WindFarm).options(selectinload(WindFarm.turbines)).where(WindFarm.id == station_id)
    )
    if farm is None or farm.lat is None:
        raise NotFound("станция не найдена или у неё нет координат")
    return farm


@router.get("/run")
async def prediction_run(
    session: SessionDep,
    _: UserDep,
    station_id: str = Query(..., max_length=64),
    origin: str | None = Query(None, max_length=32),
    horizon: int = Query(48, ge=1, le=48),
    kind: str = Query("wind", pattern="^(wind|solar)$"),
    lat: float | None = Query(None, ge=-90, le=90),
    lon: float | None = Query(None, ge=-180, le=180),
    units: str = Query("", max_length=256),
) -> dict:
    """Прогноз станции. Координаты СЭС берутся из OSM-каталога; для точки вне
    каталога (виртуальная станция) их можно передать явно."""
    from windcast import live

    ts = _origin(origin)
    if kind == "solar":
        farm = solar_farm(station_id)
        if farm is not None:
            lat, lon = farm["lat"], farm["lon"]
            units = ",".join(u["id"] for u in farm["units"])
        if lat is None or lon is None:
            raise ValidationFailed("для СЭС нужны lat и lon")
        ids = [u for u in units.split(",") if u] or ["Б1"]
        return await _call(live.solar_run, lat, lon, ts, horizon, ids)

    farm = await _farm(session, station_id)
    ids = [t.unit_id for t in farm.turbines] or ["T1"]
    if farm.data == "history":
        return await _call(
            live.ml_run_cached, farm.lat, farm.lon, ts, horizon, "запуск из раздела прогнозов"
        )
    return await _call(live.curve_run, farm.lat, farm.lon, ts, horizon, ids)


@router.get("/overview")
async def overview(session: SessionDep, _: UserDep, horizon: int = Query(48, ge=6, le=48)) -> dict:
    """Живой прогноз по всем ВЭС с координатами: сутки выработки, пик, ветер сейчас."""
    from windcast import live

    farms = list(
        await session.scalars(
            select(WindFarm)
            .options(selectinload(WindFarm.turbines))
            .where(WindFarm.lat.is_not(None))
            .order_by(WindFarm.capacity_mw.desc().nulls_last(), WindFarm.name)
        )
    )
    series = await _call(live.curve_overview, [(f.lat, f.lon) for f in farms], horizon)
    ml = None
    case = next((f for f in farms if f.data == "history"), None)
    if case is not None:
        try:
            ml = await run_in_threadpool(
                live.ml_run_cached,
                case.lat,
                case.lon,
                live.now_origin(),
                horizon,
                "сводка прогнозов",
            )
        except Exception:  # noqa: BLE001 — сводка остаётся на кривой мощности
            ml = None

    stations = []
    for farm, s in zip(farms, series, strict=True):
        method = "curve"
        p50, p10, p90 = s["p50"], None, None
        wind, wdir = s["wind_speed"], s["wind_dir"]
        if farm is case and ml is not None:
            method = "ml"
            pts = ml["predictions"]
            p50 = [p["p50"] for p in pts]
            p10 = [p["p10"] for p in pts]
            p90 = [p["p90"] for p in pts]
            wind = [p["wind_speed"] for p in pts]
            wdir = [p["wind_dir"] for p in pts]
        rated = _rated_mw(farm)
        known = [v for v in p50[:24] if v is not None]
        peak_i = max(range(len(p50)), key=lambda i: p50[i] or 0) if p50 else 0
        stations.append(
            {
                "id": farm.id,
                "name": farm.name,
                "region": farm.region or "",
                "lat": farm.lat,
                "lon": farm.lon,
                "rated_mw": rated,
                "can_open": bool(farm.turbines),
                "method": method,
                "times": s["times"],
                "p50": p50,
                "p10": p10,
                "p90": p90,
                "wind_speed": wind,
                "wind_dir": wdir,
                "cf24": round(sum(known) / len(known), 4) if known else None,
                "mwh24": round(sum(known) * rated, 1) if known and rated else None,
                "peak_at": s["times"][peak_i] if p50 else None,
                "peak": p50[peak_i] if p50 else None,
            }
        )
    return {
        "origin": live.now_origin().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "horizon": horizon,
        "sources": {
            "ml": "windcast: каскад + прямая модель на Open-Meteo Previous Runs",
            "curve": "Open-Meteo Forecast (best match), ветер 100 м → кривая мощности Нурлы",
        },
        "ml_explanation": ml.get("explanation") if ml else None,
        "stations": stations,
    }
