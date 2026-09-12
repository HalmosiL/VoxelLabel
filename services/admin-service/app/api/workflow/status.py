"""How a case's annotation history maps onto a workflow card: which of
a card's cases count as annotated / reviewed / rejected, and per-case
status rows for the Study page and My Jobs. Read-only over the
`annotations` table (annotation-service owns writing it)."""
from sqlalchemy.orm import Session

from shared_models.models import (
    Annotation,
    AnnotationReview,
    AnnotationStatus,
    Case,
    ImagingStudy,
    Instance,
    Series,
    WorkflowCard,
    WorkflowCardType,
)


_ANNOTATED_STATUSES = [AnnotationStatus.SUBMITTED, AnnotationStatus.APPROVED]


def _latest_annotation_by_target(db: Session, target_type: str, target_ids: set, since=None) -> dict:
    """Maps each of `target_ids` (all the same `target_type`) to its most
    recently created Annotation's (id, status, created_at) -- "latest
    version" the same way annotation-service's list_annotations_for_target
    already defines it (oldest-first by created_at; the last one is
    current). Uses Postgres's DISTINCT ON to pick that one row per target
    directly in SQL, rather than fetching full history and reducing in
    Python.

    `since`, when given, ignores any Annotation older than that -- see
    `_latest_annotation_per_case`'s docstring for why a card needs this."""
    if not target_ids:
        return {}
    query = db.query(Annotation.target_id, Annotation.id, Annotation.status, Annotation.created_at).filter(
        Annotation.target_type == target_type, Annotation.target_id.in_(target_ids)
    )
    if since is not None:
        query = query.filter(Annotation.created_at >= since)
    rows = query.order_by(Annotation.target_id, Annotation.created_at.desc()).distinct(Annotation.target_id).all()
    return {row[0]: (row[1], row[2], row[3]) for row in rows}


def _latest_annotation_per_case(db: Session, case_ids: list[str], since=None) -> dict:
    """Maps each of `case_ids` to its single most-recent Annotation's
    (id, status, created_at) -- across *all* of that case's targets, not
    just whichever target type happens to match first. Shared by
    `_case_ids_with_status` (below) and the per-case review action (the
    Study page's Approve/Reject buttons need the actual annotation id to
    decide on, not just a yes/no membership check).

    No Annotation is ever created with `target_type == "study"` anywhere
    in this codebase -- ct-annotator's real save path (the segmentation
    volume workflow every other part of this session is built around)
    posts with `target_type == "series"`, and its older bbox/freehand
    path posts with `target_type == "instance"`; a `"study"`-only check
    here could never match either. A case can carry annotation history
    on both paths (e.g. old per-instance bbox rows from before its real
    work moved to the modern per-series segmentation-volume flow) --
    comparing each target's own latest independently and unioning the
    matches would let a stale rejection on a path the case has long
    since moved past permanently outvote a newer decision made on the
    other path. Instead this picks the single most recent Annotation
    across both target types per case.

    `since` (pass a card's own `created_at`) excludes any Annotation
    older than that -- otherwise a brand-new Annotation/Review card
    placed downstream of an existing one that already annotated/reviewed
    these same cases would read that older card's work as its own and
    show every case "done" before anyone has touched *this* job at all.
    A case's annotation history is otherwise tracked purely per case,
    with no notion of which workflow card a given Annotation belongs to
    -- this is what stands in for that, cheaply, without a schema
    change: nothing before this card existed counts toward it."""
    if not case_ids:
        return {}

    series_rows = (
        db.query(ImagingStudy.case_id, Series.id)
        .join(Series, Series.imaging_study_id == ImagingStudy.id)
        .filter(ImagingStudy.case_id.in_(case_ids))
        .all()
    )
    instance_rows = (
        db.query(ImagingStudy.case_id, Instance.id)
        .join(Series, Series.imaging_study_id == ImagingStudy.id)
        .join(Instance, Instance.series_id == Series.id)
        .filter(ImagingStudy.case_id.in_(case_ids))
        .all()
    )

    series_latest = _latest_annotation_by_target(db, "series", {row[1] for row in series_rows}, since=since)
    instance_latest = _latest_annotation_by_target(db, "instance", {row[1] for row in instance_rows}, since=since)

    # The single most recent Annotation for each case, across both of its
    # target types (compared by created_at, the 3rd element of each entry).
    latest_per_case: dict = {}
    for case_id, series_id in series_rows:
        entry = series_latest.get(series_id)
        if entry and (case_id not in latest_per_case or entry[2] > latest_per_case[case_id][2]):
            latest_per_case[case_id] = entry
    for case_id, instance_id in instance_rows:
        entry = instance_latest.get(instance_id)
        if entry and (case_id not in latest_per_case or entry[2] > latest_per_case[case_id][2]):
            latest_per_case[case_id] = entry

    return latest_per_case


