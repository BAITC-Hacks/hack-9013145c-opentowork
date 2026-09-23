"""Данные турбин: 10-минутные записи → почасовой ряд в UTC с флагами качества.

Цель модели — «доступная мощность» при данной погоде. Часы, где турбина стояла или
была ограничена при хорошем ветре, погодой не объясняются, поэтому помечаются и
исключаются из обучения, а не вычищаются молча.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np
import pandas as pd

from windcast.config import DATASETS, SCADA_UTC_OFFSET_H, TURBINES

COLUMNS = ["id", "time_local", "ws", "power", "temp"]
MIN_SAMPLES_PER_HOUR = 4  # из 6 десятиминуток


def load_raw(turbine_id: str) -> pd.DataFrame:
    turbine = next(t for t in TURBINES if t.id == turbine_id)
    df = pd.read_csv(DATASETS / turbine.csv)
    df.columns = COLUMNS
    df["time_local"] = pd.to_datetime(df["time_local"])
    df = df.drop(columns="id").drop_duplicates("time_local").sort_values("time_local")
    df["time"] = df["time_local"] - pd.Timedelta(hours=SCADA_UTC_OFFSET_H)
    return df.set_index("time").drop(columns="time_local")


def to_hourly(raw: pd.DataFrame) -> pd.DataFrame:
    # Метка часа — начало интервала: 10:00 = среднее за 10:00–10:50.
    grouped = raw.resample("1h")
    hourly = grouped.mean()
    hourly["n_samples"] = grouped["power"].count()
    hourly.loc[hourly["n_samples"] < MIN_SAMPLES_PER_HOUR, ["ws", "power", "temp"]] = np.nan
    return hourly


def empirical_power_curve(ws: pd.Series, power: pd.Series, step: float = 0.5) -> pd.Series:
    """Медиана мощности по бинам скорости — робастна к простоям внутри бина."""
    bins = (ws / step).round() * step
    return power.groupby(bins).median()


def flag_quality(hourly: pd.DataFrame) -> pd.DataFrame:
    df = hourly.copy()
    valid = df["power"].notna() & df["ws"].notna()
    curve = empirical_power_curve(df.loc[valid, "ws"], df.loc[valid, "power"])
    expected = np.interp(df["ws"].fillna(0), curve.index.values, curve.values)
    df["expected_power"] = np.where(valid, expected, np.nan)

    # Простой: ветра достаточно для выработки, а её нет.
    df["downtime"] = valid & (df["ws"] >= 4.5) & (df["power"] <= 0.02)
    # Ограничение/частичная недоступность: заметно ниже кривой при рабочем ветре.
    df["curtailed"] = (
        valid & ~df["downtime"] & (df["ws"].between(5, 20)) & (df["power"] < expected - 0.3)
    )
    df["missing"] = ~valid
    df["usable"] = valid & ~df["downtime"] & ~df["curtailed"]
    return df


@lru_cache(maxsize=4)
def load_hourly(turbine_id: str) -> pd.DataFrame:
    return flag_quality(to_hourly(load_raw(turbine_id)))


def load_all() -> pd.DataFrame:
    """Длинный формат: (time, turbine) → поля. Удобно для одной модели на обе турбины."""
    frames = []
    for t in TURBINES:
        df = load_hourly(t.id).copy()
        df["turbine"] = t.id
        frames.append(df)
    return pd.concat(frames).reset_index().set_index(["time", "turbine"]).sort_index()


def quality_report() -> pd.DataFrame:
    rows = []
    for t in TURBINES:
        df = load_hourly(t.id)
        rows.append(
            {
                "turbine": t.id,
                "hours": len(df),
                "first_utc": df.index.min(),
                "last_utc": df.index.max(),
                "missing_pct": round(100 * df["missing"].mean(), 2),
                "downtime_pct": round(100 * df["downtime"].mean(), 2),
                "curtailed_pct": round(100 * df["curtailed"].mean(), 2),
                "usable_pct": round(100 * df["usable"].mean(), 2),
                "mean_power": round(df.loc[df["usable"], "power"].mean(), 3),
            }
        )
    return pd.DataFrame(rows)


if __name__ == "__main__":
    print(quality_report().to_string(index=False))
