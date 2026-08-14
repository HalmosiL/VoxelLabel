"""Data service entrypoint.

Read-focused API for browsing ingested studies/series/instances and
fetching pixel data (via presigned object storage URLs, not proxied
through this service).
"""
from fastapi import FastAPI

from app.api.routes import router as data_router

app = FastAPI(title="CT Platform - Data Service")
app.include_router(data_router)


@app.get("/health")
def health() -> dict:
    """Liveness/readiness probe target for Kubernetes."""
    return {"status": "ok"}
