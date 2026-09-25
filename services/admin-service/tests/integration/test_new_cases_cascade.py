"""B-22: a case that appears without admin-service's create_case -- a
quick import writes Case rows straight to the database -- still flows
into the board: the next pass of the new-cases poller pushes it through
every "all cases" Dataset and what is wired downstream, as create_case
does for a case made by hand."""
import uuid

from shared_models.models import Case, Patient

from .conftest import ANNOTATOR_SUBJECT, add_member, make_case, make_study
from .test_workflow_jobs import _card, _edge


def _imported_case(db, study_id):
    """A case the way ingestion-service's quick import creates one."""
    db.rollback()  # a fresh transaction, so created_at is really "now" (see make_annotation)
    patient = Patient(pseudonym_id=str(uuid.uuid4()))
    db.add(patient)
    db.flush()
    case = Case(study_id=uuid.UUID(study_id), patient_id=patient.id, title="Imported case")
    db.add(case)
    db.commit()
    return str(case.id)


def _job_case_ids(client, card_id):
    return {c["id"] for c in client.get(f"/admin/workflow-cards/{card_id}/cases").json()}


def _board(client):
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    first = make_case(client, sid, external="p0")["id"]
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    ann = _card(client, sid, "annotation", "Annotate", {"assigned_user_id": ANNOTATOR_SUBJECT, "labels": ["Nodule"]}, x=300)
    _edge(client, sid, ds["id"], ann["id"])
    assert client.post(f"/admin/workflow-cards/{ann['id']}/run").status_code == 200
    return sid, first, ann


def test_an_imported_case_reaches_the_annotation_job(client, db):
    from app.workflow_new_cases import cascade_new_cases

    sid, first, ann = _board(client)
    imported = _imported_case(db, sid)
    assert _job_case_ids(client, ann["id"]) == {first}  # nothing ran it yet

    assert cascade_new_cases(db) == [uuid.UUID(sid)]
    assert _job_case_ids(client, ann["id"]) == {first, imported}
    # nothing new since: the next pass leaves the board alone
    assert cascade_new_cases(db) == []


def test_a_board_nobody_has_run_yet_is_not_started_by_an_import(client, db):
    from app.workflow_new_cases import cascade_new_cases

    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    ann = _card(client, sid, "annotation", "Annotate", {"assigned_user_id": ANNOTATOR_SUBJECT, "labels": ["Nodule"]}, x=300)
    _edge(client, sid, ds["id"], ann["id"])
    _imported_case(db, sid)

    assert cascade_new_cases(db) == []
    assert _job_case_ids(client, ann["id"]) == set()


def test_a_dataset_without_a_mode_passes_new_cases_on_too(client, db):
    """C-18: a Dataset created with no "mode" (through the API or a tool)
    counts every case, like "all cases", but a new case never reached what
    was wired after it -- neither from create_case nor from the poller."""
    from app.workflow_new_cases import cascade_new_cases

    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    first = make_case(client, sid, external="p0")["id"]
    ds = _card(client, sid, "dataset", "No mode", {})
    ann = _card(client, sid, "annotation", "Annotate", {"assigned_user_id": ANNOTATOR_SUBJECT, "labels": ["Nodule"]}, x=300)
    _edge(client, sid, ds["id"], ann["id"])
    assert client.post(f"/admin/workflow-cards/{ann['id']}/run").status_code == 200

    made = make_case(client, sid, external="p1")["id"]  # through create_case
    assert _job_case_ids(client, ann["id"]) == {first, made}
    imported = _imported_case(db, sid)  # written straight to the database
    assert cascade_new_cases(db) == [uuid.UUID(sid)]
    assert _job_case_ids(client, ann["id"]) == {first, made, imported}
