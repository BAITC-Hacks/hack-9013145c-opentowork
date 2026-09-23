"""Собирает каталог солнечных электростанций Казахстана из OpenStreetMap.

Запускается один раз вручную, результат лежит в репозитории: проверка
проекта не должна зависеть от внешних API (п. 5.6.6).

    python3 scripts/fetch_solar_farms.py

Источник — OSM через Overpass API (ODbL): контуры `power=plant` +
`plant:source=solar`, мощность из `plant:output:electricity`. Реестр
Минэнерго по СЭС не сопоставлялся — операторы и мощности только те, что
внесены в OSM.

Отдельных блоков панелей в OSM у большинства станций нет, поэтому блоки —
условное деление реального контура на четыре части: точка блока — центр
части контура, доля мощности — доля площади. Это помечено в `note`.
"""

import json
import math
import re
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "app" / "solar" / "data" / "kz_solar_farms.json"
UA = {"User-Agent": "hackalem-opentowork/0.1 (hackathon)"}
# Основной сервер под нагрузкой отдаёт HTML вместо JSON — пробуем по очереди.
OVERPASS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]
KZ_AREA = 'area["ISO3166-1"="KZ"][admin_level=2]->.kz;'
GRID = 40  # точек сетки по стороне контура для оценки площади частей
# В OSM помечены как солнечные, но по названию это не СЭС.
EXCLUDE = {"way/1470801660"}  # Zaisanskaya HPS


def overpass(query: str, attempts: int = 4) -> list[dict]:
    body = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(1, attempts + 1):
        for url in OVERPASS:
            try:
                req = urllib.request.Request(url, data=body, headers=UA)
                with urllib.request.urlopen(req, timeout=240) as resp:
                    doc = json.loads(resp.read())
                # При перегрузке сервер отвечает 200 с пустым списком и ошибкой в remark.
                if "error" in doc.get("remark", ""):
                    raise OSError(doc["remark"])
                return doc["elements"]
            except (OSError, json.JSONDecodeError) as exc:
                print(f"  {url}: {exc}")
        time.sleep(10 * attempt)
    raise RuntimeError("Overpass недоступен")


def ring(element: dict) -> list[tuple[float, float]]:
    if element["type"] == "way":
        return [(p["lat"], p["lon"]) for p in element["geometry"]]
    # У мультиполигона берём самый длинный внешний контур — для блоков хватает.
    outers = [
        [(p["lat"], p["lon"]) for p in m["geometry"]]
        for m in element.get("members", [])
        if m.get("role") == "outer" and m.get("geometry")
    ]
    return max(outers, key=len) if outers else []


def inside(pt: tuple[float, float], r: list[tuple[float, float]]) -> bool:
    y, x = pt
    hit = False
    for (y1, x1), (y2, x2) in zip(r, r[1:] + r[:1], strict=True):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def area_ha(r: list[tuple[float, float]]) -> float:
    lat0 = sum(p[0] for p in r) / len(r)
    kx = math.cos(math.radians(lat0)) * 111_320
    ky = 110_540
    s = sum(
        (a[1] * kx) * (b[0] * ky) - (b[1] * kx) * (a[0] * ky)
        for a, b in zip(r, r[1:] + r[:1], strict=True)
    )
    return abs(s) / 2 / 10_000


def mw(tags: dict) -> float | None:
    m = re.match(r"^\s*([\d.]+)\s*(kW|MW|MWp|kWp)\s*$", tags.get("plant:output:electricity", ""))
    if not m:
        return None
    return float(m[1]) / (1000 if m[2].startswith("k") else 1)


