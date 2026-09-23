"""Собирает каталог действующих ВЭС Казахстана с координатами турбин.

Запускается один раз вручную, результат лежит в репозитории: проверка
проекта не должна зависеть от внешних API (п. 5.6.6).

    python3 scripts/fetch_wind_farms.py

Источники:
- перечень ВЭС, операторы и мощности — реестр объектов ВИЭ QazaqGreen
  (данные Минэнерго РК, состояние на январь 2026): https://qazaqgreen.com/map/;
- координаты турбин и контуры станций — OpenStreetMap через Overpass API (ODbL);
- контур страны — Natural Earth 1:50m (public domain) из пакета world-atlas.

Реестр не даёт координат, OSM не даёт операторов, поэтому связь между ними
задана вручную в CURATED — только там, где она подтверждена названием в OSM
или открытыми источниками. Неопознанные группы турбин попадают в каталог под
именем ближайшего населённого пункта; станции реестра без координат — в
каталог без точки на карте.
"""

import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "app" / "wind" / "data" / "kz_wind_farms.json"
OUT_MAP = ROOT / "frontend" / "src" / "twin" / "kz_outline.json"
UA = {"User-Agent": "hackalem-opentowork/0.1 (hackathon)"}
OVERPASS = "https://overpass-api.de/api/interpreter"
KZ_AREA = 'area["ISO3166-1"="KZ"][admin_level=2]->.kz;'
CLUSTER_KM = 3.0  # турбины одной станции стоят в 300–800 м друг от друга
MATCH_KM = 6.0

