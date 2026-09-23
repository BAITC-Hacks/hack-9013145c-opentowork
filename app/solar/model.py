"""Солнечный потенциал крыш: сколько энергии даст каждая крыша района за год.

Это не обучаемая модель, а физический расчёт — так честнее: радиацию на
участок определяют климат, наклон панелей и тени, и всё это считается.

Что берётся из данных:
- месячная выработка 1 кВт панелей и доля рассеянного света — PVGIS-ERA5;
- контуры и высоты зданий — OpenStreetMap.

Что считается здесь:
- площадь крыши, сколько на неё помещается панелей;
- тени от соседних зданий: для точек на крыше строится профиль горизонта
  (на какой угол поднимаются более высокие соседи в каждом направлении),
  затем по траектории солнца каждого месяца считается, какую долю прямого
  света этот горизонт закрывает.

Допущения — в `ASSUMPTIONS`, они же уходят в API и показываются на экране.
"""

import json
import math
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

DATA_FILE = Path(__file__).parent / "data" / "astana_left_bank.json"

ASSUMPTIONS = {
    "usable_roof_share_flat": 0.6,  # парапеты, выходы, вентиляция, проходы
    "usable_roof_share_pitched": 0.4,  # у скатной крыши берём только южный скат
    "ground_coverage_ratio": 0.45,  # доля полезной площади под панелями при наклоне 30°
    "module_kwp_per_m2": 0.21,  # панель с КПД ~21%
    "metres_per_level": 3.0,
    "min_roof_m2": 40.0,  # сараи и киоски не рассматриваем
    "horizon_radius_m": 250.0,  # дальше тень от соседа почти не влияет на суммарную выработку
}

# Если в OSM нет ни высоты, ни этажности — этажность по типу здания.
# Это допущение, на экране такие здания помечены.
DEFAULT_LEVELS = {
    "apartments": 9,
    "residential": 9,
    "dormitory": 5,
    "hotel": 9,
    "office": 7,
    "commercial": 3,
    "retail": 2,
    "school": 3,
    "kindergarten": 2,
    "hospital": 5,
    "university": 4,
    "public": 3,
    "house": 2,
    "detached": 2,
    "semidetached_house": 2,
    "garage": 1,
    "garages": 1,
    "shed": 1,
    "service": 1,
    "industrial": 2,
    "warehouse": 2,
}
FALLBACK_LEVELS = 4
PITCHED_TYPES = {"house", "detached", "semidetached_house", "garage", "shed"}
PITCHED_SHAPES = {"hipped", "gabled", "pyramidal", "skillion", "half-hipped", "mansard"}
# Купола и шатры (Хан Шатыр, мечети, планетарий) под панели не годятся —
# остаются только препятствиями для теней.
UNSUITABLE_SHAPES = {"dome", "cone", "orb", "round", "onion", "spherical"}

AZ_BIN_DEG = 2
MONTHS_IN = [
    "январе",
    "феврале",
    "марте",
    "апреле",
    "мае",
    "июне",
    "июле",
    "августе",
    "сентябре",
    "октябре",
    "ноябре",
    "декабре",
]


@dataclass
class SunSample:
    altitude: float  # радианы
    azimuth: float  # радианы от севера по часовой
    weight: float  # вклад в прямую радиацию на панель, отн. ед.


@dataclass
class Roof:
    id: str
    name: str | None
    type: str | None
    polygon: list[list[float]]  # [[lat, lon], ...]
    height_m: float
    height_source: str  # osm_height | osm_levels | assumed
    part: bool = False  # часть здания из OSM: только препятствие
    roof_shape: str | None = None
    xy: list[tuple[float, float]] = field(default_factory=list)  # метры от центра района
    area_m2: float = 0.0


# ─── геометрия ─────────────────────────────────────────────────────────────


