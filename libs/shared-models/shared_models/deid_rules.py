"""What a de-identification rule means, in one place.

admin-service uses it to refuse a rule that could not be applied
(check_rule), and ingestion-service uses it to apply a profile
(apply_rules). The two can therefore never disagree about a rule.
Needs pydicom: install shared-models with its "dicom" extra.

A rule's tag is written as one of:
- "(gggg,eeee)" -- any tag by number, public or private;
- a DICOM keyword such as "PatientName" (stored as its number);
- "PRIVATE" -- every private tag (odd group), with "remove" only.

What each action may do:
- keep / remove: any tag, except that Study, Series and SOP Instance UID
  can't be removed (every image needs them -- hash them instead).
- replace_fixed: a public tag, with a value valid for its VR. Not a UID
  tag: one fixed UID shared by every exam merges different patients'
  images into one study.
- hash: a public tag whose VR can hold the result (UI, and the text
  VRs). The hash is an HMAC-SHA256 with the profile's own secret salt,
  so a short identifier such as an MRN can't be recovered by trying
  every candidate. A UID becomes a valid "2.25.<128-bit int>" UID; the
  same input gives the same output, so images of one exam stay together.

Rules apply to the dataset and to every dataset nested in its sequences.
A profile with a rule that can't be applied fails the import (RuleError)
rather than letting un-de-identified data in.
"""
import hashlib
import hmac
import re
from collections.abc import Iterable, Iterator

from pydicom import config as pydicom_config
from pydicom.datadict import dictionary_VR, keyword_for_tag, tag_for_keyword
from pydicom.dataset import Dataset
from pydicom.tag import BaseTag, Tag
from pydicom.valuerep import validate_value

from shared_models.models import DeidentificationAction as Action

PRIVATE = "PRIVATE"
# Study / Series / SOP Instance UID: required on every stored image.
REQUIRED_UIDS = frozenset({0x0020000D, 0x0020000E, 0x00080018})
# VRs a hash result is a valid value for (hex text, or a 2.25 UID).
HASHABLE_VRS = frozenset({"UI", "PN", "LO", "SH", "LT", "ST", "UT", "UC", "CS"})
_INT_VRS = frozenset({"US", "SS", "UL", "SL", "UV", "SV"})
_FLOAT_VRS = frozenset({"FL", "FD"})
_TAG_RE = re.compile(r"^\(?\s*([0-9A-Fa-f]{4})\s*,?\s*([0-9A-Fa-f]{4})\s*\)?$")


class RuleError(ValueError):
    """A rule that can't be applied; the message says why, for the admin."""


def normalise_tag(raw: str | None) -> str:
    """"(0010,0010)", "0010,0010", "00100010", "PatientName" -> "(0010,0010)";
    "private" -> "PRIVATE". RuleError for anything else."""
    text = (raw or "").strip()
    if text.upper() == PRIVATE:
        return PRIVATE
    match = _TAG_RE.match(text)
    if match:
        return f"({match.group(1).upper()},{match.group(2).upper()})"
    number = tag_for_keyword(text) if text.isidentifier() else None
    if number is not None:
        tag = Tag(number)
        return f"({tag.group:04X},{tag.element:04X})"
    raise RuleError(f"'{raw}' is not a DICOM tag -- write it as (gggg,eeee), e.g. (0010,0010), or as a keyword such as PatientName")


def _tag(normalised: str) -> BaseTag:
    group, element = normalised.strip("()").split(",")
    return Tag(int(group, 16), int(element, 16))


def _vr(tag: BaseTag) -> str | None:
    """The tag's VR from the DICOM dictionary (the first one where several
    are allowed), or None for a private or unknown tag."""
    if tag.is_private:
        return None
    try:
        return dictionary_VR(tag).split(" or ")[0]
    except KeyError:
        return None


def _name(tag: BaseTag, normalised: str) -> str:
    return keyword_for_tag(tag) or normalised


def _typed_value(vr: str, value: str, name: str):
    """`value` as the element should hold it, or RuleError if it isn't valid for `vr`."""
    try:
        if vr in _INT_VRS:
            return int(value)
        if vr in _FLOAT_VRS:
            return float(value)
        validate_value(vr, value, pydicom_config.RAISE)
        return value
    except (ValueError, TypeError) as exc:
        raise RuleError(f"'{value}' is not a valid {name} ({vr}): {str(exc).split(' Please see')[0]}") from exc


