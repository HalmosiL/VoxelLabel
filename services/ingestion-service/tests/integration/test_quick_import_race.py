"""Parallel quick imports: two of the same new DICOM study end up on ONE
case (B-03), and two studies of the same new patient both import, for one
patient (B-04). The barrier makes both workers reach case/patient creation
together -- the timing that produced a duplicate, empty case every time."""
import threading

import pydicom
from app import quick_import
from shared_models.models import Case, ImagingStudy, Instance, Study

STUDY_UID = "1.2.826.0.1.3680043.99.1"


def _dataset(sop_uid, study_uid=STUDY_UID):
    ds = pydicom.Dataset()
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.SOPInstanceUID = study_uid, study_uid + ".1", sop_uid
    ds.PatientID, ds.Modality, ds.StudyDescription = "RACE-P1", "CT", "Race study"
    return ds


def _race(study_id, monkeypatch):
    """Runs one quick import per staging key ("k1", "k2") in two threads
    that meet right before patient/case creation; returns their results."""
    # Both workers wait here -- after their "does a case exist?" lookup,
    # before creating one. A worker that has to wait for the other (the
    # fix) times out of the barrier and carries on alone.
    barrier = threading.Barrier(2)
    original = quick_import._get_or_create_patient

    def meet_then_create(db_, patient_id):
        try:
            barrier.wait(timeout=3)
        except threading.BrokenBarrierError:
            pass
        return original(db_, patient_id)

    monkeypatch.setattr(quick_import, "_get_or_create_patient", meet_then_create)
    results = {}
    threads = [threading.Thread(target=lambda k=k: results.setdefault(k, quick_import.run_quick_import(study_id, [k]))) for k in ("k1", "k2")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    return results


def _new_study(db):
    study = Study(name="race")
    db.add(study)
    db.commit()
    return str(study.id)  # read once: the threads must not share this session


def test_parallel_imports_of_one_new_dicom_study_make_one_case(db, staged, monkeypatch):
    study_id = _new_study(db)
    # the patient is known already: only the case can race here (B-04 below)
    quick_import._get_or_create_patient(db, "RACE-P1")
    db.commit()
    for key in ("k1", "k2"):
        staged[key] = _dataset(f"{STUDY_UID}.1.{key[-1]}")

    results = _race(study_id, monkeypatch)

    db.expire_all()
    cases = db.query(Case).filter_by(study_id=study_id).all()
    assert len(cases) == 1, [c.id for c in cases]
    assert db.query(ImagingStudy).count() == 1
    assert db.query(Instance).count() == 2
    # exactly one of the two imports reports the case as newly created
    created = [c["created"] for r in results.values() for c in r["cases"]]
    assert sorted(created) == [False, True], results
    assert not any(r["errors"] for r in results.values()), results


def test_parallel_imports_of_one_new_patient_both_land_on_that_patient(db, staged, monkeypatch):
    study_id = _new_study(db)
    staged["k1"] = _dataset("1.2.826.0.1.3680043.99.2.1.1", study_uid="1.2.826.0.1.3680043.99.2")
    staged["k2"] = _dataset("1.2.826.0.1.3680043.99.3.1.1", study_uid="1.2.826.0.1.3680043.99.3")

    results = _race(study_id, monkeypatch)

    assert not any(r["errors"] for r in results.values()), results
    db.expire_all()
    cases = db.query(Case).filter_by(study_id=study_id).all()
    assert len(cases) == 2
    assert len({c.patient_id for c in cases}) == 1
    assert db.query(Instance).count() == 2


def test_a_padded_patient_id_is_the_same_patient(db):
    """B-18/J-14: trimmed like admin-service's case creation, so " MRN-1 "
    and "MRN-1" are one person, with the same pseudonym on both paths."""
    first = quick_import._get_or_create_patient(db, "MRN-1")
    db.commit()
    assert quick_import._get_or_create_patient(db, " MRN-1 ").id == first.id