def project(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    """Равнопромежуточная проекция: на районе в пару километров ошибка меньше метра."""
    k = math.pi / 180 * 6_371_000
    return (lon - lon0) * k * math.cos(lat0 * math.pi / 180), (lat - lat0) * k


def polygon_area(xy: list[tuple[float, float]]) -> float:
    s = 0.0
    for (x1, y1), (x2, y2) in zip(xy, xy[1:] + xy[:1], strict=True):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def centroid(xy: list[tuple[float, float]]) -> tuple[float, float]:
    return sum(p[0] for p in xy) / len(xy), sum(p[1] for p in xy) / len(xy)


def point_in_polygon(pt: tuple[float, float], xy: list[tuple[float, float]]) -> bool:
    x, y = pt
    inside = False
    for (x1, y1), (x2, y2) in zip(xy, xy[1:] + xy[:1], strict=True):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def sample_points(xy: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Центр крыши и три точки на полпути к её углам: тень часто закрывает
    только край крыши, одна центральная точка это пропустила бы."""
    cx, cy = centroid(xy)
    ring = xy[:-1] if xy[0] == xy[-1] else xy
    step = max(1, len(ring) // 3)
    pts = [(cx, cy)]
    for vx, vy in ring[::step][:3]:
        pts.append(((cx + vx) / 2, (cy + vy) / 2))
    return pts


def densify(xy: list[tuple[float, float]], step_m: float = 4.0) -> list[tuple[float, float]]:
    """Точки по периметру через каждые step_m — по ним строится горизонт."""
    out = []
    for (x1, y1), (x2, y2) in zip(xy, xy[1:], strict=False):
        n = max(1, int(math.hypot(x2 - x1, y2 - y1) / step_m))
        for i in range(n):
            t = i / n
            out.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
    return out


# ─── солнце ────────────────────────────────────────────────────────────────


def sun_path(lat_deg: float, month: int, tilt_deg: float, step_min: int = 20) -> list[SunSample]:
    """Положение солнца в течение 15-го числа месяца и вклад каждого момента
    в прямую радиацию на панель, наклонённую на юг."""
    lat = math.radians(lat_deg)
    tilt = math.radians(tilt_deg)
    doy = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349][month - 1]
    decl = math.radians(23.44) * math.sin(2 * math.pi * (284 + doy) / 365)
    out = []
    for minute in range(0, 24 * 60, step_min):
        hour_angle = math.radians(15 * (minute / 60 - 12))
        sin_alt = math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(
            hour_angle
        )
        if sin_alt <= math.sin(math.radians(2)):
            continue
        alt = math.asin(sin_alt)
        az = (
            math.atan2(
                math.sin(hour_angle),
                math.cos(hour_angle) * math.sin(lat) - math.tan(decl) * math.cos(lat),
            )
            + math.pi
        )
        # Косинус угла падения на панель, смотрящую на юг (азимут π).
        cos_inc = math.sin(alt) * math.cos(tilt) + math.cos(alt) * math.sin(tilt) * math.cos(
            az - math.pi
        )
        if cos_inc <= 0:
            continue
        # Прямая радиация ясного неба (эмпирическая формула Мейнела): утром и
        # вечером луч идёт через толщу атмосферы и почти ничего не приносит,
        # поэтому низкое солнце в тени весит мало.
        air_mass = 1 / sin_alt
        dni = 1361 * 0.7 ** (air_mass**0.678)
        out.append(SunSample(alt, az % (2 * math.pi), dni * cos_inc))
    return out


# ─── здания ────────────────────────────────────────────────────────────────


def _max_number(value: str | None) -> float | None:
    if not value:
        return None
    nums = [float(n) for n in re.findall(r"\d+(?:[.,]\d+)?", value.replace(",", "."))]
    return max(nums) if nums else None


def building_height(raw: dict) -> tuple[float, str]:
    height = _max_number(raw.get("height"))
    if height:
        return height, "osm_height"
    levels = _max_number(raw.get("levels"))
    if levels:
        return levels * ASSUMPTIONS["metres_per_level"], "osm_levels"
    levels = DEFAULT_LEVELS.get(raw.get("type") or "", FALLBACK_LEVELS)
    return levels * ASSUMPTIONS["metres_per_level"], "assumed"


def load_roofs(raw_buildings: list[dict], lat0: float, lon0: float) -> list[Roof]:
    roofs = []
    for raw in raw_buildings:
        height, source = building_height(raw)
        roof = Roof(
            id=raw["id"],
            name=raw.get("name"),
            type=raw.get("type"),
            polygon=raw["polygon"],
            height_m=height,
            height_source=source,
            part=bool(raw.get("part")),
            roof_shape=raw.get("roof_shape"),
        )
        roof.xy = [project(lat, lon, lat0, lon0) for lat, lon in raw["polygon"]]
        roof.area_m2 = polygon_area(roof.xy)
        roofs.append(roof)
    return roofs


# ─── тени ──────────────────────────────────────────────────────────────────


def horizon_profile(
    point: tuple[float, float],
    height: float,
    obstacles: list[tuple[float, float, float]],
) -> list[float]:
    """Угол горизонта (радианы) по азимутальным корзинам AZ_BIN_DEG.
    obstacles — точки периметра соседей (x, y, высота)."""
    bins = [0.0] * (360 // AZ_BIN_DEG)
    px, py = point
    radius = ASSUMPTIONS["horizon_radius_m"]
    for ox, oy, oh in obstacles:
        dh = oh - height
        if dh <= 0:
            continue
        dx, dy = ox - px, oy - py
        dist = math.hypot(dx, dy)
        if dist < 1 or dist > radius:
            continue
        elev = math.atan2(dh, dist)
        k = int((math.degrees(math.atan2(dx, dy)) % 360) // AZ_BIN_DEG)
        if elev > bins[k]:
            bins[k] = elev
    return bins


def shaded_share(horizon: list[float], path: list[SunSample]) -> float:
    total = sum(s.weight for s in path)
    if total == 0:
        return 0.0
    blocked = sum(
        s.weight
        for s in path
        if s.altitude < horizon[int((math.degrees(s.azimuth) % 360) // AZ_BIN_DEG)]
    )
    return blocked / total


# ─── расчёт района ─────────────────────────────────────────────────────────


def _usable_share(roof: Roof) -> float:
    if roof.type in PITCHED_TYPES or roof.roof_shape in PITCHED_SHAPES:
        return ASSUMPTIONS["usable_roof_share_pitched"]
    return ASSUMPTIONS["usable_roof_share_flat"]


def _notes(r: dict, large_roof_m2: float) -> list[str]:
    notes = []
    loss = r["shading_loss"]
    if loss >= 0.1:
        worst = max(range(12), key=lambda i: r["monthly_shading"][i])
        notes.append(
            f"Соседние здания выше: тень срезает {loss:.0%} выработки за год, "
            f"сильнее всего в {MONTHS_IN[worst]} — {r['monthly_shading'][worst]:.0%} прямого света"
        )
    elif loss < 0.02:
        notes.append("Крышу почти не затеняют соседи")
    else:
        notes.append(f"Тень от соседей небольшая: −{loss:.0%} за год")
    if r["roof_m2"] >= large_roof_m2:
        notes.append("Одна из самых больших крыш района")
    if r["height_source"] == "assumed":
        notes.append(
            f"Высоты здания нет в OpenStreetMap — принята {r['height_m']:.0f} м по типу "
            f"«{r['type'] or 'не указан'}»; тени считаются приблизительно"
        )
    if r["pitched"]:
        notes.append("Скатная крыша: считаем только южный скат")
    return notes


def compute_district(data: dict) -> dict:
    irr = data["irradiance"]
    lat0, lon0 = irr["lat"], irr["lon"]
    months = irr["months"]
    roofs = load_roofs(data["buildings"], lat0, lon0)
    paths = [sun_path(lat0, m, irr["tilt_deg"]) for m in range(1, 13)]

    # Точки периметра всех зданий — препятствия. Раскладываем по сетке 50 м,
    # чтобы для каждой крыши смотреть только соседей в радиусе горизонта.
    cell = 50.0
    grid: dict[tuple[int, int], list[tuple[float, float, float, int]]] = {}
    for idx, roof in enumerate(roofs):
        for x, y in densify(roof.xy):
            grid.setdefault((int(x // cell), int(y // cell)), []).append((x, y, roof.height_m, idx))
    reach = int(ASSUMPTIONS["horizon_radius_m"] // cell) + 1

    # Башня, нарисованная частью здания, стоит на крыше подиума — её площадь
    # под панели не годится.
    towers = [(centroid(r.xy), r.area_m2, r.height_m) for r in roofs if r.part]

    results = []
    for idx, roof in enumerate(roofs):
        if (
            roof.part
            or roof.roof_shape in UNSUITABLE_SHAPES
            or roof.area_m2 < ASSUMPTIONS["min_roof_m2"]
        ):
            continue
        cx, cy = centroid(roof.xy)
        gx, gy = int(cx // cell), int(cy // cell)
        obstacles = [
            (x, y, h)
            for i in range(gx - reach, gx + reach + 1)
            for j in range(gy - reach, gy + reach + 1)
            for x, y, h, owner in grid.get((i, j), ())
            if owner != idx and h > roof.height_m
        ]
        horizons = [horizon_profile(p, roof.height_m, obstacles) for p in sample_points(roof.xy)]
        # Потерю от тени применяем только к прямой части света: рассеянный
        # приходит со всего неба и соседями почти не перекрывается.
        monthly_shading = [
            sum(shaded_share(h, paths[m]) for h in horizons) / len(horizons) for m in range(12)
        ]
        covered = sum(
            area for c, area, h in towers if h > roof.height_m + 1 and point_in_polygon(c, roof.xy)
        )
        usable = max(0.0, roof.area_m2 - covered) * _usable_share(roof)
        if usable < ASSUMPTIONS["min_roof_m2"] * _usable_share(roof):
            continue
        kwp = usable * ASSUMPTIONS["ground_coverage_ratio"] * ASSUMPTIONS["module_kwp_per_m2"]
        monthly_kwh = []
        for m in range(12):
            direct = 1 - months[m]["diffuse_share"]
            monthly_kwh.append(kwp * months[m]["kwh_per_kwp"] * (1 - direct * monthly_shading[m]))
        unshaded = kwp * irr["kwh_per_kwp_year"]
        year = sum(monthly_kwh)
        results.append(
            {
                "id": roof.id,
                "name": roof.name,
                "type": roof.type,
                "height_m": round(roof.height_m, 1),
                "height_source": roof.height_source,
                "pitched": _usable_share(roof) == ASSUMPTIONS["usable_roof_share_pitched"],
                "roof_m2": round(roof.area_m2),
                "usable_m2": round(usable),
                "kwp": round(kwp, 1),
                "kwh_year": round(year),
                "kwh_per_kwp": round(year / kwp) if kwp else 0,
                "shading_loss": round(1 - year / unshaded, 3) if unshaded else 0,
                "monthly_kwh": [round(v) for v in monthly_kwh],
                "monthly_shading": [round(v, 3) for v in monthly_shading],
                "polygon": roof.polygon,
            }
        )

    results.sort(key=lambda r: r["kwh_year"], reverse=True)
    areas = sorted(r["roof_m2"] for r in results)
    large = areas[int(len(areas) * 0.9)] if areas else 0
    for rank, r in enumerate(results, start=1):
        r["rank"] = rank
        r["notes"] = _notes(r, large)

    total_kwh = sum(r["kwh_year"] for r in results)
    return {
        "district": data["district"],
        "bbox": data["bbox"],
        "sources": {
            "buildings": data["buildings_source"],
            "irradiance": irr["source"],
            "fetched": data["fetched"],
        },
        "irradiance": irr,
        "assumptions": ASSUMPTIONS,
        "summary": {
            "buildings": len(results),
            "height_known_share": round(
                sum(r["height_source"] != "assumed" for r in results) / max(1, len(results)), 3
            ),
            "total_kwp": round(sum(r["kwp"] for r in results)),
            "total_mwh_year": round(total_kwh / 1000),
            "top10_mwh_year": round(sum(r["kwh_year"] for r in results[:10]) / 1000),
        },
        "buildings": results,
    }


@lru_cache(maxsize=1)
def district_rooftops() -> dict:
    return compute_district(json.loads(DATA_FILE.read_text()))