# Реестр QazaqGreen, раздел «ВЭС», по областям — дословно, как на странице.
REGISTRY: list[tuple[str, str, float]] = [
    ("Алматинская область", "ТОО «Аннар»", 4.5),
    ("Алматинская область", "ТОО «ВЭС НУРЛЫ»", 4.5),
    ("Алматинская область", "ТОО «ВЭС Сарыбулак 2»", 4.5),
    ("Алматинская область", "ТОО «ВЭС Сарыбулак 1»", 4.5),
    ("Алматинская область", "ТОО «ВЭС Кербулак»", 4.5),
    ("Алматинская область", "ТОО «ВЭС Кербулак 2»", 4.5),
    ("Алматинская область", "ТОО «Samruk Green Energy»", 5),
    ("Алматинская область", "ТОО «ВЭС Нурлы 2»", 4.5),
    ("Алматинская область", "ТОО «Энергия Семиречья»", 60),
    ("Алматинская область", "ТОО «ЖЕРУЙЫК ЭНЕРГО» ВЭС Шелек", 50),
    ("Алматинская область", "ТОО «ВЭС Толкын»", 3),
    ("Акмолинская область", "ТОО «Агрофирма «Родина»", 0.75),
    ("Акмолинская область", "ТОО «Первая ветровая электрическая станция»", 45.1),
    ("Акмолинская область", "ТОО «ЦАТЭК Green Energy»", 100),
    ("Акмолинская область", "ТОО «Golden Energy corp.»", 4.95),
    ("Акмолинская область", "ТОО «Golden Energy Corp.»", 25),
    ("Акмолинская область", "ТОО «Вичи»", 7),
    ("Акмолинская область", "ТОО «ПФ ЭлектроСетьСтрой» ВЭС Торгай", 4.5),
    ("Акмолинская область", "ТОО «Борей Энерго» 1", 50),
    ("Акмолинская область", "ТОО «Борей Энерго» 2", 50),
    ("Акмолинская область", "ТОО «Energo Trust»", 50),
    ("Акмолинская область", "ТОО «Alcor Energy»", 4.95),
    ("Акмолинская область", "ТОО «Восток Ветер»", 10),
    ("Акмолинская область", "ТОО «Аркалыкская ВЭС» в с. Сараба", 7),
    ("Акмолинская область", "ТОО «Аркалыкская ВЭС» в с. Сараба", 10),
    ("Акмолинская область", "ТОО «Софиевская ВЭС» в с. Сараба", 39),
    ("Акмолинская область", "ТОО «Эталон Пауэр»", 18.15),
    ("Акмолинская область", "ТОО «Эталон Пауэр»", 1.4),
    ("Акмолинская область", "ТОО «Jasil Jel Energy» (бывш. «Greencity»)", 10),
    ("Акмолинская область", "ТОО «Jasil Jel Energy» (бывш. «Аргест»)", 4.95),
    ("Актюбинская область", "ТОО «Plentitude» ВЭС Бадамша 1", 48),
    ("Актюбинская область", "ТОО «Plentitude» ВЭС Бадамша 2", 48),
    ("Актюбинская область", "ТОО «Жел энерго»", 0.45),
    ("Актюбинская область", "ТОО «ERG Capital Project» Хромтау", 12.5),
    ("Актюбинская область", "ТОО «ERG Capital Project» Хромтау", 137.5),
    ("Актюбинская область", "ТОО «Next Green Energy»", 50),
    ("Актюбинская область", "ТОО «Darmen Shuak»", 50),
    ("Абайская область", "ТОО «Винд Чарск»", 4.95),
    ("Абайская область", "ТОО «ВЭС-Чарск»", 4.95),
    ("Абайская область", "ТОО «Чарск Ветер»", 4.95),
    ("Абайская область", "ТОО «DES Consulting»", 4.95),
    ("Абайская область", "ТОО «Ventum Energy»", 4.95),
    ("Абайская область", "ТОО «EastWindEnergy»", 4.95),
    ("Абайская область", "ТОО «ВЭС 100 МВт «Абай 1»", 100),
    ("Улытауская область", "ТОО «Mezgilder Qushteri»", 100),
    ("Атырауская область", "ТОО «Ветро Энерго Технологи»", 52.8),
    ("Атырауская область", "ТОО «Дивитэл»", 48),
    ("Жамбылская область", "ТОО «Изен-Су» / ТОО «Жымбыл жарык»", 1.5),
    ("Жамбылская область", "ТОО «Vista International»", 21),
    ("Жамбылская область", "ТОО «Ветро Инвест»", 30.65),
    ("Жамбылская область", "ТОО «Wind Electricity»", 4.5),
    ("Жамбылская область", "ТОО «Wind Power city»", 4.5),
    ("Жамбылская область", "ТОО «Жанатасская Ветровая Электростанция»", 100),
    ("Жамбылская область", "ТОО «ВЭС Шенгельды»", 4.5),
    ("Жамбылская область", "ТОО «ВЭС Шенгельды 2»", 4.5),
    ("Жамбылская область", "ТОО «НОВОТЭКС»", 4.5),
    ("Жамбылская область", "ТОО «Шокпарская ветровая электростанция»", 100),
    ("Карагандинская область", "ТОО «Гиперборея»", 50),
    ("Костанайская область", "ТОО «ЖЕЛ ЭЛЕКТРИК»", 50),
    ("Костанайская область", "ТОО «KazWindEnergy» в г. Аркалык", 48),
    ("Мангистауская область", "ТОО «СП «КТ Редкометальная компания»", 43.6),
    ("Мангистауская область", "ТОО «БЕСТ-Групп НС»", 5),
    ("Мангистауская область", "ТОО «ВЭС Сервис»", 10),
    ("Мангистауская область", "ТОО «ВЭС Жангиз»", 5),
    ("Мангистауская область", "ТОО «Sarkylmas Kuat»", 50),
    ("Северо-Казахстанская область", "КТ «Зенченко и К»", 3.5),
    ("Северо-Казахстанская область", "ТОО «Иван Зенченко»", 2),
    ("Область Жетісу", "ТОО «ВЭС Абай 2 50 МВт»", 50),
    ("Область Жетісу", "ТОО «EcoWattAKA»", 50),
]

