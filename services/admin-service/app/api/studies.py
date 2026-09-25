"""HTTP API for managing studies and study memberships (per-study roles).

A `Study` here is the platform's top-level, admin-created RBAC container
(e.g. a research study or clinical protocol) -- not to be confused with an
`ImagingStudy`, the DICOM per-session imaging entity that hangs off a Case
(see `app/api/imaging.py`).
"""
import logging
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel
from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import Annotation, AnnotationReview, Case, DeidentificationProfile, Study, StudyMembership, StudyRole, StudyVersion
from sqlalchemy.orm import Session

from app.api import audit
from app.api.input_checks import required_text, safe_filename
from app.duplication import duplicate_study
from app.keycloak_admin import list_realm_users
from app.storage import delete_object, delete_prefix, study_cover_image_link, upload_study_cover_image
from app.versioning import autosave

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/studies", tags=["admin:studies"])

_READ_ROLES = ["viewer", "annotator", "reviewer", "data_manager", "admin"]

# A user can hold more than one role in the same study now (see
# StudyMembership's own docstring) -- admin-ui still only has room to
# show/gate on a single "my_role" badge, so this picks the most
# privileged one someone actually holds, highest first.
_ROLE_PRIORITY = ["admin", "data_manager", "reviewer", "annotator", "viewer"]


def _highest_role(roles: list[str]) -> str | None:
    for candidate in _ROLE_PRIORITY:
        if candidate in roles:
            return candidate
    return roles[0] if roles else None


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


def _is_global_admin(user: CurrentUser) -> bool:
    return "admin" in user.realm_roles


def _require_study_admin(db: Session, study_id: str, user: CurrentUser) -> None:
    """Study management (members, editing) is open to a global admin *or*
    a member holding the study-scoped `admin` role -- that role used to
    grant nothing beyond what `data_manager` had, since every management
    endpoint here demanded the global realm role."""
    require_study_role(db, study_id, user, allowed_roles=["admin"])


def _my_role(db: Session, study_id: str, user: CurrentUser) -> str | None:
    """The caller's own study-scoped role, or "admin" for a global admin
    (who can do everything regardless of membership) -- rides along in
    study responses so admin-ui can show/hide actions per role without
    a second request. A caller holding several roles in this study gets
    the most privileged one -- see _highest_role."""
    if _is_global_admin(user):
        return "admin"
    memberships = db.query(StudyMembership).filter_by(study_id=study_id, user_id=user.subject).all()
    return _highest_role([m.role.value for m in memberships])


def _serialize_study(study: Study, my_role: str | None) -> dict:
    return {
        "id": str(study.id),
        "name": study.name,
        "description": study.description,
        "deidentification_profile_id": str(study.deidentification_profile_id) if study.deidentification_profile_id else None,
        "cover_image_url": study_cover_image_link(study.cover_image_key) if study.cover_image_key else None,
        "my_role": my_role,
    }


# Keycloak user directory (id -> username/email), refreshed at most every
# 30 s -- the members list resolves subjects to names through it. A
# Keycloak hiccup degrades to unresolved ids rather than a failed request.
_directory_cache: tuple[float, dict] = (0.0, {})


def _user_directory() -> dict:
    global _directory_cache
    fetched_at, directory = _directory_cache
    if time.time() - fetched_at < 30:
        return directory
    try:
        directory = {u["id"]: u for u in list_realm_users()}
    except Exception:  # noqa: BLE001 -- names are a nicety, membership itself is the truth
        return directory
    _directory_cache = (time.time(), directory)
    return directory


def _serialize_member(membership: StudyMembership, directory: dict) -> dict:
    user = directory.get(membership.user_id, {})
    return {
        "user_id": membership.user_id,
        "role": membership.role.value,
        "username": user.get("username"),
        "email": user.get("email"),
    }


