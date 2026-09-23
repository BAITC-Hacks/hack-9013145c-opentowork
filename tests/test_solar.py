"""Расчёт солнечного потенциала крыш — без базы и сети."""

import json
import math

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import solar
from app.deps import current_user
from app.solar import model
from app.solar.model import (
    SunSample,
    building_height,
    compute_district,
    district_rooftops,
    horizon_profile,
    shaded_share,
    sun_path,
)

LAT = 51.125  # Астана


def _noon(samples):
    return max(samples, key=lambda s: s.altitude)


def test_noon_sun_height_matches_astronomy():
    # В полдень высота солнца = 90° − широта + склонение.
    june = math.degrees(_noon(sun_path(LAT, 6, 30)).altitude)
    december = math.degrees(_noon(sun_path(LAT, 12, 30)).altitude)
    assert june == pytest.approx(90 - LAT + 23.3, abs=1)
    assert december == pytest.approx(90 - LAT - 23.3, abs=1)


def test_noon_sun_is_in_the_south():
    assert math.degrees(_noon(sun_path(LAT, 3, 30)).azimuth) == pytest.approx(180, abs=6)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ({"height": "45 m"}, (45.0, "osm_height")),
        ({"levels": "9;12"}, (36.0, "osm_levels")),
        ({"type": "apartments"}, (27.0, "assumed")),
        ({"type": "unknown_type"}, (12.0, "assumed")),
    ],
)
def test_building_height(raw, expected):
    assert building_height(raw) == expected


def test_tall_neighbour_to_the_south_shades_winter_more_than_summer():
    # Стена 60 м в 50 м к югу от точки на крыше 10 м.
    wall = [(x, -50.0, 60.0) for x in range(-100, 101, 2)]
    horizon = horizon_profile((0.0, 0.0), 10.0, wall)
    winter = shaded_share(horizon, sun_path(LAT, 12, 30))
    summer = shaded_share(horizon, sun_path(LAT, 6, 30))
    assert winter > 0.9
    assert summer < winter


def test_lower_neighbours_cast_no_shadow():
    wall = [(x, -20.0, 5.0) for x in range(-50, 51, 2)]
    horizon = horizon_profile((0.0, 0.0), 10.0, wall)
    assert shaded_share(horizon, sun_path(LAT, 12, 30)) == 0


def test_horizon_wraps_tiny_negative_north_azimuth():
    horizon = horizon_profile((0, 0), 10, [(-1e-14, 50, 60)])
    assert horizon[0] > 0
    assert shaded_share(horizon, [SunSample(0.1, -1e-17, 1)]) == 1


def _square(lat, lon, d=0.0005):
    return [[lat, lon], [lat + d, lon], [lat + d, lon + d], [lat, lon + d], [lat, lon]]


def _district(buildings):
    months = [{"month": m, "kwh_per_kwp": 100.0, "diffuse_share": 0.5} for m in range(1, 13)]
    return {
        "district": "test",
        "bbox": [0, 0, 1, 1],
        "fetched": "2026-09-23",
        "buildings_source": "test",
        "irradiance": {
            "lat": LAT,
            "lon": 71.43,
            "tilt_deg": 30,
            "kwh_per_kwp_year": 1200.0,
            "months": months,
            "source": "test",
        },
        "buildings": buildings,
    }


def test_domes_and_building_parts_are_not_candidates():
    result = compute_district(
        _district(
            [
                {"id": "flat", "type": "office", "levels": "5", "polygon": _square(LAT, 71.43)},
                {
                    "id": "dome",
                    "type": "yes",
                    "roof_shape": "dome",
                    "polygon": _square(LAT, 71.44),
                },
                {"id": "part", "type": "yes", "part": True, "height": "60",
                 "min_height": "12", "roof_height": "4", "polygon": _square(LAT, 71.45)},
            ]
        )
    )
    assert [b["id"] for b in result["buildings"]] == ["flat"]
    assert {b["id"] for b in result["context_buildings"]} == {"dome", "part"}
    context = {b["id"]: b for b in result["context_buildings"]}
    assert context["dome"]["min_height_m"] == 0
    assert context["part"]["height_m"] == 60
    assert context["part"]["min_height_m"] == 12
    assert context["part"]["roof_height_m"] == 4
    assert all("kwp" not in b for b in context.values())


def test_unshaded_roof_yields_pvgis_energy():
    roof = compute_district(
        _district([{"id": "a", "type": "office", "levels": "5", "polygon": _square(LAT, 71.43)}])
    )["buildings"][0]
    assert roof["shading_loss"] == 0
    assert roof["kwh_year"] == pytest.approx(roof["kwp"] * 1200, rel=0.01)
    assert sum(roof["monthly_kwh"]) == pytest.approx(roof["kwh_year"], abs=12)


