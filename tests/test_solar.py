"""Расчёт солнечного потенциала крыш — без базы и сети."""

import math

import pytest

from app.solar.model import (
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
                {"id": "part", "type": "yes", "part": True, "polygon": _square(LAT, 71.45)},
            ]
        )
    )
    assert [b["id"] for b in result["buildings"]] == ["flat"]


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
