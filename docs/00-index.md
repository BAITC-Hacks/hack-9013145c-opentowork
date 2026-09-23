# Документация

Как запустить и проверить проект — в [README](../README.md). Здесь — как устроена
платформа и почему она сделана именно так.

Где лежит конкретный файл и как сделать типовую правку — в [`context/`](../context/README.md):
карта файлов, список фич, рецепты и разбор типовых поломок.

| Документ | О чём |
|---|---|
| [01-architecture-overview.md](01-architecture-overview.md) | принципы, модули, общая схема |
| [02-ai-llm-pipeline.md](02-ai-llm-pipeline.md) | AI-оркестратор, абстракция LLM, семантический кэш, RAG, проверка ответов |
| [03-database-schema.md](03-database-schema.md) | схема базы, pgvector, жизненный цикл фоновых задач |
| [04-api-specification.md](04-api-specification.md) | REST API, коды ошибок, авторизация |
| [05-deployment-and-kubernetes.md](05-deployment-and-kubernetes.md) | Docker, docker-compose, Kubernetes, CI/CD, масштабирование |
| [06-security-observability.md](06-security-observability.md) | авторизация и роли, лимиты запросов, логи, метрики |
| [new-wind-turbines.md](new-wind-turbines.md) | расчёт выработки новых ветровых турбин |

Прогноз ВЭС (пакет `windcast/`) описан в README: разделы «ML-модель: как воспроизвести»,
«Как устроен прогноз» и «Результаты бэктеста».