def test_real_district_is_ranked_and_excludes_khan_shatyr():
    result = district_rooftops()
    names = [b["name"] for b in result["buildings"]]
    assert "Хан Шатыр" not in names
    energy = [b["kwh_year"] for b in result["buildings"]]
    assert energy == sorted(energy, reverse=True)
    assert all(0 <= b["shading_loss"] < 1 for b in result["buildings"])


def test_city_endpoint_default_selection_and_invalid_city(monkeypatch):
    calls = []

    def calculate(city):
        calls.append(city)
        return {"city_id": city}

    monkeypatch.setattr(solar, "district_rooftops", calculate)
    app = FastAPI()
    app.include_router(solar.router)
    app.dependency_overrides[current_user] = lambda: object()
    with TestClient(app) as client:
        assert client.get("/solar/rooftops").json() == {"city_id": "astana"}
        for city in ("almaty", "shymkent"):
            response = client.get("/solar/rooftops", params={"city": city})
            assert response.status_code == 200
            assert response.json() == {"city_id": city}
        assert client.get("/solar/rooftops?city=../astana").status_code == 422
    assert calls == ["astana", "almaty", "shymkent"]


def test_city_cache_keeps_separate_results(monkeypatch, tmp_path):
    files = {}
    for idx, city in enumerate(("astana", "almaty", "shymkent")):
        data = _district([])
        data.update(city_id=city, city_name=city, bbox=[LAT - 1, 70, LAT + 1, 73])
        data["irradiance"]["kwh_per_kwp_year"] = 1200 + 100 * idx
        path = tmp_path / f"{city}.json"
        path.write_text(json.dumps(data))
        files[city] = path
    monkeypatch.setattr(model, "CITY_FILES", files)
    district_rooftops.cache_clear()
    try:
        results = {city: district_rooftops(city) for city in files}
        assert {r["city_id"] for r in results.values()} == set(files)
        assert len({r["irradiance"]["kwh_per_kwp_year"] for r in results.values()}) == 3
        assert all(district_rooftops(city) is results[city] for city in files)
        assert district_rooftops.cache_info().hits == 3
    finally:
        district_rooftops.cache_clear()


@pytest.mark.parametrize("wrong", ["city", "irradiance"])
def test_wrong_city_or_reused_irradiance_is_rejected(monkeypatch, tmp_path, wrong):
    data = _district([])
    data.update(city_id="astana", bbox=[LAT - 1, 70, LAT + 1, 73])
    if wrong == "city":
        data["city_id"] = "almaty"
    else:
        data["irradiance"]["lat"] = 43.241
    path = tmp_path / "wrong.json"
    path.write_text(json.dumps(data))
    monkeypatch.setattr(model, "CITY_FILES", {"astana": path})
    district_rooftops.cache_clear()
    try:
        with pytest.raises(ValueError):
            district_rooftops("astana")
    finally:
        district_rooftops.cache_clear()


def test_committed_city_snapshots_have_local_weather_and_real_environment():
    latitudes = {"astana": 51.125, "almaty": 43.241, "shymkent": 42.318}
    yearly = []
    ids = []
    for city, path in model.CITY_FILES.items():
        data = json.loads(path.read_text())
        assert data["city_id"] == city
        assert data["irradiance"]["lat"] == pytest.approx(latitudes[city], abs=0.001)
        assert [m["month"] for m in data["irradiance"]["months"]] == list(range(1, 13))
        yearly.append(data["irradiance"]["kwh_per_kwp_year"])
        ids.append({b["id"] for b in data["buildings"]})
        assert len(data["buildings"]) > 20
        assert len(data["environment"]["roads"]) > 20
        assert len(data["environment"]["areas"]) > 0
        south, west, north, east = data["bbox"]
        for road in data["environment"]["roads"]:
            assert road["id"].startswith("way/")
            assert 0 < road["width_m"] <= 60
            assert len(road["coordinates"]) >= 2
            assert all(south <= lat <= north and west <= lon <= east
                       for lat, lon in road["coordinates"])
        for feature in data["buildings"] + data["environment"]["areas"]:
            assert feature["polygon"][0] == feature["polygon"][-1]
        result = district_rooftops(city)
        assert result["city_id"] == city
        assert len(result["buildings"]) > 20
        assert all(0 <= b["shading_loss"] < 1 and math.isfinite(b["kwh_year"])
                   for b in result["buildings"])
    assert len(set(yearly)) == 3
    assert all(not a.intersection(b) for i, a in enumerate(ids) for b in ids[i + 1:])
