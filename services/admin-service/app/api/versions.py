"""HTTP API for a Study's version history -- listing, saving a labelled
version, inspecting one (with what restoring it would change), restoring
it, and deleting one. See app/versioning.py for what a version holds.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import Study, StudyVersion
from sqlalchemy.orm import Session

from app.api import audit
from app.api.studies import _user_directory
from app.versioning import diff_summary, record_version, restore_version, snapshot_study

router = APIRouter(prefix="/admin/studies/{study_id}/versions", tags=["admin:versions"])

_READ_ROLES = ["viewer", "annotator", "reviewer", "data_manager", "admin"]
_WRITE_ROLES = ["data_manager", "admin"]


class VersionIn(BaseModel):
    label: str | None = None


def _study_or_404(db: Session, study_id: str) -> Study:
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")
    return study


def _version_or_404(db: Session, study_id: str, version_id: uuid.UUID) -> StudyVersion:
    version = db.get(StudyVersion, version_id)
    if version is None or str(version.study_id) != str(study_id):
        raise HTTPException(status_code=404, detail="Version not found")
    return version


def _serialize(version: StudyVersion, directory: dict) -> dict:
    author = directory.get(version.created_by, {})
    return {
        "id": str(version.id),
        "number": version.number,
        "kind": version.kind,
        "label": version.label,
        "created_by": version.created_by,
        "created_by_name": author.get("username") or author.get("email"),
        "created_at": version.created_at.isoformat() if version.created_at else None,
        "summary": version.summary,
    }


@router.get("")
def list_versions(
    study_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    _study_or_404(db, study_id)
    require_study_role(db, study_id, user, allowed_roles=_READ_ROLES)
    versions = db.query(StudyVersion).filter_by(study_id=study_id).order_by(StudyVersion.number.desc()).all()
    directory = _user_directory()
    return [_serialize(v, directory) for v in versions]


@router.post("", status_code=201)
def create_version(
    study_id: str,
    body: VersionIn,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Save the current state as a named version -- always a new entry,
    never coalesced into an automatic one."""
    _study_or_404(db, study_id)
    require_study_role(db, study_id, user, allowed_roles=_WRITE_ROLES)
    version = record_version(db, study_id, user.subject, kind="manual", label=(body.label or "").strip() or None)
    return _serialize(version, _user_directory())


@router.get("/{version_id}")
def get_version(
    study_id: str,
    version_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """One version in full, plus what restoring it now would change
    (counts per area) so the confirmation can be specific."""
    study = _study_or_404(db, study_id)
    require_study_role(db, study_id, user, allowed_roles=_READ_ROLES)
    version = _version_or_404(db, study_id, version_id)
    return {
        **_serialize(version, _user_directory()),
        "snapshot": version.snapshot,
        "changes_if_restored": diff_summary(version.snapshot, snapshot_study(db, study)),
    }


@router.post("/{version_id}/restore")
def restore(
    study_id: str,
    version_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Put the study back into this version's state. A safety version of
    the current state is recorded first, so this is itself reversible."""
    study = _study_or_404(db, study_id)
    require_study_role(db, study_id, user, allowed_roles=["admin"])
    version = _version_or_404(db, study_id, version_id)
    result = restore_version(db, study, version, user.subject)
    audit.record(db, user, "study.restore_version", "study", study.id, {"version_id": str(version_id), "version_number": version.number})
    db.commit()
    return result


@router.delete("/{version_id}", status_code=204)
def delete_version(
    study_id: str,
    version_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    _study_or_404(db, study_id)
    require_study_role(db, study_id, user, allowed_roles=["admin"])
    version = _version_or_404(db, study_id, version_id)
    audit.record(db, user, "study.delete_version", "study", version.study_id, {"version_id": str(version_id), "version_number": version.number})
    db.delete(version)
    db.commit()