@router.get("")
def list_studies(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """Every study for a global admin; for anyone else, exactly the studies
    they hold a membership in (with `my_role` set to that role) -- the
    Studies page, the workflow board and ct-annotator's picker all start
    from this list, so a member must be able to see their own studies."""
    if _is_global_admin(user):
        return [_serialize_study(s, "admin") for s in db.query(Study).order_by(Study.name).all()]
    memberships = db.query(StudyMembership).filter_by(user_id=user.subject).all()
    roles_by_study: dict[str, list[str]] = {}
    for m in memberships:
        roles_by_study.setdefault(str(m.study_id), []).append(m.role.value)
    studies = db.query(Study).filter(Study.id.in_(list(roles_by_study))).order_by(Study.name).all() if roles_by_study else []
    return [_serialize_study(s, _highest_role(roles_by_study[str(s.id)])) for s in studies]


@router.get("/{study_id}")
def get_study(
    study_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")
    require_study_role(db, study_id, user, allowed_roles=_READ_ROLES)
    return _serialize_study(study, _my_role(db, study_id, user))


@router.post("")
def create_study(
    name: str,
    description: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    name = required_text(name, "The study name")
    study = Study(name=name, description=description)
    db.add(study)
    db.flush()
    audit.record(db, user, "study.create", "study", study.id, {"name": name})
    db.commit()
    return {"id": str(study.id), "name": study.name}


@router.patch("/{study_id}")
def update_study(
    study_id: str,
    name: str | None = None,
    description: str | None = None,
    deidentification_profile_id: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Rename/describe a study, and choose the de-identification profile
    every image imported into it goes through (`deidentification_profile_id`
    = a profile id; an empty value clears it, so the platform's default
    profile applies -- see ingestion-service app/deidentify.py)."""
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")
    _require_study_admin(db, study_id, user)

    changes = {}
    if name is not None:
        name = required_text(name, "The study name")
    if name is not None and name != study.name:
        changes["name"] = {"from": study.name, "to": name}
        study.name = name
    if description is not None and description != study.description:
        changes["description"] = {"from": study.description, "to": description}
        study.description = description
    if deidentification_profile_id is not None:
        new_profile = None
        if deidentification_profile_id.strip():
            try:
                new_profile = db.get(DeidentificationProfile, uuid.UUID(deidentification_profile_id))
            except ValueError:
                new_profile = None
            if new_profile is None:
                raise HTTPException(status_code=404, detail="De-identification profile not found")
        new_id = new_profile.id if new_profile else None
        if new_id != study.deidentification_profile_id:
            changes["deidentification_profile_id"] = {
                "from": str(study.deidentification_profile_id) if study.deidentification_profile_id else None,
                "to": str(new_id) if new_id else None,
            }
            study.deidentification_profile_id = new_id
    if changes:
        audit.record(db, user, "study.update", "study", study.id, changes)
    db.commit()
    autosave(db, study.id, user.subject)
    return {
        "id": str(study.id),
        "name": study.name,
        "description": study.description,
        "deidentification_profile_id": str(study.deidentification_profile_id) if study.deidentification_profile_id else None,
    }


@router.delete("/{study_id}", status_code=204)
def delete_study(
    study_id: str,
    force: bool = False,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Deletes a study and its membership grants. Refuses to delete a
    study that still has cases unless `force=true` is explicitly passed
    -- cases carry real (pseudonymized) patient data, so removing them
    has to be a deliberate action the caller opted into, not a silent
    side effect of deleting the study they're grouped under. With
    `force`, cascades the exact same per-case delete cases.py's own
    delete_case uses (imaging studies/series/instances, clinical data
    items, all with their object-storage cleanup, and any Annotation
    that targeted them) across every case in the study, then the study
    itself, as one transaction.

    Annotation carries a real FK to `study_id`, so even a study with
    zero cases can still fail to delete here if it has Annotation rows
    orphaned by an EARLIER bug (delete_imaging_study used to remove an
    ImagingStudy/Series/Instance without checking whether an Annotation
    still targeted it -- fixed alongside this, but existing databases
    can already carry the leftovers). The sweep right before db.delete
    below is the actual fix for that: it clears every Annotation still
    tied to this study regardless of whether its target row is even
    still there, so this can't 500 on data a past version of this
    function -- or delete_imaging_study -- left behind, and it runs
    whether or not `force`/cases were involved.

    Imported from cases.py inside the function body, not at module
    load time: cases.py already imports _require_global_admin from
    this module, so importing back from cases.py up here would be a
    circular import at load time -- by the time this function actually
    runs, both modules are fully loaded, so the import just works."""
    _require_global_admin(user)
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")

    cases = db.query(Case).filter_by(study_id=study_id).all()
    if cases and not force:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete: this study still has {len(cases)} case(s). Remove them first, "
            "or delete with force to remove them along with the study.",
        )

    if cases:
        from app.api.cases import _delete_case_cascade

        for case in cases:
            _delete_case_cascade(db, case)

    stale_annotation_ids = [
        row.id for row in db.query(Annotation.id).filter(Annotation.study_id == study_id).all()
    ]
    if stale_annotation_ids:
        db.query(AnnotationReview).filter(AnnotationReview.annotation_id.in_(stale_annotation_ids)).delete(
            synchronize_session=False
        )
        db.query(Annotation).filter(Annotation.id.in_(stale_annotation_ids)).delete(synchronize_session=False)

    db.query(StudyMembership).filter_by(study_id=study_id).delete()
    audit.record(db, user, "study.delete", "study", study.id, {"name": study.name, "cases_deleted": len(cases)})
    db.delete(study)
    db.commit()
    # its cover images -- the current one and any a saved version showed (B-14)
    _forget_objects(lambda: delete_prefix(f"study-covers/{study_id}/"))


class StudyDuplicateIn(BaseModel):
    name: str | None = None
    include_workflow: bool = True


@router.post("/{study_id}/duplicate")
def duplicate_study_route(
    study_id: str,
    body: StudyDuplicateIn = StudyDuplicateIn(),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Creates a fully independent copy of a study: new Case/ImagingStudy/
    Series/Instance/ClinicalDataItem rows with fresh DICOM UIDs, a real
    copy of every object-storage payload (pixel data -- its DICOM UIDs
    rewritten to the copy's --, thumbnails, clinical data files, the
    cover image) under new keys.
    With `include_workflow` (default true), the same workflow board also
    comes along (cards/edges/config, case ids remapped, Run caches
    reset); with it false, only the raw case/imaging/document data is
    duplicated and the copy starts with a blank board. See
    app/duplication.py for exactly what does and doesn't carry over.
    Global admin only, like create_study: this mints a brand-new,
    platform-wide Study, not a scoped change to an existing one."""
    _require_global_admin(user)
    source = db.get(Study, study_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Study not found")

    new_study = duplicate_study(db, source, user, new_name=body.name, include_workflow=body.include_workflow)
    return _serialize_study(new_study, "admin")


def _cover_on_a_version(db: Session, study_id, key: str) -> bool:
    """Whether a saved version of the study shows this cover -- restoring
    it brings the key back, so the image has to stay."""
    return (
        db.query(StudyVersion.id)
        .filter(StudyVersion.study_id == study_id, StudyVersion.snapshot["study"]["cover_image_key"].astext == key)
        .first()
        is not None
    )


def _forget_objects(delete) -> None:
    """Storage cleanup after the change is committed: a failure leaves a
    stray object behind, never an error for a change that already happened."""
    try:
        delete()
    except Exception:  # noqa: BLE001
        logger.warning("could not remove a study cover image from storage", exc_info=True)


@router.post("/{study_id}/cover-image")
async def upload_cover_image(
    study_id: str,
    file: UploadFile,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Attach (or replace) a study's cover image, shown on its card in
    the admin-ui study grid."""
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")
    _require_study_admin(db, study_id, user)

    storage_key = f"study-covers/{study_id}/{uuid.uuid4()}-{safe_filename(file.filename)}"  # as for documents (J-05)
    upload_study_cover_image(storage_key, await file.read())

    previous = study.cover_image_key
    study.cover_image_key = storage_key
    audit.record(db, user, "study.cover_image", "study", study.id)
    db.commit()
    if previous and not _cover_on_a_version(db, study.id, previous):
        _forget_objects(lambda: delete_object(previous))  # B-14
    return {"id": str(study.id), "cover_image_url": study_cover_image_link(storage_key)}


@router.get("/{study_id}/members")
def list_study_members(
    study_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """Members with their study role, plus username/email resolved from
    Keycloak. Readable by every member (the workflow board's assignee
    picker and the job cards need names, and only members can ever be
    assignees -- a non-member assignee couldn't open the study's data)."""
    require_study_role(db, study_id, user, allowed_roles=_READ_ROLES)
    memberships = db.query(StudyMembership).filter_by(study_id=study_id).all()
    directory = _user_directory()
    return sorted((_serialize_member(m, directory) for m in memberships), key=lambda m: (m["username"] or "", m["user_id"]))


@router.post("/{study_id}/members")
def add_study_member(
    study_id: str,
    user_id: str,
    role: StudyRole,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Grants `user_id` (a Keycloak subject) a role scoped to this study.
    Additive, not a replace: a member can hold several roles in the same
    study at once (e.g. both annotator and reviewer) -- call this again
    with a different `role` to grant another one, it doesn't take away
    any role they already have. Idempotent: granting a role they already
    hold is a no-op (200), not an error. Open to a global admin or a
    study-scoped admin."""
    if db.get(Study, study_id) is None:
        raise HTTPException(status_code=404, detail="Study not found")
    _require_study_admin(db, study_id, user)
    membership = db.query(StudyMembership).filter_by(study_id=study_id, user_id=user_id, role=role).first()
    created = membership is None
    if created:
        membership = StudyMembership(study_id=study_id, user_id=user_id, role=role)
        db.add(membership)
        audit.record(db, user, "member.add", "study", study_id, {"user_id": user_id, "role": role.value})
        db.commit()
        autosave(db, study_id, user.subject)
    return {**_serialize_member(membership, _user_directory()), "study_id": study_id, "created": created}


@router.delete("/{study_id}/members/{user_id}", status_code=204)
def remove_study_member(
    study_id: str,
    user_id: str,
    role: StudyRole,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Revokes one specific role from a member -- their other roles in
    this study, if any, are untouched. A study-scoped admin may not
    remove their own `admin` role (that would orphan the study's
    management to global admins only, silently); a global admin can
    remove anyone's, and removing a non-admin role of your own is
    always fine."""
    _require_study_admin(db, study_id, user)
    membership = db.query(StudyMembership).filter_by(study_id=study_id, user_id=user_id, role=role).first()
    if membership is None:
        raise HTTPException(status_code=404, detail="Membership not found")
    if user_id == user.subject and role == StudyRole.ADMIN and not _is_global_admin(user):
        raise HTTPException(status_code=409, detail="You cannot remove your own admin membership")
    audit.record(db, user, "member.remove", "study", study_id, {"user_id": user_id, "role": membership.role.value})
    db.delete(membership)
    db.commit()
    autosave(db, study_id, user.subject)
