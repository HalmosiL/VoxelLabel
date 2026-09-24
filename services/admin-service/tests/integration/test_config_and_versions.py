"""Annotation types, de-identification profiles, and a study's version
history (save / inspect / restore / delete)."""
from .conftest import DM_SUBJECT, add_member, make_case, make_study


def test_annotation_types_are_global_and_admin_managed(client):
    schema = {"type": "object", "required": ["x"], "properties": {"x": {"type": "number"}}}
    r = client.post("/admin/annotation-types", params={"name": "bbox"}, json=schema)
    assert r.status_code == 200 and r.json()["name"] == "bbox"
    assert client.post("/admin/annotation-types", params={"name": "bbox"}, json=schema).status_code in (400, 409)
    listed = client.get("/admin/annotation-types").json()
    assert [t["name"] for t in listed] == ["bbox"] and listed[0]["json_schema"] == schema
    client.as_user(DM_SUBJECT)
    assert client.post("/admin/annotation-types", params={"name": "nope"}, json=schema).status_code == 403


def test_deidentification_profiles_and_rules(client):
    p = client.post("/admin/deidentification-profiles", params={"name": "Strict", "is_default": "true"}).json()
    r = client.post(f"/admin/deidentification-profiles/{p['id']}/rules", params={"dicom_tag": "(0010,0010)", "action": "hash"})
    assert r.status_code == 200 and r.json()["action"] == "hash"
    r2 = client.post(f"/admin/deidentification-profiles/{p['id']}/rules", params={"dicom_tag": "(0008,0080)", "action": "replace_fixed", "replacement_value": "HOSPITAL"})
    assert r2.json()["replacement_value"] == "HOSPITAL"
    profiles = client.get("/admin/deidentification-profiles").json()
    assert profiles[0]["is_default"] is True and [x["dicom_tag"] for x in profiles[0]["rules"]] == ["(0008,0080)", "(0010,0010)"]  # listed by tag


def test_versions_capture_changes_and_restore_them(client):
    sid = make_study(client, "Original")
    add_member(client, sid, DM_SUBJECT, "data_manager")
    make_case(client, sid, title="case one")
    saved = client.post(f"/admin/studies/{sid}/versions", json={"label": "before rename"})
    assert saved.status_code == 201
    vid = saved.json()["id"]

    client.patch(f"/admin/studies/{sid}", params={"name": "Renamed"})
    assert client.get(f"/admin/studies/{sid}").json()["name"] == "Renamed"

    detail = client.get(f"/admin/studies/{sid}/versions/{vid}").json()
    assert detail["label"] == "before rename" and detail["changes_if_restored"]

    restored = client.post(f"/admin/studies/{sid}/versions/{vid}/restore")
    assert restored.status_code == 200
    assert client.get(f"/admin/studies/{sid}").json()["name"] == "Original"
    # a safety version of the pre-restore state exists, and the restore is audited
    labels = [v.get("label") for v in client.get(f"/admin/studies/{sid}/versions").json()]
    assert any(label and "before restore" in label.lower() for label in labels) or len(labels) >= 3
    actions = [e["action"] for e in client.get("/admin/audit-log", params={"entity_id": sid}).json()["entries"]]
    assert "study.restore_version" in actions

    client.as_user(DM_SUBJECT)
    assert client.post(f"/admin/studies/{sid}/versions/{vid}/restore").status_code == 403  # study admin only
    assert client.delete(f"/admin/studies/{sid}/versions/{vid}").status_code == 403
    client.as_admin()
    assert client.delete(f"/admin/studies/{sid}/versions/{vid}").status_code == 204


def test_annotation_type_schema_can_be_widened_in_place(client):
    """A registered type grows a field (ct-annotator's segmentation_volume
    gained per-object attributes) by replacing its schema; the version
    bumps, the same schema again is a no-op, unknown names 404."""
    client.as_admin()
    v1 = {"type": "object", "properties": {"a": {"type": "string"}}, "additionalProperties": False}
    v2 = {"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "object"}}, "additionalProperties": False}
    assert client.post("/admin/annotation-types", params={"name": "growing"}, json=v1).status_code == 200
    r = client.put("/admin/annotation-types/growing/schema", json=v2)
    assert r.status_code == 200 and r.json()["changed"] is True and r.json()["schema_version"] == 2
    again = client.put("/admin/annotation-types/growing/schema", json=v2).json()
    assert again["changed"] is False and again["schema_version"] == 2
    listed = next(t for t in client.get("/admin/annotation-types").json() if t["name"] == "growing")
    assert listed["json_schema"] == v2
    assert client.put("/admin/annotation-types/nope/schema", json=v2).status_code == 404
    client.as_user("someone-else")
    assert client.put("/admin/annotation-types/growing/schema", json=v1).status_code == 403



def test_versions_recorded_at_the_same_moment_get_consecutive_numbers(client, db):
    """I-02: the next number was read without a lock, so two recordings at
    once got the same number (a 500 on the real schema's unique key)."""
    import threading

    from app.versioning import record_version
    from shared_models.database import SessionLocal
    from shared_models.models import StudyVersion

    sid = make_study(client, "Versioned")
    for _ in range(3):
        barrier = threading.Barrier(4)

        def record():
            session = SessionLocal()
            try:
                barrier.wait()
                record_version(session, sid, "someone", kind="manual")
            finally:
                session.close()

        threads = [threading.Thread(target=record) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    db.expire_all()
    numbers = sorted(v.number for v in db.query(StudyVersion).filter_by(study_id=sid).all())
    assert numbers == list(range(1, len(numbers) + 1)) and len(numbers) >= 12, numbers
