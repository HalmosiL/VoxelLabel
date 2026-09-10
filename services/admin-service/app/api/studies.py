"""HTTP API for managing studies and study memberships (per-study roles).

A `Study` here is the platform's top-level, admin-created RBAC container
(e.g. a research study or clinical protocol) -- not to be confused with an
`ImagingStudy`, the DICOM per-session imaging entity that hangs off a Case
(see `app/api/imaging.py`).
"""
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import Case, Study, StudyMembership, StudyRole

from app.keycloak_admin import list_realm_users
from app.storage import presigned_study_cover_image_url, upload_study_cover_image
from app.versioning import autosave

router = APIRouter(prefix="/admin/studies", tags=["admin:studies"])

_READ_ROLES = ["viewer", "annotator", "reviewer", "data_manager", "admin"]


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
    a second request."""
    if _is_global_admin(user):
        return "admin"
    membership = db.query(StudyMembership).filter_by(study_id=study_id, user_id=user.subject).first()
    return membership.role.value if membership else None


def _serialize_study(study: Study, my_role: str | None) -> dict:
    return {
        "id": str(study.id),
        "name": study.name,
        "description": study.description,
        "deidentification_profile_id": str(study.deidentification_profile_id) if study.deidentification_profile_id else None,
        "cover_image_url": presigned_study_cover_image_url(study.cover_image_key) if study.cover_image_key else None,
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
    role_by_study = {str(m.study_id): m.role.value for m in memberships}
    studies = db.query(Study).filter(Study.id.in_(list(role_by_study))).order_by(Study.name).all() if role_by_study else []
    return [_serialize_study(s, role_by_study[str(s.id)]) for s in studies]


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
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")
    _require_study_admin(db, study_id, user)

    if name is not None:
        study.name = name
    if description is not None:
        study.description = description
    db.commit()
    autosave(db, study.id, user.subject)
    return {"id": str(study.id), "name": study.name, "description": study.description}


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
    items, all with their object-storage cleanup) across every case in
    the study, then the study itself, as one transaction.

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
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")
    _require_study_admin(db, study_id, user)

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
    """Grant `user_id` (a Keycloak subject) a role scoped to this study.
    An upsert: re-adding an existing member changes their role (200)
    instead of tripping the primary key (which used to surface as a
    500). Open to a global admin or a study-scoped admin."""
    if db.get(Study, study_id) is None:
        raise HTTPException(status_code=404, detail="Study not found")
    _require_study_admin(db, study_id, user)
    membership = db.query(StudyMembership).filter_by(study_id=study_id, user_id=user_id).first()
    created = membership is None
    if created:
        membership = StudyMembership(study_id=study_id, user_id=user_id, role=role)
        db.add(membership)
    else:
        membership.role = role
    db.commit()
    autosave(db, study_id, user.subject)
    return {**_serialize_member(membership, _user_directory()), "study_id": study_id, "created": created}


@router.delete("/{study_id}/members/{user_id}", status_code=204)
def remove_study_member(
    study_id: str,
    user_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Revoke a member's study role. A study-scoped admin may not remove
    themselves (that would orphan the study's management to global
    admins only, silently) -- a global admin can remove anyone."""
    _require_study_admin(db, study_id, user)
    membership = db.query(StudyMembership).filter_by(study_id=study_id, user_id=user_id).first()
    if membership is None:
        raise HTTPException(status_code=404, detail="Membership not found")
    if user_id == user.subject and not _is_global_admin(user):
        raise HTTPException(status_code=409, detail="You cannot remove your own admin membership")
    db.delete(membership)
    db.commit()
    autosave(db, study_id, user.subject)