def _case_ids_with_status(db: Session, case_ids: list[str], statuses: list[AnnotationStatus], since=None) -> list[str]:
    """The subset of `case_ids` whose single most-recent Annotation record
    (see `_latest_annotation_per_case`) is in one of `statuses`. Shared by
    `_annotated_case_ids` (combined submitted-or-approved / approved-or-
    rejected checks) and Review's per-decision materialization (approved-
    only, rejected-only), below."""
    latest_per_case = _latest_annotation_per_case(db, case_ids, since=since)
    return sorted(str(cid) for cid, (_id, status, _created_at) in latest_per_case.items() if status in statuses)


def _annotated_case_ids(db: Session, case_ids: list[str], review: bool, since=None) -> list[str]:
    """The subset of `case_ids` that actually have a real, *deliberately
    submitted* Annotation record (or, for Review, one already
    approved/rejected) -- a bare draft (created on every ct-annotator
    Save, as an in-progress version) doesn't count on its own; the
    annotator explicitly marking a case done (ct-annotator's "Mark as
    annotated", which saves with status=submitted) is what flips this,
    matching what a Reviewer would actually want to see queued.

    REJECTED is deliberately excluded from the Annotation side (though
    still counted on the Review side, here): a rejection means the case
    needs rework, so it should fall back out of the Annotation job's own
    "annotated" count rather than keep showing as done -- the annotator
    then sees it drop out of their completed total (and back out of a
    job that had reached "done"), no separate rework queue needed. If
    they resubmit, the new Annotation row's own SUBMITTED status counts
    it again, regardless of the older REJECTED row still sitting there."""
    statuses = [AnnotationStatus.APPROVED, AnnotationStatus.REJECTED] if review else _ANNOTATED_STATUSES
    return _case_ids_with_status(db, case_ids, statuses, since=since)


def _annotation_progress(db: Session, case_ids: list[str], review: bool, since=None) -> dict:
    if not case_ids:
        return {"annotated": 0, "total": 0}
    if review:
        # A case with nothing ever submitted has nothing for a reviewer
        # to decide on -- it shouldn't count toward this job's total any
        # more than it belongs in its case list (see
        # _cases_with_annotated_status, which excludes it the same way).
        latest_per_case = _latest_annotation_per_case(db, case_ids, since=since)
        annotated = sum(
            1 for entry in latest_per_case.values() if entry[1] in (AnnotationStatus.APPROVED, AnnotationStatus.REJECTED)
        )
        return {"annotated": annotated, "total": len(latest_per_case)}
    return {"annotated": len(_annotated_case_ids(db, case_ids, review, since=since)), "total": len(case_ids)}


def _case_status(entry, review: bool) -> str:
    """Classifies a case's single latest Annotation (see
    `_latest_annotation_per_case`, `None` if it has none at all) into one
    of three states worth showing distinctly, rather than collapsing
    "rejected -- needs rework" into the same "not annotated" bucket a
    case that was simply never touched would show:
    - "done": submitted-or-approved for an Annotation card; approved for
      a Review card.
    - "rejected": needs rework -- kept separate so it doesn't read as
      "nothing has happened here yet".
    - "pending": nothing submitted yet (Annotation), or awaiting a
      decision (Review, including a bare SUBMITTED with no decision)."""
    if entry is None:
        return "pending"
    status = entry[1]
    if status == AnnotationStatus.REJECTED:
        return "rejected"
    if review:
        return "done" if status == AnnotationStatus.APPROVED else "pending"
    return "done" if status in (AnnotationStatus.SUBMITTED, AnnotationStatus.APPROVED) else "pending"


