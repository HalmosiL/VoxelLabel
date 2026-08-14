"""Annotation service entrypoint.

Owns annotation create/list/review. Annotation types are data (see
AnnotationType in shared_models), not hardcoded here -- new types can be
registered without a deployment.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as annotations_router
from app.core.config import settings

app = FastAPI(title="CT Platform - Annotation Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(annotations_router)


@app.get("/health")
def health() -> dict:
    """Liveness/readiness probe target for Kubernetes."""
    return {"status": "ok"}
