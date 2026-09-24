"""De-identification engine: applies an admin-configured profile to a pydicom dataset.

Rules are stored in the deidentification_profiles / deidentification_rules
tables (see shared_models.models) and are editable via the admin service --
this module never hardcodes tag-handling policy, since the exact
de-identification requirements are a compliance decision, not a technical
one (see ARCHITECTURE.md).
"""
import hashlib

from pydicom.datadict import keyword_for_tag
from pydicom.tag import Tag
from shared_models.database import SessionLocal
from shared_models.models import DeidentificationAction, DeidentificationProfile, Study


def profile_for_study(db, study_id: str) -> DeidentificationProfile | None:
    """The profile imports into `study_id` go through: the one assigned
    to the study, else the platform's default profile (the newest one
    marked is_default), else none."""
    study = db.get(Study, study_id)
    if study is None:
        return None
    if study.deidentification_profile_id is not None:
        profile = db.get(DeidentificationProfile, study.deidentification_profile_id)
        if profile is not None:
            return profile
    return (
        db.query(DeidentificationProfile)
        .filter(DeidentificationProfile.is_default.is_(True))
        .order_by(DeidentificationProfile.created_at.desc())
        .first()
    )


def apply_deidentification_profile(dataset, study_id: str):
    """Apply the study's de-identification profile (see profile_for_study).

    With neither a study profile nor a default profile the dataset is
    returned unchanged -- the tag policy is a compliance decision made by
    an admin, not hardcoded here; the admin-ui warns about such studies.
    """
    db = SessionLocal()
    try:
        profile = profile_for_study(db, study_id)
        if profile is None:
            return dataset
        for rule in profile.rules:
            _apply_rule(dataset, rule)
        return dataset
    finally:
        db.close()


def _apply_rule(dataset, rule) -> None:
    tag_keyword = _tag_to_keyword(rule.dicom_tag)
    if tag_keyword is None or tag_keyword not in dataset:
        return

    if rule.action == DeidentificationAction.KEEP:
        return
    if rule.action == DeidentificationAction.REMOVE:
        delattr(dataset, tag_keyword)
    elif rule.action == DeidentificationAction.REPLACE_FIXED:
        setattr(dataset, tag_keyword, rule.replacement_value or "")
    elif rule.action == DeidentificationAction.HASH:
        original = str(getattr(dataset, tag_keyword))
        setattr(dataset, tag_keyword, hashlib.sha256(original.encode()).hexdigest()[:16])


def _tag_to_keyword(dicom_tag: str) -> str | None:
    """Resolve a "(gggg,eeee)" tag string to its pydicom keyword attribute name."""
    group, element = dicom_tag.strip("()").split(",")
    return keyword_for_tag(Tag(int(group, 16), int(element, 16))) or None
