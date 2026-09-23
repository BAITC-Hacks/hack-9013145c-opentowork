"""Константы площадки и протокола прогноза. Всё, что меняется при переносе на другую ВЭС."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASETS = ROOT / "datasets"
ARTIFACTS = ROOT / "artifacts"
WEATHER_DIR = ARTIFACTS / "weather"
MODELS_DIR = ARTIFACTS / "models"
FORECASTS_DIR = ARTIFACTS / "forecasts"
REPORTS_DIR = ARTIFACTS / "reports"


@dataclass(frozen=True)
class Turbine:
    id: str
    name: str
    lat: float
    lon: float
    csv: str


TURBINES = (
    Turbine("T1", "Турбина 1", 43.645150, 78.535604, "turbine_1.csv"),
    Turbine("T2", "Турбина 2", 43.643198, 78.538828, "turbine_2.csv"),
)

# Турбины в ~400 м друг от друга — одна ячейка любой глобальной погодной модели,
# поэтому погоду берём в одной точке, посередине.
SITE_LAT = round(sum(t.lat for t in TURBINES) / len(TURBINES), 4)
SITE_LON = round(sum(t.lon for t in TURBINES) / len(TURBINES), 4)

# Время в CSV — местное UTC+5. Сдвиг найден по максимуму корреляции
# измеренного ветра с прогнозом Open-Meteo в GMT (лаг 5 ч, r=0.68 против ≤0.6 на соседних).
SCADA_UTC_OFFSET_H = 5

# Задержка публикации выпуска погодной модели: выпуск 00 UTC становится доступен
# примерно через 4–6 ч. Берём верхнюю границу — так утечка будущего исключена.
NWP_PUBLICATION_DELAY_H = 6

HORIZON_H = 48

# Погодные модели Open-Meteo, у которых есть архив «прошлых выпусков» для этой точки
# (проверено запросом 23.09.2026). Первые пять дают ветер на высоте ступицы.
NWP_MODELS = (
    "ecmwf_aifs025_single",
    "ecmwf_ifs025",
    "icon_seamless",
    "gfs_seamless",
    "ukmo_seamless",
    "gem_seamless",
    "cma_grapes_global",
)

NWP_VARIABLES = (
    "wind_speed_10m",
    "wind_speed_80m",
    "wind_speed_100m",
    "wind_speed_120m",
    "wind_direction_100m",
    "wind_direction_10m",
    "wind_gusts_10m",
    "temperature_2m",
    "relative_humidity_2m",
    "surface_pressure",
)

# Сколько «суток назад» выпусков тянуть: для горизонта 48 ч с задержкой 6 ч нужен день 3.
NWP_MAX_DAY = 3

# Период, за который есть архив прогнозов (Open-Meteo хранит с января 2024).
WEATHER_START = "2024-01-01"
# С запасом: последний выпуск тестового периода (27.02 00 UTC) смотрит до 01.03 00 UTC.
WEATHER_END = "2026-03-02"

# Тестовый период кейса: выпуски с 31.01 по 27.02 включительно.
TEST_FIRST_ORIGIN = "2026-01-31"
TEST_LAST_ORIGIN = "2026-02-27"
