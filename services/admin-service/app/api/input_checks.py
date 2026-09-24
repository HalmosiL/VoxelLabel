"""Small checks for request values that the database can't make itself,
shared by the admin endpoints (J-13, J-14, B-18). Values the database
does refuse -- malformed ids, over-long or NUL-containing text,
duplicates -- are mapped centrally by shared_auth.db_errors."""
import re
from datetime import date

from fastapi import HTTPException


def required_text(value: str | None, what: str) -> str:
    """`value` without surrounding whitespace; 422 if nothing is left."""
    text = (value or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail=f"{what} can't be empty")
    return text


def optional_date(value: str | None, what: str) -> date | None:
    """An ISO date (2025-01-31), or None for an empty value; 422 otherwise."""
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"{what} must be a date like 2025-01-31, not '{value[:40]}'") from None


def external_patient_id(value: str | None) -> str:
    """A real-world patient identifier as it is pseudonymised: trimmed, so
    a stray space doesn't split one person into two patients, and never
    empty (every blank identifier used to map to one shared patient).
    Case is kept -- whether "mrn-1" and "MRN-1" are one person is the
    issuing system's rule, not ours. ingestion-service's quick import
    trims the same way."""
    return required_text(value, "The patient identifier")


_UNSAFE_FILENAME_CHARS = re.compile(r"[^\w.\- ()]", re.UNICODE)


def safe_filename(raw: str | None) -> str:
    """The last path component of an uploaded file's name, with anything
    but letters, digits, space, "._-()" replaced by "_" and no leading dots:
    the client's filename becomes part of an object key and must not add
    path segments ("../") or control characters to it (J-05). Letters of
    any script are kept, so "lelet_ő.pdf" stays readable."""
    base = re.split(r"[\\/]", raw or "")[-1]
    name = _UNSAFE_FILENAME_CHARS.sub("_", base).lstrip(". ")[:120]
    return name or "file"
