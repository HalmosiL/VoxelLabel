"""Stored objects this service hands to the browser (study cover
images), behind signed links to its own API -- see
shared_auth.object_links. Streamed from MinIO over the internal
network, so a cover image shows wherever the admin API is reachable,
whether or not the browser can reach MinIO's port."""
from botocore.exceptions import ClientError
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from shared_auth.object_links import verify_object_link

from app.storage import LINK_SECRET, OBJECTS_PATH, read_object

router = APIRouter(prefix="/admin", tags=["admin:objects"])


@router.get("/objects")
def get_object(key: str = Query(...), exp: int = Query(...), sig: str = Query(...)) -> StreamingResponse:
    if not verify_object_link(OBJECTS_PATH, key, exp, sig, LINK_SECRET):
        raise HTTPException(status_code=403, detail="This link is invalid or has expired -- reload the page for a fresh one.")
    try:
        body, content_type, length = read_object(key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            raise HTTPException(status_code=404, detail="Object not found") from None
        raise
    headers = {"Content-Disposition": f'inline; filename="{key.rsplit("/", 1)[-1]}"', "Cache-Control": "private, max-age=3600"}
    if length is not None:
        headers["Content-Length"] = str(length)
    return StreamingResponse(body.iter_chunks(64 * 1024), media_type=content_type, headers=headers)
