"""Unit tests for the notification service's pure logic (change
detection and email composition) -- no DB, no SMTP, same split as
test_workflow.py."""
import uuid

import pytest

from app.notifications.events import CardContext, Event, Snapshot, _guidance, compose, diff_snapshots
from shared_models.models import WorkflowCardType


def test_new_card_with_assignee_is_a_new_job() -> None:
    events = diff_snapshots(None, Snapshot("u1", "todo"))
    assert [e.kind for e in events] == ["job_assigned"]
    assert events[0].user_id == "u1"


def test_new_card_without_assignee_notifies_nobody() -> None:
    assert diff_snapshots(None, Snapshot(None, "todo")) == []


def test_reassignment_is_a_new_job_for_the_new_person_only() -> None:
    events = diff_snapshots(Snapshot("u1", "in_progress"), Snapshot("u2", "in_progress"))
    assert [(e.kind, e.user_id) for e in events] == [("job_assigned", "u2")]


def test_status_change_for_same_assignee() -> None:
    events = diff_snapshots(Snapshot("u1", "todo"), Snapshot("u1", "in_progress"))
    assert [e.kind for e in events] == ["job_status_changed"]
    assert events[0].details == {"from": "todo", "to": "in_progress"}


def test_nothing_changed_means_no_events() -> None:
    assert diff_snapshots(Snapshot("u1", "in_progress", {"c1": "annotated"}), Snapshot("u1", "in_progress", {"c1": "annotated"})) == []


def test_case_level_changes_alone_never_email() -> None:
    """Deliberate: a case sent back, approved or newly awaiting review
    is not a message -- only the job's own assignment/status is, to
    keep the inbox quiet while someone works through a queue."""
    previous = Snapshot("u1", "in_progress", {"c1": "annotated", "c2": "not_started"})
    current = Snapshot("u1", "in_progress", {"c1": "rejected", "c2": "awaiting_review"})
    assert diff_snapshots(previous, current) == []


def test_a_rejection_that_reopens_a_done_job_is_a_status_change() -> None:
    events = diff_snapshots(Snapshot("u1", "done", {"c1": "approved"}), Snapshot("u1", "in_progress", {"c1": "rejected"}))
    assert [e.kind for e in events] == ["job_status_changed"]
    assert events[0].details == {"from": "done", "to": "in_progress"}


class _FakeCard:
    def __init__(self, type_: WorkflowCardType, title: str) -> None:
        self.id = uuid.UUID("12345678-1234-5678-1234-567812345678")
        self.type = type_
        self.title = title


def _ctx(card, study, status="todo", annotated=1, total=3) -> CardContext:
    return CardContext(card=card, study_name=study, status=status, annotated=annotated, total=total)


def test_every_status_has_its_own_meaning_and_action() -> None:
    """Every (card type, status) combo the guidance table is asked about
    for real (todo/in_progress/done on both card types) must resolve to
    non-generic, distinct advice -- this is what keeps the email from
    reading like a form letter."""
    seen = set()
    for card_type in (WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW):
        for status in ("todo", "in_progress", "done"):
            meaning, action = _guidance(card_type, status)
            assert meaning and action
            seen.add((meaning, action))
    assert len(seen) == 6  # all six combinations give distinct advice


def test_compose_new_job_email_has_no_links_and_draws_the_card() -> None:
    card = _FakeCard(WorkflowCardType.ANNOTATION, "Nodule annotation")
    subject, text, html = compose(Event("job_assigned", "u1", {"status": "todo"}), _ctx(card, "LIDC"))
    assert subject == "New annotation job: Nodule annotation (LIDC)"
    assert "http" not in text and "href" not in html
    assert "Nodule annotation" in html and "LIDC" in html and "To do" in html
    assert "1 of 3 cases annotated" in html
    # Every email explains itself: what the status means and what to do.
    meaning, action = _guidance(WorkflowCardType.ANNOTATION, "todo")
    assert "What this means:" in text and meaning in text
    assert "What to do:" in text and action in text
    assert "What this means:" in html and "What to do:" in html


def test_compose_status_change_for_a_review_job() -> None:
    card = _FakeCard(WorkflowCardType.REVIEW, "Nodule review")
    subject, text, html = compose(Event("job_status_changed", "r1", {"from": "in_progress", "to": "done"}), _ctx(card, None, status="done", annotated=3, total=3))
    assert subject == "Job status: Nodule review is now Done"
    assert '"In progress" to "Done"' in text
    assert "Review job" in html and "3 of 3 cases decided" in html and "http" not in html
    meaning, action = _guidance(WorkflowCardType.REVIEW, "done")
    assert action in html  # meaning contains an apostrophe html.escape rewrites; action doesn't


def test_html_escapes_user_provided_titles() -> None:
    card = _FakeCard(WorkflowCardType.ANNOTATION, "<script>x</script>")
    _subject, _text, html = compose(Event("job_assigned", "u1", {"status": "todo"}), _ctx(card, "S & T"))
    assert "<script>" not in html and "&lt;script&gt;" in html and "S &amp; T" in html


def test_compose_rejects_unknown_event_kinds() -> None:
    card = _FakeCard(WorkflowCardType.ANNOTATION, "x")
    with pytest.raises(ValueError):
        compose(Event("case_changed", "u1", {}), _ctx(card, None))