def check_rule(dicom_tag: str | None, action, replacement_value: str | None = None) -> str:
    """The rule's tag in stored form, or RuleError saying why the rule can't be applied."""
    normalised = normalise_tag(dicom_tag)
    action = Action(action)
    if normalised == PRIVATE:
        if action != Action.REMOVE:
            raise RuleError("PRIVATE (every private tag) can only be removed")
        return normalised
    if action == Action.KEEP:
        return normalised

    tag = _tag(normalised)
    name = _name(tag, normalised)
    vr = _vr(tag)
    if action == Action.REMOVE:
        if int(tag) in REQUIRED_UIDS:
            raise RuleError(f"{name} can't be removed -- every image needs it; use hash to give it a new UID")
        return normalised
    if tag.is_private:
        raise RuleError(f"{normalised} is a private tag -- its meaning is vendor-specific, so it can only be kept or removed")
    if vr is None:
        raise RuleError(f"{normalised} is not in the DICOM dictionary -- it can only be kept or removed")
    if action == Action.REPLACE_FIXED:
        if vr == "UI":
            raise RuleError(f"{name} can't be given one fixed value -- every exam would share it and different patients' images would merge; use hash")
        if replacement_value is None or replacement_value == "":
            raise RuleError("replace_fixed needs a replacement value")
        _typed_value(vr, replacement_value, name)
        return normalised
    # HASH
    if vr not in HASHABLE_VRS:
        raise RuleError(f"hash would write an invalid {name} ({vr}) -- use remove or replace_fixed")
    return normalised


def hashed_value(value: str, vr: str, salt: str) -> str:
    """Keyed, deterministic replacement for `value` that is valid for `vr`."""
    digest = hmac.new(salt.encode(), value.encode(), hashlib.sha256).digest()
    if vr == "UI":
        return "2.25." + str(int.from_bytes(digest[:16], "big"))
    text = digest.hex()[:16] if vr in ("SH", "CS") else digest.hex()[:32]
    return text.upper() if vr == "CS" else text


def _datasets(dataset: Dataset) -> Iterator[Dataset]:
    """`dataset` and every dataset nested in its sequences, depth first.
    Each one's elements are listed after the caller has processed it, so
    a sequence a rule removed is not walked."""
    yield dataset
    for element in list(dataset):
        if element.VR == "SQ" and element.value is not None:
            for item in element.value:
                yield from _datasets(item)


def apply_rules(dataset: Dataset, rules: Iterable, salt: str) -> Dataset:
    """Applies the rules (objects with dicom_tag / action /
    replacement_value) to `dataset` in place and returns it. RuleError if
    any rule can't be applied, or two rules name the same tag."""
    checked: dict[str, tuple[Action, str | None]] = {}
    for rule in rules:
        try:
            normalised = check_rule(rule.dicom_tag, rule.action, rule.replacement_value)
        except RuleError as exc:
            raise RuleError(f"De-identification rule '{rule.dicom_tag} {Action(rule.action).value}' can't be applied: {exc}") from exc
        if normalised in checked:
            raise RuleError(f"The de-identification profile has two rules for {normalised} -- delete one of them")
        checked[normalised] = (Action(rule.action), rule.replacement_value)

    for current in _datasets(dataset):
        for normalised, (action, value) in checked.items():
            _apply(current, normalised, action, value, salt)
    # The file header repeats the SOP Instance UID; keep it in step.
    file_meta = getattr(dataset, "file_meta", None)
    if file_meta is not None and "MediaStorageSOPInstanceUID" in file_meta and "SOPInstanceUID" in dataset:
        file_meta.MediaStorageSOPInstanceUID = dataset.SOPInstanceUID
    return dataset


def _apply(dataset: Dataset, normalised: str, action: Action, value: str | None, salt: str) -> None:
    if action == Action.KEEP:
        return
    if normalised == PRIVATE:
        dataset.remove_private_tags()
        return
    tag = _tag(normalised)
    if tag not in dataset:
        return
    if action == Action.REMOVE:
        del dataset[tag]
        return
    vr = _vr(tag)
    element = dataset[tag]
    if action == Action.REPLACE_FIXED:
        element.value = _typed_value(vr, value, _name(tag, normalised))
    elif action == Action.HASH and element.value not in (None, ""):
        element.value = hashed_value(str(element.value), vr, salt)
