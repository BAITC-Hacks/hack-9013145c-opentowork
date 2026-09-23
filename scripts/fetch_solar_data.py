"""Скачивает исходные данные для расчёта солнечного потенциала крыш.

Запускается один раз вручную, результат лежит в репозитории: проверка
проекта не должна зависеть от внешних API (п. 5.6.6).

    python3 scripts/fetch_solar_data.py

Источники:
- контуры и этажность зданий — OpenStreetMap через Overpass API (ODbL);
- месячная радиация и выработка 1 кВт панелей — PVGIS-ERA5 (JRC, ЕС).
"""

import json
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
# Типовой наклон стоек на плоской крыше: ряды меньше затеняют друг друга,
# чем при оптимальных для Астаны ~43°.
TILT = 30

OUT = Path(__file__).resolve().parents[1] / "app" / "solar" / "data" / "astana_left_bank.json"
UA = {"User-Agent": "hackalem-opentowork/0.1 (hackathon)"}


def get_json(url: str, data: bytes | None = None, attempts: int = 4) -> dict:
    # Публичные Overpass и PVGIS периодически отвечают 429/504 под нагрузкой.
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, json.JSONDecodeError) as exc:
            if attempt == attempts:
                raise
            print(f"  {exc}, повтор {attempt}/{attempts - 1} через {10 * attempt} с")
            time.sleep(10 * attempt)
    raise AssertionError("unreachable")


def fetch_buildings() -> list[dict]:
    # building:part — отдельно нарисованные башни и этажи: без них высотка
    # на подиуме выглядит шестиметровой и не отбрасывает тени.
    query = (
        f'[out:json][timeout:90];(way[building]{BBOX};way["building:part"]{BBOX};);out tags geom;'
    )
    body = urllib.parse.urlencode({"data": query}).encode()
    elements = get_json("https://overpass-api.de/api/interpreter", body)["elements"]
    out = []
    for e in elements:
        tags = e.get("tags", {})
        is_part = "building" not in tags
        if tags.get("building") in {"construction", "roof", "ruins"}:
            continue
        geom = e.get("geometry") or []
        if len(geom) < 4:
            continue
        address = " ".join(filter(None, [tags.get("addr:street"), tags.get("addr:housenumber")]))
        out.append(
            {
                "id": f"way/{e['id']}",
                "name": tags.get("name") or address or None,
                "type": tags.get("building") or tags.get("building:part"),
                "part": is_part,  # только препятствие для теней, не кандидат под панели
                "roof_shape": tags.get("roof:shape"),
                "height": tags.get("height"),
                "min_height": tags.get("min_height"),
                "levels": tags.get("building:levels"),
                "polygon": [[round(p["lat"], 6), round(p["lon"], 6)] for p in geom],
            }
        )
    return out


def fetch_pvgis() -> dict:
    lat, lon = CENTER
    base = "https://re.jrc.ec.europa.eu/api/v5_2"
    common = f"lat={lat:.4f}&lon={lon:.4f}&raddatabase=PVGIS-ERA5&outputformat=json"
    pv = get_json(f"{base}/PVcalc?{common}&peakpower=1&loss=14&angle={TILT}&aspect=0")
    mr = get_json(f"{base}/MRcalc?{common}&horirrad=1&d2g=1&startyear=2011&endyear=2020")

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
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "tilt_deg": TILT,
        "azimuth": "south",
        "system_loss_pct": 14,
        "kwh_per_kwp_year": pv["outputs"]["totals"]["fixed"]["E_y"],
        "months": months,
    }


def main() -> None:
    buildings = fetch_buildings()
    data = {
        "district": "Астана, левый берег",
        "bbox": BBOX,
        "fetched": date.today().isoformat(),
        "buildings_source": "OpenStreetMap (ODbL), Overpass API",
        "irradiance": fetch_pvgis(),
        "buildings": buildings,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(buildings)} зданий → {OUT} ({OUT.stat().st_size // 1024} КБ)")


if __name__ == "__main__":
    main()
