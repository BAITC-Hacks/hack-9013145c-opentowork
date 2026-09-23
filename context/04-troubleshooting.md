# Если сломалось

Порядок действий по умолчанию: **посмотреть логи, а не гадать.**

```bash
docker compose logs -f api worker      # что происходит прямо сейчас
docker compose logs api | tail -50     # что было
docker compose ps                      # кто вообще жив
curl http://localhost:8000/ready       # какая зависимость отвалилась
```

Логи структурные: ищите `"error"` и `request_id` — номер возвращается
и в заголовке `X-Request-ID`, и в теле любой ошибки API.

---

## Не поднимается стек

### `port is already allocated`
На машине уже занят порт. Посмотреть кем:
```bash
docker ps --format "table {{.Names}}\t{{.Ports}}"
```
Остановить лишний проект или временно переопределить порты — **создайте**
`docker-compose.override.yml` рядом с основным (git его игнорирует не сам,
удалите файл перед коммитом):
```yaml
services:
  api:
    ports: !override ["18000:8000"]
  postgres:
    ports: !override []
```
`!override` обязателен: без него списки портов **сливаются**, а не заменяются.

> На этой машине уже работают проекты `fotmob` (держит 5432) и
> `medserviceprice` (держит 8000 и 80). На площадке этой проблемы не будет.

### `socket access forbidden` на порту 5xxxx
Windows зарезервировал диапазон под Hyper-V. Берите порты 13000–19999.

### `failed to connect to the docker API`
Docker Desktop не запущен. Запустить и подождать ~30 секунд.

### API стартует и сразу падает
Почти всегда миграции. `docker compose logs api | grep -i alembic`.
Быстрое лечение на хакатоне — снести состояние:
`docker compose down -v && docker compose up -d`.

---

## Поведение AI

### Ответ всегда `source=live`, кэш не срабатывает
1. `SEMANTIC_CACHE_ENABLED=true` в `.env`?
2. **Контекст совпадает?** Разные `language`/`region` — это разные записи
   кэша, так и задумано.
3. Порог слишком высокий. В офлайн-режиме работает
   `SEMANTIC_CACHE_THRESHOLD_LOCAL` (0.50), а не основной 0.92 — шкала у
   хэш-эмбеддера другая. Смотрите фактическую схожесть:
   ```bash
   curl http://localhost:8000/metrics | grep ai_cache_similarity
   ```
4. Меняли промпт? `PROMPT_VERSION` инвалидирует кэш целиком — это защита
   от выдачи ответов, построенных по старым правилам.

### Кэш срабатывает там, где не должен
Порог низкий: поднимите `SEMANTIC_CACHE_THRESHOLD_LOCAL`. Или в
`CACHE_CONTEXT_FIELDS` не хватает поля, которое реально различает запросы.

### Все ответы приходят `degraded`
Модель не проходит валидацию. Смотрите, какое правило падает:
```bash
docker compose logs api | grep output_validation_failed
curl http://localhost:8000/metrics | grep ai_validation_failures
```
Частые причины:
- Слишком строгое правило в `app/domain/rules.py` — диапазон не тот.
- `ungrounded_number`: модель называет число, которого нет ни в документах,
  ни в вопросе. Либо база знаний не содержит нужного, либо промпт провоцирует
  придумывать цифры.
- `hallucinated_sources`: модель ссылается на несуществующий документ.
  Проверьте, что retrieval вообще что-то нашёл (`meta.retrieved` в ответе).

### Retrieval ничего не находит
```bash
curl "http://localhost:8000/api/v1/knowledge/search?q=тест" -H "Authorization: Bearer $TOKEN"
```
- База пустая: сид не отработал. `docker compose logs api | grep seed`.
  Сид пропускается, если в базе **уже есть хоть один пользователь** — поэтому
  после правки `DEMO_DOCUMENTS` нужен именно `down -v`, а не рестарт.
- Порог: `RAG_MIN_SIMILARITY_LOCAL` (0.20 в офлайне).
- Фильтр по языку: документы засеяны как `ru`, а запрос идёт с `language=en`.
  Есть откат на весь корпус, но если и там пусто — проверьте содержимое таблиц.

