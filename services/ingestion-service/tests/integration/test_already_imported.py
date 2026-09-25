"""B-17 / B-21: a file that is already imported is reported as such, with
where it is -- not skipped in silence (quick import), and not described
as "already in this case" when it lives in another study (single
upload), whose instance id isn't handed out either."""
import uuid

import pydicom
from app import pipeline, quick_import
from shared_models.models import Case, Patient, Study


def _ds(sop):
    ds = pydicom.Dataset()
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.SOPInstanceUID = "1.2.77", "1.2.77.1", sop
    ds.PatientID, ds.Modality = "P-77", "CT"
    return ds


def _study(db):
    s = Study(name=f"s-{uuid.uuid4().hex[:6]}")
    db.add(s)
    db.commit()
    return str(s.id)


def test_quick_import_lists_files_already_imported_and_where(db, staged):
    first, second = _study(db), _study(db)
    staged["k1"] = _ds("1.2.77.1.1")
    assert quick_import.run_quick_import(first, ["k1"])["instances_ingested"] == 1
    again = quick_import.run_quick_import(first, ["k1"])
    assert again["already_imported"] == [{"file": "k1", "where": "this_study"}]
    elsewhere = quick_import.run_quick_import(second, ["k1"])
    assert elsewhere["already_imported"] == [{"file": "k1", "where": "another_study"}]


def test_a_single_upload_says_where_the_instance_already_is(db, staged):
    first, second = _study(db), _study(db)
    staged["k1"] = _ds("1.2.77.1.2")
    quick_import.run_quick_import(first, ["k1"])
    patient = Patient(pseudonym_id=uuid.uuid4().hex)
    db.add(patient)
    db.flush()
    other_case = Case(study_id=uuid.UUID(second), patient_id=patient.id)
    db.add(other_case)
    db.commit()
    result = pipeline._ingest_one_instance(db, other_case, _ds("1.2.77.1.2"))
    assert result["status"] == "duplicate" and result["where"] == "another_study" and "instance_id" not in result
