#!/usr/bin/env sh
set -e

# Ждём БД: при первом старте docker-compose/K8s Postgres может быть ещё не готов
if [ -n "$DATABASE_URL" ]; then
  echo "[entrypoint] waiting for database..."
  i=0
  until python -c "
import os, sys, asyncio, asyncpg
url = os.environ['DATABASE_URL'].replace('+asyncpg', '')
asyncio.run(asyncpg.connect(url)).close()
" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge 30 ] && echo "[entrypoint] database unreachable, giving up" && exit 1
    sleep 2
  done
fi

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] applying migrations..."
  alembic upgrade head
fi

if [ "${SEED_ON_START:-false}" = "true" ]; then
  echo "[entrypoint] seeding demo data..."
  python -m app.scripts.seed || echo "[entrypoint] seed skipped"
fi

echo "[entrypoint] starting: $*"
exec "$@"
