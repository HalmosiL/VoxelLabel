"""At most N requests of a service in flight at once, N = its database
connections -- the rest wait asynchronously, holding nothing.

Why: a sync FastAPI endpoint runs on the threadpool (40 threads) and its
answer is serialized there too. Under a burst (the viewer asking for 150
slices at once) the threads all blocked waiting for one of the 15 pooled
connections, while the requests that held those connections waited for a
free thread to serialize their answer -- neither side could move until
the 30 s pool timeout, and the viewer said "The server had a problem".
Limiting in-flight requests to the pool size means no thread ever waits
for a connection.

Streaming downloads that touch no database (a signed object link) and
health checks are exempt, so a slow download never takes a slot."""
import asyncio
import os


class RequestLimitMiddleware:
    """Pure ASGI middleware: a semaphore around every HTTP request whose
    path doesn't start with one of `exempt`."""

    def __init__(self, app, limit: int, exempt: tuple[str, ...] = ()):
        self.app = app
        self.limit = max(1, int(limit))
        self.exempt = tuple(exempt)
        self._semaphore: asyncio.Semaphore | None = None

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("path", "").startswith(self.exempt):
            await self.app(scope, receive, send)
            return
        if self._semaphore is None:  # made in the running loop
            self._semaphore = asyncio.Semaphore(self.limit)
        async with self._semaphore:
            await self.app(scope, receive, send)


def database_request_limit() -> int:
    """The pool's capacity (SQLAlchemy's default 5 + 10 overflow), or
    REQUEST_LIMIT when a deployment sizes it differently."""
    return int(os.environ.get("REQUEST_LIMIT", "15"))


def install_request_limit(app, exempt: tuple[str, ...] = ("/health",)) -> None:
    app.add_middleware(RequestLimitMiddleware, limit=database_request_limit(), exempt=exempt)
