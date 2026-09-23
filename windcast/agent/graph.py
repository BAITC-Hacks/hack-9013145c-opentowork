"""Граф агента: planner → weather → qa → forecast → critic → analyze → compare → report.

Переходы — явные правила, а не «LLM решит»: так агент воспроизводим без ключа.
Решения, которые принимает граф:
  - qa провалена         → повтор с более старым выпуском погоды (сдвиг origin на −6 ч)
  - critic провален      → запасной прогноз (сырой прогноз ветра + кривая), флаг degraded
  - ревизия не существенна → версия не публикуется, остаётся предыдущая
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field

import pandas as pd

from windcast.agent import tools
from windcast.agent.report import llm_report
from windcast.metrics import QCOLS
from windcast.pipeline import Forecaster

MAX_WEATHER_RETRIES = 2


@dataclass
class AgentRun:
    origin: pd.Timestamp
    horizon: int = 48
    run_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    steps: list[dict] = field(default_factory=list)
    facts: dict = field(default_factory=dict)
    prediction: pd.DataFrame | None = None
    published: bool = False
    degraded: bool = False
    report: str = ""
    report_source: str = ""

    def step(self, agent: str, action: str, status: str, t0: float, detail: str = "") -> None:
        self.steps.append(
            {
                "agent": agent,
                "action": action,
                "status": status,
                "duration_ms": int((time.time() - t0) * 1000),
                "detail": detail,
            }
        )


def run(
    fc: Forecaster,
    origin: pd.Timestamp,
    horizon: int = 48,
    previous: pd.DataFrame | None = None,
    reason: str = "плановый выпуск",
) -> AgentRun:
    r = AgentRun(origin=pd.Timestamp(origin), horizon=horizon)

    t0 = time.time()
    runs = tools.list_available_runs(r.origin)
    r.facts["weather_runs"] = runs
    r.step(
        "Планировщик", f"{reason}; свежайший выпуск погоды {runs['latest_run_init']} UTC", "ok", t0
    )

    effective_origin = r.origin
    for attempt in range(MAX_WEATHER_RETRIES + 1):
        t0 = time.time()
        shift_h = int((r.origin - effective_origin) / pd.Timedelta(hours=1))
        x, meta = tools.fetch_weather(effective_origin, horizon + shift_h)
        r.step(
            "Сборщик погоды",
            f"Open-Meteo: {len(meta['hub_models_ok'])} моделей с ветром на 100 м, "
            f"выпуски за {meta['nwp_days_used']} сут.",
            "ok",
            t0,
        )
        t0 = time.time()
        qa = tools.qa_check(x, meta)
        if qa["ok"]:
            r.step(
                "Контроль качества",
                "; ".join(qa["warnings"]) or "данные в норме",
                "warn" if qa["warnings"] else "ok",
                t0,
            )
            break
        r.step(
            "Контроль качества",
            "; ".join(qa["issues"]),
            "fail",
            t0,
            detail=f"попытка {attempt + 1}: откат на предыдущий выпуск",
        )
        effective_origin = effective_origin - pd.Timedelta(hours=6)
    r.facts["weather"] = meta
    r.facts["qa"] = qa

    t0 = time.time()
    shift_h = int((r.origin - effective_origin) / pd.Timedelta(hours=1))
    pred = tools.run_forecast(fc, effective_origin, horizon + shift_h)
    pred = pred[pred.index > r.origin].copy()
    # Горизонт — всегда от момента выпуска прогноза, даже если погода взята из более раннего.
    pred["horizon_h"] = ((pred.index - r.origin) / pd.Timedelta(hours=1)).astype(int)
    r.step(
        "Прогнозист",
        f"каскад + прямая модель, веса {fc.state.weights}"
        + (f"; погода из выпуска на {shift_h} ч раньше" if shift_h else ""),
        "warn" if shift_h else "ok",
        t0,
    )

    # Часы, где погоды нет даже после отката: модели на пустых признаках не верим —
    # ставим климатологию с широким интервалом и помечаем прогноз как деградированный.
    no_wx = pred["wind_nwp"].isna().to_numpy()
    if no_wx.any():
        t0 = time.time()
        r.degraded = True
        clim = pred.loc[no_wx, "climatology"].to_numpy()
        for c, k in zip(QCOLS, (0.1, 0.25, 0.6, 1.0, 1.4, 1.75, 1.9), strict=True):
            pred.loc[no_wx, c] = (clim * k).clip(0, 1)
        pred.loc[no_wx, "mean"] = clim
        r.step(
            "Прогнозист",
            f"нет погоды на {int(no_wx.sum() // pred['turbine'].nunique())} ч → климатология",
            "fail",
            t0,
        )

    t0 = time.time()
    crit = tools.critic(pred, horizon)
    if not crit["ok"]:
        r.degraded = True
        for c in QCOLS:
            pred[c] = pred["raw_nwp_curve"]
        r.step("Критик", "; ".join(crit["problems"]) + " → запасной прогноз по кривой", "fail", t0)
    else:
        r.step(
            "Критик",
            "; ".join(crit["warnings"]) or "квантили согласованы, 48 ч на месте",
            "warn" if crit["warnings"] else "ok",
            t0,
        )
    r.facts["critic"] = crit

    t0 = time.time()
    r.facts["analysis"] = tools.analyze(pred)
    a = r.facts["analysis"]
    r.step(
        "Аналитик",
        f"перепадов {a['n_ramps']}, часов низкой уверенности {a['wide_interval_hours']}",
        "warn" if a["n_ramps"] or a["wide_interval_hours"] else "ok",
        t0,
    )

    t0 = time.time()
    rev = tools.compare_with_previous(pred, previous)
    r.facts["revision"] = rev
    if rev.get("is_revision"):
        r.published = rev["material"]
        r.step(
            "Ревизор",
            f"сдвиг P50 {rev['mean_abs_change']:.3f} в среднем, до {rev['max_abs_change']:.3f} — "
            + ("публикуем ревизию" if rev["material"] else "без существенных изменений"),
            "warn" if rev["material"] else "ok",
            t0,
        )
    else:
        r.published = True
        r.step("Ревизор", "первая версия прогноза на эти сутки", "ok", t0)

    t0 = time.time()
    r.facts.update({"origin": str(r.origin), "horizon": horizon, "degraded": r.degraded})
    r.report, r.report_source = llm_report(r.facts)
    r.step("Отчёт", f"сводка оператору ({r.report_source})", "ok", t0)
    r.prediction = pred
    return r