def blocks(r: list[tuple[float, float]]) -> list[dict]:
    """Четыре блока: контур делится по медианам широты и долготы точек внутри него."""
    lats = [p[0] for p in r]
    lons = [p[1] for p in r]
    grid = [
        (
            min(lats) + (i + 0.5) * (max(lats) - min(lats)) / GRID,
            min(lons) + (j + 0.5) * (max(lons) - min(lons)) / GRID,
        )
        for i in range(GRID)
        for j in range(GRID)
    ]
    pts = [p for p in grid if inside(p, r)]
    if not pts:
        return []
    mid_lat = sorted(p[0] for p in pts)[len(pts) // 2]
    mid_lon = sorted(p[1] for p in pts)[len(pts) // 2]
    parts = [
        [p for p in pts if (p[0] >= mid_lat) == north and (p[1] < mid_lon) == west]
        for north in (True, False)
        for west in (True, False)
    ]
    out = []
    for n, part in enumerate((p for p in parts if p), start=1):
        share = len(part) / len(pts)
        out.append(
            {
                "id": f"Б{n}",
                "lat": round(sum(p[0] for p in part) / len(part), 6),
                "lon": round(sum(p[1] for p in part) / len(part), 6),
                "share": share,
            }
        )
    return out


def main() -> None:
    print("OSM: контуры СЭС…")
    plants = overpass(
        f"[out:json][timeout:180];{KZ_AREA}"
        'nwr["power"="plant"]["plant:source"="solar"](area.kz);out geom;'
    )
    plants = [p for p in plants if f"{p['type']}/{p['id']}" not in EXCLUDE and len(ring(p)) > 3]

    farms = []
    for p in plants:
        r = ring(p)
        tags = p["tags"]
        cap = mw(tags)
        farms.append(
            {
                "osm": f"{p['type']}/{p['id']}",
                "name": tags.get("name:ru") or tags.get("name"),
                "operators": [tags["operator"]] if tags.get("operator") else [],
                "capacity_mw": cap,
                "capacity_source": "osm" if cap else None,
                "commissioned": (tags.get("start_date") or "")[:4] or None,
                "lat": round(sum(q[0] for q in r) / len(r), 5),
                "lon": round(sum(q[1] for q in r) / len(r), 5),
                "area_ha": round(area_ha(r), 1),
                "units": blocks(r),
            }
        )

    print("OSM: области…")
    regions = overpass(
        "[out:json][timeout:180];"
        + "".join(
            f'is_in({f["lat"]},{f["lon"]})->.a{i};area.a{i}["admin_level"="4"];out tags;'
            for i, f in enumerate(farms)
        )
    )
    # По одной области на запрос; если ответ не сошёлся по длине — область не пишем.
    if len(regions) == len(farms):
        for f, a in zip(farms, regions, strict=True):
            f["region"] = a["tags"].get("name:ru") or a["tags"].get("name")

    print("OSM: населённые пункты…")
    places = [
        {
            "name": n["tags"].get("name:ru") or n["tags"].get("name"),
            "lat": n["lat"],
            "lon": n["lon"],
        }
        for n in overpass(
            f'[out:json][timeout:180];{KZ_AREA}node["place"~"^(city|town|village)$"](area.kz);out;'
        )
        if n["tags"].get("name:ru") or n["tags"].get("name")
    ]
    for f in farms:
        f["place"] = min(
            places, key=lambda n: math.hypot(n["lat"] - f["lat"], (n["lon"] - f["lon"]) * 0.7)
        )["name"]

    # Где мощности в OSM нет, оцениваем по площади контура: медиана МВт/га по
    # станциям, у которых мощность указана. Источник помечается как "area".
    density = sorted(f["capacity_mw"] / f["area_ha"] for f in farms if f["capacity_mw"])
    mw_per_ha = density[len(density) // 2]
    for f in farms:
        if not f["capacity_mw"]:
            f["capacity_mw"] = round(f["area_ha"] * mw_per_ha, 1)
            f["capacity_source"] = "area"
        for u in f["units"]:
            u["rated_kw"] = round(f["capacity_mw"] * u.pop("share") * 1000)

    out = []
    for f in sorted(
        farms, key=lambda f: (f["capacity_source"] != "osm", -f["capacity_mw"], f["name"] or "")
    ):
        place = f.pop("place")
        name = f.pop("name") or f"СЭС у {place}"
        area = f.pop("area_ha")
        slug = re.sub(r"[^a-z0-9]+", "-", f["osm"]).strip("-")
        cap = (
            f"{f['capacity_mw']:g} МВт по OSM"
            if f["capacity_source"] == "osm"
            else f"мощности в OSM нет, {f['capacity_mw']:g} МВт — оценка по площади"
            f" ({mw_per_ha:.2f} МВт/га)"
        )
        out.append(
            {
                "id": f"pv-{slug}",
                "name": name,
                "region": f.pop("region", None),
                **f,
                "location": "plant",
                "in_registry": False,
                "data": "model",
                "note": f"Контур OSM {area:g} га, {cap}; ближайший пункт — {place}. "
                "Блоки — условное деление контура на четыре части",
            }
        )

    OUT.write_text(
        json.dumps(
            {
                "generated": date.today().isoformat(),
                "sources": {
                    "osm": "© участники OpenStreetMap, ODbL — https://www.openstreetmap.org/copyright",
                },
                "farms": out,
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n"
    )
    print(
        f"СЭС: {len(out)}, мощность из OSM: {sum(f['capacity_source'] == 'osm' for f in out)}, "
        f"оценка по площади: {mw_per_ha:.2f} МВт/га → {OUT.relative_to(ROOT)}"
    )


if __name__ == "__main__":
    main()
