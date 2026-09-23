import json
import re

from app.ai.schemas import AIRequest
from app.config import settings
from app.errors import PromptInjectionSuspected, ValidationFailed
from app.observability import AI_INJECTION_BLOCKED, log

INJECTION_PATTERNS = [
    r"ignore\s+(all\s+)?(previous|above|prior)\s+instructions",
    r"disregard\s+.{0,20}(rules|prompt|instructions)",
    r"forget\s+(everything|all\s+previous)",
    r"you\s+are\s+now\s+(a|an|the)\b",
    r"</?system>",
    r"\bsystem\s*prompt\b",
    r"reveal\s+.{0,20}(prompt|instructions)",
    r"забудь\s+(все\s+)?(предыдущие\s+)?(инструкции|указания)",
    r"игнорируй\s+.{0,20}(инструкции|правила)",
    r"покажи\s+.{0,20}(системный\s+промпт|инструкции)",
]
_COMPILED = [re.compile(p, re.IGNORECASE) for p in INJECTION_PATTERNS]

PII_PATTERNS = [
    (re.compile(r"\b\d{12}\b"), "[IIN]"),
    (re.compile(r"\b(?:\d[ -]?){13,19}\b"), "[CARD]"),
    (re.compile(r"\+?\d{1,3}[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}"), "[PHONE]"),
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b"), "[EMAIL]"),
]


def strip_pii(text: str) -> str:
    for pattern, placeholder in PII_PATTERNS:
        text = pattern.sub(placeholder, text)
    return text


def _scan(text: str, where: str) -> None:
    for pattern in _COMPILED:
        if pattern.search(text):
            AI_INJECTION_BLOCKED.inc()
            log.warning("prompt_injection_blocked", pattern=pattern.pattern, where=where)
            raise PromptInjectionSuspected(
                "Request looks like a prompt-injection attempt"
            )


class InputGuard:
    def check(self, req: AIRequest) -> AIRequest:
        query = (req.query or "").strip()
        if not query:
            raise ValidationFailed("Query must not be empty")
        if len(query) > settings.INPUT_MAX_CHARS:
            raise ValidationFailed(
                f"Query too long: {len(query)} > {settings.INPUT_MAX_CHARS}"
            )

        # context дословно уходит в промпт (см. build_prompt), поэтому он —
        # такой же недоверенный ввод, как и query. Раньше проверялся только
        # query, и инъекция, положенная в context, проходила мимо guard.
        context_blob = json.dumps(req.context, ensure_ascii=False)
        if len(context_blob) > settings.CONTEXT_MAX_CHARS:
            raise ValidationFailed(
                f"Context too large: {len(context_blob)} > {settings.CONTEXT_MAX_CHARS}"
            )

        if settings.INJECTION_GUARD_ENABLED:
            _scan(query, "query")
            _scan(context_blob, "context")

        req.query = strip_pii(query)
        req.context = {k: strip_pii(v) if isinstance(v, str) else v
                       for k, v in req.context.items()}
        return req
