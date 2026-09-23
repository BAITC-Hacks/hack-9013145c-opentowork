"""Скачивает исходные данные для расчёта солнечного потенциала крыш.

Запускается один раз вручную, результат лежит в репозитории: проверка
проекта не должна зависеть от внешних API (п. 5.6.6).

    python3 scripts/fetch_solar_data.py

Источники:
- контуры и этажность зданий — OpenStreetMap через Overpass API (ODbL);
- месячная радиация и выработка 1 кВт панелей — PVGIS-ERA5 (JRC, ЕС).
"""

import argparse
import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

# Левый берег Астаны: жилые кварталы, офисы и высотки вперемешку — есть
# и открытые крыши, и затенённые, рейтинг получается нетривиальным.
BBOX = (51.115, 71.405, 51.135, 71.445)  # south, west, north, east
CENTER = ((BBOX[0] + BBOX[2]) / 2, (BBOX[1] + BBOX[3]) / 2)
CITIES = {
    "astana": ("Астана", "Астана, левый берег", BBOX, "astana_left_bank.json"),
    "almaty": (
        "Алматы", "Алматы, площадь Республики", (43.232, 76.929, 43.250, 76.953),
        "almaty_center.json",
    ),
    "shymkent": (
        "Шымкент", "Шымкент, центральные кварталы", (42.309, 69.582, 42.327, 69.606),
        "shymkent_center.json",
    ),
}
# Типовой наклон стоек на плоской крыше: ряды меньше затеняют друг друга,
# чем при оптимальных для Астаны ~43°.
TILT = 30

OUT = Path(__file__).resolve().parents[1] / "app" / "solar" / "data" / "astana_left_bank.json"
UA = {"User-Agent": "hackalem-opentowork/0.1 (hackathon)"}
OVERPASS = "https://overpass-api.de/api/interpreter"
# Public global mirrors listed at https://wiki.openstreetmap.org/wiki/Overpass_API.
OVERPASS_MIRRORS = (
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    OVERPASS,
)
ROAD_WIDTHS = {
    "motorway": 12, "trunk": 11, "primary": 10, "secondary": 9, "tertiary": 8,
    "unclassified": 6, "residential": 6, "living_street": 5, "service": 4,
    "road": 6, "pedestrian": 5, "footway": 2, "cycleway": 2.5, "path": 1.5,
    "steps": 2, "track": 3,
}


def get_json(
    url: str, data: bytes | None = None, attempts: int = 4, timeout_s: int = 180,
) -> dict:
    # Публичные Overpass и PVGIS периодически отвечают 429/504 под нагрузкой.
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, json.JSONDecodeError) as exc:
            if attempt == attempts:
                raise
            print(f"  {exc}, повтор {attempt}/{attempts - 1} через {10 * attempt} с")
            time.sleep(10 * attempt)
    raise AssertionError("unreachable")


def coordinates(geometry: list[dict]) -> list[list[float]]:
    points = []
    for p in geometry:
        if not all(isinstance(p.get(k), (int, float)) and math.isfinite(p[k])
                   for k in ("lat", "lon")):
            return []
        pair = [round(p["lat"], 6), round(p["lon"], 6)]
        if not points or pair != points[-1]:
            points.append(pair)
    return points


def closed_ring(points: list[list[float]]) -> bool:
    return len(points) >= 4 and points[0] == points[-1] and len({tuple(p) for p in points}) >= 3


