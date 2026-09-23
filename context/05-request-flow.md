# Путь запроса: от кнопки до базы

Copilot передаёт `forecast_id` и горизонт в `/ai/chat`. После guard AIOrchestrator
вызывает `app/wind/copilot.evidence`: загрузка серверного прогноза → расчёт сводки
и what-if → ответ по шаблону в mock либо LLM с проверкой по этим фактам в live.
Этот путь не использует семантический кэш, чтобы не смешивать выпуски и сценарии.

## Новая турбина

Существующая `Placement` → `WindPlacement` → выбор на `KzMap` →
`api.simulateWind` → авторизация → `POST /wind/simulate` → проверка каталога
оборудования → текущая погода Open-Meteo (либо кэш) → `app/wind/model.py` →
почасовая мощность и энергия. Сервис независим от `windcast/`.
Кнопка добавления записывает только конфигурацию в localStorage браузера;
пересчёт сохранённой турбины заново проходит через API и погоду.

Три главных сценария, по шагам, с точными файлами. Открывайте, когда нужно
понять «а где вообще это происходит».

---

## 1. Пользователь задаёт вопрос

Самый важный путь в проекте. Всё остальное — обслуживание этого.

```
[Браузер]  вкладка «Запрос», кнопка «Спросить»
    │      frontend/src/App.tsx → ChatTab.ask()
    ▼
[api.ts]   POST /api/v1/ai/chat  { query, context }
    │      frontend/src/api.ts → api.chat()
    ▼
[nginx]    проксирует /api на бэкенд          frontend/nginx.conf
    ▼
[FastAPI]  middleware вешает request_id        app/middleware.py
    ▼
[chat()]   проверка лимита частоты             app/api/v1/ai.py
    ▼
┌───────────────── app/ai/orchestrator.py, метод run() ─────────────────┐
│                                                                       │
│  1. GUARD          длина, персональные данные, инъекции               │
│                    app/ai/guard.py                                    │
│                    ↓ не прошло → 400, конец                           │
│                                                                       │
│  2. ТОЧНЫЙ КЭШ     тот же вопрос слово в слово?                       │
│                    app/cache/semantic.py → get_exact()  [Redis]       │
│                    ↓ ЕСТЬ → source=exact_cache, ~10 мс, КОНЕЦ         │
│                                                                       │
│  3. ЭМБЕДДИНГ      текст → вектор                                     │
│                    app/ai/embedder.py                                 │
│                                                                       │
│  4. СЕМАНТИЧЕСКИЙ  похожий по смыслу вопрос уже был?                  │
│     КЭШ            app/cache/semantic.py → get_semantic()  [pgvector] │
│                    ↓ схожесть ≥ порога → source=semantic_cache, КОНЕЦ │
│                                                                       │
│  5. RAG            поиск документов по тому же вектору                │
│                    app/rag/pipeline.py → retrieve()                   │
│                                                                       │
│  6. ПРОМПТ         системные правила + документы + схема ответа       │
│                    app/ai/prompts.py → build_prompt()                 │
│                                                                       │
│  7. МОДЕЛЬ         Anthropic или MockProvider                         │
│                    app/ai/providers.py                                │
│                    ↓ недоступна → безопасный ответ, КОНЕЦ             │
│                                                                       │
│  8. ВАЛИДАЦИЯ      JSON? схема? источники есть? числа обоснованы?     │
│                    доменные правила пройдены?                         │
│                    app/ai/validator.py + app/domain/rules.py          │
│                    ↓ НЕТ → шаг 6 с текстом ошибки (до 2 попыток)      │
│                    ↓ так и не вышло → безопасный ответ                │
│                                                                       │
│  9. ЗАПИСЬ В КЭШ   ответ + вектор + реальные токены                   │
│                    app/cache/semantic.py → put()                      │
└───────────────────────────────────────────────────────────────────────┘
    ▼
[chat()]   сохраняет диалог, сообщения и журнал запроса в БД
    ▼
[Браузер]  MetaBadge показывает источник, задержку, схожесть, экономию
           frontend/src/components.tsx
```

