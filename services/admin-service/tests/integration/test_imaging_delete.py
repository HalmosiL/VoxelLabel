"""B-11: deleting a series also deletes the annotations made on it and on
its instances, as deleting an imaging study or a case already does --
they were left behind, pointing at rows that no longer exist."""
import uuid

from shared_models.models import Annotation, Instance

from .conftest import ANNOTATOR_SUBJECT, make_annotation, make_case, make_series, make_study


def test_deleting_a_series_deletes_its_annotations(client, db, monkeypatch):
    sid = make_study(client)
    case_id = make_case(client, sid)["id"]
    series_id = make_series(db, case_id)
    instance = Instance(series_id=series_id, sop_instance_uid=f"1.4.{uuid.uuid4().int % 10**12}", object_storage_key="dicom/x.dcm")
    db.add(instance)
    db.commit()
    instance_id = instance.id
    make_annotation(db, sid, series_id, ANNOTATOR_SUBJECT, "draft")
    on_instance = make_annotation(db, sid, series_id, ANNOTATOR_SUBJECT, "draft")
    row = db.get(Annotation, on_instance)
    row.target_type, row.target_id = "instance", instance_id
    db.commit()

    import app.api.imaging as imaging

    monkeypatch.setattr(imaging, "delete_object", lambda key: None, raising=False)  # no bucket in tests
    assert client.delete(f"/admin/series/{series_id}").status_code == 200
    db.expire_all()
    assert db.query(Annotation).filter(Annotation.target_id.in_([series_id, instance_id])).count() == 0
