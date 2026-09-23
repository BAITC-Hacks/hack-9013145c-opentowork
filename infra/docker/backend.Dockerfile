# ─── build stage ────────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

# Зависимости берём из pyproject.toml, чтобы не поддерживать второй список.
# Слой пересобирается только при изменении pyproject.toml.
COPY pyproject.toml ./
RUN python -c "\
import tomllib, pathlib; \
data = tomllib.loads(pathlib.Path('pyproject.toml').read_text()); \
pathlib.Path('requirements.txt').write_text('\n'.join(data['project']['dependencies']))" \
 && pip install --no-cache-dir --prefix=/install -r requirements.txt

# ─── runtime stage ──────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

RUN useradd --create-home --uid 1000 app

COPY --from=builder /install /usr/local

WORKDIR /app
COPY --chown=app:app . .
RUN chmod +x scripts/entrypoint.sh

USER app
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=3s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
