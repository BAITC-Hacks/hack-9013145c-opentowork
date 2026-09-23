"""Проверяемые ответы о выпуске: числа считает Python, а не LLM."""

import re

from app.ai.schemas import AIAnswer, RetrievedDoc, SourceRef
from app.errors import ValidationFailed


def evidence(query: str, context: dict) -> tuple[AIAnswer, list[RetrievedDoc], list[str]]:
    from app.api.v1.forecast import _trim, find_by_id, simulate_run

    forecast_id = context.get("forecast_id")
    if not isinstance(forecast_id, str) or not 1 <= len(forecast_id) <= 128:
        raise ValidationFailed("Нужен идентификатор выбранного прогноза")
    horizon = context.get("horizon", 48)
    if not isinstance(horizon, int) or not 1 <= horizon <= 48:
        raise ValidationFailed("Горизонт должен быть от 1 до 48 часов")
    run = _trim(find_by_id(forecast_id), horizon)
    pts = run["predictions"]
    if not pts:
        raise ValidationFailed("В прогнозе нет часов для анализа")
    peak = max(pts, key=lambda p: p["p50"])
    last = pts[-1]
    tools = ["forecast.load", "forecast.analyze"]
    first_day = pts[:24]
    energy = sum(p["p50"] for p in first_day)
    text = (
        f"Выпуск {run['forecast_origin']}, горизонт {len(pts)} ч. "
        f"Пик ожидается {peak['forecast_for']}: {peak['p50'] * 100:.1f}% номинала. "
        f"Сумма почасовых P50 за первые {len(first_day)} ч: {energy:.2f} "
        "МВт·ч на каждый МВт установленной мощности. "
        f"К концу горизонта ({last['forecast_for']}) P50 = {last['p50'] * 100:.1f}%, "
        f"диапазон P10–P90: {last['p10'] * 100:.1f}–{last['p90'] * 100:.1f}% номинала. "
        "Это интервал прогноза мощности, не гарантия результата. Все времена — UTC."
    )
    q = query.lower()
    if any(word in q for word in ("почему", "сниз", "перепад", "паден")) and len(pts) > 3:
        a, b = min(
            zip(pts, pts[3:], strict=False),
            key=lambda pair: pair[1]["p50"] - pair[0]["p50"],
        )
        delta = (b["p50"] - a["p50"]) * 100
        text += (
            f" Минимальное изменение за три часа: {delta:+.1f} п.п. "
            f"между {a['forecast_for']} и {b['forecast_for']}; "
            f"прогноз ветра меняется с {a['wind_speed']:.1f} до {b['wind_speed']:.1f} м/с. "
            "Это связь внутри модели, а не установленная причина изменения фактической выработки."
        )
    if any(word in q for word in ("если", "слаб", "сильн", "сценар", "%")):
        match = re.search(r"([+−-]?\d+(?:[.,]\d+)?)\s*(?:%|процент)", q)
        if match:
            change = float(match[1].replace(",", ".").replace("−", "-"))
            if any(word in q for word in ("слаб", "меньше", "ниже", "сниз")):
                change = -abs(change)
            if abs(change) > 50:
                raise ValidationFailed("Сценарий поддерживает изменение ветра от −50 до +50%")
            scenario = simulate_run(run, change)
            tools.append("simulation.wind_change")
            base, altered = scenario["base_energy"], scenario["scenario_energy"]
            text += (
                f" Сценарий: ветер {change:+.1f}%. За весь горизонт сумма P50 меняется "
                f"с {base:.2f} до {altered:.2f} МВт·ч на МВт. "
                "Это чувствительность по кривой мощности, без переобучения модели."
            )
        else:
            text += " Для сценария укажите процент изменения ветра, например «на 15% слабее»."
    doc = RetrievedDoc(
        doc_id=forecast_id, title="Расчёт по выбранному прогнозу", content=text, similarity=1,
    )
    answer = AIAnswer(
        summary=text,
        sources=[SourceRef(doc_id=forecast_id, title=doc.title)],
        needs_expert_review=bool(run.get("degraded")),
    )
    return answer, [doc], tools
