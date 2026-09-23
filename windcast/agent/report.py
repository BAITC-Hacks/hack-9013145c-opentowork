"""Отчёт оператору. Шаблон работает всегда; LLM подключается при наличии ключа и
только переформулирует факты — ответ с числом, которого нет в фактах, отбрасывается."""

from __future__ import annotations

import json
import os
import re

import pandas as pd

LLM_MODEL = os.getenv("WINDCAST_LLM_MODEL", "claude-sonnet-5")

SYSTEM = (
    "Ты — диспетчер-аналитик ветроэлектростанции. По фактам из JSON напиши оператору "
    "короткую сводку прогноза (4–6 предложений, по-русски): ожидаемая выработка, "
    "резкие перепады, часы низкой уверенности, риски (обледенение, расхождение моделей), "
    "что изменилось относительно прошлой версии. Используй ТОЛЬКО числа из фактов, "
    "ничего не придумывай и не пересчитывай."
)


def _fmt_time(ts: str) -> str:
    t = pd.Timestamp(ts) + pd.Timedelta(hours=5)
    return t.strftime("%d.%m %H:%M")


def template_report(facts: dict) -> str:
    a = facts["analysis"]
    parts = [
        f"Прогноз от {_fmt_time(facts['origin'])} (местное) на {facts['horizon']} ч: "
        f"средняя мощность {a['mean_p50']:.0%} номинала, пик {a['max_p50']:.0%} около "
        f"{_fmt_time(a['peak_time'])}."
    ]
    if a["n_ramps"]:
        r = a["ramps"][0]
        word = "рост" if r["direction"] == "up" else "спад"
        parts.append(
            f"Резких перепадов: {a['n_ramps']}; первый — {word} на {abs(r['delta']):.0%} "
            f"за 3 ч к {_fmt_time(r['time'])}."
        )
    if a["wide_interval_hours"]:
        parts.append(
            f"Низкая уверенность в {a['wide_interval_hours']} ч "
            f"(интервал P10–P90 шире {0.45:.0%} номинала)."
        )
    for w in facts["qa"]["warnings"]:
        parts.append(w[0].upper() + w[1:] + ".")
    parts.append(
        f"Поправка погоды: модель скорректировала прогноз ветра в среднем на "
        f"{a['wind_bias_correction_ms']:+.2f} м/с."
    )
    rev = facts.get("revision") or {}
    if rev.get("is_revision"):
        if rev["material"]:
            parts.append(
                f"Ревизия: новый выпуск погоды сдвинул прогноз в среднем на "
                f"{rev['mean_abs_change']:.0%}, максимум {rev['max_abs_change']:.0%} "
                f"в {_fmt_time(rev['max_change_time'])}."
            )
        else:
            parts.append("Новый выпуск погоды существенно прогноз не изменил.")
    return " ".join(parts)


def _numbers(text: str) -> set[str]:
    return {n.rstrip(".,").replace(",", ".") for n in re.findall(r"\d+(?:[.,]\d+)?", text)}


def llm_report(facts: dict) -> tuple[str, str]:
    """(текст, источник). Источник: 'llm' | 'template' | 'template:<причина>'."""
    base = template_report(facts)
    if not os.getenv("ANTHROPIC_API_KEY"):
        return base, "template"
    try:
        import anthropic

        client = anthropic.Anthropic()
        msg = client.messages.create(
            model=LLM_MODEL,
            max_tokens=500,
            system=SYSTEM,
            messages=[
                {
                    "role": "user",
                    "content": json.dumps(facts, ensure_ascii=False, default=str)
                    + "\n\nЧерновик шаблона:\n"
                    + base,
                }
            ],
        )
        text = msg.content[0].text.strip()
    except Exception as exc:  # сеть, ключ, квота — отчёт всё равно нужен
        return base, f"template:{type(exc).__name__}"
    allowed = _numbers(json.dumps(facts, default=str) + " " + base) | {
        str(i) for i in range(0, 101)
    }
    invented = _numbers(text) - allowed
    if invented:
        return base, f"template:llm_invented_numbers={sorted(invented)[:5]}"
    return text, "llm"