def outer_rings(element: dict) -> list[list[list[float]]]:
    """Keep topology: holes/unfinished relations are skipped, never silently filled."""
    if element["type"] == "way":
        ring = coordinates(element.get("geometry", []))
        return [ring] if closed_ring(ring) else []
    members = element.get("members", [])
    if any(m.get("role") == "inner" for m in members):
        return []
    parts = [coordinates(m.get("geometry", [])) for m in members
             if m.get("type") == "way" and m.get("role", "") in {"", "outer"}]
    if not parts or any(len(p) < 2 for p in parts):
        return []
    rings = []
    while parts:
        ring = parts.pop()
        while ring[0] != ring[-1]:
            for i, p in enumerate(parts):
                if ring[-1] == p[0]:
                    ring.extend(p[1:])
                elif ring[-1] == p[-1]:
                    ring.extend(p[-2::-1])
                else:
                    continue
                parts.pop(i)
                break
            else:
                return []
        if not closed_ring(ring):
            return []
        rings.append(ring)
    return rings


def area_kind(tags: dict) -> str | None:
    if tags.get("natural") == "water" or tags.get("landuse") in {"reservoir", "basin"}:
        return "water"
    if tags.get("natural") == "wood" or tags.get("landuse") == "forest":
        return "wood"
    if tags.get("leisure") in {"park", "garden", "nature_reserve"}:
        return "park"
    if tags.get("natural") in {"grassland", "scrub"} or tags.get("landuse") in {
        "grass", "meadow", "recreation_ground",
    }:
        return "grass"
    if tags.get("amenity") == "parking":
        return "parking"
    if tags.get("highway") == "pedestrian" and tags.get("area") == "yes":
        return "pedestrian"
    landuse = tags.get("landuse")
    if landuse in {"residential", "commercial", "industrial"}:
        return landuse
    return "commercial" if landuse == "retail" else None


def road_width(tags: dict) -> tuple[float, int | None, str]:
    kind = tags["highway"].removesuffix("_link")
    lanes = int(tags["lanes"]) if re.fullmatch(r"[1-9]\d?", tags.get("lanes", "")) else None
    width = tags.get("width", "")
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(m|ft)?\s*", width)
    if match:
        value = float(match[1]) * (0.3048 if match[2] == "ft" else 1)
        if 0.5 <= value <= 60:
            return round(value, 2), lanes, "osm_width"
    if lanes and kind not in {"pedestrian", "footway", "cycleway", "path", "steps"}:
        return min(40.0, lanes * 3.2 + 0.6), lanes, "assumed_from_lanes"
    value = ROAD_WIDTHS.get(kind, 6)
    return (min(value, 5) if tags["highway"].endswith("_link") else value), lanes, "assumed_by_kind"


def clip_road(points: list[list[float]], bbox: tuple) -> list[list[list[float]]]:
    """Clip real centreline segments to the downloaded district, preserving gaps."""
    south, west, north, east = bbox
    lines: list[list[list[float]]] = []
    for a, b in zip(points, points[1:], strict=False):
        dy, dx = b[0] - a[0], b[1] - a[1]
        lo, hi = 0.0, 1.0
        for p, q in ((-dx, a[1] - west), (dx, east - a[1]),
                     (-dy, a[0] - south), (dy, north - a[0])):
            if p == 0:
                if q < 0:
                    hi = -1
                    break
            elif p < 0:
                lo = max(lo, q / p)
            else:
                hi = min(hi, q / p)
        if lo >= hi:
            continue
        start = [round(a[0] + lo * dy, 6), round(a[1] + lo * dx, 6)]
        end = [round(a[0] + hi * dy, 6), round(a[1] + hi * dx, 6)]
        if start == end:
            continue
        if lines and lines[-1][-1] == start:
            lines[-1].append(end)
        else:
            lines.append([start, end])
    return lines


