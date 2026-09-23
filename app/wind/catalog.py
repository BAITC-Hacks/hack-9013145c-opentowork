"""Загрузка справочника ВЭС из JSON, который собирает scripts/fetch_wind_farms.py."""

import json
from pathlib import Path

import sqlalchemy as sa

CATALOG = Path(__file__).parent / "data" / "kz_wind_farms.json"

FARM_COLUMNS = (
    "id",
    "name",
    "region",
    "operators",
    "capacity_mw",
    "capacity_source",
    "commissioned",
    "lat",
    "lon",
    "location",
    "osm",
    "in_registry",
    "data",
    "note",
)


def load_rows() -> tuple[list[dict], list[dict]]:
    farms = json.loads(CATALOG.read_text(encoding="utf-8"))["farms"]
    farm_rows = [{k: f[k] for k in FARM_COLUMNS} for f in farms]
    turbine_rows = [
        {
            "farm_id": f["id"],
            "unit_id": u["id"],
            "position": i,
            "lat": u["lat"],
            "lon": u["lon"],
            "rated_kw": u["rated_kw"],
            "model": u["model"],
            "osm": u["osm"],
        }
        for f in farms
        for i, u in enumerate(f["units"])
    ]
    return farm_rows, turbine_rows


def sync(connection: sa.Connection, farms: sa.Table, turbines: sa.Table) -> None:
    """Справочник заменяется целиком: пользовательских правок в нём нет."""
    farm_rows, turbine_rows = load_rows()
    connection.execute(turbines.delete())
    connection.execute(farms.delete())
    connection.execute(farms.insert(), farm_rows)
    if turbine_rows:
        connection.execute(turbines.insert(), turbine_rows)
