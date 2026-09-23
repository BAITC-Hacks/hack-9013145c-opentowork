"""Решения агента на синтетических данных: без обучения моделей и без сети."""

import pytest

pd = pytest.importorskip("pandas")
np = pytest.importorskip("numpy")
pytest.importorskip("lightgbm")

from windcast.agent import tools  # noqa: E402
from windcast.agent.report import _numbers, llm_report, template_report  # noqa: E402

QS = ["q05", "q10", "q25", "q50", "q75", "q90", "q95"]


def _pred(origin="2026-02-07 00:00", hours=48, level=0.5, turbines=("T1", "T2")):
    idx = pd.date_range(pd.Timestamp(origin) + pd.Timedelta(hours=1), periods=hours, freq="1h")
    frames = []
    for t in turbines:
        df = pd.DataFrame(index=idx)
        df["turbine"] = t
        df["horizon_h"] = range(1, hours + 1)
        df["nwp_day"] = 1
        df["available_at"] = pd.Timestamp(origin)
        for i, q in enumerate(QS):
            df[q] = np.clip(level + (i - 3) * 0.1, 0, 1)
        df["cas_q50"] = level
        df["dir_q50"] = level
        frames.append(df)
    out = pd.concat(frames)
    out.index.name = "time"
    return out


def test_new_weather_run_gives_fresher_data_only_for_some_hours():
    day = pd.Timestamp("2026-02-07")
    targets = pd.date_range(day + pd.Timedelta(hours=7), day + pd.Timedelta(hours=48), freq="1h")
    fresh = tools.fresher_data_available(day, day + pd.Timedelta(hours=6), targets)
    # Сдвиг на 6 ч переводит часы на границах N(h) на более свежий выпуск: 18→12 и 42→36.
    assert fresh == 12


def test_same_origin_gives_no_fresh_data():
    day = pd.Timestamp("2026-02-07")
    targets = pd.date_range(day + pd.Timedelta(hours=1), periods=48, freq="1h")
    assert tools.fresher_data_available(day, day, targets) == 0


def test_revision_published_only_when_material():
    base = _pred(level=0.5)
    small = _pred(level=0.51)
    big = _pred(level=0.7)
    assert tools.compare_with_previous(base, None)["first_issue"]
    assert not tools.compare_with_previous(small, base)["material"]
    assert tools.compare_with_previous(big, base)["material"]


def test_critic_catches_crossing_quantiles():
    bad = _pred()
    bad["q90"] = bad["q10"] - 0.1
    res = tools.critic(bad, 48)
    assert not res["ok"]
    assert tools.critic(_pred(), 48)["ok"]


def test_critic_catches_missing_hours():
    res = tools.critic(_pred(hours=40), 48)
    assert not res["ok"] and "часов" in res["problems"][0]


def test_ramps_are_merged_into_events():
    p = _pred()
    idx = p.index.unique()
    step = pd.Series(np.where(np.arange(len(idx)) < 20, 0.1, 0.9), index=idx)
    for q in QS:
        p[q] = step.reindex(p.index).to_numpy()
    for c in ("mean", "raw_nwp_curve", "wind_corrected", "wind_nwp"):
        p[c] = 0.5
    a = tools.analyze(p)
    assert a["n_ramps"] == 1
    assert a["ramps"][0]["direction"] == "up"


def test_report_without_key_is_template(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    facts = {
        "origin": "2026-02-07 00:00:00",
        "horizon": 48,
        "analysis": {
            "mean_p50": 0.5,
            "max_p50": 0.9,
            "peak_time": "2026-02-08 12:00:00",
            "n_ramps": 0,
            "ramps": [],
            "wide_interval_hours": 0,
            "wind_bias_correction_ms": 0.3,
        },
        "qa": {"warnings": []},
        "revision": {"is_revision": False},
    }
    text, source = llm_report(facts)
    assert source == "template"
    assert text == template_report(facts)


def test_number_extraction_for_llm_guard():
    assert _numbers("мощность 53% и 0,25 номинала, 12 ч") == {"53", "0.25", "12"}
