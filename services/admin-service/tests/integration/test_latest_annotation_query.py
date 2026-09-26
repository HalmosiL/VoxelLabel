"""The newest annotation per target used Query.distinct(column), which
SQLAlchemy 2.1 deprecates (about 200 warnings per test run). Same result
through postgresql.distinct_on, and no deprecation warning."""
import warnings

from app.api.workflow.status import _latest_annotation_by_target
from sqlalchemy.exc import SADeprecationWarning

from .conftest import ANNOTATOR_SUBJECT, make_annotation, make_case, make_series, make_study


def test_the_newest_annotation_per_target_without_a_deprecation(client, db):
    sid = make_study(client)
    series = make_series(db, make_case(client, sid)["id"])
    make_annotation(db, sid, series, ANNOTATOR_SUBJECT, "submitted")
    newest = make_annotation(db, sid, series, ANNOTATOR_SUBJECT, "approved")
    with warnings.catch_warnings():
        warnings.simplefilter("error", SADeprecationWarning)
        latest = _latest_annotation_by_target(db, "series", {series})
    assert latest[series][0] == newest
