"""Доменные правила проверки ответа модели.

ЗАПОЛНИТЬ ПОД КЕЙС 23.09 — это самый ценный для защиты файл во всём проекте.
Одна-две реальные проверки здесь превращают «мы вызвали LLM» в «мы верифицируем
её выход правилами предметной области».

Движок готов: `RANGE_RULES` — таблица «величина → допустимый диапазон», парсер
чисел с единицами измерения уже написан. После объявления Задачи остаётся
дописать строки таблицы, код трогать не нужно.

Каждая функция возвращает список проблем. Пустой список = ответ прошёл проверку.
Непустой — оркестратор сделает ретрай с текстом ошибки, а затем degraded-ответ.
"""

import re

from app.ai.schemas import AIAnswer

FORBIDDEN_CLAIMS = [
    "гарантирую",
    "100% результат",
    "guaranteed",
    "without any risk",
]


class RangeRule:
    """Физический или регуляторный диапазон для величины, названной в ответе.

    `unit` — как единица пишется в тексте (кВт, %, тг/кВт·ч). `aliases` — слова,
    рядом с которыми число считается этой величиной.
    """

    def __init__(
        self,
        name: str,
        unit: str,
        low: float,
        high: float,
        aliases: tuple[str, ...],
        note: str = "",
    ):
        self.name = name
        self.unit = unit
        self.low = low
        self.high = high
        self.aliases = aliases
        self.note = note


# ЗАПОЛНИТЬ 23.09 после объявления Задачи: 1–2 строки достаточно для защиты.
#
# Примеры для разных треков (раскомментировать нужное и подставить реальные
# границы из ТЗ Задачи или отраслевого норматива — цифры ниже условные):
#
#   энергетика — RangeRule("КПД", "%", 0, 100, ("кпд", "эффективность"),
#                          "КПД выше 100% — нарушение закона сохранения энергии")
#   энергетика — RangeRule("напряжение", "В", 198, 242, ("напряжение", "вольт"),
#                          "ГОСТ 32144: отклонение ±10% от 220 В")
#   финансы    — RangeRule("ставка", "%", 0, 56, ("ставка", "гэсв"), "предел регулятора")
#   логистика  — RangeRule("срок", "дн", 1, 60, ("срок доставки", "доставка"))
#
RANGE_RULES: list[RangeRule] = []

_NUM_RE = r"(\d+(?:[.,]\d+)?)"


def extract_quantities(text: str, rule: RangeRule) -> list[float]:
    """Достаёт числа, относящиеся к величине: по единице измерения или по слову рядом."""
    found: list[float] = []
    lowered = text.lower()

    if rule.unit:
        for match in re.finditer(rf"{_NUM_RE}\s*{re.escape(rule.unit.lower())}\b", lowered):
            found.append(float(match.group(1).replace(",", ".")))

    for alias in rule.aliases:
        pattern = rf"{re.escape(alias)}\D{{0,20}}?{_NUM_RE}"
        for match in re.finditer(pattern, lowered):
            found.append(float(match.group(1).replace(",", ".")))

    return found


def check_ranges(text: str) -> list[str]:
    issues: list[str] = []
    for rule in RANGE_RULES:
        for value in extract_quantities(text, rule):
            if not (rule.low <= value <= rule.high):
                detail = f" ({rule.note})" if rule.note else ""
                issues.append(
                    f"out_of_range: {rule.name} = {value} {rule.unit}, "
                    f"допустимо {rule.low}–{rule.high}{detail}"
                )
    return issues


def validate(answer: AIAnswer, context: dict | None = None) -> list[str]:
    issues: list[str] = []
    context = context or {}

    lowered = answer.summary.lower()
    for claim in FORBIDDEN_CLAIMS:
        if claim in lowered:
            issues.append(f"forbidden_claim: {claim}")

    if answer.confidence < 0.3 and not answer.needs_expert_review:
        issues.append("low_confidence_without_expert_flag")

    # Диапазоны проверяем по всему, что пользователь прочитает как указание
    # к действию, а не только по summary.
    text = " ".join(
        [answer.summary, *(f"{r.title} {r.action}" for r in answer.recommendations)]
    )
    issues += check_ranges(text)

    return issues
