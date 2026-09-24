"""B-05: the same SOP instance ingested twice at once is one instance and
one "duplicate" -- not a raw IntegrityError for the loser, after it had
already uploaded (and possibly overwritten) the pixel data and a thumbnail."""
import threading
import time
import uuid

import pydicom
from app import pipeline
from shared_models.database import SessionLocal
from shared_models.models import Case, Instance, Patient, Study


def test_two_workers_ingesting_one_instance(db, monkeypatch):
    study = Study(name="race-sop")
    patient = Patient(pseudonym_id=f"P-{uuid.uuid4().hex[:8]}")
    db.add_all([study, patient])
    db.flush()
    case = Case(study_id=study.id, patient_id=patient.id)
    db.add(case)
    db.commit()
    case_id = case.id

    uploads, thumbnails = [], []

    def slow_upload(key, ds):  # widens the window between the duplicate check and the insert
        uploads.append(key)
        time.sleep(0.3)

    monkeypatch.setattr(pipeline, "upload_pixel_data", slow_upload)
    monkeypatch.setattr(pipeline, "upload_thumbnail", lambda key, png: thumbnails.append(key))
    monkeypatch.setattr(pipeline, "generate_thumbnail", lambda ds: b"png")

    results, errors, barrier = [], [], threading.Barrier(2)

    def ingest():
        ds = pydicom.Dataset()
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.SOPInstanceUID, ds.Modality = "1.2.9", "1.2.9.1", "1.2.9.1.1", "CT"
        session = SessionLocal()
        try:
            barrier.wait()
            results.append(pipeline._ingest_one_instance(session, session.get(Case, case_id), ds)["status"])
            session.commit()
        except Exception as exc:  # noqa: BLE001 -- the test reports whatever escaped
            errors.append(repr(exc))
        finally:
            session.close()

    threads = [threading.Thread(target=ingest) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == [] and sorted(results) == ["completed", "duplicate"], (errors, results)
    assert len(uploads) == 1 and len(thumbnails) == 1
    db.expire_all()
    assert db.query(Instance).count() == 1
