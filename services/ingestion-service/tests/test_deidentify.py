"""Unit tests for what a de-identification rule means
(shared_models.deid_rules) -- DB-free. Imports through the pipeline are
exercised in tests/integration/test_deidentify_rules.py."""
import pytest
from pydicom.dataset import Dataset
from shared_models.deid_rules import RuleError, apply_rules, check_rule, hashed_value, normalise_tag


@pytest.mark.parametrize("raw", ["(0010,0010)", "(0010, 0010)", "0010,0010", "00100010", "PatientName", "(0010,0010) "])
def test_every_way_of_writing_a_tag_normalises_to_its_number(raw) -> None:
    assert normalise_tag(raw) == "(0010,0010)"


def test_private_means_every_private_tag() -> None:
    assert normalise_tag("private") == "PRIVATE"


@pytest.mark.parametrize("raw", ["", "(zzzz,0010)", "(0010,0010)(0010,0020)x", "PatientNme", None])
def test_anything_else_is_refused(raw) -> None:
    with pytest.raises(RuleError, match="not a DICOM tag"):
        normalise_tag(raw)


@pytest.mark.parametrize(
    ("tag", "action", "value", "why"),
    [
        ("(0020,000D)", "remove", None, "can't be removed"),
        ("(0008,0018)", "remove", None, "can't be removed"),
        ("(0020,000D)", "replace_fixed", "1.2.3", "merge"),
        ("(0010,0010)", "replace_fixed", None, "needs a replacement value"),
        ("(0020,0013)", "replace_fixed", "abc", "not a valid InstanceNumber"),
        ("(0008,0020)", "replace_fixed", "2025-01-02", "not a valid StudyDate"),
        ("(0008,0020)", "hash", None, "hash would write an invalid StudyDate"),
        ("(0009,1010)", "hash", None, "private tag"),
        ("PRIVATE", "hash", None, "can only be removed"),
    ],
)
def test_rules_that_cant_be_applied_say_why(tag, action, value, why) -> None:
    with pytest.raises(RuleError, match=why):
        check_rule(tag, action, value)


@pytest.mark.parametrize(
    ("tag", "action", "value"),
    [
        ("PatientName", "hash", None),
        ("(0020,000D)", "hash", None),
        ("(0009,1010)", "remove", None),
        ("PRIVATE", "remove", None),
        ("(0008,0020)", "replace_fixed", "19000101"),
        ("(0028,0010)", "replace_fixed", "512"),  # Rows, US
        ("(0020,000D)", "keep", None),
    ],
)
def test_sensible_rules_pass(tag, action, value) -> None:
    check_rule(tag, action, value)


def test_hash_is_keyed_deterministic_and_valid_for_the_vr() -> None:
    uid = hashed_value("1.2.3", "UI", "salt")
    assert uid == hashed_value("1.2.3", "UI", "salt")
    assert uid != hashed_value("1.2.3", "UI", "other salt")
    assert uid.startswith("2.25.") and len(uid) <= 64 and uid[5:].isdigit()
    assert len(hashed_value("MRN-1", "SH", "salt")) == 16
    assert hashed_value("x", "CS", "salt").isupper()


class _Rule:
    def __init__(self, dicom_tag, action, replacement_value=None):
        self.dicom_tag, self.action, self.replacement_value = dicom_tag, action, replacement_value


def test_two_rules_for_one_tag_are_refused() -> None:
    ds = Dataset()
    ds.PatientName = "A^B"
    with pytest.raises(RuleError, match="two rules"):
        apply_rules(ds, [_Rule("(0010,0010)", "keep"), _Rule("PatientName", "remove")], "salt")
