# ─── build stage ────────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

# Зависимости берём из pyproject.toml, чтобы не поддерживать второй список.
# Слой пересобирается только при изменении pyproject.toml.
COPY pyproject.toml ./
RUN python -c "\
import tomllib, pathlib; \
data = tomllib.loads(pathlib.Path('pyproject.toml').read_text()); \
deps = data['project']['dependencies'] + data['project']['optional-dependencies']['ml']; \
pathlib.Path('requirements.txt').write_text('\n'.join(deps))" \
 && pip install --no-cache-dir --prefix=/install -r requirements.txt

# ─── runtime stage ──────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

# libgomp — рантайм OpenMP для LightGBM (ML-контур прогноза ВЭС).
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 app

COPY --from=builder /install /usr/local

WORKDIR /app
COPY --chown=app:app . .
RUN chmod +x scripts/entrypoint.sh
# Модель обучается при сборке из datasets/ и artifacts/weather (~1 мин): pickle не
# хранится в git и всегда совпадает с версиями библиотек образа.
RUN python -m windcast train && chown -R app:app artifacts/models

USER app
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=3s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
