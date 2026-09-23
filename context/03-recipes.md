# Рецепты: «хочу сделать X»

Каждый рецепт — законченная последовательность. Файлы указаны точно,
угадывать ничего не нужно.

**После любой правки Python:** `docker compose restart api worker`
**После правки фронтенда:** `docker compose up -d --build frontend`

---

## Переименовать сущность под кейс (`DomainEntity` → например `Asset`)

Это первое, что делается в час 1.

1. `app/models.py` — класс `DomainEntity`, поменять имя класса и `__tablename__`.
   Поля, по которым будете **фильтровать**, вынести в колонки; всё остальное
   оставить в `attributes` (JSONB) — тогда новое поле не требует миграции.
2. `app/api/v1/entities.py` — переименовать файл и `prefix="/entities"`,
   заменить импорт модели. Структура эндпоинтов остаётся.
3. `app/api/v1/router.py` — поправить импорт.
4. `app/scripts/seed.py` — демо-объект.
5. Миграция:
   ```bash
   docker compose exec api alembic revision --autogenerate -m "rename entity to asset"
   docker compose restart api
   ```
6. `frontend/src/api.ts` — если добавляли методы, поправить пути.

> Если времени в обрез — **не переименовывайте**. `DomainEntity` с осмысленными
> полями в `attributes` работает ровно так же. Переименование — косметика,
> которая на демо не видна.

---

## Добавить поле в ответ модели

Например, модель должна возвращать оценку риска.

1. `app/ai/schemas.py`, класс `AIAnswer`:
   ```python
   risk_level: Literal["low", "medium", "high"] = "medium"
   ```
2. Всё. Промпт соберёт новую схему сам (`schema_hint()` строится из класса),
   валидация схемы и ретраи подхватят поле автоматически.
3. `app/ai/providers.py`, `MockProvider.generate` — добавить поле в `payload`,
   иначе офлайн-режим будет отдавать ответ без него.
4. Показать на экране: `frontend/src/api.ts` (интерфейс `AIAnswer`) и
   `frontend/src/components.tsx` (`AnswerView`).

---

## Добавить доменное правило проверки

**Это самый сильный аргумент на защите. Сделайте минимум одно.**

`app/domain/rules.py`, список `RANGE_RULES`:

```python
RANGE_RULES: list[RangeRule] = [
    RangeRule(
        name="КПД",
        unit="%",                       # как единица пишется в тексте
        low=0, high=100,                # допустимый диапазон
        aliases=("кпд", "эффективность"),  # слова, рядом с которыми искать число
        note="КПД выше 100% нарушает закон сохранения энергии",
    ),
]
```

Движок сам найдёт числа в `summary` и в рекомендациях, проверит диапазон,
а при нарушении оркестратор сделает повторный запрос к модели с текстом ошибки
и, если не помогло, отдаст безопасный ответ.

Нужна проверка сложнее диапазона — дописать прямо в функцию `validate()`:

```python
def validate(answer: AIAnswer, context: dict | None = None) -> list[str]:
    ...
    if context.get("region") == "север" and "летний режим" in answer.summary.lower():
        issues.append("wrong_season_for_region")
    return issues
```

Проверить: `docker compose restart api`, задать вопрос, который должен нарушить
правило, и посмотреть `meta.validation_retries` в ответе.

---

## Загрузить материалы Задачи в базу знаний

**Вариант A — через API** (быстро, документ живёт до пересоздания томов):

```bash
curl -X POST http://localhost:8000/api/v1/knowledge/documents \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Регламент","kind":"regulation","lang":"ru","content":"...текст..."}'
```
Нужна роль `EXPERT` или выше — у демо-пользователя роль `ADMIN`, подойдёт.

**Вариант B — через сид** (правильный: документы появляются сами на чистой машине):

`app/scripts/seed.py`, список `DEMO_DOCUMENTS`:
```python
{
    "title": "Название документа",
    "source": "откуда взято",
    "kind": "regulation",          # можно фильтровать при поиске
    "content": "Текст. Абзацы разделяются пустой строкой.\n\nВторой абзац.",
},
```
Затем `docker compose down -v && docker compose up -d` — сид отработает заново.

> Текст разбивается по абзацам. Пустые строки между абзацами важны:
> по ним идёт нарезка на куски.

---

## Изменить, что разделяет кэш

По умолчанию `CACHE_CONTEXT_FIELDS=language,region,doc_kind`. Если в вашей Задаче
два одинаковых вопроса различаются, скажем, типом объекта и сезоном:

1. `.env`: `CACHE_CONTEXT_FIELDS=language,asset_type,season`
2. Фронтенд должен слать эти поля в `context`:
   `frontend/src/App.tsx`, состояние `context` в `ChatTab`.
3. `docker compose restart api worker`

**Проверка:** один вопрос с разными значениями поля должен дать **два разных**
живых ответа, а не попадание в кэш.

> ⚠️ **Правило, на котором легко обжечься.** Если поле контекста фильтрует
> retrieval (`language`, `doc_kind` — см. `RAGPipeline.retrieve`), оно **обязано**
> быть в `CACHE_CONTEXT_FIELDS`. Иначе два запроса с разным фильтром получат
> один и тот же ответ из кэша, собранный по чужому набору документов.
> Добавили фильтр — сразу добавьте поле в `CACHE_CONTEXT_FIELDS`.

---

## Сделать кэш приватным (персональные данные в запросах)

`.env`: `SEMANTIC_CACHE_SCOPE=user` → `docker compose restart api worker`

Ключ кэша начнёт включать владельца запроса, и ответ одного пользователя
физически не сможет уйти другому. Цена — падение доли попаданий.
На защите это сильный ответ: «приватность у нас переключателем, а не обещанием».

---

## Добавить экран во фронтенд

1. `frontend/src/api.ts` — метод и типы ответа.
2. `frontend/src/App.tsx`:
   - добавить имя вкладки в тип `Tab` и в массив `TABS`;
   - написать компонент по образцу `KnowledgeTab` (там есть и загрузка, и ошибки);
   - отрисовать: `{tab === "новая" && <НоваяВкладка />}` внизу `App`.
3. `docker compose up -d --build frontend`

Готовые кусочки, которые можно переиспользовать:
`useError()` — обработка ошибок API, `className="card"` — блок,
`className="metric"` — плитка с цифрой, `<span className="spin" />` — спиннер.

---

## Добавить эндпоинт

1. Написать в подходящем файле `app/api/v1/*.py`:
   ```python
   @router.get("/summary", response_model=SummaryOut)
   async def summary(session: SessionDep, user: UserDep) -> SummaryOut:
       ...
   ```
   `SessionDep` — сессия БД, `UserDep` — авторизованный пользователь
   (без него эндпоинт открыт всем), `RedisDep` — Redis.
2. Новый файл — подключить в `app/api/v1/router.py`.
3. Ошибки бросать классами из `app/errors.py` (`NotFound`, `Forbidden`,
   `ValidationFailed`) — наружу уйдёт единый формат с `request_id`.
4. Проверить в http://localhost:8000/docs

---

## Добавить тип фоновой задачи

`app/workers/main.py`, функция `handle_job` — ветка по `job_type`:

```python
if job_type == "bulk_import":
    ...
else:
    result = await orchestrator.run(AIRequest(query=query, ...))
```

Запуск: `POST /api/v1/analysis` с телом `{"type": "bulk_import", "payload": {...}}`.
Прогресс писать в `job.progress` (0–100) — фронтенд его показывает.

---

## Включить реальную модель вместо заглушки

`.env`:
```
LLM_MODE=live
LLM_API_KEY=sk-ant-...
```
`docker compose restart api worker`

Пороги схожести переключатся автоматически (офлайн-эмбеддер и настоящая модель
живут в разных шкалах — см. `app/config.py`).

**Перед сдачей верните `LLM_MODE=mock`**: эксперт обязан проверить проект без
ваших ключей (п. 5.6.6), и ключ в `.env` у него всё равно не окажется.

---

## Добавить метрику

`app/observability.py`:
```python
MY_COUNTER = Counter("my_thing_total", "Описание", ["label"])
```
Использовать: `MY_COUNTER.labels("значение").inc()`.
Появится в `/metrics` автоматически; в дашборд добавлять руками
(`infra/docker/grafana/dashboards/hackalem.json`).

---

## Поменять цвета и вид интерфейса

`frontend/src/styles.css`, блок `:root` в самом верху — все цвета там.
`--accent` задаёт акцентный цвет всего интерфейса.

---

## Перед коммитом (часы 4–5)

```bash
python scripts/smoke_test.py    # всё зелёное?
make test-docker                # тесты и линтер
```

## Перед сдачей

```bash
docker compose down -v && docker compose up -d && python scripts/smoke_test.py
```
Это ровно то, что сделает технический эксперт. Если здесь красное —
важнее любой недоделанной фичи.