**Что смотреть при разборе:** поле `meta` в ответе. `source` говорит, откуда
пришёл ответ; `retrieved` — сколько документов ушло в промпт;
`validation_retries` — сколько раз модель переспрашивали.

---

## 2. Тяжёлая операция через очередь

```
[Браузер]  вкладка «Асинхронный анализ»
    ▼
POST /api/v1/analysis                        app/api/v1/jobs.py
    │  создаёт запись Job (status=PENDING)
    │  кладёт сообщение в поток Redis         app/queue/redis_queue.py
    ▼  отвечает 202 + job_id  ← HTTP-соединение закрывается
    
[Worker]  отдельный процесс, 2 реплики        app/workers/main.py
    │  читает поток, берёт задачу
    │  status → PROCESSING, progress → 10
    │  гоняет через тот же оркестратор (шаги 1–9 выше)
    │  status → COMPLETED, progress → 100
    ▼  подтверждает обработку (ack)
    
[Браузер]  раз в секунду опрашивает GET /api/v1/jobs/{id}
           пока не COMPLETED или FAILED
```

**Если воркер умер посреди задачи:** другой воркер заберёт её через
`xautoclaim` (`reclaim_stale`) и обработает заново. Задача не теряется.

**Заодно воркер** раз в 5 минут чистит протухшие записи кэша — API остаётся
без состояния и одинаковым во всех репликах.

---

## 3. Старт приложения

```
docker compose up -d
    ▼
[entrypoint]  scripts/entrypoint.sh
    │  1. ждёт, пока PostgreSQL начнёт отвечать (до 60 секунд)
    │  2. alembic upgrade head       ← миграции применяются САМИ
    │  3. python -m app.scripts.seed ← демо-данные, если база пустая
    ▼
[uvicorn]  app/main.py
    │  lifespan: создаёт бакет в MinIO, пишет стартовый лог
    ▼
Готово: /health отвечает 200
```

Воркер поднимается тем же образом, но с `RUN_MIGRATIONS=false` —
миграции применяет только API, чтобы два процесса не делали это одновременно.

**Сид срабатывает только на пустой базе** (проверяет, есть ли хоть один
пользователь). Поэтому после правки демо-документов нужен `down -v`.

---

## Где живут данные

| Таблица | Что хранит | Модель |
|---|---|---|
| `users` | пользователи и роли | `User` |
| `domain_entities` | **сущность кейса** (переименовать) | `DomainEntity` |
| `analyses` | результаты анализов | `Analysis` |
| `ai_requests` | журнал всех AI-запросов: источник, токены, задержка | `AIRequestLog` |
| `conversations` / `messages` | история диалогов | `Conversation`, `Message` |
| `jobs` | фоновые задачи и их статус | `Job` |
| `files` | метаданные загруженных файлов (сами файлы в MinIO) | `FileObject` |
| `knowledge_documents` / `knowledge_chunks` | база знаний и её векторы | `KnowledgeDocument`, `KnowledgeChunk` |
| `semantic_cache` | кэш ответов с векторами и учётом токенов | `SemanticCacheEntry` |
| `feedback` | оценки ответов пользователями | `Feedback` |

Все модели — `app/models.py`. Посмотреть содержимое:
```bash
docker compose exec postgres psql -U app -d app
\dt                                    -- список таблиц
select source, count(*) from ai_requests group by source;
```

---

## Что где слушает

| Порт | Кто | Зачем |
|---|---|---|
| 3000 | frontend (nginx) | интерфейс, сюда идёт проверяющий |
| 8000 | api | REST + Swagger на `/docs` |
| 5432 | postgres | база + pgvector |
| 6379 | redis | кэш, очередь, лимиты |
| 9000 / 9001 | minio | хранилище файлов / консоль |
| 9090 | prometheus | метрики (профиль `observability`) |
| 3001 | grafana | дашборд (профиль `observability`) |
