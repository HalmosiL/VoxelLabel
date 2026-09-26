"""The Usage and pipeline pages' study filter: one study, or several.

`study_id` on those endpoints takes one id or a comma-separated list --
the Usage page's "My studies" is every study the viewer belongs to, so
the figures are about work they can act on (UX: the page opened on every
study on the platform, the test studies included)."""
import uuid

from fastapi import HTTPException


def study_ids(value) -> list[str] | None:
    """None when there is no filter; else the ids, validated and
    normalised. A bad id is a 422 that names it."""
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return [str(value)]
    parts = value if isinstance(value, (list, tuple, set)) else str(value).split(",")
    out: list[str] = []
    for part in parts:
        part = str(part).strip()
        if not part:
            continue
        try:
            out.append(str(uuid.UUID(part)))
        except ValueError:
            raise HTTPException(status_code=422, detail=f"'{part}' is not a valid study id") from None
    return out or None


def study_uuids(value) -> list[uuid.UUID] | None:
    ids = study_ids(value)
    return [uuid.UUID(i) for i in ids] if ids else None
