"""J-05: a document upload is checked before anything is written to the
bucket. A bad date answered 500 after the file was already stored (an
orphan object no row points at), and a "../" filename reached the
object key -- stopped only because MinIO refused it."""
import pytest
from app.api import clinical_data

from .conftest import make_case, make_study


@pytest.fixture
def bucket(monkeypatch):
    stored, deleted = {}, []
    monkeypatch.setattr(clinical_data, "upload_clinical_data_file", lambda key, data: stored.__setitem__(key, data))
    monkeypatch.setattr(clinical_data, "delete_object", lambda key: deleted.append(key))
    return stored, deleted


def _upload(client, case_id, filename="a.txt", **params):
    return client.post(
        f"/admin/cases/{case_id}/clinical-data-items",
        params={"type": "report", "title": "Report", **params},
        files={"file": (filename, b"hello", "text/plain")},
    )


def test_a_bad_value_stores_nothing(client, bucket):
    stored, _ = bucket
    case_id = make_case(client, make_study(client))["id"]
    assert _upload(client, case_id, item_date="not-a-date").status_code == 422
    assert _upload(client, case_id, title="   ").status_code == 422
    assert stored == {}


def test_the_filename_cannot_steer_the_object_key(client, bucket):
    stored, _ = bucket
    case_id = make_case(client, make_study(client))["id"]
    assert _upload(client, case_id, filename="../../../qa-trav.pdf").status_code == 200
    assert _upload(client, case_id, filename="lelet:ő?.txt").status_code == 200
    keys = sorted(stored)
    assert all(k.startswith(f"clinical-data/{case_id}/") and ".." not in k and k.count("/") == 2 for k in keys), keys
    assert any(k.endswith("-qa-trav.pdf") for k in keys) and any(k.endswith("-lelet_ő_.txt") for k in keys), keys


def test_a_bad_date_on_edit_is_a_422(client, bucket):
    case_id = make_case(client, make_study(client))["id"]
    item_id = _upload(client, case_id).json()["id"]
    assert client.patch(f"/admin/clinical-data-items/{item_id}", params={"item_date": "31/12/2020"}).status_code == 422
