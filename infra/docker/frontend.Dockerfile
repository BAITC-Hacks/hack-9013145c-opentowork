# ─── build stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Отдельный слой под зависимости: правка исходников не заставляет ставить
# пакеты заново. На площадке с перегруженным wifi это экономит минуты.
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY frontend/ ./
RUN npm run build

# ─── runtime stage ──────────────────────────────────────────────────────────
# Образ без привилегий: обычный nginx стартует от root и делает chown кэша,
# а в Kubernetes с `capabilities: drop: [ALL]` capability CHOWN отобрана,
# и контейнер падает при запуске. Этот образ работает от пользователя 101
# и ничего не chown-ит.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

COPY --from=builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

USER 101
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:3000/ || exit 1
