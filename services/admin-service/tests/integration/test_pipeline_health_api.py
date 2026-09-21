"""Pipeline health through the real API: Running an Annotation/Review
card records CaseStageEvent rows, a full annotate-then-review cycle
shows up correctly in the summary's legs, a case left untouched shows
up as a bottleneck once its wait crosses the fallback threshold, and
every read is admin-only."""
from datetime import datetime, timedelta, timezone

from shared_models.models import Annotation, CaseStageEvent

from .conftest import ANNOTATOR_SUBJECT, DM_SUBJECT, REVIEWER_SUBJECT, add_member, make_annotation, make_case, make_review, make_series, make_study


def _card(client, sid, type_, title, config=None, x=0):
    r = client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": type_, "title": title, "position_x": x, "position_y": 0, "config": config or {}})
    assert r.status_code == 201, r.text
    return r.json()


def _edge(client, sid, src, dst):
    assert client.post(f"/admin/studies/{sid}/workflow/edges", json={"source_card_id": src, "target_card_id": dst}).status_code == 201


def _pipeline(client, db, n_cases=1):
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    add_member(client, sid, REVIEWER_SUBJECT, "reviewer")
    add_member(client, sid, DM_SUBJECT, "data_manager")
    cases = [make_case(client, sid, external=f"p{i}") for i in range(n_cases)]
    series = [make_series(db, c["id"]) for c in cases]
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    ann = _card(client, sid, "annotation", "Annotate", {"assigned_user_id": ANNOTATOR_SUBJECT})
    rev = _card(client, sid, "review", "Review", {"assigned_user_id": REVIEWER_SUBJECT}, x=300)
    _edge(client, sid, ds["id"], ann["id"])
    _edge(client, sid, ann["id"], rev["id"])
    assert client.post(f"/admin/workflow-cards/{ann['id']}/run").status_code == 200
    assert client.post(f"/admin/workflow-cards/{rev['id']}/run").status_code == 200
    return sid, cases, series, ann, rev


def test_running_a_job_card_records_queue_start_once_per_case(client, db):
    sid, cases, _, ann, rev = _pipeline(client, db, n_cases=2)
    rows = db.query(CaseStageEvent).filter(CaseStageEvent.card_id == ann["id"]).all()
    assert {str(r.case_id) for r in rows} == {c["id"] for c in cases}
    first_seen = rows[0].occurred_at

    # Re-running (e.g. re-adding the same cases) never creates a second
    # row or moves the timestamp -- first entry wins.
    assert client.post(f"/admin/workflow-cards/{ann['id']}/run").status_code == 200
    rows_again = db.query(CaseStageEvent).filter(CaseStageEvent.card_id == ann["id"]).all()
    assert len(rows_again) == 2 and rows_again[0].occurred_at == first_seen

    # Review's own queue-start also got recorded from the ripple.
    assert db.query(CaseStageEvent).filter(CaseStageEvent.card_id == rev["id"]).count() == 2


def test_reads_are_admin_only(client, db):
    _pipeline(client, db)
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.get("/admin/pipeline-health/summary").status_code == 403
    assert client.get("/admin/pipeline-health/learning-curve").status_code == 403


def test_a_completed_cycle_reports_real_queue_and_work_durations(client, db):
    sid, cases, series, ann, rev = _pipeline(client, db)
    series_id = series[0]

    # Backdate the queue-start 5h into the past, then place the draft
    # and submission 2h and then 1h after it -- everything still safely
    # in the past relative to when the summary endpoint computes "now",
    # so the window filter (default last 30 days) actually includes it.
    # Two real Annotation rows, so first_touch and submitted-at are
    # genuinely different events, same as ct-annotator's own
    # Save-then-Mark-as-Annotated flow.
    queue_start = db.query(CaseStageEvent).filter_by(card_id=ann["id"]).one().occurred_at - timedelta(hours=5)
    db.query(CaseStageEvent).filter_by(card_id=ann["id"]).update({"occurred_at": queue_start})
    db.commit()
    draft_id = make_annotation(db, sid, series_id, ANNOTATOR_SUBJECT, "draft")
    submitted_id = make_annotation(db, sid, series_id, ANNOTATOR_SUBJECT, "submitted")
    # Both calls above start with their own db.rollback() (see
    # make_annotation's own docstring) -- do the timestamp backdating
    # only now, after both rows exist, or an update sitting uncommitted
    # between the two calls would be silently discarded by the second
    # rollback.
    db.query(Annotation).filter_by(id=draft_id).update({"created_at": queue_start + timedelta(hours=2)})
    db.query(Annotation).filter_by(id=submitted_id).update({"created_at": queue_start + timedelta(hours=3)})
    db.commit()
    # Ripple Review's own Run so it picks up the fresh submission.
    assert client.post(f"/admin/workflow-cards/{rev['id']}/run").status_code == 200

    client.as_admin()
    summary = client.get("/admin/pipeline-health/summary", params={"card_id": ann["id"]}).json()
    assert summary["legs"]["annotation"]["queue"]["count"] == 1
    assert summary["legs"]["annotation"]["queue"]["median_ms"] == 2 * 3_600_000
    assert summary["legs"]["annotation"]["work"]["median_ms"] == 1 * 3_600_000


def test_bottlenecks_flag_a_stalled_case_once_it_crosses_the_fallback_threshold(client, db):
    sid, cases, series, ann, rev = _pipeline(client, db)
    event = db.query(CaseStageEvent).filter_by(card_id=ann["id"]).one()
    # Backdate it 10 days -- past the flat 7-day fallback (no completed
    # history yet for this brand-new card, so the median path can't apply).
    event.occurred_at = datetime.now(timezone.utc) - timedelta(days=10)
    db.commit()

    client.as_admin()
    summary = client.get("/admin/pipeline-health/summary", params={"card_id": ann["id"]}).json()
    row = next(r for r in summary["bottlenecks"] if r["case_id"] == cases[0]["id"])
    assert row["kind"] == "queue" and row["flagged"] is True and row["baseline_ms"] is None
    assert row["assignee"] == "dr-test"

    load = next(r for r in summary["assignee_load"] if r["assignee_id"] == ANNOTATOR_SUBJECT)
    assert load["open_count"] == 1 and load["assignee"] == "dr-test"


def test_learning_curve_uses_the_persons_own_first_annotation_as_tenure_start(client, db):
    sid, cases, series, ann, rev = _pipeline(client, db)
    annotation_id = make_annotation(db, sid, series[0], ANNOTATOR_SUBJECT, "submitted")
    # ct-annotator's real review flow always saves the reviewer's own
    # draft (handleSubmitReview) before posting the decision -- that's
    # what makes the review leg's own "first touch" -- so a review
    # without it isn't a real cycle.
    make_annotation(db, sid, series[0], REVIEWER_SUBJECT, "draft")
    make_review(db, annotation_id, REVIEWER_SUBJECT, "approve")
    assert client.post(f"/admin/workflow-cards/{rev['id']}/run").status_code == 200

    client.as_admin()
    rows = client.get("/admin/pipeline-health/learning-curve").json()
    annot_rows = [r for r in rows if r["actor_id"] == ANNOTATOR_SUBJECT and r["card_type"] == "annotation"]
    assert annot_rows and annot_rows[0]["week"] == 0 and annot_rows[0]["username"] == "dr-test"
    review_rows = [r for r in rows if r["actor_id"] == REVIEWER_SUBJECT and r["card_type"] == "review"]
    assert review_rows and review_rows[0]["username"] == "dr-review"
