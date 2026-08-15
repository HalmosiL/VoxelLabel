"""Admin service entrypoint.

Platform administration: projects, project memberships (per-project
roles), de-identification profiles, cases, and clinical data items. Most
endpoints require project-scoped roles (see shared_auth); project/profile
management specifically requires the global Keycloak "admin" realm role.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.annotation_types import router as annotation_types_router
from app.api.cases import router as cases_router
from app.api.clinical_data import router as clinical_data_router
from app.api.deidentification import router as deidentification_router
from app.api.projects import router as projects_router
from app.api.users import router as users_router
from app.core.config import settings

app = FastAPI(title="CT Platform - Admin Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(projects_router)
app.include_router(deidentification_router)
app.include_router(annotation_types_router)
app.include_router(cases_router)
app.include_router(clinical_data_router)
app.include_router(users_router)


@app.get("/health")
def health() -> dict:
    """Liveness/readiness probe target for Kubernetes."""
    return {"status": "ok"}
