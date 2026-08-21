"""Admin service entrypoint.

Platform administration: studies, study memberships (per-study
roles), de-identification profiles, cases, and clinical data items. Most
endpoints require study-scoped roles (see shared_auth); study/profile
management specifically requires the global Keycloak "admin" realm role.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.annotation_types import router as annotation_types_router
from app.api.cases import router as cases_router
from app.api.clinical_data import router as clinical_data_router
from app.api.deidentification import router as deidentification_router
from app.api.imaging import router as imaging_router
from app.api.studies import router as studies_router
from app.api.users import router as users_router
from app.api.workflow import router as workflow_router
from app.core.config import settings

app = FastAPI(title="CT Platform - Admin Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(studies_router)
app.include_router(deidentification_router)
app.include_router(annotation_types_router)
app.include_router(cases_router)
app.include_router(clinical_data_router)
app.include_router(imaging_router)
app.include_router(users_router)
app.include_router(workflow_router)


@app.get("/health")
def health() -> dict:
    """Liveness/readiness probe target for Kubernetes."""
    return {"status": "ok"}
