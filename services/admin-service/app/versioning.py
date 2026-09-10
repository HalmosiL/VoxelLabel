"""Study versioning: snapshots of a Study's configuration, recorded
automatically after every change and on demand, restorable later.

What a version holds (see `snapshot_study`): the study's own fields, its
memberships, the whole workflow board (every card with its config, run
output and materialization links; every edge) and each case's editable
metadata. What it never holds or touches: clinical payload data --
DICOM instances, documents, annotations. A restore re-shapes the study
*around* that data (cards, edges, members, case titles/dates/comments),
it never deletes a case or an image.

Automatic versions are coalesced: consecutive changes by the same person
within `AUTO_COALESCE_MINUTES` collapse into one version (the latest
state wins), so dragging a card around for a minute yields one version,
not sixty. An unchanged snapshot never creates a version at all.
"""
import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from shared_models.models import Case, Study, StudyMembership, StudyRole, StudyVersion, WorkflowCard, WorkflowCardType, WorkflowEdge

logger = logging.getLogger(__name__)

AUTO_COALESCE_MINUTES = 10
# How many versions a study keeps: older *auto* versions beyond this are
# pruned (manual and pre_restore ones are kept until deleted explicitly).
MAX_AUTO_VERSIONS = 200


def _iso(value) -> str | None:
    return value.isoformat() if value is not None else None


def _parse_dt(value: str | None):
    return datetime.fromisoformat(value) if value else None


def _parse_date(value: str | None):
    return datetime.fromisoformat(value).date() if value else None


def snapshot_study(db: Session, study: Study) -> dict:
    cards = db.query(WorkflowCard).filter_by(study_id=study.id).order_by(WorkflowCard.created_at).all()
    edges = db.query(WorkflowEdge).filter_by(study_id=study.id).order_by(WorkflowEdge.created_at).all()
    members = db.query(StudyMembership).filter_by(study_id=study.id).all()
    cases = db.query(Case).filter_by(study_id=study.id).order_by(Case.created_at).all()
    return {
        "format": 1,
        "study": {
            "name": study.name,
            "description": study.description,
            "deidentification_profile_id": _iso_uuid(study.deidentification_profile_id),
            "cover_image_key": study.cover_image_key,
        },
        "members": sorted(({"user_id": m.user_id, "role": m.role.value} for m in members), key=lambda m: m["user_id"]),
        "cards": [
            {
                "id": str(c.id),
                "type": c.type.value,
                "title": c.title,
                "position_x": c.position_x,
                "position_y": c.position_y,
                "width": c.width,
                "height": c.height,
                "config": c.config,
                "output_case_ids": c.output_case_ids,
                "last_run_at": _iso(c.last_run_at),
                "created_at": _iso(c.created_at),
                "materialized_source_card_id": _iso_uuid(c.materialized_source_card_id),
                "materialized_source_handle": c.materialized_source_handle,
            }
            for c in cards
        ],
        "edges": [
            {
                "id": str(e.id),
                "source_card_id": str(e.source_card_id),
                "source_handle": e.source_handle,
                "target_card_id": str(e.target_card_id),
                "target_handle": e.target_handle,
            }
            for e in edges
        ],
        "cases": [
            {
                "id": str(c.id),
                "title": c.title,
                "accession_number": c.accession_number,
                "type": c.type,
                "date": _iso(c.date),
                "comment": c.comment,
            }
            for c in cases
        ],
    }


def _iso_uuid(value) -> str | None:
    return str(value) if value is not None else None


def summarize(snapshot: dict) -> dict:
    return {
        "cards": len(snapshot.get("cards", [])),
        "edges": len(snapshot.get("edges", [])),
        "members": len(snapshot.get("members", [])),
        "cases": len(snapshot.get("cases", [])),
        "name": snapshot.get("study", {}).get("name"),
    }


def _latest(db: Session, study_id) -> StudyVersion | None:
    return db.query(StudyVersion).filter_by(study_id=study_id).order_by(StudyVersion.number.desc()).first()


def record_version(db: Session, study_id, user_subject: str, kind: str = "auto", label: str | None = None) -> StudyVersion | None:
    """Snapshot the study now. For `kind == "auto"`: no-op when nothing
    changed since the latest version, and coalesced into the latest
    version when that one is also automatic, by the same person, and
    recent (see module docstring). Manual/pre_restore versions are
    always a new numbered entry. Commits."""
    study = db.get(Study, study_id)
    if study is None:
        return None
    snapshot = snapshot_study(db, study)
    latest = _latest(db, study_id)
    now = datetime.now(timezone.utc)

    if kind == "auto" and latest is not None:
        if latest.snapshot == snapshot:
            return latest
        recent = latest.created_at is not None and now - latest.created_at < timedelta(minutes=AUTO_COALESCE_MINUTES)
        if latest.kind == "auto" and latest.created_by == user_subject and recent:
            latest.snapshot = snapshot
            latest.summary = summarize(snapshot)
            latest.created_at = now
            db.commit()
            return latest

    version = StudyVersion(
        study_id=study_id,
        number=(latest.number + 1) if latest else 1,
        kind=kind,
        label=label,
        created_by=user_subject,
        created_at=now,
        snapshot=snapshot,
        summary=summarize(snapshot),
    )
    db.add(version)
    _prune_auto_versions(db, study_id)
    db.commit()
    return version


def _prune_auto_versions(db: Session, study_id) -> None:
    autos = (
        db.query(StudyVersion)
        .filter_by(study_id=study_id, kind="auto")
        .order_by(StudyVersion.number.desc())
        .offset(MAX_AUTO_VERSIONS)
        .all()
    )
    for old in autos:
        db.delete(old)


