"""/health/ready: is this service able to do its work right now?

/health only says the process is up -- it answered "ok" while the
database, object storage or the task queue was unreachable. /health/ready
runs each dependency check the service names and answers 503 with which
one is down, e.g. {"status": "not ready", "checks": {"database": "ok",
"storage": "unavailable (EndpointConnectionError)"}}. Only the error's
type is shown: the endpoint needs no login, so no hosts or messages.
/health stays the liveness check (restarting a service doesn't bring a
dependency back)."""
from typing import Callable

from fastapi import FastAPI
from fastapi.responses import JSONResponse


def database_check() -> None:
    """One round trip to the platform database."""
    from shared_models.database import engine
    from sqlalchemy import text

    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))


def install_readiness(app: FastAPI, checks: dict[str, Callable[[], None]]) -> None:
    @app.get("/health/ready")
    def ready() -> JSONResponse:
        results = {}
        for name, check in checks.items():
            try:
                check()
                results[name] = "ok"
            except Exception as err:  # noqa: BLE001 -- any failure means "not ready"
                results[name] = f"unavailable ({type(err).__name__})"
        ok = all(value == "ok" for value in results.values())
        return JSONResponse(status_code=200 if ok else 503, content={"status": "ready" if ok else "not ready", "checks": results})
