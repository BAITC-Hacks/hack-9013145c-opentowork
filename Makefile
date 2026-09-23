.DEFAULT_GOAL := help
.PHONY: help up down restart build logs ps smoke test test-docker test-integration \
	security-scan lint fmt migrate revision seed shell db redis reset clean venv \
	k8s-up k8s-down k8s-status k8s-smoke k8s-load k8s-forward

VENV := .venv
PY   := $(VENV)/bin/python

help: ## Показать список команд
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up: ## Поднять стек (api, воркеры, postgres, redis, minio)
	@test -f .env || cp .env.example .env
	docker compose up -d
	@echo "Ожидание API..."
	@for i in $$(seq 1 60); do \
		if [ "$$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/health)" = "200" ]; then \
			echo "Готово: http://localhost:8000/docs"; exit 0; fi; sleep 2; done; \
		echo "API не поднялся, смотрите make logs"; exit 1

down: ## Остановить стек
	docker compose down

restart: down up ## Перезапустить стек

build: ## Пересобрать образы
	docker compose build

logs: ## Логи api и воркеров
	docker compose logs -f api worker

ps: ## Статус контейнеров
	docker compose ps

smoke: ## Сквозная проверка всего пути (PASS/FAIL по пунктам)
	python3 scripts/smoke_test.py

test: ## Тесты и линтер (нужен локальный venv: make venv)
	$(VENV)/bin/pytest -q
	$(VENV)/bin/ruff check .

test-integration: ## Интеграционные тесты границ доступа (нужен поднятый стек)
	docker compose exec -T api sh -c 		"pip install -q pytest pytest-asyncio && python -m pytest -q -m integration -p no:cacheprovider"

security-scan: ## Аудит зависимостей и статический анализ кода
	docker compose run --rm --no-deps -e RUN_MIGRATIONS=false -e SEED_ON_START=false 		--entrypoint sh api -c 'pip install -q pip-audit bandit && 		python -m pip_audit --strict || true; 		python -m bandit -q -r app -x app/scripts || true'

test-docker: ## Тесты и линтер внутри контейнера — работает и на Windows без venv
	docker compose run --rm --no-deps -e RUN_MIGRATIONS=false -e SEED_ON_START=false 		--entrypoint sh api -c 'pip install -q pytest pytest-asyncio ruff && 		python -m pytest -q -p no:cacheprovider && 		RUFF_CACHE_DIR=/tmp/.ruff python -m ruff check .' 

lint: ## Только линтер
	$(VENV)/bin/ruff check .

fmt: ## Автоисправление линтера
	$(VENV)/bin/ruff check --fix .

migrate: ## Применить миграции
	docker compose exec api alembic upgrade head

revision: ## Создать миграцию: make revision m="add field"
	docker compose exec api alembic revision --autogenerate -m "$(m)"

seed: ## Загрузить демо-данные
	docker compose exec api python -m app.scripts.seed

shell: ## Python-консоль внутри api
	docker compose exec api python

db: ## psql в базу
	docker compose exec postgres psql -U app -d app

redis: ## redis-cli
	docker compose exec redis redis-cli

reset: ## ПОЛНЫЙ сброс: снести тома и поднять заново + smoke (проверка «чистой машины»)
	docker compose down -v
	$(MAKE) up
	@sleep 3
	$(MAKE) smoke

venv: ## Локальное окружение для тестов и линтера
	python3 -m venv $(VENV)
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -e ".[dev]"
	@echo "Готово: $(VENV)"

# ─── Kubernetes (локальный кластер Docker Desktop) ──────────────────────────

K8S_NODE := desktop-control-plane

k8s-load: ## Загрузить локальные образы в ноду кластера
	docker compose build api frontend
	docker save hackalem-api:latest | docker exec -i $(K8S_NODE) 		ctr --namespace k8s.io images import -
	docker save hackalem-frontend:latest | docker exec -i $(K8S_NODE) 		ctr --namespace k8s.io images import -

k8s-up: k8s-load ## Развернуть весь стек в локальном кластере
	kubectl -n hackalem delete job db-migrate --ignore-not-found
	kubectl apply -k infra/k8s-local/
	kubectl -n hackalem rollout status deploy/api --timeout=180s
	@echo "Готово. Порты: make k8s-forward"

k8s-status: ## Поды, HPA и потребление ресурсов
	@kubectl -n hackalem get pods
	@echo
	@kubectl -n hackalem get hpa
	@echo
	@kubectl -n hackalem top pods 2>/dev/null || echo "(нет metrics-server — см. context/06-kubernetes.md)"

k8s-forward: ## Пробросить порты кластера на localhost (Ctrl+C для выхода)
	@echo "Frontend: http://localhost:3000   API: http://localhost:8000/docs"
	kubectl -n hackalem port-forward svc/frontend 3000:3000 & 	kubectl -n hackalem port-forward svc/api 8000:8000; 	kill %1 2>/dev/null || true

k8s-smoke: ## Сквозная проверка приложения в кластере
	@kubectl -n hackalem port-forward svc/api 28000:8000 > /dev/null 2>&1 & 	sleep 5; python3 scripts/smoke_test.py --base http://localhost:28000; 	status=$$?; kill %1 2>/dev/null; exit $$status

k8s-down: ## Снести приложение из кластера (сам кластер остаётся)
	kubectl delete namespace hackalem --ignore-not-found

clean: ## Удалить кэши
	rm -rf .pytest_cache .ruff_cache .mypy_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