def parse_osm(elements: list[dict], bbox: tuple) -> tuple[list[dict], dict]:
    buildings, roads, areas = [], [], []
    # Suppress member ways even for skipped relations: rendering an outer member
    # separately would incorrectly fill a courtyard/lake island.
    member_ids = {m["ref"] for e in elements if e["type"] == "relation"
                  for m in e.get("members", []) if m.get("type") == "way"}
    skipped = 0
    for e in elements:
        tags = e.get("tags", {})
        osm_id = f"{e['type']}/{e['id']}"
        highway = tags.get("highway", "")
        if (e["type"] == "way" and tags.get("area") != "yes"
                and highway.removesuffix("_link") in ROAD_WIDTHS):
            width, lanes, source = road_width(tags)
            for i, line in enumerate(clip_road(coordinates(e.get("geometry", [])), bbox)):
                road = {"id": f"{osm_id}/{i}", "kind": highway, "width_m": width,
                        "width_source": source, "coordinates": line}
                if tags.get("name"):
                    road["name"] = tags["name"]
                if lanes:
                    road["lanes"] = lanes
                for key in ("bridge", "tunnel"):
                    if key in tags:
                        road[key] = tags[key] not in {"no", "false", "0"}
                roads.append(road)
        is_building = bool(tags.get("building") or tags.get("building:part"))
        kind = area_kind(tags)
        if not (is_building or kind) or (e["type"] == "way" and e["id"] in member_ids):
            continue
        polygons = outer_rings(e)
        if not polygons:
            skipped += 1
        for i, polygon in enumerate(polygons):
            feature_id = osm_id if len(polygons) == 1 else f"{osm_id}/{i}"
            if is_building:
                if tags.get("building") in {"construction", "roof", "ruins", "no"}:
                    continue
                address = " ".join(filter(None, [tags.get("addr:street"),
                                                  tags.get("addr:housenumber")]))
                buildings.append({
                    "id": feature_id, "name": tags.get("name") or address or None,
                    "type": tags.get("building") or tags.get("building:part"),
                    "part": "building" not in tags, "roof_shape": tags.get("roof:shape"),
                    "roof_height": tags.get("roof:height"),
                    "height": tags.get("height"), "min_height": tags.get("min_height"),
                    "levels": tags.get("building:levels"), "polygon": polygon,
                })
            elif kind:
                areas.append({"id": feature_id, "kind": kind, "polygon": polygon})
    return buildings, {
        "roads": roads, "areas": areas, "source": "OpenStreetMap (ODbL), Overpass API",
        "skipped_polygon_features": skipped,
        "notes": [
            "Выборка OSM в пределах района, не полный кадастр города.",
            "Полигоны с внутренними кольцами и незамкнутые геометрии пропущены вместе с частями.",
            "Ширина дороги: тег width, иначе оценка по lanes или классу; "
            "не геодезическое измерение.",
            "OSM не содержит все высоты и формы крыш; деревья и детали фасадов — иллюстрация.",
        ],
    }


def fetch_osm(bbox: tuple) -> tuple[list[dict], dict, dict]:
    filters = [
        '["building"]', '["building:part"]',
        '["leisure"~"^(park|garden|nature_reserve)$"]',
        '["natural"~"^(wood|water|scrub|grassland)$"]',
        '["landuse"~"^(forest|grass|meadow|recreation_ground|residential|commercial|retail|industrial|reservoir|basin)$"]',
        '["amenity"="parking"]', '["highway"="pedestrian"]["area"="yes"]',
    ]
    batches = [
        "".join(f"{typ}{tag}{bbox};" for typ in ("way", "relation") for tag in filters[:2]),
        f'way["highway"]{bbox};',
        "".join(f"{typ}{tag}{bbox};" for typ in ("way", "relation") for tag in filters[2:]),
    ]
    elements, queries = {}, []
    for batch in batches:
        query = f"[out:json][timeout:60];({batch});out tags geom;"
        body = urllib.parse.urlencode({"data": query}).encode()
        payload = None
        for endpoint in OVERPASS_MIRRORS:
            try:
                payload = get_json(endpoint, body, attempts=1, timeout_s=90)
                if payload.get("remark"):
                    raise RuntimeError(f"Overpass returned incomplete data: {payload['remark']}")
                break
            except (OSError, RuntimeError, json.JSONDecodeError) as exc:
                print(f"  {endpoint}: {exc}", flush=True)
                payload = None
        if payload is None:
            raise RuntimeError("No Overpass mirror returned a complete snapshot")
        for element in payload["elements"]:
            elements[(element["type"], element["id"])] = element
        queries.append({"endpoint": endpoint, "query": query,
                        "timestamp": payload.get("osm3s", {}).get("timestamp_osm_base")})
        print(f"  OSM batch {len(queries)}/3: {len(payload['elements'])} features", flush=True)
    buildings, environment = parse_osm(list(elements.values()), bbox)
    if not buildings or not environment["roads"]:
        raise RuntimeError("OSM snapshot has no buildings or roads")
    stamps = [q["timestamp"] for q in queries if q["timestamp"]]
    return buildings, environment, {
        "queries": queries, "timestamp": min(stamps) if stamps else None,
    }


