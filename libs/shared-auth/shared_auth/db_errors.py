"""Database errors caused by the request's own values answer 4xx, not 500.

Postgres refuses a malformed UUID, text longer than its column, a NUL
byte, an impossible date, or a second row with a unique name. Before
this, every endpoint that passed such a value on answered 500 and logged
a full traceback (J-01, J-13). install_db_error_handlers(app) maps them
once for a whole service:

- DataError (the value can't be stored as given) -> 422, saying which
  kind of value was wrong.
- IntegrityError: unique -> 409 "already exists", foreign key -> 409,
  missing required value / failed check -> 422.

The request's session is rolled back by the get_db dependency closing
it. Each mapped error is logged as one warning line, without traceback.

It also answers request validation errors (FastAPI's 422) without
echoing the offending input back: a NaN in the input made the 422 itself
fail to serialise (C-07), and the input may be a password.
"""
import logging
import re

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DataError, IntegrityError

log = logging.getLogger(__name__)

_TOO_LONG = re.compile(r"character varying\((\d+)\)")
_BAD_TEXT = re.compile(r'invalid input syntax for type (\w+): "([^"]{0,80})')


def describe(exc: Exception) -> tuple[int, str]:
    """(status code, message for the user) for a DataError/IntegrityError."""
    orig = getattr(exc, "orig", None)
    state = getattr(orig, "sqlstate", None)
    text = str(orig if orig is not None else exc)

    if isinstance(exc, IntegrityError):
        if state == "23505":
            return 409, "That already exists -- a name or identifier like this must be unique."
        if state == "23503":
            return 409, "This refers to something that doesn't exist, or is still used by something else."
        if state == "23502":
            return 422, "A required value is missing."
        if state == "23514":
            return 422, "One of the values isn't allowed."
        return 409, "That conflicts with data already stored."

    if "NUL (0x00)" in text:
        return 422, "Text can't contain NUL (0x00) characters."
    if state == "22001":
        limit = _TOO_LONG.search(text)
        return 422, f"A value is too long{f' (at most {limit.group(1)} characters)' if limit else ''}."
    if state == "22P02":
        bad = _BAD_TEXT.search(text)
        if bad and bad.group(1) == "uuid":
            return 422, f"'{bad.group(2)}' is not a valid id."
        return 422, f"Not a valid {bad.group(1)} value." if bad else "One of the values isn't valid."
    if state in ("22007", "22008"):
        return 422, "Not a valid date or time."
    if state == "22003":
        return 422, "A number is out of range."
    return 422, "One of the values isn't valid."


def install_db_error_handlers(app: FastAPI) -> None:
    """Registers the DataError/IntegrityError -> 4xx mapping on `app`."""

    async def handle(request: Request, exc: Exception) -> JSONResponse:
        status, detail = describe(exc)
        log.warning("%s %s -> %d: %s", request.method, request.url.path, status, str(getattr(exc, "orig", exc)).splitlines()[0][:300])
        return JSONResponse(status_code=status, content={"detail": detail})

    async def handle_validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [{k: v for k, v in e.items() if k not in ("input", "ctx")} for e in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})

    app.add_exception_handler(DataError, handle)
    app.add_exception_handler(IntegrityError, handle)
    app.add_exception_handler(RequestValidationError, handle_validation)
