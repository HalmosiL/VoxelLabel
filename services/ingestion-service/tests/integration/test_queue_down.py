"""I-06: with the task queue (Redis) unreachable, an upload, quick import
or export answered a bare 500 and left its staged files (or the export's
request marker) behind; a status poll answered 500 too. Now it's a 503
that says to try again, and nothing is left behind."""

import uuid

import pytest
from app import queue
from app.api import routes
from kombu.exceptions import OperationalError
from redis.exceptions import ConnectionError as RedisConnectionError
from shared_models.models import Case, Patient, Study


@pytest.fixture(
    params=[
        OperationalError("Error 111 connecting to redis:6379. Connection refused."),
        # what Celery's Redis result backend really raises (seen live)
        RuntimeError("Retry limit exceeded while trying to reconnect to the Celery result store backend."),
    ]
)
def queue_down(monkeypatch, request):
    stored = {}
    monkeypatch.setattr(routes, "upload_staged_file", lambda key, data: stored.__setitem__(key, data))
    monkeypatch.setattr(routes, "upload_export_object", lambda key, data: stored.__setitem__(key, data))
    monkeypatch.setattr(queue, "delete_staged_file", lambda key: stored.pop(key, None))

    def refuse(*args, **kwargs):
        raise request.param

    for task in (routes.quick_import_batch, routes.ingest_dicom_file, routes.export_pytorch_dataset):
        monkeypatch.setattr(task, "apply_async", refuse)
    return stored


def _study_with_case(db):
    study = Study(name=f"qa-queue-{uuid.uuid4().hex[:6]}")
    patient = Patient(pseudonym_id=str(uuid.uuid4()))
    db.add_all([study, patient])
    db.flush()
    case = Case(study_id=study.id, patient_id=patient.id)
    db.add(case)
    db.commit()
    return str(study.id), str(case.id)


def test_a_quick_import_and_an_export_with_the_queue_down_are_a_503_and_leave_nothing(client, db, queue_down):
    study_id, case_id = _study_with_case(db)
    r = client.post(f"/ingestion/studies/{study_id}/quick-import", files=[("files", ("a.dcm", b"x")), ("files", ("b.dcm", b"y"))])
    assert r.status_code == 503 and "try again" in r.json()["detail"], r.text
    r = client.post("/ingestion/exports", json={"study_id": study_id, "case_ids": [case_id]})
    assert r.status_code == 503 and "try again" in r.json()["detail"], r.text
    assert queue_down == {}  # no staged file, no export marker left


def test_a_status_poll_with_the_queue_down_is_a_503(client, monkeypatch):
    class _Down:
        @property
        def state(self):
            raise RedisConnectionError("Error 111 connecting to redis:6379")

    monkeypatch.setattr(routes, "AsyncResult", lambda *a, **k: _Down())
    monkeypatch.setattr(routes, "download_object", lambda key: (_ for _ in ()).throw(KeyError(key)))  # no owner marker; the caller is an admin
    r = client.get(f"/ingestion/quick-imports/{uuid.uuid4()}")
    assert r.status_code == 503, r.text
    r = client.get(f"/ingestion/jobs/{uuid.uuid4()}")
    assert r.status_code == 503, r.text
