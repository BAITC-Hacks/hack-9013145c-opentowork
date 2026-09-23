"""Архив прогнозов погоды Open-Meteo (Previous Runs API) и доступ к нему «на момент времени».

`<var>_previous_dayN` в Open-Meteo — значение на час t, предсказанное выпуском примерно
за 24·N часов до t. Выпуск становится публичным не сразу, поэтому для прогноза,
выпущенного в момент T на горизонт h = t − T, допустим только день

    N(h) = ceil((h + NWP_PUBLICATION_DELAY_H) / 24)

— тогда выпуск инициализирован не позже t − 24N ≤ T − delay и гарантированно был
опубликован к T. Эта функция — единственное место, где решается, что «видно» модели;
тест утечек в tests/test_windcast_leakage.py проверяет её инвариант.
"""

from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
from functools import lru_cache

import numpy as np
import pandas as pd

from windcast.config import (
    NWP_MAX_DAY,
    NWP_MODELS,
    NWP_PUBLICATION_DELAY_H,
    NWP_VARIABLES,
    SITE_LAT,
    SITE_LON,
    WEATHER_DIR,
    WEATHER_END,
    WEATHER_START,
)

API_URL = "https://previous-runs-api.open-meteo.com/v1/forecast"


def day_for_horizon(h: int | np.ndarray) -> int | np.ndarray:
    """Какой «день назад» выпуска можно использовать на горизонте h без утечки."""
    if isinstance(h, np.ndarray):
        return np.ceil((h + NWP_PUBLICATION_DELAY_H) / 24).astype(int)
    return math.ceil((h + NWP_PUBLICATION_DELAY_H) / 24)


def latest_issue_bound(valid_time: pd.Timestamp, day: int) -> pd.Timestamp:
    """Верхняя граница момента, когда значение `day` для часа valid_time стало доступно."""
    return valid_time - pd.Timedelta(hours=24 * day) + pd.Timedelta(hours=NWP_PUBLICATION_DELAY_H)


def _url(model: str, start: str, end: str, lat: float, lon: float) -> str:
    hourly = [f"{v}_previous_day{d}" for v in NWP_VARIABLES for d in range(1, NWP_MAX_DAY + 1)]
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": ",".join(hourly),
        "models": model,
        "start_date": start,
        "end_date": end,
        "wind_speed_unit": "ms",
        "timezone": "GMT",
    }
    return f"{API_URL}?{urllib.parse.urlencode(params)}"


def fetch_model(
    model: str,
    start: str = WEATHER_START,
    end: str = WEATHER_END,
    lat: float = SITE_LAT,
    lon: float = SITE_LON,
    retries: int = 4,
) -> pd.DataFrame:
    url = _url(model, start, end, lat, lon)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310 — фиксированный https
                payload = json.load(resp)
            break
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2**attempt * 5)
    hourly = pd.DataFrame(payload["hourly"])
    hourly["time"] = pd.to_datetime(hourly["time"])
    hourly = hourly.set_index("time").dropna(axis=1, how="all")
    return hourly.astype("float32")


def cache_path(model: str):
    return WEATHER_DIR / f"{model}.parquet"


def download_all(models=NWP_MODELS, force: bool = False) -> dict[str, int]:
    WEATHER_DIR.mkdir(parents=True, exist_ok=True)
    stats = {}
    for model in models:
        path = cache_path(model)
        if path.exists() and not force:
            stats[model] = -1
            continue
        df = fetch_model(model)
        df.to_parquet(path)
        stats[model] = df.shape[1]
        time.sleep(1)
    return stats


@lru_cache(maxsize=1)
def load_archive() -> pd.DataFrame:
    """Все модели в одной таблице: колонки `<model>|<var>|d<N>`, индекс — час UTC."""
    frames = []
    for model in NWP_MODELS:
        path = cache_path(model)
        if not path.exists():
            continue
        df = pd.read_parquet(path)
        cols = {}
        for col in df.columns:
            var, day = col.rsplit("_previous_day", 1)
            cols[col] = f"{model}|{var}|d{day}"
        frames.append(df.rename(columns=cols))
    if not frames:
        raise FileNotFoundError(
            f"Нет кэша погоды в {WEATHER_DIR}. Запустите: python -m windcast weather"
        )
    return pd.concat(frames, axis=1).sort_index()


def nwp_by_day(day: int, archive: pd.DataFrame | None = None) -> pd.DataFrame:
    """Срез архива для одного «дня назад»: колонки `<model>|<var>`."""
    archive = load_archive() if archive is None else archive
    suffix = f"|d{day}"
    cols = [c for c in archive.columns if c.endswith(suffix)]
    return archive[cols].rename(columns=lambda c: c[: -len(suffix)])


def nwp_as_of(origin: pd.Timestamp, horizon: int = 48) -> pd.DataFrame:
    """Погода, доступная в момент origin, на часы origin+1 … origin+horizon.

    Для каждого часа берётся самый свежий допустимый выпуск (минимальный N(h)).
    Возвращает также `available_at` — верхнюю границу публикации использованного выпуска.
    """
    archive = load_archive()
    rows = []
    for h in range(1, horizon + 1):
        t = origin + pd.Timedelta(hours=h)
        day = day_for_horizon(h)
        sl = nwp_by_day(day, archive)
        values = sl.loc[t] if t in sl.index else pd.Series(np.nan, index=sl.columns)
        row = values.to_dict()
        row.update(
            {"time": t, "horizon_h": h, "nwp_day": day, "available_at": latest_issue_bound(t, day)}
        )
        rows.append(row)
    return pd.DataFrame(rows).set_index("time")


def coverage() -> pd.DataFrame:
    archive = load_archive()
    rows = []
    for model in NWP_MODELS:
        for day in range(1, NWP_MAX_DAY + 1):
            col = f"{model}|wind_speed_100m|d{day}"
            alt = f"{model}|wind_speed_10m|d{day}"
            use = col if col in archive else alt if alt in archive else None
            if use is None:
                continue
            s = archive[use].dropna()
            rows.append(
                {"model": model, "day": day, "var": use.split("|")[1], "first": s.index.min(),
                 "last": s.index.max(), "hours": len(s)}
            )
    return pd.DataFrame(rows)
