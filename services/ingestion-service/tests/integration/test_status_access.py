"""B-19: the status of an upload, a quick import or an export -- case ids,
titles, file names -- was readable by any logged-in account that had the
id. Now only by those who may import into that study."""
import uuid

import pytest
from app.api import routes
from app.main import app
from shared_auth import CurrentUser, get_current_user
from shared_models.models import Case, Patient, Study

OUTSIDER = CurrentUser(subject="00000000-0000-4000-8000-0000000000b2", email=None, realm_roles=[])


@pytest.fixture
def bucket(monkeypatch):
    stored = {}

    def download(key):
        if key not in stored:
            raise KeyError(key)
        return stored[key]

    for name in ("upload_staged_file", "upload_export_object"):
        monkeypatch.setattr(routes, name, lambda key, data: stored.__setitem__(key, data))
    monkeypatch.setattr(routes, "download_object", download)
    monkeypatch.setattr(routes, "object_exists", lambda key: key in stored)
    for task in (routes.quick_import_batch, routes.ingest_dicom_file, routes.export_pytorch_dataset):
        monkeypatch.setattr(task, "apply_async", lambda *a, **k: None)

    class _Pending:
        state, result, info = "PENDING", None, None

    monkeypatch.setattr(routes, "AsyncResult", lambda *a, **k: _Pending())
    return stored


def test_only_those_who_may_import_into_the_study_read_its_statuses(client, db, bucket):
    study = Study(name=f"qa-status-{uuid.uuid4().hex[:6]}")
    patient = Patient(pseudonym_id=str(uuid.uuid4()))
    db.add_all([study, patient])
    db.flush()
    case = Case(study_id=study.id, patient_id=patient.id)
    db.add(case)
    db.commit()

    import_id = client.post(f"/ingestion/studies/{study.id}/quick-import", files=[("files", ("a.dcm", b"x"))]).json()["import_id"]
    export_id = client.post("/ingestion/exports", json={"study_id": str(study.id), "case_ids": [str(case.id)]}).json()["export_id"]
    polls = [f"/ingestion/quick-imports/{import_id}", f"/ingestion/exports/{export_id}"]
    for url in polls:
        assert client.get(url).status_code == 200, url  # the admin who started it

    app.dependency_overrides[get_current_user] = lambda: OUTSIDER
    for url in polls:
        assert client.get(url).status_code == 403, url
    # an id nobody started is unknown, not "pending"
    assert client.get(f"/ingestion/quick-imports/{uuid.uuid4()}").status_code == 404
