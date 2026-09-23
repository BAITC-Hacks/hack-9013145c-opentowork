import re

from app.ai.schemas import AIAnswer, RetrievedDoc
from app.domain import rules as domain_rules
from app.observability import AI_VALIDATION_FAILURES

_NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)?")
# Только то, что почти не несёт смысла как величина. «5» и «100» отсюда
# убраны: это ровно те цифры, которыми модель охотнее всего выдумывает
# проценты, дозировки и сроки.
_TRIVIAL_NUMBERS = {"0", "1", "2"}


def _mentions_number(corpus: str, number: str) -> bool:
    """Ищет число как самостоятельный токен.

    Наивный поиск подстрокой давал ложные пропуски: «12» находилось внутри
    «2012», и выдуманная цифра проходила проверку.
    """
    for variant in {number, number.replace(".", ","), number.replace(",", ".")}:
        if re.search(rf"(?<!\d)(?<![.,]){re.escape(variant)}(?![\d])", corpus):
            return True
    return False


class OutputValidator:
    """Детерминированные проверки ответа модели. Без второго вызова LLM."""

    def semantic_checks(
        self,
        answer: AIAnswer,
        docs: list[RetrievedDoc],
        context: dict | None = None,
        query: str = "",
    ) -> list[str]:
        issues: list[str] = []
        known_ids = {d.doc_id for d in docs}
        # Числа из самого вопроса — не галлюцинация: пользователь их и назвал.
        corpus = " ".join([*(d.content for d in docs), query])

        hallucinated = [s.doc_id for s in answer.sources if s.doc_id not in known_ids]
        if hallucinated:
            issues.append(f"hallucinated_sources: {hallucinated[:3]}")

        if docs and answer.recommendations and not answer.sources:
            issues.append("no_grounding_for_recommendations")

        if docs:
            # possible_causes раньше не проверялись вовсе, хотя фронтенд
            # показывает их пользователю наравне с остальным.
            checked = " ".join(
                [
                    answer.summary,
                    *answer.possible_causes,
                    *(f"{r.title} {r.action}" for r in answer.recommendations),
                ]
            )
            # Раньше стоял break после первой находки: модель чинила по одной
            # цифре за ретрай и упиралась в лимит попыток, так и не исправив всё.
            ungrounded = [
                num
                for num in dict.fromkeys(_NUMBER_RE.findall(checked))
                if num.replace(",", ".") not in _TRIVIAL_NUMBERS
                and not _mentions_number(corpus, num)
            ]
            if ungrounded:
                issues.append(f"ungrounded_numbers: {ungrounded[:5]}")

        issues += domain_rules.validate(answer, context)

        for issue in issues:
            AI_VALIDATION_FAILURES.labels(issue.split(":")[0]).inc()
        return issues
