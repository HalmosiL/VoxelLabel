"""One source of truth for per-person counts (UX-ux-admin-27: a reviewer
counted 2 on Analytics › People, 0 on Usage › People, 1 in the report).
For the same study and window, a person's hand-ins and decisions are the
same number on the study's analytics, the Usage page and its report."""
import uuid
from datetime import datetime, timezone

from shared_models.models import UsageEvent

from .conftest import ANNOTATOR_SUBJECT, REVIEWER_SUBJECT, make_annotation, make_review
from .test_pipeline_health_api import _pipeline


def test_the_same_person_counts_the_same_everywhere(client, db):
    sid, cases, series, ann, rev = _pipeline(client, db, n_cases=2)
    for s in series:
        submitted = make_annotation(db, sid, s, ANNOTATOR_SUBJECT, "submitted")
        make_annotation(db, sid, s, REVIEWER_SUBJECT, "draft")
        make_review(db, submitted, REVIEWER_SUBJECT, "reject")
    now = datetime.now(timezone.utc)
    for who in (ANNOTATOR_SUBJECT, REVIEWER_SUBJECT):  # both used the viewer on the study's pages
        db.add(UsageEvent(id=uuid.uuid4(), user_id=who, session_id=f"s-{who}", app="viewer", event_type="page_view", route="/viewer/:id", detail={"study_id": sid}, occurred_at=now))
    db.commit()
    client.as_admin()

    people = {p["user_id"]: p for p in client.get(f"/admin/studies/{sid}/analytics").json()["people"]}
    usage = {u["user_id"]: u for u in client.get("/admin/usage/summary", params={"days": 7, "study_id": sid}).json()["users"]}
    assert (people[ANNOTATOR_SUBJECT]["submissions"], usage[ANNOTATOR_SUBJECT]["annotated"]) == (2, 2)
    assert (people[REVIEWER_SUBJECT]["reviews"], usage[REVIEWER_SUBJECT]["reviewed"]) == (2, 2)
    report = client.get("/admin/usage/report.md", params={"days": 7, "study_id": sid}).text
    assert "| Submissions | Reviews |" in report
    assert "| Dr-Review User |" in report and "| 0 | 2 | 0 |" in report
