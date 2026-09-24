"""shared_auth.db_errors: which database error becomes which 4xx (J-01, J-13)."""
import pytest
from shared_auth.db_errors import describe
from sqlalchemy.exc import DataError, IntegrityError


class _Orig(Exception):
    def __init__(self, message, sqlstate=None):
        super().__init__(message)
        self.sqlstate = sqlstate


def _data(message, state=None):
    return DataError("stmt", {}, _Orig(message, state))


def _integrity(state):
    return IntegrityError("stmt", {}, _Orig("violates constraint", state))


@pytest.mark.parametrize(
    ("exc", "status", "says"),
    [
        (_data('invalid input syntax for type uuid: "not-a-uuid"', "22P02"), 422, "'not-a-uuid' is not a valid id"),
        (_data("value too long for type character varying(255)", "22001"), 422, "at most 255 characters"),
        (_data("PostgreSQL text fields cannot contain NUL (0x00) bytes"), 422, "NUL"),
        (_data("date/time field value out of range", "22008"), 422, "date"),
        (_integrity("23505"), 409, "already exists"),
        (_integrity("23503"), 409, "doesn't exist"),
        (_integrity("23502"), 422, "required"),
    ],
)
def test_each_database_error_gets_its_own_answer(exc, status, says):
    got_status, message = describe(exc)
    assert got_status == status and says in message
