# Kubernetes

**Статус: локальный оверлей развёрнут и проверен на живом кластере 23.09.2026.**
15 из 15 сквозных проверок прошли, автомасштабирование сработало.

Важная оговорка, чтобы не обещать лишнего: разворачивался
`infra/k8s-local/` — оверлей для ноутбука. Базовый набор `infra/k8s/`
проверен статически (`kubectl apply --dry-run=server` на живом API-сервере),
но в боевом кластере не запускался: для этого нужны свой registry, домен,
ingress-контроллер и настоящие секреты.

---

## Что проверено, а что нет

| Проверено | Как |
|---|---|
| Все объекты валидны против настоящего API-сервера | `kubectl apply --dry-run=server -k infra/k8s/` |
| Стек разворачивается с нуля | `kubectl apply -k infra/k8s-local/` |
| Миграции проходят отдельной задачей | Job `db-migrate` → `Completed` |
| API отвечает, зависимости живы | `/health` 200, `/ready` `{"database":true,"redis":true}` |
| Весь сценарий работает в кластере | `smoke_test.py` — 15/15 PASS |
| Очередь работает между подами | задачу создал API-под, обработал под воркера |
| Фронтенд раздаётся | HTTP 200 |
| HPA реально масштабирует | понизили порог → **2 → 4 реплики за 30 секунд** |

| Не проверено | Почему |
|---|---|
| Запуск `infra/k8s/` в боевом кластере | нужны registry с образами, домен и реальные секреты |
| Ingress | нужен ingress-контроллер; локально используется `port-forward`, в проде контроллер свой |
| TLS через cert-manager | нужен публичный домен |
| Отказоустойчивость БД | одна нода; в проде — managed-сервис |
| Поведение под нагрузкой | нагрузочного теста не было; цифры пропускной способности не измерены |

---

## Файлы

| Файл | Что описывает |
|---|---|
| `infra/k8s/namespace.yaml` | пространство имён `hackalem` |
| `infra/k8s/configmap.yaml` | несекретные настройки, синхронизирован с `app/config.py` |
| `infra/k8s/secret.yaml` | **шаблон** секретов; реальные значения не коммитятся |
| `infra/k8s/stateful-services.yaml` | PostgreSQL + pgvector, Redis, MinIO |
| `infra/k8s/migrate-job.yaml` | миграции схемы отдельной задачей |
| `infra/k8s/api-deployment.yaml` | API (3 реплики) + PodDisruptionBudget |
| `infra/k8s/api-service.yaml` | ClusterIP на порт 8000 |
| `infra/k8s/worker-deployment.yaml` | воркеры очереди |
| `infra/k8s/frontend.yaml` | React + nginx |
| `infra/k8s/hpa.yaml` | автомасштабирование API 2→10, воркеров 1→20 |
| `infra/k8s/ingress.yaml` | маршрутизация: `/api`, `/docs` → API, остальное → фронтенд |
| `infra/k8s-local/kustomization.yaml` | **оверлей для ноутбука**: локальные образы, 1 реплика, `LLM_MODE=mock`, без Ingress |

---

## Поднять локально

### Один раз: включить кластер

Docker Desktop → Settings → Kubernetes → Enable Kubernetes.

> **Грабли, на которые мы наступили.** Docker Desktop 4.68 по умолчанию ставит
> версию ноды **1.37.0**, но генерирует конфиг kubeadm в формате `v1beta3`,
> который в 1.36+ уже удалён. Кластер молча не стартует с ошибкой
> `your configuration file uses an old API spec`.
> **Лечится понижением версии ноды до 1.34.3** там же в настройках
> (или в `%APPDATA%\Docker\settings-store.json`, ключ `KubernetesNodesVersion`).

Проверка:
```bash
docker desktop kubernetes status      # State: running
kubectl get nodes                     # Ready
```

### Каждый раз: развернуть

```bash
make k8s-up      # собрать образы, загрузить в кластер, применить оверлей
make k8s-status  # поды, HPA, потребление
make k8s-smoke   # сквозная проверка через port-forward
make k8s-down    # снести namespace
```

Без `make`:
```bash
# 1. собрать образы
docker compose build api frontend

# 2. загрузить в ноду — кластер в kind-режиме НЕ видит образы Docker напрямую
docker save hackalem-api:latest | docker exec -i desktop-control-plane \
  ctr --namespace k8s.io images import -
docker save hackalem-frontend:latest | docker exec -i desktop-control-plane \
  ctr --namespace k8s.io images import -

# 3. развернуть
kubectl apply -k infra/k8s-local/

# 4. посмотреть
kubectl -n hackalem get pods -w
```

### Открыть в браузере

Ingress локально не используется — пробрасываем порты:
```bash
kubectl -n hackalem port-forward svc/frontend 3000:3000   # интерфейс
kubectl -n hackalem port-forward svc/api      8000:8000   # Swagger на /docs
```

---

## Развернуть в настоящем кластере

