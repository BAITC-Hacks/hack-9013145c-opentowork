"""Интерпретация: вклады складываются в предсказание, шаги каскада сходятся с прогнозом."""

import json

import pytest

pd = pytest.importorskip("pandas")
pytest.importorskip("lightgbm")

from windcast.config import MODELS_DIR  # noqa: E402
from windcast.explain import EXPLAIN_DIR, GROUPS, explain_revision, group_of  # noqa: E402

needs_model = pytest.mark.skipif(
    not (MODELS_DIR / "forecaster.pkl").exists(), reason="нет обученной модели"
)


def test_every_feature_has_a_human_group():
    from windcast.features import feature_columns, inference_frame

    x = inference_frame(pd.Timestamp("2026-02-07"), 6)
    known = {k for k, _, _ in GROUPS}
    for f in feature_columns(x):
        assert group_of(f) in known


@pytest.fixture(scope="module")
def doc():
    from windcast.explain import explain_origin
    from windcast.pipeline import Forecaster

    return explain_origin(Forecaster.load(), pd.Timestamp("2026-02-06 00:00"), 48)


@needs_model
def test_shap_contributions_add_up_to_corrected_wind(doc):
    # TreeSHAP точен для деревьев: база + сумма вкладов = медиана поправки ветра.
    # Допуск — на сортировку квантилей и усреднение двух турбин.
    for h in doc["hours"]:
        total = h["wind"]["base"] + sum(g["wind_ms"] for g in h["groups"])
        assert total == pytest.approx(h["wind"]["corrected"], abs=0.35)


@needs_model
def test_cascade_steps_end_at_forecast(doc):
    from windcast.pipeline import Forecaster, station_view

    pred = station_view(Forecaster.load().predict(pd.Timestamp("2026-02-06 00:00"), 48))
    for h in doc["hours"]:
        t = pd.Timestamp(h["time"].rstrip("Z"))
        assert [s["key"] for s in h["steps"]] == ["raw", "corrected", "uncertainty", "final"]
        assert h["steps"][-1]["power"] == pytest.approx(pred.loc[t, "q50"], abs=1e-3)
        assert h["interval"][0] <= h["steps"][-1]["power"] <= h["interval"][1]


@needs_model
def test_summary_and_overall_are_consistent(doc):
    assert len(doc["hours"]) == 48
    labels = [o["label"] for o in doc["overall"]]
    assert labels[0].lower() in doc["summary"].lower()


def test_revision_points_to_biggest_change():
    def hour(t, p, w):
        return {
            "time": t,
            "local": t,
            "steps": [{"power": p}],
            "wind": {"raw": w, "by_model": {"A": w}},
            "groups": [{"group": "wind_level", "label": "Прогноз ветра", "wind_ms": w}],
        }

    prev = {"origin": "o1", "hours": [hour("t1", 0.5, 7.0), hour("t2", 0.5, 7.0)]}
    new = {"origin": "o2", "hours": [hour("t1", 0.52, 7.1), hour("t2", 0.2, 5.0)]}
    r = explain_revision(prev, new)
    assert r["hours"][0]["time"] == "t2"
    assert r["hours"][0]["model_wind_change"]["A"] == pytest.approx(-2.0)
    assert "A (-2.0 м/с)" in r["summary"]


@pytest.mark.skipif(not (EXPLAIN_DIR / "2026-02-07.json").exists(), reason="нет объяснений")
def test_saved_explanations_match_agent_versions():
    from windcast.config import FORECASTS_DIR

    e = json.loads((EXPLAIN_DIR / "2026-02-07.json").read_text(encoding="utf-8"))
    f = json.loads((FORECASTS_DIR / "2026-02-07.json").read_text(encoding="utf-8"))
    runs = [v for v in f["versions"] if "skipped" not in v]
    assert [v["forecast_id"] for v in e["versions"]] == [v["forecast_id"] for v in runs]
    assert all("revision" in v for v in e["versions"][1:])