def _job_status_from_entries(case_ids: list[str], latest_per_case: dict, review: bool) -> str:
    """The decision half of `compute_job_status`, split out so it's
    testable without a database -- takes already-fetched entries (see
    `_latest_annotation_per_case`) instead of fetching them itself.

    Annotation: "done" once every case's latest Annotation is
    submitted-or-approved; "todo" while every case is still completely
    untouched (no Annotation at all); anything in between -- a draft in
    progress, a case sent back REJECTED, or some cases done and others
    still untouched -- reads as "in_progress".

    Review: cases with nothing ever submitted aren't part of a Review
    card's real scope (see `_cases_with_annotated_status`'s own
    comment), so only cases carrying an Annotation at all are
    considered. "in_progress" the moment any of them is still SUBMITTED
    and awaiting a decision; "done" once every one of them has been
    APPROVED or REJECTED; "todo" if none has anything submitted yet."""
    if review:
        entries = list(latest_per_case.values())
        if not entries:
            return "todo"
        if any(entry[1] == AnnotationStatus.SUBMITTED for entry in entries):
            return "in_progress"
        if all(entry[1] in (AnnotationStatus.APPROVED, AnnotationStatus.REJECTED) for entry in entries):
            return "done"
        return "in_progress"

    if not case_ids:
        return "todo"
    # `latest_per_case` is keyed by the native UUID objects
    # `_latest_annotation_per_case`'s own query returns, but
    # `card.output_case_ids` (JSONB) comes back as plain strings -- str()
    # both sides so the lookup below actually matches instead of always
    # missing (which would silently make every case look untouched).
    latest_by_str_id = {str(cid): entry for cid, entry in latest_per_case.items()}
    entries = [latest_by_str_id.get(str(cid)) for cid in case_ids]
    if all(entry is not None and entry[1] in _ANNOTATED_STATUSES for entry in entries):
        return "done"
    if all(entry is None for entry in entries):
        return "todo"
    return "in_progress"


def compute_job_status(db: Session, card: WorkflowCard) -> str:
    """The Annotation/Review card's own todo/in_progress/done status,
    derived fresh from its cases' real annotation state every time this
    is called -- not a value someone has to remember to set (or a
    client-side nudge that only fires after a save/review action *in
    that specific job*, which can go stale the moment a change happens
    elsewhere, e.g. a reviewer rejecting a case while nobody has the
    Annotation job open). Always correct, because it's never stored.
    See `_job_status_from_entries` for the actual decision rules."""
    case_ids = card.output_case_ids or []
    if not case_ids:
        return "todo"
    review = card.type == WorkflowCardType.REVIEW
    latest_per_case = _latest_annotation_per_case(db, case_ids, since=None if review else card.created_at)
    return _job_status_from_entries(case_ids, latest_per_case, review)


