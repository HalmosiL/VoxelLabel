"""Unit tests for annotation payload validation against a JSON Schema."""
import pytest

from app.validation import PayloadValidationError, validate_payload

BBOX_SCHEMA = {
    "type": "object",
    "required": ["x", "y", "width", "height"],
    "properties": {
        "x": {"type": "number"},
        "y": {"type": "number"},
        "width": {"type": "number"},
        "height": {"type": "number"},
    },
}


def test_valid_payload_passes() -> None:
    validate_payload({"x": 1, "y": 2, "width": 10, "height": 20}, BBOX_SCHEMA)


def test_missing_required_field_raises() -> None:
    with pytest.raises(PayloadValidationError):
        validate_payload({"x": 1, "y": 2, "width": 10}, BBOX_SCHEMA)


def test_wrong_type_raises() -> None:
    with pytest.raises(PayloadValidationError):
        validate_payload({"x": "not-a-number", "y": 2, "width": 10, "height": 20}, BBOX_SCHEMA)
