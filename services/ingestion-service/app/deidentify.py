"""De-identification engine: applies an admin-configured profile to a pydicom dataset.

Rules are stored in the deidentification_profiles / deidentification_rules
tables (see shared_models.models) and are editable via the admin service --
this module never hardcodes tag-handling policy, since the exact
de-identification requirements are a compliance decision, not a technical
one (see ARCHITECTURE.md). What each rule does is defined once, in
shared_models.deid_rules, which admin-service also uses to refuse rules
that couldn't be applied.
"""
from shared_models.database import SessionLocal
from shared_models.deid_rules import RuleError, apply_rules
from shared_models.models import DeidentificationProfile, Study


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
    """Apply the study's de-identification profile (see profile_for_study),
    in place, and return the dataset.

    With neither a study profile nor a default profile the dataset is
    returned unchanged -- the tag policy is a compliance decision made by
    an admin, not hardcoded here; the admin-ui warns about such studies.
    Raises RuleError (a DicomValidationError-style per-file failure) when
    a rule of the profile can't be applied: nothing is imported
    un-de-identified.
    """
    db = SessionLocal()
    try:
        profile = profile_for_study(db, study_id)
        if profile is None:
            return dataset
        return apply_rules(dataset, profile.rules, profile.hash_salt)
    finally:
        db.close()


__all__ = ["RuleError", "apply_deidentification_profile", "profile_for_study"]
