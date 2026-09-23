"""Главный инвариант кейса: прогноз из момента T видит только то, что было опубликовано к T.

Проверка не «на глаз», а подменой: все значения архива, опубликованные позже T,
заменяются мусором — признаки прогноза не должны измениться ни на бит.
"""

import numpy as np
import pytest

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
