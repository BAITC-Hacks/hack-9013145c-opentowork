"""Граф агента: planner → weather → qa → forecast → critic → analyze → compare → report.

Переходы — явные правила, а не «LLM решит»: так агент воспроизводим без ключа.
Решения, которые принимает граф:
  - qa провалена         → повтор с более старым выпуском погоды (сдвиг origin на −6 ч)
  - qa провалена везде   → модели не верим: климатология, флаг degraded
  - critic провален      → запасной прогноз (сырой прогноз ветра + кривая), флаг degraded;
                           запасной прогноз проверяется тем же критиком, не прошёл — AgentFailure
  - ревизия не существенна → версия не публикуется, остаётся предыдущая
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from windcast.agent import tools
from windcast.agent.report import llm_report
from windcast.metrics import QCOLS
from windcast.pipeline import MODEL_VERSION, Forecaster

MAX_WEATHER_RETRIES = 2
# Множители климатологии для P5…P95: интервал намеренно широкий, погоды нет.
CLIM_BANDS = (0.1, 0.25, 0.6, 1.0, 1.4, 1.75, 1.9)


class AgentFailure(RuntimeError):
    """Ни основной, ни запасной прогноз не прошли проверку — публиковать нечего."""


def _climatology_fill(pred: pd.DataFrame, mask) -> None:
    clim = pred.loc[mask, "climatology"].to_numpy()
    for c, k in zip(QCOLS, CLIM_BANDS, strict=True):
        pred.loc[mask, c] = (clim * k).clip(0, 1)
    pred.loc[mask, "mean"] = clim


@dataclass
class AgentRun:
    origin: pd.Timestamp
    horizon: int = 48
    run_id: str = ""
    steps: list[dict] = field(default_factory=list)
    facts: dict = field(default_factory=dict)
    prediction: pd.DataFrame | None = None
    published: bool = False
    degraded: bool = False
    report: str = ""
    report_source: str = ""
    explanation: dict | None = None

    def __post_init__(self) -> None:
        # Детерминированный id: тот же момент и горизонт → тот же прогноз и та же ссылка
        # из черновика заявки после перезапуска.
        if not self.run_id:
            key = f"{self.origin.isoformat()}|{self.horizon}|{MODEL_VERSION}"
            self.run_id = hashlib.sha1(key.encode()).hexdigest()[:12]

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
    archive: pd.DataFrame | None = None,
) -> AgentRun:
    r = AgentRun(origin=pd.Timestamp(origin), horizon=horizon)

    t0 = time.time()
    runs = tools.list_available_runs(r.origin)
    r.facts["weather_runs"] = runs
    r.step(
        "Планировщик", f"{reason}; свежайший выпуск погоды {runs['latest_run_init']} UTC", "ok", t0
    )

    effective_origin = r.origin
    qa_passed = False
    for attempt in range(MAX_WEATHER_RETRIES + 1):
        t0 = time.time()
        shift_h = int((r.origin - effective_origin) / pd.Timedelta(hours=1))
        x, meta = tools.fetch_weather(effective_origin, horizon + shift_h, archive)
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
            qa_passed = True
            r.step(
                "Контроль качества",
                "; ".join(qa["warnings"]) or "данные в норме",
                "warn" if qa["warnings"] else "ok",
                t0,
            )
            break
        last = attempt == MAX_WEATHER_RETRIES
        r.step(
            "Контроль качества",
            "; ".join(qa["issues"]),
            "fail",
            t0,
            detail="повторы исчерпаны: прогноз по климатологии"
            if last
            else f"попытка {attempt + 1}: откат на предыдущий выпуск",
        )
        # Сдвигаем только перед следующей попыткой: прогноз должен считаться
        # на том выпуске, который реально прошёл через qa_check.
        if not last:
            effective_origin = effective_origin - pd.Timedelta(hours=6)
    r.facts["weather"] = meta
    r.facts["qa"] = qa
    r.facts["qa_passed"] = qa_passed

    t0 = time.time()
    shift_h = int((r.origin - effective_origin) / pd.Timedelta(hours=1))
    pred = tools.run_forecast(fc, effective_origin, horizon + shift_h, archive)
    pred = pred[pred.index > r.origin].copy()
    # Горизонт — всегда от момента выпуска прогноза, даже если погода взята из более раннего.
    pred["horizon_h"] = ((pred.index - r.origin) / pd.Timedelta(hours=1)).astype(int)
    r.step(
        "Прогнозист",
        "каскад (поправка ветра → кривая мощности) + калибровка интервала по сложности часа"
        + (f"; погода из выпуска на {shift_h} ч раньше" if shift_h else ""),
        "warn" if shift_h else "ok",
        t0,
    )

    # Часы, где погоды нет даже после отката, и все часы, если погода не прошла qa:
    # модели на таких признаках не верим — климатология с широким интервалом.
    no_wx = pred["wind_nwp"].isna().to_numpy() if qa_passed else np.ones(len(pred), dtype=bool)
    if no_wx.any():
        t0 = time.time()
        r.degraded = True
        _climatology_fill(pred, no_wx)
        n_h = int(no_wx.sum() // pred["turbine"].nunique())
        why = "нет погоды" if qa_passed else "погода не прошла контроль"
        r.step(
            "Прогнозист",
            f"{why} на {n_h} ч → климатология",
            "fail",
            t0,
        )

    t0 = time.time()
    crit = tools.critic(pred, horizon)
    if not crit["ok"]:
        r.degraded = True
        for c in QCOLS:
            pred[c] = pred["raw_nwp_curve"].clip(0, 1)
        pred["mean"] = pred["q50"]
        # Кривая по сырому ветру тоже бывает пустой — эти часы закрываем климатологией.
        gaps = pred["q50"].isna().to_numpy()
        if gaps.any():
            _climatology_fill(pred, gaps)
        recheck = tools.critic(pred, horizon)
        r.facts["fallback_critic"] = recheck
        if not recheck["ok"]:
            r.step(
                "Критик",
                "; ".join(crit["problems"])
                + " → запасной прогноз тоже не прошёл: "
                + "; ".join(recheck["problems"]),
                "fail",
                t0,
            )
            raise AgentFailure(
                "Прогноз не выпущен: основной и запасной варианты не прошли проверку ("
                + "; ".join(recheck["problems"])
                + ")"
            )
        r.step(
            "Критик",
            "; ".join(crit["problems"]) + " → запасной прогноз по кривой, перепроверен",
            "fail",
            t0,
        )
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
    if r.degraded:
        r.step("Объяснитель", "прогноз деградирован — объяснение модели не применимо", "warn", t0)
    else:
        from windcast.explain import explain_origin

        r.explanation = explain_origin(fc, r.origin, horizon, archive)
        top = [o for o in r.explanation["overall"] if o["mean_abs_wind_ms"] >= 0.05][:3]
        r.facts["explain"] = {
            "top_factors": [
                {"label": o["label"], "mean_abs_wind_ms": o["mean_abs_wind_ms"]} for o in top
            ],
            "summary": r.explanation["summary"],
        }
        r.step(
            "Объяснитель",
            "главные факторы: " + ", ".join(o["label"].lower() for o in top),
            "ok",
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