### `could not determine data type of parameter`
В сыром SQL появился параметр, который может быть `NULL`, без явного типа.
Лечится кастом: `CAST(:lang AS text)` вместо `:lang`. Пример —
`SEARCH_SQL` в `app/rag/pipeline.py`.

---

## Очередь и воркеры

### Задача висит в `PENDING`
```bash
docker compose ps worker
docker compose logs worker | tail -30
```
- Воркер не запущен или падает на старте.
- Очередь не создана: воркер делает `ensure_group()` сам при старте — перезапустите.
- Проверить глубину очереди:
  ```bash
  docker compose exec redis redis-cli XLEN ai_jobs
  ```

### Задача ушла в `FAILED`
Текст ошибки лежит прямо в задаче: `GET /api/v1/jobs/{id}`, поле `error`.
Полный стек — в `docker compose logs worker`.

### Задача обработалась дважды
Так и должно быть при падении воркера: очередь даёт гарантию
«хотя бы один раз». Для операций с побочным эффектом используйте
заголовок `Idempotency-Key` при создании задачи.

---

## Фронтенд

### Белый экран
Консоль браузера (F12). Чаще всего — ошибка в компоненте.
```bash
docker compose logs frontend
docker compose up -d --build frontend    # правки видны только после пересборки
```

### `401` на каждый запрос
Токен протух (час жизни). Приложение само вернёт на экран входа; если нет —
`localStorage.clear()` в консоли и перезагрузить.

### Изменил код — ничего не поменялось
Фронтенд собирается в статику внутрь образа. Нужна пересборка:
`docker compose up -d --build frontend`.
Для быстрой работы запускайте `npm run dev` (порт 5173) — там горячая перезагрузка.

### `429 Rate limit exceeded`
Сработал лимит: 20 AI-запросов в минуту на пользователя, 10 попыток входа
в минуту на email. Подождать минуту или поднять `RATE_LIMIT_AI` в `.env`.

---

## Окружение разработчика (Windows)

| Симптом | Причина и что делать |
|---|---|
| `python` ничего не делает, код выхода 49 | В PATH заглушка Microsoft Store. Использовать `C:\Users\User\miniconda3\python.exe` |
| `make: command not found` | `make` не установлен. Команды брать из `Makefile` и выполнять напрямую |
| `.venv/bin/pytest` не найден | Окружение собрано на macOS. Использовать `make test-docker` |
| Воркер не стартует локально | `add_signal_handler` не поддерживается на Windows. Воркер запускать только в Docker |

---

## Аварийный план на демо

1. **Упал интернет.** `LLM_MODE=mock` в `.env`, `docker compose restart api worker`.
   Всё работает офлайн, кэш и RAG настоящие.
2. **Кончился лимит API (429/503 в логах).** То же самое — переключиться на mock.
3. **Упало вообще всё.** `docker compose down -v && docker compose up -d`,
   ~60 секунд до готовности. Данные демо создаются автоматически.
4. **Не поднимается на площадке.** Показываете записанное видео демо.
   **Запишите его заранее, в час 5** — это не паранойя, это две минуты работы,
   которые спасают выступление.

---

## Стек отвечает, но работает старый код

**Симптом:** `docker compose ps` всё зелёное, но новых таблиц/колонок нет,
`select version_num from alembic_version` меньше последней миграции в
`migrations/versions/`, фронтенд-контейнера нет в списке.
**Причина:** `docker compose up -d` без `--build` переиспользует старые образы.
**Решение:** `docker compose up -d --build`, затем `make smoke`.

## Фронтенд `unhealthy`, хотя :3000 открывается

**Причина:** в alpine `localhost` резолвится в `::1`, а nginx слушает только
IPv4 (`listen 3000`). Healthcheck стучался в IPv6 и получал отказ.
**Решение:** в `infra/docker/frontend.Dockerfile` healthcheck ходит на `127.0.0.1`.

---

## Куда смотреть, когда непонятно

| Вопрос | Где ответ |
|---|---|
| Почему ответ такой | `docker compose logs api \| grep <request_id>` |
| Что происходит с кэшем | `curl localhost:8000/metrics \| grep ai_cache` |
| Что происходит в целом | Grafana: `docker compose --profile observability up -d` → :3001 |
| Всё ли ещё работает | `python scripts/smoke_test.py` |
| Что лежит в базе | `docker compose exec postgres psql -U app -d app` |
