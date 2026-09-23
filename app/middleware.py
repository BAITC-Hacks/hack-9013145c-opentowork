import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from app.observability import HTTP_LATENCY, HTTP_REQUESTS, log, request_id_ctx


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:16]
        token = request_id_ctx.set(request_id)
        request.state.request_id = request_id

        route = request.scope.get("route")
        path = getattr(route, "path", request.url.path)
        started = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            response.headers["X-Request-ID"] = request_id
            return response
        finally:
            elapsed = time.perf_counter() - started
            route = request.scope.get("route")
            # Без маршрута в лейбл попадал сырой URL: перебор несуществующих
            # путей раздувал число временных рядов в Prometheus без предела.
            path = getattr(route, "path", None) or "__unmatched__"
            HTTP_REQUESTS.labels(request.method, path, str(status_code)).inc()
            HTTP_LATENCY.labels(request.method, path).observe(elapsed)
            if not path.startswith(("/health", "/ready", "/metrics")):
                log.info(
                    "http_request",
                    method=request.method,
                    path=path,
                    status=status_code,
                    latency_ms=round(elapsed * 1000, 2),
                )
            request_id_ctx.reset(token)
