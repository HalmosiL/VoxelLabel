"""B-01: the profile a study's imports go through -- its own, else the
platform default -- is really applied to the stored dataset."""
import pydicom
from app.deidentify import apply_deidentification_profile, profile_for_study
from shared_models.models import DeidentificationAction, DeidentificationProfile, DeidentificationRule, Study


def _dataset():
    ds = pydicom.Dataset()
    ds.PatientName = "Small^Patient"
    ds.PatientID = "MRN-42"
    return ds


def _profile(db, name, is_default=False, **rules):
    p = DeidentificationProfile(name=name, is_default=is_default, created_by="admin")
    db.add(p)
    db.flush()
    for tag, action in rules.items():
        db.add(DeidentificationRule(profile_id=p.id, dicom_tag=tag.replace("_", ","), action=action))
    db.flush()
    return p


def test_the_default_profile_applies_to_a_study_without_one(db):
    study = Study(name="No profile")
    db.add(study)
    _profile(db, "Default", is_default=True, **{"(0010_0010)": DeidentificationAction.REMOVE})
    db.commit()
    assert profile_for_study(db, str(study.id)).name == "Default"
    ds = apply_deidentification_profile(_dataset(), str(study.id))
    assert "PatientName" not in ds and ds.PatientID == "MRN-42"


def test_the_studys_own_profile_wins_over_the_default(db):
    own = _profile(db, "Own", **{"(0010_0020)": DeidentificationAction.REMOVE})
    _profile(db, "Default", is_default=True, **{"(0010_0010)": DeidentificationAction.REMOVE})
    study = Study(name="With profile", deidentification_profile_id=own.id)
    db.add(study)
    db.commit()
    ds = apply_deidentification_profile(_dataset(), str(study.id))
    assert "PatientID" not in ds and str(ds.PatientName) == "Small^Patient"


def test_no_profile_anywhere_leaves_the_dataset_as_it_is(db):
    study = Study(name="Bare")
    db.add(study)
    db.commit()
    assert profile_for_study(db, str(study.id)) is None
    assert str(apply_deidentification_profile(_dataset(), str(study.id)).PatientName) == "Small^Patient"
