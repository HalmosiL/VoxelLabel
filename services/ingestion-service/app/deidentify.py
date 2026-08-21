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


def apply_deidentification_profile(dataset, study_id: str):
    """Apply the de-identification profile assigned to `study_id`, if any.

    If the study has no profile assigned, the dataset is returned
    unchanged -- an explicit profile assignment is required to de-identify,
    rather than a hardcoded default.
    """
    db = SessionLocal()
    try:
        study = db.get(Study, study_id)
        if study is None or study.deidentification_profile_id is None:
            return dataset

        profile = db.get(DeidentificationProfile, study.deidentification_profile_id)
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