# Ручные сопоставления. osm — станция из OSM (контур), near — точка, к которой
# привязывается ближайшая группа турбин, place — населённый пункт, если
# известен только район. registry — подстроки операторов из REGISTRY.
CURATED: list[dict] = [
    {
        "id": "ereymentau",
        "name": "Ерейментау ВЭС",
        "osm": "relation/9249912",
        "registry": ["Первая ветровая"],
        "commissioned": "2015",
        "data": "history",
        "note": "Станция из датасета кейса: SCADA с марта 2023 по январь 2026",
    },
    {
        "id": "akmola",
        "name": "Акмолинская ВЭС",
        "osm": "relation/19431823",
        "registry": ["Борей Энерго» 1", "Борей Энерго» 2", "Energo Trust"],
        "note": "Три очереди по 50 МВт у сёл Булаксай и Сарыоба (SPIC / CPID) — сопоставлено по сообщениям СМИ",
    },
    {"id": "arshaly", "name": "Аршалынская ВЭС", "osm": "relation/14072937"},
    {
        "id": "kordai",
        "name": "Кордайская ВЭС",
        "osm": "way/670401286",
        "registry": ["Vista International", "Ветро Инвест"],
        "commissioned": "2015",
    },
    {
        "id": "zhanatas",
        "name": "Жанатасская ВЭС",
        "osm": "relation/14072440",
        "registry": ["Жанатасская"],
        "commissioned": "2021",
    },
    {
        "id": "shokpar",
        "name": "Шокпарская ВЭС",
        "osm": "relation/18511885",
        "registry": ["Шокпарская"],
        "commissioned": "2024",
        "note": "Сарысуский район, у г. Жанатас",
    },
    {"id": "fort-shevchenko", "name": "ВЭС Форт-Шевченко", "osm": "way/1054469775"},
    {
        "id": "taiman",
        "name": "Исатайская ВЭС (Тайман)",
        "osm": "relation/13673983",
        "registry": ["Ветро Энерго Технологи"],
        "commissioned": "2019",
    },
    {"id": "makat", "name": "Макатская ВЭС", "osm": "relation/18989260", "registry": ["Дивитэл"]},
    {
        "id": "badamsha-1",
        "name": "Бадамша ВЭС-1",
        "osm": "relation/14072906",
        "registry": ["Бадамша 1"],
    },
    {
        "id": "badamsha-2",
        "name": "Бадамша ВЭС-2",
        "osm": "relation/19036232",
        "registry": ["Бадамша 2"],
    },
    {
        "id": "khromtau",
        "name": "ВЭС Хромтау",
        "near": (50.339, 58.622),
        "registry": ["ERG Capital Project» Хромтау"],
        "location_only": True,
        "note": "В OSM отмечена одной точкой, турбины не нанесены",
    },
    {
        "id": "arkalyk",
        "name": "Аркалыкская ВЭС",
        "osm": "relation/18995937",
        "registry": ["KazWindEnergy"],
    },
    {
        "id": "kostanay",
        "name": "Костанайская ВЭС",
        "osm": "relation/18989187",
        "registry": ["ЖЕЛ ЭЛЕКТРИК"],
        "note": "Сопоставлено по мощности: единственная ВЭС 50 МВт в Костанайской области",
    },
    {"id": "kokshetau", "name": "Кокшетауская ВЭС", "osm": "relation/14072930"},
    {"id": "petropavlovsk", "name": "Петропавловская ВЭС", "osm": "relation/14073345"},
    {"id": "nurly", "name": "ВЭС Нурлы", "osm": "relation/14072944"},
    # Известен только район — точка ставится на райцентр.
    {
        "id": "abai-1",
        "name": "ВЭС «Абай 1»",
        "place": "Аягоз",
        "registry": ["Абай 1"],
        "commissioned": "2022",
        "note": "Аягозский район; точные координаты турбин неизвестны",
    },
    {
        "id": "hyperborea",
        "name": "ВЭС «Гиперборея»",
        "place": "Осакаровка",
        "registry": ["Гиперборея"],
        "commissioned": "2025",
        "note": "Осакаровский район; точные координаты турбин неизвестны",
    },
    {
        "id": "sarkylmas",
        "name": "ВЭС Sarkylmas Kuat",
        "place": "Мунайшы",
        "registry": ["Sarkylmas"],
        "note": "С. Мунайшы, Каракиянский район; 8 турбин по 6.25 МВт",
    },
    {
        "id": "darmen-shuak",
        "name": "ВЭС Darmen Shuak",
        "place": "Хромтау",
        "registry": ["Darmen Shuak"],
        "note": "Хромтауский район; точные координаты турбин неизвестны",
    },
    {
        "id": "next-green",
        "name": "ВЭС Next Green Energy",
        "place": "Хромтау",
        "registry": ["Next Green Energy"],
        "note": "Хромтауский район; точные координаты турбин неизвестны",
    },
]


