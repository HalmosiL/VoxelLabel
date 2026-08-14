"""Annotation service entrypoint.

Owns annotation create/list/review. Annotation types are data (see
AnnotationType in shared_models), not hardcoded here -- new types can be
registered without a deployment.
"""
from fastapi import FastAPI

from app.api.routes import router as annotations_router

app = FastAPI(title="CT Platform - Annotation Service")
app.include_router(annotations_router)


@app.get("/health")
def health() -> dict:
    """Liveness/readiness probe target for Kubernetes."""
    return {"status": "ok"}