def fetch_pvgis(center: tuple[float, float] = CENTER) -> dict:
    lat, lon = center
    base = "https://re.jrc.ec.europa.eu/api/v5_2"
    common = f"lat={lat:.4f}&lon={lon:.4f}&raddatabase=PVGIS-ERA5&outputformat=json"
    pv_url = f"{base}/PVcalc?{common}&peakpower=1&loss=14&angle={TILT}&aspect=0"
    mr_url = f"{base}/MRcalc?{common}&horirrad=1&d2g=1&startyear=2011&endyear=2020"
    pv, mr = get_json(pv_url), get_json(mr_url)
    location = pv["inputs"]["location"]
    if abs(location["latitude"] - lat) > 0.001 or abs(location["longitude"] - lon) > 0.001:
        raise ValueError("PVGIS returned a different location")

    # MRcalc отдаёт помесячно по годам — усредняем по годам.
    diffuse: dict[int, list[float]] = {}
    ghi: dict[int, list[float]] = {}
    for row in mr["outputs"]["monthly"]:
        diffuse.setdefault(row["month"], []).append(row["Kd"])
        ghi.setdefault(row["month"], []).append(row["H(h)_m"])

    months = []
    for row in pv["outputs"]["monthly"]["fixed"]:
        m = row["month"]
        months.append(
            {
                "month": m,
                "kwh_per_kwp": row["E_m"],  # выработка 1 кВт панелей с потерями системы 14%
                "poa_kwh_m2": row["H(i)_m"],  # радиация на наклонную плоскость
                "ghi_kwh_m2": round(sum(ghi[m]) / len(ghi[m]), 2),
                "diffuse_share": round(sum(diffuse[m]) / len(diffuse[m]), 3),
            }
        )
    return {
        "source": "PVGIS-ERA5 v5.2",
        "requests": {"pvcalc": pv_url, "mrcalc": mr_url},
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "tilt_deg": TILT,
        "azimuth": "south",
        "system_loss_pct": 14,
        "kwh_per_kwp_year": pv["outputs"]["totals"]["fixed"]["E_y"],
        "months": months,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--city", choices=[*CITIES, "all"], default="all")
    args = parser.parse_args()
    for city in CITIES if args.city == "all" else [args.city]:
        name, district, bbox, filename = CITIES[city]
        print(f"{name}: downloading OSM…", flush=True)
        buildings, environment, provenance = fetch_osm(bbox)
        print(f"{name}: {len(buildings)} buildings; downloading PVGIS…", flush=True)
        data = {
            "city_id": city, "city_name": name, "district": district, "bbox": bbox,
            "fetched": date.today().isoformat(), "osm": provenance,
            "buildings_source": "OpenStreetMap (ODbL), Overpass API",
            "irradiance": fetch_pvgis(((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)),
            "buildings": buildings, "environment": environment,
        }
        out = OUT.parent / filename
        out.parent.mkdir(parents=True, exist_ok=True)
        temporary = out.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
        temporary.replace(out)
        print(f"{len(buildings)} buildings → {out} ({out.stat().st_size // 1024} KB)", flush=True)


if __name__ == "__main__":
    main()
