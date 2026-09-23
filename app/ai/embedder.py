import hashlib
import math
import re
from typing import Protocol

from app.config import settings
from app.errors import AIProviderError

_WORD_RE = re.compile(r"\w+", re.UNICODE)


class Embedder(Protocol):
    # Имя модели хранится рядом с каждым вектором. Без него векторы разных
    # моделей лежат в одной таблице с одинаковой размерностью и молча
    # смешиваются: переключение провайдера превращало базу знаний в шум.
    model_name: str

    async def embed(self, text: str) -> list[float]: ...

    async def embed_many(self, texts: list[str]) -> list[list[float]]: ...


def _l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    return [v / norm for v in vec] if norm else vec


class HashingEmbedder:
    """Локальные эмбеддинги без сети: хэширование слов и символьных триграмм.

    Это не заменяет настоящую модель по качеству, но даёт устойчивое свойство
    «похожий текст → близкий вектор», поэтому semantic cache и RAG работают
    и демонстрируются полностью offline.
    """

    model_name = "local-hash-v1"

    def __init__(self, dim: int = settings.EMBEDDING_DIM):
        self.dim = dim

    def _features(self, text: str) -> list[str]:
        lowered = text.lower()
        words = _WORD_RE.findall(lowered)
        feats = list(words)
        feats += [f"{a}_{b}" for a, b in zip(words, words[1:], strict=False)]
        compact = " ".join(words)
        feats += [compact[i : i + 3] for i in range(max(0, len(compact) - 2))]
        return feats

    async def embed(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        feats = self._features(text)
        if not feats:
            return vec
        for feat in feats:
            digest = hashlib.blake2b(feat.encode("utf-8"), digest_size=8).digest()
            idx = int.from_bytes(digest[:4], "big") % self.dim
            sign = 1.0 if digest[4] & 1 else -1.0
            vec[idx] += sign
        return _l2_normalize(vec)

    async def embed_many(self, texts: list[str]) -> list[list[float]]:
        return [await self.embed(t) for t in texts]


class OpenAIEmbedder:
    def __init__(self, api_key: str, model: str, dim: int):
        self.api_key = api_key
        self.model = model
        self.dim = dim
        self.model_name = f"openai:{model}"

    async def embed(self, text: str) -> list[float]:
        import httpx

        from app.ai.providers import get_http_client

        try:
            client = await get_http_client()
            resp = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={"model": self.model, "input": text[:8000]},
                timeout=20.0,
            )
        except httpx.HTTPError as exc:
            raise AIProviderError("Embedding request failed") from exc

        if resp.status_code >= 400:
            raise AIProviderError(f"Embedding provider returned {resp.status_code}")
        return resp.json()["data"][0]["embedding"]

    async def embed_many(self, texts: list[str]) -> list[list[float]]:
        """Один запрос на пачку вместо запроса на каждый кусок.

        Индексация документа делала по HTTP-вызову на чанк последовательно —
        сотни вызовов внутри одного запроса. API принимает массив, батчинг
        здесь ничего не стоит.
        """
        import httpx

        from app.ai.providers import get_http_client

        vectors: list[list[float]] = []
        for start in range(0, len(texts), 64):
            batch = [t[:8000] for t in texts[start : start + 64]]
            try:
                client = await get_http_client()
                resp = await client.post(
                    "https://api.openai.com/v1/embeddings",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json={"model": self.model, "input": batch},
                    timeout=60.0,
                )
            except httpx.HTTPError as exc:
                raise AIProviderError("Embedding request failed") from exc
            if resp.status_code >= 400:
                raise AIProviderError(f"Embedding provider returned {resp.status_code}")
            data = sorted(resp.json()["data"], key=lambda d: d["index"])
            vectors.extend(item["embedding"] for item in data)
        return vectors


def current_model_name() -> str:
    """Имя активной модели эмбеддингов — без создания самого эмбеддера.

    Нужно там, где вектор только сравнивается с сохранённым (кэш), чтобы
    не смешивать векторы разных моделей.
    """
    if settings.EMBEDDING_PROVIDER == "openai" and settings.EMBEDDING_API_KEY:
        return f"openai:{settings.EMBEDDING_MODEL}"
    return "local-hash-v1"


def build_embedder() -> Embedder:
    if settings.EMBEDDING_PROVIDER == "openai" and settings.EMBEDDING_API_KEY:
        return OpenAIEmbedder(
            settings.EMBEDDING_API_KEY, settings.EMBEDDING_MODEL, settings.EMBEDDING_DIM
        )
    return HashingEmbedder(settings.EMBEDDING_DIM)


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0
