# 4. API

Версионированный REST, база `/api/v1`. FastAPI даёт OpenAPI-схему бесплатно —
`/docs` — живая документация API (Swagger).

## 4.1 Эндпоинты

```
# Служебные (вне версии)
GET    /health                     # liveness: процесс жив
GET    /ready                      # readiness: БД + Redis доступны
GET    /metrics                    # Prometheus

# Аутентификация
POST   /api/v1/auth/register
POST   /api/v1/auth/login          → { access_token, refresh_token }
POST   /api/v1/auth/refresh
GET    /api/v1/users/me

# Доменные сущности (переименовать под кейс)
GET    /api/v1/entities
POST   /api/v1/entities
GET    /api/v1/entities/{id}
PATCH  /api/v1/entities/{id}
DELETE /api/v1/entities/{id}

# AI
POST   /api/v1/ai/chat             # синхронно, с semantic cache
GET    /api/v1/ai/conversations/{id}
POST   /api/v1/analysis            # асинхронно → 202 + job_id
GET    /api/v1/analysis/{id}

# Файлы
POST   /api/v1/files               # multipart → object storage
GET    /api/v1/files/{id}          # presigned URL

# Задачи
GET    /api/v1/jobs/{id}           # статус + progress
DELETE /api/v1/jobs/{id}           # отмена

# База знаний (RAG)
POST   /api/v1/knowledge/documents  # загрузка + индексация (роль ADMIN/EXPERT)
GET    /api/v1/knowledge/search     # отладочный: показать retrieval без LLM
```

Последний эндпоинт недооценён: на демо он позволяет показать «вот что система нашла
в базе знаний, вот на основании чего ответила» — наглядная демонстрация того, что это
RAG, а не просто обёртка над чатом.

## 4.2 Синхронный AI-запрос

```http
POST /api/v1/ai/chat
Authorization: Bearer <token>
Content-Type: application/json

{
  "query": "Что делать при пожелтении листьев?",
  "context": { "crop": "wheat", "region": "almaty", "language": "ru" },
  "conversation_id": "conv-123"
}
```

```json
{
  "request_id": "req-8f72b1",
  "answer": {
    "summary": "...",
    "possible_causes": ["..."],
    "recommendations": [
      { "title": "...", "action": "...", "priority": "high" }
    ],
    "confidence": 0.87,
    "sources": [{ "doc_id": "doc-12", "title": "...", "uri": "..." }],
    "needs_expert_review": false
  },
  "meta": {
    "source": "semantic_cache",
    "similarity": 0.94,
    "model": "claude-sonnet-5",
    "latency_ms": 62,
    "tokens": { "prompt": 0, "completion": 0 },
    "degraded": false
  }
}
```

`meta.source` — намеренно в публичном ответе: на демо вы задаёте похожий вопрос
второй раз, показываете `"source": "semantic_cache"` и `latency_ms: 62` вместо 2400.
Это доказательство работы оптимизации за 3 секунды эфира.

## 4.3 Асинхронный запрос

```http
POST /api/v1/analysis
{ "entity_id": "...", "type": "image_analysis", "file_id": "file-42" }
```

```http
HTTP/1.1 202 Accepted
Location: /api/v1/jobs/job-123
{ "job_id": "job-123", "status": "PENDING" }
```

```http
GET /api/v1/jobs/job-123
{ "job_id": "job-123", "status": "PROCESSING", "progress": 65 }
```

Правило: всё, что дольше ~3 секунд — асинхронно. Иначе первый же
долгий вызов на демо выглядит как зависший фронтенд.

## 4.4 Единый формат ошибок

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid entity identifier",
    "details": { "field": "entity_id" },
    "request_id": "req-8f72b1"
  }
}
```

| Код | HTTP | Когда |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Pydantic не принял вход |
| `UNAUTHORIZED` | 401 | нет/просрочен токен |
| `FORBIDDEN` | 403 | роль не позволяет |
| `NOT_FOUND` | 404 | объект не найден |
| `CONFLICT` | 409 | дубликат, гонка |
| `RATE_LIMITED` | 429 | превышен лимит (+ заголовок `Retry-After`) |
| `PROMPT_INJECTION_SUSPECTED` | 400 | сработал Input Guard |
| `AI_PROVIDER_ERROR` | 503 | провайдер недоступен после fallback |
| `INTERNAL_ERROR` | 500 | всё остальное |

## 4.5 Request ID

Middleware присваивает `X-Request-ID` (или принимает входящий), кладёт в contextvar,
и он попадает: в каждую строку лога, в span трейсинга, в тело ошибки, в ответ.
Когда на демо что-то падает, вы находите причину по id за 10 секунд, а не листаете логи.

## 4.6 Идемпотентность

`POST /api/v1/analysis` и `POST /api/v1/files` принимают `Idempotency-Key`.
Ключ хранится в Redis 24ч вместе с id созданного ресурса. Двойной клик на кнопку
в UI (частое на демо) не создаёт две задачи и не тратит два LLM-вызова.

## 4.7 Пагинация

```
GET /api/v1/entities?limit=20&cursor=<opaque>
→ { "items": [...], "next_cursor": "...", "has_more": true }
```

Cursor-based, не offset: на больших таблицах offset деградирует.