def overpass(query: str, attempts: int = 6) -> list[dict]:
    body = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(OVERPASS, data=body, headers=UA)
            with urllib.request.urlopen(req, timeout=240) as resp:
                return json.loads(resp.read())["elements"]
        except (urllib.error.URLError, json.JSONDecodeError) as exc:
            # Публичный Overpass под нагрузкой отдаёт HTML с ошибкой вместо JSON.
            if attempt == attempts:
                raise
            print(f"  {exc}, повтор {attempt}/{attempts - 1} через {15 * attempt} с")
            time.sleep(15 * attempt)
    raise AssertionError("unreachable")


def km(a: tuple[float, float], b: tuple[float, float]) -> float:
    dlat = a[0] - b[0]
    dlon = (a[1] - b[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(dlat, dlon) * 111.2


def rings(element: dict) -> list[list[tuple[float, float]]]:
    if element["type"] == "way":
        return [[(p["lat"], p["lon"]) for p in element["geometry"]]]
    # Внешний контур мультиполигона в OSM часто разрезан на несколько линий —
    # склеиваем их по общим концам в замкнутые кольца.
    parts = [
        [(p["lat"], p["lon"]) for p in m["geometry"]]
        for m in element.get("members", [])
        if m.get("type") == "way" and m.get("role") in ("outer", "") and m.get("geometry")
    ]
    out = []
    while parts:
        ring = parts.pop(0)
        while ring[0] != ring[-1]:
            for i, part in enumerate(parts):
                if part[0] == ring[-1]:
                    ring += part[1:]
                elif part[-1] == ring[-1]:
                    ring += part[::-1][1:]
                else:
                    continue
                parts.pop(i)
                break
            else:
                break  # незамкнутое кольцо — всё равно проверяем, как есть
        out.append(ring)
    return out


def inside(pt: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    y, x = pt
    hit = False
    for (y1, x1), (y2, x2) in zip(ring, ring[1:] + ring[:1], strict=True):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def rated_kw(tags: dict, key: str = "generator:output:electricity") -> float | None:
    m = re.match(r"^\s*([\d.]+)\s*(kW|MW)\s*$", tags.get(key, ""))
    if not m:
        return None
    return float(m[1]) * (1000 if m[2] == "MW" else 1)


def cluster(points: list[dict]) -> list[list[dict]]:
    parent = list(range(len(points)))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, a in enumerate(points):
        for j in range(i + 1, len(points)):
            if km((a["lat"], a["lon"]), (points[j]["lat"], points[j]["lon"])) < CLUSTER_KM:
                parent[root(i)] = root(j)
    groups: dict[int, list[dict]] = defaultdict(list)
    for i, p in enumerate(points):
        groups[root(i)].append(p)
    return list(groups.values())


def centroid(points: list[dict]) -> tuple[float, float]:
    return (
        sum(p["lat"] for p in points) / len(points),
        sum(p["lon"] for p in points) / len(points),
    )


def kz_outline() -> list[list[list[float]]]:
    """Контур Казахстана из TopoJSON Natural Earth: декодируем дуги без зависимостей."""
    req = urllib.request.Request("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json", headers=UA)
    with urllib.request.urlopen(req, timeout=60) as resp:
        topo = json.loads(resp.read())
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append([round(y * sy + ty, 3), round(x * sx + tx, 3)])
        arcs.append(pts)
    geom = next(g for g in topo["objects"]["countries"]["geometries"] if g.get("id") == "398")
    polys = geom["arcs"] if geom["type"] == "MultiPolygon" else [geom["arcs"]]
    out = []
    for poly in polys:
        ring: list[list[float]] = []
        for idx in poly[0]:
            seg = arcs[idx] if idx >= 0 else arcs[~idx][::-1]
            ring.extend(seg if not ring else seg[1:])
        out.append(ring)
    return out


def main() -> None:
    print("OSM: контуры станций…")
    plants = overpass(f'[out:json][timeout:180];{KZ_AREA}nwr["power"="plant"]["plant:source"="wind"](area.kz);out tags geom;')
    print("OSM: турбины…")
    turbines = overpass(f'[out:json][timeout:180];{KZ_AREA}node["generator:source"="wind"](area.kz);out body;')
    print("OSM: населённые пункты…")
    places = overpass(f'[out:json][timeout:180];{KZ_AREA}node["place"~"^(city|town|village)$"](area.kz);out;')
    places = [
        {"name": p["tags"].get("name:ru") or p["tags"].get("name"), "lat": p["lat"], "lon": p["lon"],
         "rank": {"city": 3, "town": 2, "village": 1}[p["tags"]["place"]]}
        for p in places if p["tags"].get("name:ru") or p["tags"].get("name")
    ]

    # Мелкие бытовые ветряки — не станции.
    turbines = [t for t in turbines if t.get("tags", {}).get("generator:output:electricity") != "small_installation"]

    plant_by_ref = {f"{p['type']}/{p['id']}": p for p in plants}
    groups: list[dict] = []
    free = list(turbines)
    for ref, p in plant_by_ref.items():
        rs = rings(p)
        members = [t for t in free if any(inside((t["lat"], t["lon"]), r) for r in rs)]
        free = [t for t in free if t not in members]
        c = members and centroid(members)
        if not members:
            b = p["bounds"]
            c = ((b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2)
        groups.append({"osm": ref, "tags": p["tags"], "turbines": members, "center": c})
    for g in cluster(free):
        groups.append({"osm": None, "tags": {}, "turbines": g, "center": centroid(g)})

    registry_used: set[int] = set()
    farms: list[dict] = []
    used_groups: set[int] = set()

    def take_registry(needles: list[str]) -> list[int]:
        out = []
        for needle in needles:
            for i, (_, op, _) in enumerate(REGISTRY):
                if needle in op and i not in registry_used:
                    registry_used.add(i)
                    out.append(i)
        return out

    def nearest_place(pt: tuple[float, float], min_rank: int = 1) -> dict:
        return min((p for p in places if p["rank"] >= min_rank), key=lambda p: km(pt, (p["lat"], p["lon"])))

    def build(c: dict, g: dict | None) -> dict:
        idx = take_registry(c.get("registry", []))
        units = []
        if g and not c.get("location_only"):
            for n, t in enumerate(sorted(g["turbines"], key=lambda t: (-t["lat"], t["lon"])), start=1):
                tags = t.get("tags", {})
                units.append({
                    "id": f"T{n}",
                    "lat": round(t["lat"], 6),
                    "lon": round(t["lon"], 6),
                    "rated_kw": rated_kw(tags),
                    "model": " ".join(filter(None, [tags.get("manufacturer"), tags.get("model")])) or None,
                    "osm": f"node/{t['id']}",
                })
        cap_registry = round(sum(REGISTRY[i][2] for i in idx), 2) if idx else None
        cap_osm = rated_kw(g["tags"], "plant:output:electricity") if g else None
        if cap_registry is not None:
            capacity, cap_source = cap_registry, "registry"
        elif cap_osm:
            capacity, cap_source = round(cap_osm / 1000, 2), "osm"
        else:
            capacity, cap_source = None, None
        tags = (g or {}).get("tags", {})
        if g:
            lat, lon = g["center"]
            location = "turbines" if units else "plant"
        elif c.get("place"):
            p = next(p for p in places if p["name"] == c["place"])
            lat, lon, location = p["lat"], p["lon"], "district"
        else:
            lat = lon = location = None
        return {
            "id": c["id"],
            "name": c["name"],
            "region": REGISTRY[idx[0]][0] if idx else c.get("region"),
            "operators": [REGISTRY[i][1] for i in idx],
            "capacity_mw": capacity,
            "capacity_source": cap_source,
            "commissioned": c.get("commissioned") or tags.get("start_date", "")[:4] or None,
            "lat": round(lat, 5) if lat is not None else None,
            "lon": round(lon, 5) if lon is not None else None,
            "location": location,
            "osm": g["osm"] if g else None,
            "in_registry": bool(idx),
            "data": c.get("data", "none"),
            "note": c.get("note"),
            "units": units,
        }

    for c in CURATED:
        gi = None
        if c.get("osm"):
            gi = next(i for i, g in enumerate(groups) if g["osm"] == c["osm"])
        elif c.get("near"):
            gi = min(range(len(groups)), key=lambda i: km(groups[i]["center"], c["near"]))
            if km(groups[gi]["center"], c["near"]) > MATCH_KM:
                gi = None
        if gi is not None:
            used_groups.add(gi)
        farms.append(build(c, groups[gi] if gi is not None else None))

    # Остальные группы: станция есть в OSM, но оператор не установлен.
    for i, g in enumerate(groups):
        if i in used_groups or (len(g["turbines"]) < 3 and not g["osm"]):
            continue
        p = nearest_place(g["center"])
        dist = km(g["center"], (p["lat"], p["lon"]))
        slug = re.sub(r"[^a-z0-9]+", "-", (g["osm"] or f"c{g['center'][0]:.3f}-{g['center'][1]:.3f}").lower()).strip("-")
        farm = build({
            "id": f"osm-{slug}",
            "name": g["tags"].get("name:ru") or g["tags"].get("name") or f"ВЭС у {p['name']}",
            "note": f"Оператор не установлен; {dist:.0f} км от {p['name']}",
        }, g)
        farms.append(farm)

    # Станции реестра, которых нет ни в OSM, ни в открытых источниках с координатами.
    for i, (region, op, mw) in enumerate(REGISTRY):
        if i in registry_used:
            continue
        farms.append({
            "id": f"reg-{i + 1:02d}",
            "name": re.sub(r"^(ТОО|КТ)\s*", "", op).replace("«", "").replace("»", ""),
            "region": region, "operators": [op], "capacity_mw": mw, "capacity_source": "registry",
            "commissioned": None, "lat": None, "lon": None, "location": None, "osm": None,
            "in_registry": True, "data": "none", "note": "Координаты не опубликованы", "units": [],
        })

    # Область для станций вне реестра — по административной границе OSM.
    missing = [f for f in farms if not f["region"] and f["lat"] is not None]
    if missing:
        print("OSM: области для станций вне реестра…")
        query = "[out:json][timeout:180];" + "".join(
            f'is_in({f["lat"]},{f["lon"]})->.a{i};area.a{i}["admin_level"="4"];out tags;'
            for i, f in enumerate(missing)
        )
        areas = overpass(query)
        if len(areas) == len(missing):
            for f, a in zip(missing, areas, strict=True):
                f["region"] = a["tags"].get("name:ru") or a["tags"].get("name")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated": date.today().isoformat(),
        "sources": {
            "registry": "QazaqGreen, карта ВИЭ, данные Минэнерго РК на январь 2026 — https://qazaqgreen.com/map/",
            "osm": "© участники OpenStreetMap, ODbL — https://www.openstreetmap.org/copyright",
        },
        "farms": farms,
    }, ensure_ascii=False, indent=1) + "\n")
    OUT_MAP.write_text(json.dumps(kz_outline()) + "\n")

    on_map = [f for f in farms if f["lat"] is not None]
    print(f"Станций: {len(farms)}, на карте: {len(on_map)}, турбин с координатами: "
          f"{sum(len(f['units']) for f in farms)}, из реестра не сопоставлено с OSM: "
          f"{sum(1 for f in farms if f['lat'] is None)}")
    print(f"→ {OUT.relative_to(ROOT)}\n→ {OUT_MAP.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