def _cases_with_annotated_status(db: Session, card: WorkflowCard) -> list[dict]:
    """The Annotation/Review card's case scope, each case's title
    alongside its status (see `_case_status`) -- shared by list_my_jobs
    and get_workflow_card_cases (the Study page's per-row expand). Every
    case also carries `latest_annotation_id`: the id of its single most
    recent Annotation record regardless of status, or null if it has
    none -- backs the Study page's "Delete annotation" action. For a
    Review card, each case additionally carries `pending_annotation_id`:
    the same id but only while that record is still SUBMITTED (awaiting
    a decision) -- null otherwise. Backs the Approve/Reject buttons,
    which need the actual annotation id to decide on, not just its
    status."""
    case_ids = card.output_case_ids or []
    if not case_ids:
        return []
    cases = db.query(Case).filter(Case.id.in_(case_ids)).all()
    review = card.type == WorkflowCardType.REVIEW
    # A Review card's whole job is to consume an upstream Annotation
    # card's already-submitted work -- which by definition predates this
    # Review card's own creation -- so the "since" cutoff (see
    # `_latest_annotation_per_case`'s docstring) must not apply here, or
    # every case a Review card is wired to right after Annotation
    # finished would show as never annotated. It stays for Annotation,
    # where it protects against a *different* new card of the same type
    # falsely taking credit for unrelated old work on a shared case pool.
    latest_per_case = _latest_annotation_per_case(db, case_ids, since=None if review else card.created_at)
    # The reviewer's comment on each latest version's decision, if any --
    # shown to the annotator on My Jobs / the job page so a rejected case
    # says *why* without opening the viewer. One query for all cases;
    # the newest review row per annotation wins.
    latest_ids = [entry[0] for entry in latest_per_case.values()]
    comments: dict = {}
    if latest_ids:
        review_rows = (
            db.query(AnnotationReview.annotation_id, AnnotationReview.comment)
            .filter(AnnotationReview.annotation_id.in_(latest_ids), AnnotationReview.comment.isnot(None))
            .order_by(AnnotationReview.created_at)
            .all()
        )
        for annotation_id, comment in review_rows:
            comments[annotation_id] = comment

    result = []
    for c in cases:
        entry = latest_per_case.get(c.id)
        # A Review card's own list is scoped to cases actually awaiting
        # (or already given) a decision -- one that's never had anything
        # submitted is stale scope left over from before its last
        # annotation was deleted, or from a Review wired straight to a
        # Dataset instead of through Annotation's materialized
        # "(annotated)" child. Either way there's nothing here for a
        # reviewer to act on, so it drops out immediately (a live filter,
        # not something waiting on a Run) rather than sitting there
        # mislabeled "Not annotated" as if it just hadn't been reached
        # yet. It still shows correctly wherever its Annotation job's own
        # list is drawn from -- this only narrows the Review side.
        if review and entry is None:
            continue
        case = {
            "id": str(c.id),
            "title": c.title,
            "status": _case_status(entry, review),
            "latest_annotation_id": str(entry[0]) if entry else None,
            "latest_review_comment": comments.get(entry[0]) if entry else None,
        }
        if review:
            case["pending_annotation_id"] = str(entry[0]) if entry and entry[1] == AnnotationStatus.SUBMITTED else None
        result.append(case)
    return result


def job_case_states(db: Session, card: WorkflowCard) -> dict[str, str]:
    """Every case in the card's scope with a finer state than
    `_case_status`'s three buckets -- what the notification service
    watches for changes worth an email (see app/notifications/events.py):

    Annotation card: "not_started" (no Annotation at all), "in_progress"
    (a draft), "annotated" (submitted, awaiting review), "approved",
    "rejected" (sent back).
    Review card: only cases with something submitted at all (the card's
    real scope, see `_cases_with_annotated_status`): "awaiting_review",
    "approved", "rejected" -- and "in_progress" for the rare draft."""
    case_ids = card.output_case_ids or []
    if not case_ids:
        return {}
    review = card.type == WorkflowCardType.REVIEW
    latest_per_case = _latest_annotation_per_case(db, case_ids, since=None if review else card.created_at)
    latest_by_str_id = {str(cid): entry for cid, entry in latest_per_case.items()}
    states: dict[str, str] = {}
    for cid in case_ids:
        entry = latest_by_str_id.get(str(cid))
        if entry is None:
            if not review:
                states[str(cid)] = "not_started"
            continue
        status = entry[1]
        if status == AnnotationStatus.DRAFT:
            states[str(cid)] = "in_progress"
        elif status == AnnotationStatus.SUBMITTED:
            states[str(cid)] = "awaiting_review" if review else "annotated"
        elif status == AnnotationStatus.APPROVED:
            states[str(cid)] = "approved"
        else:
            states[str(cid)] = "rejected"
    return states

