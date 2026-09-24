"""HTTP API for browsing cases, imaging studies/series/instances, and
clinical data items."""
import mimetypes

from botocore.exceptions import ClientError
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_auth.object_links import verify_object_link
from shared_models.database import get_db
from shared_models.models import Case, ClinicalDataItem, ImagingStudy, Instance, Patient, Series, case_tags
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.storage import LINK_SECRET, OBJECTS_PATH, object_link, read_object

router = APIRouter(prefix="/data", tags=["data"])


@router.get("/objects")
def get_object(key: str = Query(...), exp: int = Query(...), sig: str = Query(...)) -> StreamingResponse:
    """A stored object (thumbnail, document, DICOM file) behind a signed
    link from object_link -- the link's signature is the access check
    (whoever issued it checked the caller's role), so this takes no
    token and works as a plain <img src> or a new tab. Streamed from
    MinIO over the internal network: the browser never needs MinIO."""
    if not verify_object_link(OBJECTS_PATH, key, exp, sig, LINK_SECRET):
        raise HTTPException(status_code=403, detail="This link is invalid or has expired -- reload the page for a fresh one.")
    try:
        body, content_type, length = read_object(key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            raise HTTPException(status_code=404, detail="Object not found") from None
        raise
    if content_type == "application/octet-stream":
        content_type = mimetypes.guess_type(key)[0] or content_type
    filename = key.rsplit("/", 1)[-1]
    disposition = "attachment" if filename.endswith(".dcm") else "inline"
    headers = {"Content-Disposition": f'{disposition}; filename="{filename}"', "Cache-Control": "private, max-age=3600"}
    if length is not None:
        headers["Content-Length"] = str(length)
    return StreamingResponse(body.iter_chunks(64 * 1024), media_type=content_type, headers=headers)

_READ_ROLES = ["viewer", "annotator", "reviewer", "data_manager", "admin"]


def _case_or_404(db: Session, case_id: str) -> Case:
    case = db.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


def _require_global_admin(user: CurrentUser) -> None:
    """A patient's cases can span multiple studies; there is no single
    study to check a role against, so cross-study patient views
    require the global Keycloak `admin` role rather than
    `require_study_role`."""
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


def _thumbnail_url_for_series(series: Series) -> str | None:
    """The first instance in the series that has a thumbnail, as a signed link --
    used as the representative preview for a whole series (and, one level
    up, for the imaging study it belongs to)."""
    for instance in series.instances:
        if instance.thumbnail_key:
            return object_link(instance.thumbnail_key)
    return None


def _thumbnail_url_for_imaging_study(imaging_study: ImagingStudy) -> str | None:
    for series in imaging_study.series:
        url = _thumbnail_url_for_series(series)
        if url:
            return url
    return None


def _serialize_case(case: Case) -> dict:
    return {
        "id": str(case.id),
        "study_id": str(case.study_id),
        "patient_pseudonym_id": case.patient.pseudonym_id,
        "accession_number": case.accession_number,
        "date": case.date.isoformat() if case.date else None,
        "type": case.type,
        "title": case.title,
        "comment": case.comment,
        "tags": case_tags(case),
    }


@router.get("/studies/{study_id}/cases")
def list_cases(
    study_id: str,
    response: Response,
    q: str | None = Query(default=None, description="Case-insensitive substring of title, accession number or type"),
    limit: int | None = Query(default=None, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """Cases of a study, optionally searched (`q`) and paged (`limit`/
    `offset`). The response stays a plain list for existing callers;
    the unpaged total is in the `X-Total-Count` header so a paging UI
    can render "N of M" without a second request."""
    require_study_role(db, study_id, user, allowed_roles=_READ_ROLES)

    query = db.query(Case).filter_by(study_id=study_id)
    if q:
        pattern = f"%{q}%"
        query = query.filter(or_(Case.title.ilike(pattern), Case.accession_number.ilike(pattern), Case.type.ilike(pattern)))
    response.headers["X-Total-Count"] = str(query.count())
    query = query.order_by(Case.created_at.desc()).offset(offset)
    if limit is not None:
        query = query.limit(limit)
    return [_serialize_case(c) for c in query.all()]


@router.get("/cases/{case_id}")
def get_case(
    case_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    case = _case_or_404(db, case_id)
    require_study_role(db, str(case.study_id), user, allowed_roles=_READ_ROLES)
    return _serialize_case(case)


@router.get("/cases/{case_id}/imaging-studies")
def list_imaging_studies(
    case_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    case = _case_or_404(db, case_id)
    require_study_role(db, str(case.study_id), user, allowed_roles=_READ_ROLES)

    imaging_studies = db.query(ImagingStudy).filter_by(case_id=case_id).all()
    return [
        {
            "id": str(s.id),
            "study_instance_uid": s.study_instance_uid,
            "study_date": s.study_date.isoformat() if s.study_date else None,
            "modality": s.modality,
            "description": s.description,
            "thumbnail_url": _thumbnail_url_for_imaging_study(s),
        }
        for s in imaging_studies
    ]


@router.get("/cases/{case_id}/series")
def list_case_series(
    case_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """Every series across every imaging study in the case, flattened --
    the single-page case profile shows series directly, without a
    per-imaging-study drill-down step."""
    case = _case_or_404(db, case_id)
    require_study_role(db, str(case.study_id), user, allowed_roles=_READ_ROLES)

    result = []
    for imaging_study in case.imaging_studies:
        for series in imaging_study.series:
            result.append(
                {
                    "id": str(series.id),
                    "series_instance_uid": series.series_instance_uid,
                    "series_description": series.series_description,
                    "imaging_study_id": str(imaging_study.id),
                    "imaging_study_description": imaging_study.description,
                    "thumbnail_url": _thumbnail_url_for_series(series),
                    "instance_count": len(series.instances),
                }
            )
    return result


@router.get("/imaging-studies/{imaging_study_id}/series")
def list_series(
    imaging_study_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    imaging_study = db.get(ImagingStudy, imaging_study_id)
    require_study_role(db, str(imaging_study.case.study_id), user, allowed_roles=_READ_ROLES)

    return [
        {
            "id": str(s.id),
            "series_instance_uid": s.series_instance_uid,
            "series_description": s.series_description,
            "thumbnail_url": _thumbnail_url_for_series(s),
        }
        for s in imaging_study.series
    ]


@router.get("/series/{series_id}/instances")
def list_instances(
    series_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    series = db.get(Series, series_id)
    require_study_role(db, str(series.imaging_study.case.study_id), user, allowed_roles=_READ_ROLES)

    # series.instances (the bare relationship) has no defined order --
    # explicitly ordered here so the gallery always reads top-to-bottom/
    # left-to-right in real anatomical slice order, not upload/insertion
    # order (which quick-import in particular has no reason to match,
    # since it processes whatever order a folder picker/glob happens to
    # hand it). Nulls last: an instance with no InstanceNumber at all
    # (rare, but the column is nullable) still shows up, just at the end
    # rather than sorting arbitrarily among the real ones.
    instances = (
        db.query(Instance)
        .filter_by(series_id=series_id)
        .order_by(Instance.instance_number.asc().nulls_last())
        .all()
    )
    return [
        {
            "id": str(i.id),
            "sop_instance_uid": i.sop_instance_uid,
            "instance_number": i.instance_number,
            "thumbnail_url": object_link(i.thumbnail_key) if i.thumbnail_key else None,
        }
        for i in instances
    ]


@router.get("/instances/{instance_id}/pixel-data-url")
def get_pixel_data_url(
    instance_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """A signed link (see app/storage.object_link) to download the raw
    DICOM file through this service."""
    instance = db.get(Instance, instance_id)
    imaging_study = instance.series.imaging_study
    require_study_role(db, str(imaging_study.case.study_id), user, allowed_roles=_READ_ROLES)

    # storage_key alongside the browser-facing signed link: a *server*
    # (ct-annotator's backend building its MPR volume) that has its own
    # credentials for the same bucket reads the object over the internal
    # endpoint instead of going through the link.
    return {"url": object_link(instance.object_storage_key), "storage_key": instance.object_storage_key}


def _serialize_clinical_data_item(item: ClinicalDataItem) -> dict:
    return {
        "id": str(item.id),
        "date": item.date.isoformat() if item.date else None,
        "type": item.type,
        "title": item.title,
        "has_file": item.object_storage_key is not None,
        "tags": [t.label for t in item.tags],
        "consents": [{"consent_type": c.consent_type, "status": c.status.value} for c in item.consents],
    }


@router.get("/cases/{case_id}/clinical-data-items")
def list_clinical_data_items(
    case_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    case = _case_or_404(db, case_id)
    require_study_role(db, str(case.study_id), user, allowed_roles=_READ_ROLES)

    items = db.query(ClinicalDataItem).filter_by(case_id=case_id).all()
    return [_serialize_clinical_data_item(i) for i in items]


@router.get("/patients")
def list_patients(
    response: Response,
    q: str | None = Query(default=None, description="Case-insensitive substring of the pseudonym id"),
    limit: int | None = Query(default=None, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """Cross-study patient list -- see _require_global_admin for why this
    needs the global admin role instead of a study-scoped check."""
    _require_global_admin(user)

    query = db.query(Patient)
    if q:
        query = query.filter(Patient.pseudonym_id.ilike(f"%{q}%"))
    response.headers["X-Total-Count"] = str(query.count())
    query = query.order_by(Patient.pseudonym_id).offset(offset)
    if limit is not None:
        query = query.limit(limit)
    return [{"id": str(p.id), "pseudonym_id": p.pseudonym_id, "case_count": len(p.cases)} for p in query.all()]


@router.get("/patients/{patient_id}/cases")
def list_patient_cases(
    patient_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """A patient "profile" view: every case the patient has, across every
    study, each with its imaging studies (with preview thumbnails) and
    clinical data items -- enough to browse, edit, and delete a patient's
    data without navigating into each case individually."""
    _require_global_admin(user)

    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="Patient not found")

    result = []
    for case in patient.cases:
        result.append(
            {
                "id": str(case.id),
                "study_id": str(case.study_id),
                "study_name": case.study.name,
                "accession_number": case.accession_number,
                "title": case.title,
                "imaging_studies": [
                    {
                        "id": str(s.id),
                        "study_instance_uid": s.study_instance_uid,
                        "modality": s.modality,
                        "description": s.description,
                        "thumbnail_url": _thumbnail_url_for_imaging_study(s),
                    }
                    for s in case.imaging_studies
                ],
                "documents": [_serialize_clinical_data_item(i) for i in case.clinical_data_items],
                "tags": case_tags(case),
            }
        )
    return result


@router.get("/clinical-data-items/{item_id}/file-url")
def get_clinical_data_file_url(
    item_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    item = db.get(ClinicalDataItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Clinical data item not found")
    require_study_role(db, str(item.case.study_id), user, allowed_roles=_READ_ROLES)

    if item.object_storage_key is None:
        raise HTTPException(status_code=404, detail="This item has no attached file")
    # The storage key rides along for the same reason as get_pixel_data_url's:
    # a server-side caller (ct-annotator's inline document preview) reads the
    # object straight from the bucket instead of going through the link.
    return {"url": object_link(item.object_storage_key), "storage_key": item.object_storage_key}
