"""HTTP API for managing de-identification profiles and their per-tag rules.

Rules are consumed by the ingestion service (see
services/ingestion-service/app/deidentify.py) at upload time -- this
service only edits the configuration, it does not process DICOM files.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import DeidentificationAction, DeidentificationProfile, DeidentificationRule

router = APIRouter(prefix="/admin/deidentification-profiles", tags=["admin:deidentification"])


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


@router.post("")
def create_profile(
    name: str,
    is_default: bool,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    profile = DeidentificationProfile(name=name, is_default=is_default, created_by=user.subject)
    db.add(profile)
    db.commit()
    return {"id": str(profile.id), "name": profile.name}


@router.post("/{profile_id}/rules")
def add_rule(
    profile_id: uuid.UUID,
    dicom_tag: str,
    action: DeidentificationAction,
    replacement_value: str | None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Add one tag-handling rule (e.g. "(0010,0010)" -> hash) to a profile."""
    _require_global_admin(user)
    rule = DeidentificationRule(
        profile_id=profile_id, dicom_tag=dicom_tag, action=action, replacement_value=replacement_value
    )
    db.add(rule)
    db.commit()
    return {"id": str(rule.id), "dicom_tag": rule.dicom_tag, "action": rule.action.value}
