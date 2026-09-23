"""Ветер «сейчас»: разбор Open-Meteo current и выбор ближайшего METAR — без сети."""

import pytest

from app.wind.wind_now import haversine_km, nearest_observation, parse_current

ASTANA = (51.0826, 71.3285)


def metar(icao, lat, lon, wdir, wspd, wgst=None):
    return {"icaoId": icao, "name": icao, "lat": lat, "lon": lon, "wdir": wdir,
            "wspd": wspd, "wgst": wgst, "reportTime": "2026-09-23T12:00:00.000Z"}


def test_haversine_astana_almaty():
    # Астана — Алматы по прямой около 970 км.
    assert haversine_km(*ASTANA, 43.35, 77.04) == pytest.approx(970, rel=0.03)


def test_parse_current_adds_utc_marker():
    out = parse_current({"latitude": 51.1, "longitude": 71.3, "current": {
        "time": "2026-09-23T12:15", "wind_speed_10m": 5.3, "wind_direction_10m": 55,
        "wind_gusts_10m": 10.4, "wind_speed_100m": 7.6, "wind_direction_100m": 58,
    }})
    assert out["time"] == "2026-09-23T12:15Z"
    assert out["wind_dir_10m"] == 55 and out["wind_dir_100m"] == 58


def test_nearest_picks_closest_and_converts_knots():
    reports = [
        metar("FAR", 52.5, 73.0, 90, 10),
        metar("UACC", 51.02, 71.47, 50, 10, wgst=20),
    ]
    obs = nearest_observation(reports, *ASTANA)
    assert obs["icao"] == "UACC"
    assert obs["wind_dir_10m"] == 50
    assert obs["wind_speed_10m"] == pytest.approx(5.1, abs=0.05)
    assert obs["wind_gusts_10m"] == pytest.approx(10.3, abs=0.05)
    assert obs["distance_km"] < 20


def test_variable_wind_is_skipped():
    # VRB приходит строкой — направления нет, берём следующий аэродром.
    reports = [metar("NEAR", 51.05, 71.4, "VRB", 2), metar("NEXT", 51.5, 72.0, 270, 8)]
    assert nearest_observation(reports, *ASTANA)["icao"] == "NEXT"


def test_too_far_station_is_not_used():
    assert nearest_observation([metar("FAR", 43.35, 77.04, 180, 5)], *ASTANA) is None
