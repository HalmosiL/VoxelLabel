"""HTTP API for managing de-identification profiles and their per-tag rules.

Rules are consumed by the ingestion service (see
services/ingestion-service/app/deidentify.py) at upload time -- this
service only edits the configuration, it does not process DICOM files.

A rule is accepted only if it can be applied (shared_models.deid_rules
decides, for both services): an unparsable tag, a missing or invalid
replacement value, or a rule that would merge exams or write an invalid
value used to be stored and then fail every import of every study using
the profile (B-10). One rule per tag, so conflicting rules can't exist.
Rules and profiles no longer in use can be deleted. Every change is
audited. A profile's hash salt is a secret and is never returned.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.deid_rules import RuleError, check_rule, normalise_tag
from shared_models.models import DeidentificationAction, DeidentificationProfile, DeidentificationRule, Study
from sqlalchemy.orm import Session

from app.api import audit

router = APIRouter(prefix="/admin/deidentification-profiles", tags=["admin:deidentification"])


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


def _profile_or_404(db: Session, profile_id: uuid.UUID) -> DeidentificationProfile:
    profile = db.get(DeidentificationProfile, profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="De-identification profile not found")
    return profile


def _problem(rule: DeidentificationRule) -> str | None:
    """Why a stored rule can't be applied (one saved before the checks
    existed), or None. Such a rule fails every import until it's deleted."""
    try:
        check_rule(rule.dicom_tag, rule.action, rule.replacement_value)
    except RuleError as exc:
        return str(exc)
    return None


def _serialize_rule(rule: DeidentificationRule, conflict: str | None = None) -> dict:
    return {
        "id": str(rule.id),
        "dicom_tag": rule.dicom_tag,
        "action": rule.action.value,
        "replacement_value": rule.replacement_value,
        "problem": _problem(rule) or conflict,
    }


def _serialize_rules(rules: list[DeidentificationRule]) -> list[dict]:
    """The profile's rules by tag. Rules stored before the one-rule-per-tag
    check can name one tag twice (written differently); that fails every
    import too, so each of them is flagged."""
    by_tag: dict[str, int] = {}
    for rule in rules:
        try:
            tag = normalise_tag(rule.dicom_tag)
        except RuleError:
            continue
        by_tag[tag] = by_tag.get(tag, 0) + 1

    def conflict(rule: DeidentificationRule) -> str | None:
        try:
            tag = normalise_tag(rule.dicom_tag)
        except RuleError:
            return None
        return f"another rule of this profile also covers {tag} -- keep only one" if by_tag.get(tag, 0) > 1 else None

    return [_serialize_rule(r, conflict(r)) for r in sorted(rules, key=lambda r: r.dicom_tag)]


@router.get("")
def list_profiles(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    _require_global_admin(user)
    profiles = db.query(DeidentificationProfile).order_by(DeidentificationProfile.created_at).all()
    return [
        {
            "id": str(p.id),
            "name": p.name,
            "is_default": p.is_default,
            "rules": _serialize_rules(p.rules),
        }
        for p in profiles
    ]


@router.post("")
def create_profile(
    name: str,
    is_default: bool = False,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    profile = DeidentificationProfile(name=name, is_default=is_default, created_by=user.subject)
    db.add(profile)
    db.flush()
    audit.record(db, user, "deidentification_profile.create", "deidentification_profile", profile.id, {"name": name, "is_default": is_default})
    db.commit()
    return {"id": str(profile.id), "name": profile.name}


@router.delete("/{profile_id}", status_code=204)
def delete_profile(
    profile_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Deletes a profile with its rules -- refused while a study uses it,
    since that study's imports would silently lose their de-identification."""
    _require_global_admin(user)
    profile = _profile_or_404(db, profile_id)
    users = [s.name for s in db.query(Study).filter_by(deidentification_profile_id=profile.id).order_by(Study.name).all()]
    if users:
        raise HTTPException(status_code=409, detail=f"Used by {len(users)} study(ies): {', '.join(users)} -- give them another profile first")
    for rule in list(profile.rules):
        db.delete(rule)
    db.delete(profile)
    audit.record(db, user, "deidentification_profile.delete", "deidentification_profile", profile.id, {"name": profile.name})
    db.commit()


@router.post("/{profile_id}/rules")
def add_rule(
    profile_id: uuid.UUID,
    dicom_tag: str,
    action: DeidentificationAction,
    replacement_value: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Add one tag-handling rule (e.g. "(0010,0010)" or "PatientName" ->
    hash) to a profile. 422 if it couldn't be applied, 409 if the profile
    already has a rule for that tag."""
    _require_global_admin(user)
    profile = _profile_or_404(db, profile_id)
    try:
        tag = check_rule(dicom_tag, action, replacement_value)
    except RuleError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    for existing in profile.rules:
        try:
            same = normalise_tag(existing.dicom_tag) == tag
        except RuleError:
            same = False
        if same:
            raise HTTPException(status_code=409, detail=f"This profile already has a rule for {tag} ({existing.action.value}) -- delete it first")
    value = replacement_value if action == DeidentificationAction.REPLACE_FIXED else None
    rule = DeidentificationRule(profile_id=profile.id, dicom_tag=tag, action=action, replacement_value=value)
    db.add(rule)
    db.flush()
    audit.record(db, user, "deidentification_rule.add", "deidentification_profile", profile.id, {"dicom_tag": tag, "action": action.value})
    db.commit()
    return _serialize_rule(rule)


@router.delete("/{profile_id}/rules/{rule_id}", status_code=204)
def delete_rule(
    profile_id: uuid.UUID,
    rule_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    _require_global_admin(user)
    profile = _profile_or_404(db, profile_id)
    rule = db.get(DeidentificationRule, rule_id)
    if rule is None or rule.profile_id != profile.id:
        raise HTTPException(status_code=404, detail="Rule not found in this profile")
    db.delete(rule)
    audit.record(db, user, "deidentification_rule.delete", "deidentification_profile", profile.id, {"dicom_tag": rule.dicom_tag, "action": rule.action.value})
    db.commit()
