"""De-identification in a real quick import (B-08, B-09, B-10): rules are
applied before the case is chosen, so cases group by the de-identified
UIDs and are titled from de-identified tags; nested sequences and private
tags are covered; hashing is keyed and yields valid values; a rule that
can't be applied fails the file before anything is created."""
from app import quick_import
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.sequence import Sequence
from shared_models.models import Case, DeidentificationAction, DeidentificationProfile, DeidentificationRule, ImagingStudy, Instance, Study


def _dataset(patient, study_uid, n):
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPInstanceUID = f"{study_uid}.1.{n}"
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.SOPInstanceUID = study_uid, f"{study_uid}.1", f"{study_uid}.1.{n}"
    ds.PatientID, ds.PatientName, ds.Modality = patient, f"{patient}^Real", "CT"
    ds.StudyDescription, ds.StudyDate = f"Scan of {patient}", "20250102"
    ds.RequestAttributesSequence = Sequence([Dataset()])
    ds.RequestAttributesSequence[0].PatientName = "Nested^Name"
    ds.add_new(0x00090010, "LO", "ACME")
    ds.add_new(0x00091010, "LO", "PRIVATE-JOHN-DOE")
    return ds


def _study_with_profile(db, rules):
    profile = DeidentificationProfile(name=f"p-{len(rules)}-{id(rules)}", created_by="t")
    db.add(profile)
    db.flush()
    for tag, action, value in rules:
        db.add(DeidentificationRule(profile_id=profile.id, dicom_tag=tag, action=DeidentificationAction(action), replacement_value=value))
    study = Study(name=f"s-{profile.name}", deidentification_profile_id=profile.id)
    db.add(study)
    db.commit()
    return str(study.id)


def _import(staged, study_id, datasets):
    keys = []
    for n, ds in enumerate(datasets):
        staged[f"k{n}"] = ds
        keys.append(f"k{n}")
    return quick_import.run_quick_import(study_id, keys)


def test_a_hashed_study_uid_still_makes_one_case_per_exam(db, staged):
    """B-08: 5 files of one exam made 5 cases (4 empty) when the StudyInstanceUID was hashed."""
    study_id = _study_with_profile(db, [("(0020,000D)", "hash", None)])
    result = _import(staged, study_id, [_dataset("P1", "1.2.3.4", n) for n in range(5)])
    assert result["errors"] == []
    assert db.query(Case).filter_by(study_id=study_id).count() == 1
    assert db.query(Instance).count() == 5
    (uid,) = {ds.StudyInstanceUID for ds in staged.uploaded}
    assert uid.startswith("2.25.") and uid != "1.2.3.4"
    assert db.query(ImagingStudy).one().study_instance_uid == uid


def test_two_patients_exams_stay_apart_with_hashed_uids(db, staged):
    study_id = _study_with_profile(db, [("StudyInstanceUID", "hash", None), ("SeriesInstanceUID", "hash", None), ("SOPInstanceUID", "hash", None)])
    result = _import(staged, study_id, [_dataset("P3", "1.2.3.3", 1), _dataset("P4", "1.2.3.4", 1)])
    assert result["errors"] == []
    cases = db.query(Case).filter_by(study_id=study_id).all()
    assert len(cases) == 2 and len({c.patient_id for c in cases}) == 2
    for ds in staged.uploaded:  # the file header follows the hashed SOP Instance UID
        assert ds.file_meta.MediaStorageSOPInstanceUID == ds.SOPInstanceUID


def test_nested_private_and_case_fields_are_de_identified(db, staged):
    """B-09: nested PatientName, private tags and the case's title/date escaped the rules."""
    study_id = _study_with_profile(db, [
        ("PatientName", "replace_fixed", "ANON"),
        ("PRIVATE", "remove", None),
        ("(0008,1030)", "remove", None),
        ("(0008,0020)", "replace_fixed", "19000101"),
    ])
    result = _import(staged, study_id, [_dataset("P1", "1.2.3.9", 1)])
    assert result["errors"] == []
    (stored,) = staged.uploaded
    assert stored.PatientName == "ANON"
    assert stored.RequestAttributesSequence[0].PatientName == "ANON"
    assert not any(el.tag.is_private for el in stored.iterall())
    assert "StudyDescription" not in stored
    case = db.query(Case).filter_by(study_id=study_id).one()
    assert "P1" not in (case.title or "")
    assert str(case.date) == "1900-01-01"


def test_hash_is_keyed_by_the_profiles_secret(db, staged):
    a = _study_with_profile(db, [("PatientName", "hash", None)])
    b = _study_with_profile(db, [("(0010,0010)", "hash", None)])
    _import(staged, a, [_dataset("P1", "1.2.5.1", 1)])
    _import(staged, b, [_dataset("P1", "1.2.5.2", 1)])
    first, second = (str(ds.PatientName) for ds in staged.uploaded)
    assert first != second  # same name, different profile salt
    assert len(first) == 32 and first != "P1^Real"


def test_a_rule_that_cant_be_applied_fails_the_file_and_creates_nothing(db, staged):
    """B-08/B-10: a fixed StudyInstanceUID merged patients; a typo in a tag failed every file after
    leaving an empty case behind."""
    for rules in ([("(0020,000D)", "replace_fixed", "1.2.3")], [("(zzzz,0010)", "remove", None)], [("(0008,0020)", "hash", None)]):
        study_id = _study_with_profile(db, rules)
        result = _import(staged, study_id, [_dataset("P1", "1.2.6.1", 1)])
        assert len(result["errors"]) == 1 and "can't be applied" in result["errors"][0]["error"], result
        assert db.query(Case).filter_by(study_id=study_id).count() == 0
