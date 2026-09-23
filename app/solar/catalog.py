"""Справочник СЭС Казахстана из JSON, который собирает scripts/fetch_solar_farms.py.

В БД не кладётся: пользовательских правок нет, а читать 26 записей из файла
дешевле, чем заводить миграцию.
"""

import json
from functools import lru_cache
from pathlib import Path

CATALOG = Path(__file__).parent / "data" / "kz_solar_farms.json"


@lru_cache(maxsize=1)
def solar_farms() -> list[dict]:
    if not CATALOG.exists():
        return []
    return json.loads(CATALOG.read_text(encoding="utf-8"))["farms"]


def solar_farm(station_id: str) -> dict | None:
    return next((f for f in solar_farms() if f["id"] == station_id), None)
