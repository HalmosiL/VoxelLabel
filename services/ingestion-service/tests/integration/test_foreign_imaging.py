"""B-02: a file whose DICOM study/series already belongs to another case
(in any study) is refused before anything is stored -- never attached to
that other case."""
import uuid

import pydicom
import pytest
from app import pipeline
from shared_models.models import Case, ImagingStudy, Instance, Patient, Series, Study


def _dataset(study_uid, series_uid, sop_uid=None):
    ds = pydicom.Dataset()
    ds.StudyInstanceUID, ds.SeriesInstanceUID = study_uid, series_uid
    ds.SOPInstanceUID = sop_uid or f"1.9.{uuid.uuid4().int % 10**12}"
    ds.Modality = "CT"
    return ds


def _case(db, study_name):
    study = Study(name=study_name)
    patient = Patient(pseudonym_id=f"P-{uuid.uuid4().hex[:8]}")
    db.add_all([study, patient])
    db.flush()
    case = Case(study_id=study.id, patient_id=patient.id)
    db.add(case)
    db.flush()
    return case


@pytest.fixture(autouse=True)
def _no_storage(monkeypatch):
    stored = []
    monkeypatch.setattr(pipeline, "upload_pixel_data", lambda key, ds: stored.append(key))
    monkeypatch.setattr(pipeline, "upload_thumbnail", lambda key, png: None)
    monkeypatch.setattr(pipeline, "generate_thumbnail", lambda ds: b"png")
    return stored


def test_a_dicom_study_in_another_study_is_refused_and_nothing_is_stored(db, _no_storage):
    case_y = _case(db, "Y")
    case_x = _case(db, "X")
    first = _dataset("1.2.100", "1.3.100")
    assert pipeline._ingest_one_instance(db, case_y, first)["status"] == "completed"
    db.commit()
    stored_before = len(_no_storage)

    later = _dataset("1.2.100", "1.3.200")  # same exam, a new series, uploaded into X
    with pytest.raises(pipeline.ForeignImagingError, match="different study"):
        pipeline._ingest_one_instance(db, case_x, later)
    db.rollback()
    assert len(_no_storage) == stored_before
    # nothing landed in Y either
    assert db.query(Series).filter_by(series_instance_uid="1.3.200").first() is None
    assert db.query(Instance).count() == 1
    # the quick-import check refuses it before a case is chosen
    assert "different study" in pipeline.foreign_imaging_owner(db, later, study_id=str(case_x.study_id))
    assert pipeline.foreign_imaging_owner(db, later, study_id=str(case_y.study_id)) is None


def test_another_case_of_the_same_study_is_refused_too(db):
    case_a = _case(db, "S")
    case_b = Case(study_id=case_a.study_id, patient_id=case_a.patient_id)
    db.add(case_b)
    db.flush()
    pipeline._ingest_one_instance(db, case_a, _dataset("1.2.300", "1.3.300"))
    db.commit()
    with pytest.raises(pipeline.ForeignImagingError, match="another case"):
        pipeline._ingest_one_instance(db, case_b, _dataset("1.2.300", "1.3.301"))


def test_a_series_uid_reused_under_another_dicom_study_is_refused(db):
    case = _case(db, "T")
    pipeline._ingest_one_instance(db, case, _dataset("1.2.400", "1.3.400"))
    db.commit()
    with pytest.raises(pipeline.ForeignImagingError, match="different DICOM study"):
        pipeline._ingest_one_instance(db, case, _dataset("1.2.401", "1.3.400"))


def test_more_files_of_the_same_exam_into_the_same_case_still_work(db):
    case = _case(db, "U")
    pipeline._ingest_one_instance(db, case, _dataset("1.2.500", "1.3.500"))
    db.commit()
    assert pipeline._ingest_one_instance(db, case, _dataset("1.2.500", "1.3.500"))["status"] == "completed"
    assert pipeline._ingest_one_instance(db, case, _dataset("1.2.500", "1.3.501"))["status"] == "completed"
    db.commit()
    assert db.query(ImagingStudy).count() == 1 and db.query(Series).count() == 2 and db.query(Instance).count() == 3