def autosave(db: Session, study_id, user_subject: str) -> None:
    """Best-effort automatic version after a successful change -- a
    versioning hiccup must never turn a change that already committed
    into an error for the caller."""
    try:
        record_version(db, study_id, user_subject, kind="auto")
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("Automatic study version failed for study %s", study_id)


def diff_summary(snapshot: dict, current: dict) -> dict:
    """What restoring `snapshot` over `current` would change -- counts
    per area, so the UI can say "adds 2 cards, removes 1, changes 3
    members" before anyone confirms."""

    def by_id(items):
        return {i["id"]: i for i in items}

    def changed(a: dict, b: dict) -> dict:
        added = [k for k in a if k not in b]
        removed = [k for k in b if k not in a]
        modified = [k for k in a if k in b and a[k] != b[k]]
        return {"added": len(added), "removed": len(removed), "modified": len(modified)}

    snap_members = {m["user_id"]: m for m in snapshot.get("members", [])}
    cur_members = {m["user_id"]: m for m in current.get("members", [])}
    return {
        "study": snapshot.get("study") != current.get("study"),
        "members": changed(snap_members, cur_members),
        "cards": changed(by_id(snapshot.get("cards", [])), by_id(current.get("cards", []))),
        "edges": changed(by_id(snapshot.get("edges", [])), by_id(current.get("edges", []))),
        "cases": changed(by_id(snapshot.get("cases", [])), by_id(current.get("cases", []))),
    }


def restore_version(db: Session, study: Study, version: StudyVersion, user_subject: str) -> dict:
    """Puts the study back into `version`'s state (see module docstring
    for what that covers). A "pre_restore" safety version of the current
    state is recorded first, so a restore is itself undoable. Commits."""
    current = snapshot_study(db, study)
    safety = record_version(db, study.id, user_subject, kind="pre_restore", label=f"Before restoring v{version.number}")
    snapshot = version.snapshot
    diff = diff_summary(snapshot, current)

    # --- study fields ---
    fields = snapshot.get("study", {})
    study.name = fields.get("name", study.name)
    study.description = fields.get("description")
    study.deidentification_profile_id = (
        uuid.UUID(fields["deidentification_profile_id"]) if fields.get("deidentification_profile_id") else None
    )
    study.cover_image_key = fields.get("cover_image_key")

    # --- members ---
    wanted = {m["user_id"]: m["role"] for m in snapshot.get("members", [])}
    for membership in db.query(StudyMembership).filter_by(study_id=study.id).all():
        if membership.user_id not in wanted:
            db.delete(membership)
        else:
            membership.role = StudyRole(wanted.pop(membership.user_id))
    for user_id, role in wanted.items():
        db.add(StudyMembership(study_id=study.id, user_id=user_id, role=StudyRole(role)))
    db.flush()

    # --- board: cards (two passes: rows first, then the self-referencing
    # materialization link, which may point at a card created in this
    # same restore) ---
    existing = {str(c.id): c for c in db.query(WorkflowCard).filter_by(study_id=study.id).all()}
    wanted_cards = {c["id"]: c for c in snapshot.get("cards", [])}
    for card_id, card in existing.items():
        if card_id not in wanted_cards:
            db.delete(card)  # its edges cascade at the DB level
    db.flush()
    for card_id, data in wanted_cards.items():
        card = existing.get(card_id)
        if card is None:
            card = WorkflowCard(id=uuid.UUID(card_id), study_id=study.id, type=WorkflowCardType(data["type"]))
            db.add(card)
        card.type = WorkflowCardType(data["type"])
        card.title = data["title"]
        card.position_x = data["position_x"]
        card.position_y = data["position_y"]
        card.width = data.get("width")
        card.height = data.get("height")
        card.config = data.get("config") or {}
        card.output_case_ids = data.get("output_case_ids")
        card.last_run_at = _parse_dt(data.get("last_run_at"))
        card.materialized_source_card_id = None
        card.materialized_source_handle = data.get("materialized_source_handle")
    db.flush()
    for card_id, data in wanted_cards.items():
        source = data.get("materialized_source_card_id")
        if source and source in wanted_cards:
            db.get(WorkflowCard, uuid.UUID(card_id)).materialized_source_card_id = uuid.UUID(source)
    db.flush()

    # --- board: edges (replaced wholesale; only edges between cards that
    # exist after the card pass above) ---
    db.query(WorkflowEdge).filter_by(study_id=study.id).delete()
    for edge in snapshot.get("edges", []):
        if edge["source_card_id"] in wanted_cards and edge["target_card_id"] in wanted_cards:
            db.add(
                WorkflowEdge(
                    id=uuid.UUID(edge["id"]),
                    study_id=study.id,
                    source_card_id=uuid.UUID(edge["source_card_id"]),
                    source_handle=edge["source_handle"],
                    target_card_id=uuid.UUID(edge["target_card_id"]),
                    target_handle=edge["target_handle"],
                )
            )

    # --- case metadata (never creates or deletes a case) ---
    cases = {str(c.id): c for c in db.query(Case).filter_by(study_id=study.id).all()}
    for data in snapshot.get("cases", []):
        case = cases.get(data["id"])
        if case is None:
            continue
        case.title = data.get("title")
        case.accession_number = data.get("accession_number")
        case.type = data.get("type")
        case.date = _parse_date(data.get("date"))
        case.comment = data.get("comment")

    db.commit()
    restored = record_version(db, study.id, user_subject, kind="manual", label=f"Restored v{version.number}")
    return {
        "restored_version": version.number,
        "safety_version": safety.number if safety else None,
        "new_version": restored.number if restored else None,
        "changes": diff,
    }
