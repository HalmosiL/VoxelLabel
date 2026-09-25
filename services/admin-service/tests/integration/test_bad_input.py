"""Bad input gets a 4xx with a reason, never a 500 (J-01, J-13, J-14,
B-18): malformed ids, over-long or NUL-containing text, duplicates,
unparsable dates, blank names and padded patient identifiers."""
import uuid

import pytest

from .conftest import make_case, make_study

NIL = "00000000-0000-0000-0000-000000000000"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/admin/studies/not-a-uuid"),
        ("PATCH", "/admin/studies/not-a-uuid"),
        ("DELETE", "/admin/studies/not-a-uuid"),
        ("GET", "/admin/studies/not-a-uuid/members"),
        ("GET", "/admin/studies/not-a-uuid/versions"),
        ("PATCH", "/admin/cases/not-a-uuid"),
        ("DELETE", "/admin/cases/not-a-uuid"),
        ("GET", "/admin/studies/1' OR '1'='1"),
    ],
)
def test_a_malformed_id_is_a_422_not_a_500(client, method, path):
    r = client.request(method, path)
    assert r.status_code == 422, (path, r.status_code, r.text)
    assert "not a valid id" in r.json()["detail"]


def test_text_that_cant_be_stored_is_a_422(client):
    r = client.post("/admin/studies", params={"name": "x" * 10000})
    assert r.status_code == 422 and "too long" in r.json()["detail"]
    r = client.post("/admin/studies", params={"name": "a\x00b"})
    assert r.status_code == 422 and "NUL" in r.json()["detail"]


def test_a_duplicate_name_is_a_409(client):
    make_study(client, "Taken")
    r = client.post("/admin/studies", params={"name": "Taken"})
    assert r.status_code == 409 and "already exists" in r.json()["detail"]
    other = make_study(client, "Other")
    assert client.patch(f"/admin/studies/{other}", params={"name": "Taken"}).status_code == 409


def test_bad_dates_missing_studies_and_bad_patient_ids(client):
    sid = make_study(client)
    r = client.post(f"/admin/studies/{sid}/cases", params={"external_patient_id": "P-1", "case_date": "31/12/2020"})
    assert r.status_code == 422, r.text
    assert client.post(f"/admin/studies/{NIL}/cases", params={"external_patient_id": "P-2"}).status_code == 404
    assert client.post(f"/admin/studies/{sid}/cases", params={"patient_id": "not-a-uuid"}).status_code == 422
    case_id = make_case(client, sid, external="P-3")["id"]
    assert client.patch(f"/admin/cases/{case_id}", params={"case_date": "xx"}).status_code == 422
    assert client.patch(f"/admin/cases/{case_id}", params={"title": "a\x00b"}).status_code == 422


def test_blank_names_and_patient_ids_are_refused_and_ids_are_trimmed(client):
    assert client.post("/admin/studies", params={"name": ""}).status_code == 422
    assert client.post("/admin/studies", params={"name": "   "}).status_code == 422
    sid = make_study(client)
    assert client.post(f"/admin/studies/{sid}/cases", params={"external_patient_id": "   "}).status_code == 422
    assert client.post("/admin/patients", params={"external_patient_id": ""}).status_code == 422
    one = make_case(client, sid, external="QA-TRIM")["patient_id"]
    two = make_case(client, sid, external=" QA-TRIM ")["patient_id"]
    assert one == two  # one person, one pseudonym


def test_a_patient_without_cases_can_be_deleted_with_their_identity(client, db):
    """B-23: patients could be created but never deleted -- case-less
    patients and the hash of their real identifier stayed forever."""
    from shared_models.models import Patient, PatientIdentityMap

    lone = client.post("/admin/patients", params={"external_patient_id": "MRN-LONE"}).json()["id"]
    sid = make_study(client)
    busy = make_case(client, sid, external="MRN-BUSY")["patient_id"]
    r = client.delete(f"/admin/patients/{busy}")
    assert r.status_code == 409 and "1 case" in r.json()["detail"]
    assert client.delete(f"/admin/patients/{lone}").status_code == 204
    db.expire_all()
    assert db.get(Patient, uuid.UUID(lone)) is None
    assert db.query(PatientIdentityMap).filter_by(patient_id=uuid.UUID(lone)).count() == 0
    # the identifier is free again: registering it gives a new pseudonym, not the old one
    again = client.post("/admin/patients", params={"external_patient_id": "MRN-LONE"}).json()["id"]
    assert again != lone
