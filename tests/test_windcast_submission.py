"""Черновик заявки в РФЦ: часы формы, срок подачи, правило «за 2 часа», МВт."""

import pytest

pd = pytest.importorskip("pandas")

from windcast import submission as sub  # noqa: E402
from windcast.config import FORECASTS_DIR  # noqa: E402

pytestmark = pytest.mark.skipif(
    not (FORECASTS_DIR / "2026-02-06.json").exists(), reason="нет прогона агента"
)
DAY = "2026-02-07"


@pytest.fixture(scope="module")
def bid():
    return sub.build_bid(DAY)


def test_form_hours_are_astana_intervals(bid):
    assert [h.hour for h in bid.hours] == list(range(1, 25))
    assert bid.hours[0].interval_local == "00:00–01:00"
    assert bid.hours[-1].interval_local == "23:00–24:00"
    # 00:00 по Астане 07.02 = 19:00 UTC 06.02
    assert bid.hours[0].utc_start == "2026-02-06 19:00:00"


def test_bid_uses_forecast_issued_before_deadline(bid):
    # Срок — 08:00 Астаны 06.02 = 03:00 UTC; выпуск агента в 00 UTC успевает.
    assert bid.deadline_local == "06.02.2026 08:00"
    assert bid.prepared_at_local == "06.02.2026 05:00"
    # Сутки D по Астане — это горизонты 19–43 выпуска D−1 00 UTC.
    assert [h.horizon_h for h in bid.hours] == list(range(19, 43))


def test_volumes_in_mw_within_installed_capacity(bid):
    assert bid.installed_mw == 5.0
    for h in bid.hours:
        assert 0 <= h.p10_mw <= h.mw <= h.p90_mw <= bid.installed_mw
        assert round(h.mw, 3) == h.mw
    assert bid.total_mwh == pytest.approx(sum(h.mw for h in bid.hours), abs=1e-6)


def test_rated_power_scales_volumes():
    big = sub.build_bid(DAY, rated_mw_per_turbine=5.0)
    small = sub.build_bid(DAY)
    assert big.hours[5].mw == pytest.approx(2 * small.hours[5].mw, abs=0.002)


def test_corrections_respect_two_hour_lead(bid):
    assert bid.corrections, "на 07.02 агент выпускал ревизии"
    for c in bid.corrections:
        hour = next(h for h in bid.hours if h.hour == c.hour)
        decided = pd.Timestamp(c.weather_run_origin.rstrip("Z"))
        assert pd.Timestamp(hour.utc_start) - decided >= pd.Timedelta(hours=2)
        assert c.volume_mw >= sub.CORRECTION_MIN_SHARE * bid.installed_mw
        assert c.direction == ("вверх" if c.new_mw > c.was_mw else "вниз")


def test_form_number_format():
    assert sub._fmt(4.8551) == "4,855"
    assert sub._fmt(0) == "0,000"


def test_documents_are_generated(tmp_path, bid):
    pytest.importorskip("docx")
    pytest.importorskip("reportlab")
    sub.save_docx(bid, tmp_path / "b.docx")
    sub.save_pdf(bid, tmp_path / "b.pdf")
    sub.save_csv(bid, tmp_path / "b.csv")
    assert (tmp_path / "b.pdf").read_bytes()[:4] == b"%PDF"
    assert (tmp_path / "b.docx").stat().st_size > 10_000
    lines = (tmp_path / "b.csv").read_text(encoding="utf-8-sig").splitlines()
    assert len(lines) == 25 and lines[1].split(";")[1] == "01:00"