```bash
# 1. образы в registry
docker build -f infra/docker/backend.Dockerfile  -t ghcr.io/ВЫ/hackalem-api:v1 .
docker build -f infra/docker/frontend.Dockerfile -t ghcr.io/ВЫ/hackalem-frontend:v1 .
docker push ghcr.io/ВЫ/hackalem-api:v1
docker push ghcr.io/ВЫ/hackalem-frontend:v1

# 2. подставить свой registry и тег
cd infra/k8s
kustomize edit set image ghcr.io/OWNER/hackalem-api=ghcr.io/ВЫ/hackalem-api:v1
kustomize edit set image ghcr.io/OWNER/hackalem-frontend=ghcr.io/ВЫ/hackalem-frontend:v1

# 3. секреты — НЕ из secret.yaml, он шаблон
kubectl create namespace hackalem
kubectl -n hackalem create secret generic app-secrets \
  --from-literal=DATABASE_URL='postgresql+asyncpg://app:ПАРОЛЬ@postgres:5432/app' \
  --from-literal=POSTGRES_PASSWORD='ПАРОЛЬ' \
  --from-literal=REDIS_URL='redis://redis:6379/0' \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=LLM_API_KEY='...' \
  --from-literal=EMBEDDING_API_KEY='...' \
  --from-literal=S3_ENDPOINT='http://minio:9000' \
  --from-literal=S3_BUCKET='uploads' \
  --from-literal=S3_ACCESS_KEY='...' \
  --from-literal=S3_SECRET_KEY='...'

# 4. домен в ingress.yaml заменить на свой, затем
kubectl apply -k infra/k8s/
kubectl -n hackalem rollout status deploy/api
```

Повторное развёртывание: Job нельзя применить поверх завершённого, поэтому
```bash
kubectl -n hackalem delete job db-migrate --ignore-not-found
kubectl apply -k infra/k8s/
```

---

## Решения, которые надо уметь объяснить

**Почему миграции отдельным Job, а не в подах.**
У API три реплики, стартуют одновременно. Если миграции делает под, три процесса
гонят `alembic upgrade head` по одной базе наперегонки. Job выполняется один раз;
поды до готовности схемы просто не проходят readiness и не получают трафик.

**Почему liveness не проверяет базу.**
`/health` отвечает «процесс жив», `/ready` — «зависимости доступны». Если бы
liveness дёргал БД, просадка базы вызвала бы каскадный перезапуск всех подов —
ровно в тот момент, когда система и так под нагрузкой. Readiness при этом уберёт
под из балансировки, что и нужно.

**Почему `maxUnavailable: 1`, а не `minAvailable: 2`.**
HPA может опустить число реплик до `minReplicas=2`. При `minAvailable: 2` узел
стало бы невозможно вывести на обслуживание — вытеснение пода навсегда запрещено.

**Почему воркеры масштабируются отдельно от API.**
Это разные профили нагрузки: API упирается в количество HTTP-запросов, воркер —
в длительность AI-задач. HPA: API 2→10, воркеры 1→20.

**Почему по CPU, а это не идеально.**
Воркер ждёт ответ модели, CPU при этом простаивает — по нему масштабировать
неправильно. Правильно — по длине очереди. Готовая конфигурация KEDA лежит
закомментированной в `hpa.yaml`: 1 воркер на каждые 5 задач в очереди.

**Почему Postgres и MinIO в кластере, хотя так не делают.**
Для демо. В проде — managed-сервисы: бэкапы, репликация и failover уже входят
в услугу. Это же и есть ответ на вопрос «как обеспечивается сохранность данных».

---

## Если что-то не так

```bash
kubectl -n hackalem get pods                  # кто не поднялся
kubectl -n hackalem describe pod ИМЯ          # секция Events внизу — причина
kubectl -n hackalem logs ИМЯ                  # логи
kubectl -n hackalem logs job/db-migrate       # миграции
```

| Симптом | Причина |
|---|---|
| `ErrImagePull` / `ImagePullBackOff` | образ не загружен в ноду — шаг 2 в «Поднять локально» |
| Job `db-migrate` в `Error` | Postgres ещё не готов. Job идёт через entrypoint, который ждёт базу; при повторе — `kubectl delete job db-migrate` |
| `CreateContainerConfigError` | в Secret нет ключа, на который ссылается манифест |
| Под `Pending` | не хватает ресурсов ноды или PVC не создаётся (`kubectl get pvc -n hackalem`) |
| HPA показывает `<unknown>` | нет metrics-server: `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`, затем добавить аргумент `--kubelet-insecure-tls` |
| nginx падает с `chown ... Operation not permitted` | обычный образ nginx требует capability CHOWN; используется `nginxinc/nginx-unprivileged` |

---

## Освободить ресурсы

Кластер держит около 2 ГБ памяти. Перед хакатоном лучше убрать:

```bash
make k8s-down                      # снести только наше приложение
# и/или Docker Desktop → Settings → Kubernetes → снять галочку
```
