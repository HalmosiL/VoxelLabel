"""Unit tests for DICOM tag resolution in the de-identification engine.

Covers only the pure, DB-free helper -- apply_deidentification_profile
itself needs a DB session and is exercised via integration tests instead.
"""
from app.deidentify import _tag_to_keyword


def test_resolves_known_tag_to_keyword() -> None:
    assert _tag_to_keyword("(0010,0010)") == "PatientName"


def test_resolves_patient_id_tag() -> None:
    assert _tag_to_keyword("(0010,0020)") == "PatientID"


def test_unknown_tag_returns_none() -> None:
    assert _tag_to_keyword("(9999,9999)") is None
