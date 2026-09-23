from typing import Literal

from pydantic import BaseModel, Field


class SourceRef(BaseModel):
    doc_id: str
    title: str = ""
    uri: str | None = None


class Recommendation(BaseModel):
    title: str = Field(max_length=200)
    action: str = Field(max_length=1000)
    priority: Literal["low", "medium", "high"] = "medium"


class AIAnswer(BaseModel):
    """Структурированный ответ модели.

    Схема намеренно общая. Под кейс добавляйте поля здесь — валидация и ретраи
    подхватят их автоматически.
    """

    summary: str = Field(max_length=4000)
    possible_causes: list[str] = Field(default_factory=list, max_length=5)
    recommendations: list[Recommendation] = Field(default_factory=list, max_length=5)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    sources: list[SourceRef] = Field(default_factory=list)
    needs_expert_review: bool = False


class LLMResponse(BaseModel):
    text: str = ""
    parsed: dict | None = None
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: int = 0


class RetrievedDoc(BaseModel):
    doc_id: str
    title: str
    content: str
    similarity: float


class AIRequest(BaseModel):
    query: str
    context: dict = Field(default_factory=dict)
    conversation_id: str | None = None
    user_id: str | None = None


class AIMeta(BaseModel):
    tools: list[str] = Field(default_factory=list)
    source: Literal["live", "exact_cache", "semantic_cache", "degraded"] = "live"
    similarity: float | None = None
    model: str = ""
    latency_ms: int = 0
    tokens: dict = Field(default_factory=lambda: {"prompt": 0, "completion": 0})
    # Токены, которые НЕ были потрачены благодаря кэшу: реальный расход
    # оригинального вызова, сохранённый вместе с ответом.
    saved_tokens: dict = Field(default_factory=lambda: {"prompt": 0, "completion": 0})
    cost_usd: float = 0.0
    saved_usd: float = 0.0
    degraded: bool = False
    validation_retries: int = 0
    retrieved: int = 0


class AIResult(BaseModel):
    answer: AIAnswer
    meta: AIMeta = Field(default_factory=AIMeta)
    cacheable: bool = True
