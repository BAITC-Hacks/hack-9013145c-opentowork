"""Главный инвариант кейса: прогноз из момента T видит только то, что было опубликовано к T.

Проверка не «на глаз», а подменой: все значения архива, опубликованные позже T,
заменяются мусором — признаки прогноза не должны измениться ни на бит.
"""

import pytest

np = pytest.importorskip("numpy")
pd = pytest.importorskip("pandas")
pytest.importorskip("pyarrow")

from windcast.config import NWP_PUBLICATION_DELAY_H, WEATHER_DIR  # noqa: E402

pytestmark = pytest.mark.skipif(
    not any(WEATHER_DIR.glob("*.parquet")), reason="нет кэша погоды artifacts/weather"
)

ORIGINS = ["2025-02-10 00:00", "2025-07-01 12:00", "2026-01-31 00:00", "2026-02-15 06:00"]


def _poison_future(archive, origin):
    poisoned = archive.copy()
    for col in poisoned.columns:
        day = int(col.rsplit("|d", 1)[1])
        published = poisoned.index - pd.Timedelta(hours=24 * day - NWP_PUBLICATION_DELAY_H)
        poisoned.loc[published > origin, col] = 9999.0
    return poisoned


@pytest.mark.parametrize("origin", ORIGINS)
def test_features_do_not_depend_on_future_nwp(origin):
    from windcast.features import feature_columns, inference_frame
    from windcast.weather import load_archive

    origin = pd.Timestamp(origin)
    archive = load_archive()
    clean = inference_frame(origin, 48, archive)
    poisoned = inference_frame(origin, 48, _poison_future(archive, origin))
    cols = feature_columns(clean)
    pd.testing.assert_frame_equal(clean[cols], poisoned[cols])


@pytest.mark.parametrize("origin", ORIGINS)
def test_every_row_published_before_origin(origin):
    from windcast.features import inference_frame

    origin = pd.Timestamp(origin)
    x = inference_frame(origin, 48)
    assert (x["available_at"] <= origin).all()
    assert x["horizon_h"].between(1, 48).all()


def test_day_for_horizon_is_minimal_safe_day():
    from windcast.weather import day_for_horizon

    for h in range(1, 49):
        d = day_for_horizon(h)
        assert 24 * d >= h + NWP_PUBLICATION_DELAY_H
        assert d == 1 or 24 * (d - 1) < h + NWP_PUBLICATION_DELAY_H
    assert np.array_equal(day_for_horizon(np.array([1, 18, 19, 42, 43, 48])), [1, 1, 2, 2, 3, 3])


def test_calibration_cannot_see_targets_after_cutoff():
    from windcast.metrics import QCOLS
    from windcast.models.ensemble import calibrate

    times = pd.date_range("2025-02-01", periods=800, freq="h")
    h = pd.DataFrame(index=times)
    h["actual"] = 0.4
    h["nwp_day"] = 1
    for prefix, value in (("cas", 0.3), ("dir", 0.6)):
        for c in [*QCOLS, "mean"]:
            h[f"{prefix}_{c}"] = value
    cutoff = pd.Timestamp("2025-03-01")
    clean = calibrate(h, before=cutoff)
    h.loc[h.index >= cutoff, "actual"] = 9999
    assert calibrate(h, before=cutoff) == clean
    assert clean.calibrated_on == 672


def test_quality_flags_ignore_future_scada(monkeypatch):
    from windcast import scada

    raw = pd.DataFrame(
        {"ws": 8.0, "power": [0.2] * 12 + [0.9] * 24, "temp": 5.0},
        index=pd.date_range("2025-01-01", periods=36, freq="10min"),
    )
    cutoff = pd.Timestamp("2025-01-01 02:00")
    monkeypatch.setattr(scada, "load_raw", lambda _: raw.copy())
    scada.load_hourly.cache_clear()
    clean = scada.load_hourly("T1", cutoff)
    raw.loc[raw.index >= cutoff, "power"] = 9999
    scada.load_hourly.cache_clear()
    pd.testing.assert_frame_equal(clean, scada.load_hourly("T1", cutoff))
    scada.load_hourly.cache_clear()
