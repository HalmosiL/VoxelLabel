"""HTTP API for managing studies and study memberships (per-study roles).

A `Study` here is the platform's top-level, admin-created RBAC container
(e.g. a research study or clinical protocol) -- not to be confused with an
`ImagingStudy`, the DICOM per-session imaging entity that hangs off a Case
(see `app/api/imaging.py`).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import Case, Study, StudyMembership, StudyRole

from app.storage import presigned_study_cover_image_url, upload_study_cover_image

router = APIRouter(prefix="/admin/studies", tags=["admin:studies"])


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


@router.get("")
def list_studies(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    _require_global_admin(user)
    studies = db.query(Study).all()
    return [
        {
            "id": str(s.id),
            "name": s.name,
            "description": s.description,
            "deidentification_profile_id": str(s.deidentification_profile_id) if s.deidentification_profile_id else None,
            "cover_image_url": presigned_study_cover_image_url(s.cover_image_key) if s.cover_image_key else None,
        }
        for s in studies
    ]


@router.get("/{study_id}")
def get_study(
    study_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")
    return {
        "id": str(study.id),
        "name": study.name,
        "description": study.description,
        "deidentification_profile_id": str(study.deidentification_profile_id) if study.deidentification_profile_id else None,
        "cover_image_url": presigned_study_cover_image_url(study.cover_image_key) if study.cover_image_key else None,
    }


@router.post("")
def create_study(
    name: str,
    description: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    study = Study(name=name, description=description)
    db.add(study)
    db.commit()
    return {"id": str(study.id), "name": study.name}


@router.patch("/{study_id}")
def update_study(
    study_id: str,
    name: str | None = None,
    description: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")

    if name is not None:
        study.name = name
    if description is not None:
        study.description = description
    db.commit()
    return {"id": str(study.id), "name": study.name, "description": study.description}


@router.delete("/{study_id}", status_code=204)
def delete_study(
    study_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Deletes a study and its membership grants. Refuses to delete a
    study that still has cases -- cases carry real (pseudonymized)
    patient data, so removing them has to be a deliberate, separate
    action, not a side effect of deleting the study they're grouped
    under."""
    _require_global_admin(user)
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")

    case_count = db.query(Case).filter_by(study_id=study_id).count()
    if case_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete: this study still has {case_count} case(s). Remove them first.",
        )

    db.query(StudyMembership).filter_by(study_id=study_id).delete()
    db.delete(study)
    db.commit()


@router.post("/{study_id}/cover-image")
async def upload_cover_image(
    study_id: str,
    file: UploadFile,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Attach (or replace) a study's cover image, shown on its card in
    the admin-ui study grid."""
    _require_global_admin(user)
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")

    storage_key = f"study-covers/{study_id}/{uuid.uuid4()}-{file.filename}"
    upload_study_cover_image(storage_key, await file.read())

    study.cover_image_key = storage_key
    db.commit()
    return {"id": str(study.id), "cover_image_url": presigned_study_cover_image_url(storage_key)}


@router.get("/{study_id}/members")
def list_study_members(
    study_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    _require_global_admin(user)
    memberships = db.query(StudyMembership).filter_by(study_id=study_id).all()
    return [{"user_id": m.user_id, "role": m.role.value} for m in memberships]


@router.post("/{study_id}/members")
def add_study_member(
    study_id: str,
    user_id: str,
    role: StudyRole,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Grant `user_id` (a Keycloak subject) a role scoped to this study."""
    _require_global_admin(user)
    membership = StudyMembership(study_id=study_id, user_id=user_id, role=role)
    db.add(membership)
    db.commit()
    return {"study_id": study_id, "user_id": user_id, "role": role.value}
