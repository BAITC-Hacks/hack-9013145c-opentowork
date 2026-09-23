"""Rebuild bundled reference curves: python scripts/build_wind_catalog.py."""

import csv
import io
import json
from pathlib import Path
from urllib.request import urlopen

REVISION = "191d8ca894d6d830997630fa3599f048d6e8c7b4"
BASE = f"https://raw.githubusercontent.com/wind-python/windpowerlib/{REVISION}"
SELECTED = {
    "GE100/2500": ("ge-100-2500", [75.0, 85.0]),
    "E-101/3050": ("enercon-e101-3050", [99.0, 124.0, 135.0, 149.0]),
    "E-126/7580": ("enercon-e126-7580", [127.0]),
}


def download(name: str) -> str:
    with urlopen(f"{BASE}/{name}", timeout=30) as response:  # noqa: S310
        return response.read().decode("utf-8")


def build(metadata_text: str, curves_text: str) -> dict:
    metadata = {r["turbine_type"]: r for r in csv.DictReader(io.StringIO(metadata_text))}
    curves = {r["turbine_type"]: r for r in csv.DictReader(io.StringIO(curves_text))}
    turbines = []
    for kind, (slug, heights) in SELECTED.items():
        row = metadata[kind]
        points = sorted((float(v), float(p) / 1000) for v, p in curves[kind].items()
                        if v != "turbine_type" and p)
        last_operating = max(v for v, p in points if p > 0)
        cutoff = min(v for v, p in points if v > last_operating and p == 0)
        notes = [
            "Каталожная кривая — предварительная оценка; комплектацию и климатический "
            "допуск для установки проверяет производитель.",
            f"Нулевая точка при сильном ветре в таблице: {cutoff:g} м/с. "
            "Плато продлено до этой границы; штормовой режим и перезапуск не моделируются.",
        ]
        rated = float(row["nominal_power"]) / 1000
        maximum = max(p for _, p in points)
        if maximum != rated:
            notes.append(f"Номинал каталога {rated:g} кВт, максимум кривой {maximum:g} кВт; "
                         "сохранены исходные значения, результат ограничен номиналом.")
        turbines.append({
            "id": slug, "name": f"{row['manufacturer']} {kind}",
            "manufacturer": row["manufacturer"], "rated_power_kw": rated,
            "rotor_diameter_m": float(row["rotor_diameter"]), "hub_heights_m": heights,
            "reference_density_kg_m3": 1.225, "high_wind_zero_ms": cutoff, "curve": points,
            "source_url": f"https://github.com/wind-python/windpowerlib/blob/{REVISION}"
                          "/windpowerlib/oedb/power_curves.csv",
            "metadata_source_url": f"https://github.com/wind-python/windpowerlib/blob/{REVISION}"
                                   "/windpowerlib/oedb/turbine_data.csv",
            "notes": notes,
        })
    return {"upstream_revision": REVISION, "turbines": turbines}


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1] / "app" / "wind"
    catalog = build(download("windpowerlib/oedb/turbine_data.csv"),
                    download("windpowerlib/oedb/power_curves.csv"))
    (root / "turbines.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (root / "UPSTREAM-LICENSE.txt").write_text(download("LICENSE"), encoding="utf-8")
    print(f"Saved {len(catalog['turbines'])} turbine curves from {REVISION}")
