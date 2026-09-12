"""Cases and patients: pseudonymisation, role gates, cascades, audit."""
from .conftest import ANNOTATOR_SUBJECT, DM_SUBJECT, add_member, make_case, make_study


def test_same_external_id_resolves_to_the_same_patient(client):
    p1 = client.post("/admin/patients", params={"external_patient_id": "MRN-42"}).json()
    p2 = client.post("/admin/patients", params={"external_patient_id": "MRN-42"}).json()
    assert p1["id"] == p2["id"] and p1["pseudonym_id"] == p2["pseudonym_id"]
    assert "MRN-42" not in p1["pseudonym_id"]  # never stored / echoed in the clear
    sid = make_study(client)
    case = make_case(client, sid, external="MRN-42")
    assert case["patient_id"] == p1["id"]


def test_case_needs_exactly_one_patient_reference(client):
    sid = make_study(client)
    assert client.post(f"/admin/studies/{sid}/cases").status_code == 422
    p = client.post("/admin/patients", params={"external_patient_id": "MRN-7"}).json()
    r = client.post(f"/admin/studies/{sid}/cases", params={"patient_id": p["id"], "accession_number": "ACC-1"})
    assert r.status_code == 200 and r.json()["accession_number"] == "ACC-1"


def test_only_data_managers_and_admins_write_cases(client):
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    add_member(client, sid, DM_SUBJECT, "data_manager")
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.post(f"/admin/studies/{sid}/cases", params={"external_patient_id": "x"}).status_code == 403
    client.as_user(DM_SUBJECT)
    case = client.post(f"/admin/studies/{sid}/cases", params={"external_patient_id": "x", "title": "t"}).json()
    assert client.patch(f"/admin/cases/{case['id']}", params={"title": "renamed", "comment": "c"}).json()["title"] == "renamed"
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.patch(f"/admin/cases/{case['id']}", params={"title": "no"}).status_code == 403
    assert client.delete(f"/admin/cases/{case['id']}").status_code == 403
    client.as_user(DM_SUBJECT)
    assert client.delete(f"/admin/cases/{case['id']}").status_code == 204


def test_empty_string_clears_a_field(client):
    sid = make_study(client)
    case = make_case(client, sid, title="Has title", comment="note")
    r = client.patch(f"/admin/cases/{case['id']}", params={"title": ""}).json()
    assert r["title"] is None and r["comment"] == "note"


def test_case_lifecycle_is_audited(client):
    sid = make_study(client)
    case = make_case(client, sid, title="T")
    client.patch(f"/admin/cases/{case['id']}", params={"title": "T2"})
    client.delete(f"/admin/cases/{case['id']}")
    entries = client.get("/admin/audit-log", params={"entity_type": "case", "entity_id": case["id"]}).json()["entries"]
    assert [e["action"] for e in entries] == ["case.delete", "case.update", "case.create"]  # newest first
    assert entries[1]["diff"]["fields"] == ["title"]
    assert entries[0]["diff"]["study_id"] == sid


def test_new_case_flows_into_an_all_cases_dataset(client):
    sid = make_study(client)
    ds = client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": "dataset", "title": "All", "position_x": 0, "position_y": 0, "config": {"mode": "all_cases"}}).json()
    c1 = make_case(client, sid, external="a")
    c2 = make_case(client, sid, external="b")
    card = next(c for c in client.get(f"/admin/studies/{sid}/workflow").json()["cards"] if c["id"] == ds["id"])
    assert set(card["output_case_ids"]) == {c1["id"], c2["id"]}
