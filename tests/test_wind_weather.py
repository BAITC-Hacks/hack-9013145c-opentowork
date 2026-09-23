from datetime import datetime

from app.wind import weather


def test_beaufort_scale_edges():
    assert weather.beaufort(0.0) == 0
    assert weather.beaufort(3.3) == 2
    assert weather.beaufort(8.8) == 5
    assert weather.beaufort(24.4) == 9
    assert weather.beaufort(40) == 12


def test_shear_alpha_log_profile():
    # v100 = v10 · 10^α
    assert weather.shear_alpha(5.0, 5.0 * 10**0.14) == 0.14
    assert weather.shear_alpha(0.2, 5.0) is None
    assert weather.shear_alpha(None, 5.0) is None


def test_rows_parse_open_meteo_payload():
    payload = {
        "hourly": {
            "time": ["2026-01-31T01:00", "2026-01-31T02:00"],
            "wind_speed_10m": [4.46, 4.82],
            "wind_speed_100m": [8.81, None],
            "wind_direction_10m": [81, 77],
            "wind_direction_100m": [65, 63],
            "wind_gusts_10m": [7.1, 7.8],
            "temperature_2m": [-4.3, -3.9],
        }
    }
    rows = weather._rows(payload)
    assert len(rows) == 1  # час без скорости у ротора отброшен
    assert rows[0]["time"] == "2026-01-31T01:00:00Z"
    assert rows[0]["beaufort"] == 5
    assert rows[0]["shear_alpha"] == 0.3


def test_snapshot_covers_whole_test_period_offline():
    # Проверка проекта идёт без сети: весь тестовый период лежит в репозитории.
    first = weather.from_snapshot("nurly", datetime(2026, 1, 31, 1), 48)
    last = weather.from_snapshot("nurly", datetime(2026, 2, 27, 1), 48)
    assert first and len(first) == 48 and first[0]["time"] == "2026-01-31T01:00:00Z"
    assert last and len(last) == 48
    assert weather.from_snapshot("akmola", datetime(2026, 1, 31, 1), 48) is None
