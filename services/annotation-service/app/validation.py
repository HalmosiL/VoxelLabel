"""Validates an annotation payload against its registered type's JSON Schema.

Kept separate from app/api/routes.py so it can be unit-tested without a
DB session or FastAPI request context.
"""
import jsonschema


class PayloadValidationError(Exception):
    """Raised when a payload does not match its annotation type's JSON Schema."""


def validate_payload(payload: dict, json_schema: dict) -> None:
    try:
        jsonschema.validate(payload, json_schema)
    except jsonschema.ValidationError as exc:
        raise PayloadValidationError(exc.message) from exc
