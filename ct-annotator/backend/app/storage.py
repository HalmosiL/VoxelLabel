"""Minimal boto3 client for the shared MinIO bucket the main platform
already uses (`ct-pixel-data`) -- only for the one new capability this
service adds: storing freehand annotation mask PNGs under a dedicated
`annotation-masks/` prefix that can't collide with the platform's own
key conventions (`{StudyInstanceUID}/{SeriesInstanceUID}/{SOPInstanceUID}.dcm`,
`thumbnails/{instance_id}.png`). Everything else (raw DICOM, thumbnails)
is read exclusively via the main platform's own presigned-URL endpoints;
this service never reads those keys directly.
"""
import mimetypes
import uuid

import boto3

from app.config import (
    OBJECT_STORAGE_ACCESS_KEY,
    OBJECT_STORAGE_BUCKET,
    OBJECT_STORAGE_ENDPOINT,
    OBJECT_STORAGE_SECRET_KEY,
)

_client = boto3.client(
    "s3",
    endpoint_url=OBJECT_STORAGE_ENDPOINT,
    aws_access_key_id=OBJECT_STORAGE_ACCESS_KEY,
    aws_secret_access_key=OBJECT_STORAGE_SECRET_KEY,
)

_MASK_PREFIX = "annotation-masks"


def upload_mask(mask_png_bytes: bytes) -> str:
    key = f"{_MASK_PREFIX}/{uuid.uuid4()}.png"
    _client.put_object(Bucket=OBJECT_STORAGE_BUCKET, Key=key, Body=mask_png_bytes, ContentType="image/png")
    return key


# Whole-series 3D mask volumes are stored as an opaque gzip blob (the
# browser packs/unpacks the actual Uint8Array -- this service never
# decodes it), so unlike `upload_mask` above this isn't a PNG and needs
# its own content type.
def upload_mask_volume(gzip_bytes: bytes) -> str:
    key = f"{_MASK_PREFIX}/{uuid.uuid4()}.gz"
    _client.put_object(Bucket=OBJECT_STORAGE_BUCKET, Key=key, Body=gzip_bytes, ContentType="application/gzip")
    return key


def delete_mask_object(storage_key: str) -> None:
    """Best-effort removal of a mask upload whose save was then refused."""
    if not storage_key.startswith(f"{_MASK_PREFIX}/"):
        return
    try:
        _client.delete_object(Bucket=OBJECT_STORAGE_BUCKET, Key=storage_key)
    except Exception:  # noqa: BLE001 -- an orphan is untidy, not an error for the user
        pass


def download_bytes(storage_key: str) -> bytes:
    return _client.get_object(Bucket=OBJECT_STORAGE_BUCKET, Key=storage_key)["Body"].read()


def download_object(storage_key: str) -> tuple[bytes, str]:
    """The object's bytes plus a usable content type. Uploads that
    arrived without one (MinIO then records `binary/octet-stream`) get
    it guessed from the key's extension, so a `.txt` report still
    previews as text and a `.pdf` as a PDF."""
    obj = _client.get_object(Bucket=OBJECT_STORAGE_BUCKET, Key=storage_key)
    content_type = obj.get("ContentType") or ""
    if not content_type or content_type in ("binary/octet-stream", "application/octet-stream"):
        content_type = mimetypes.guess_type(storage_key)[0] or "application/octet-stream"
    return obj["Body"].read(), content_type


def presigned_mask_url(storage_key: str, expires_in: int = 300) -> str:
    return _client.generate_presigned_url(
        "get_object", Params={"Bucket": OBJECT_STORAGE_BUCKET, "Key": storage_key}, ExpiresIn=expires_in
    )
