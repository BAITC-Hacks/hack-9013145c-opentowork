"""Демо-данные при старте.

Технический эксперт должен проверить основной сценарий без ваших личных аккаунтов
(п. 5.6.6) — поэтому демо-пользователь и база знаний создаются автоматически.
Содержимое DEMO_DOCUMENTS заменить на материалы кейса 23.09.
"""

import asyncio

from sqlalchemy import func, select

from app.ai.embedder import build_embedder
from app.auth.security import hash_password
from app.config import settings
from app.db import SessionLocal
from app.models import DomainEntity, KnowledgeDocument, User
from app.observability import log, setup_logging
from app.rag.pipeline import RAGPipeline

DEMO_DOCUMENTS = [
    {
        "title": "Как устроена платформа",
        "source": "internal/architecture",
        "kind": "manual",
        "content": (
            "Платформа построена как модульный монолит на FastAPI с асинхронными "
            "воркерами. Данные хранятся в PostgreSQL с расширением pgvector.\n\n"
            "Семантический кэш снижает количество обращений к языковой модели. "
            "Порог срабатывания кэша по умолчанию равен 0.92. При попадании в кэш "
            "ответ возвращается без обращения к внешнему провайдеру.\n\n"
            "Тяжёлые операции выполняются асинхронно через очередь на Redis Streams. "
            "Клиент создаёт задачу и получает её идентификатор, затем опрашивает статус."
        ),
    },
    {
        "title": "Проверка качества ответов модели",
        "source": "internal/validation",
        "kind": "manual",
        "content": (
            "Ответ языковой модели проходит четыре уровня проверки. Первый уровень "
            "фильтрует вход: ограничение длины, маскирование персональных данных и "
            "обнаружение попыток подмены инструкций.\n\n"
            "Второй уровень проверяет соответствие ответа схеме. Если структура "
            "нарушена, выполняется повторный запрос с текстом ошибки.\n\n"
            "Третий уровень проверяет обоснованность: каждый источник должен "
            "существовать в выданном контексте, числа должны встречаться в исходных "
            "документах.\n\n"
            "Четвёртый уровень возвращает безопасный ответ с пометкой о необходимости "
            "проверки экспертом, если предыдущие уровни не дали валидного результата."
        ),
    },
]


async def seed() -> None:
    async with SessionLocal() as session:
        user_count = await session.scalar(select(func.count()).select_from(User))
        if user_count:
            log.info("seed_skipped", reason="database already populated")
            return

        demo = User(
            email=settings.DEMO_USER_EMAIL,
            password_hash=hash_password(settings.DEMO_USER_PASSWORD),
            full_name="Demo User",
            # НЕ ADMIN: ADMIN обходит authorize_owner и читал бы данные всех
            # пользователей, а пароль этой учётки опубликован в README.
            role=settings.DEMO_USER_ROLE,
        )
        session.add(demo)
        await session.flush()

        session.add(
            DomainEntity(
                owner_id=demo.id,
                name="Демонстрационный объект",
                kind="demo",
                attributes={"note": "Заменить на сущность кейса"},
            )
        )

        rag = RAGPipeline(session, build_embedder())
        total_chunks = 0
        for doc in DEMO_DOCUMENTS:
            document = KnowledgeDocument(
                title=doc["title"],
                source=doc["source"],
                lang="ru",
                kind=doc.get("kind"),
                owner_id=demo.id,
                # Демо-документы — общая справка платформы, а не личные
                # материалы: они и должны быть видны всем.
                visibility="public",
            )
            session.add(document)
            await session.flush()
            total_chunks += await rag.index_document(document.id, doc["content"])

        await session.commit()
        log.info(
            "seed_completed",
            user=settings.DEMO_USER_EMAIL,
            documents=len(DEMO_DOCUMENTS),
            chunks=total_chunks,
        )


def main() -> None:
    setup_logging()
    asyncio.run(seed())


if __name__ == "__main__":
    main()
