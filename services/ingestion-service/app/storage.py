"""Object storage (MinIO/S3-compatible) access for DICOM pixel data."""
import io

import boto3

from app.core.config import settings

_client = boto3.client(
    "s3",
    endpoint_url=settings.object_storage_endpoint,
    aws_access_key_id=settings.object_storage_access_key,
    aws_secret_access_key=settings.object_storage_secret_key,
)

# A second client, pointed at the browser-reachable endpoint rather than
# the container-internal one -- used only to *sign* URLs (never to move
# actual bytes through it), the same dual-client split admin-service's
# own object storage config already uses. A presigned URL bakes in
# whichever host the signing client was configured with, so a URL hoping
# to be opened straight from someone's own machine has to be signed with
# this one, not `_client`.
_public_client = boto3.client(
    "s3",
    endpoint_url=settings.object_storage_public_endpoint,
    aws_access_key_id=settings.object_storage_access_key,
    aws_secret_access_key=settings.object_storage_secret_key,
)


def upload_pixel_data(storage_key: str, dataset) -> None:
    """Upload a pydicom dataset's raw bytes to the pixel data bucket."""
    buffer = io.BytesIO()
    dataset.save_as(buffer, enforce_file_format=False)
    buffer.seek(0)
    _client.put_object(Bucket=settings.object_storage_bucket, Key=storage_key, Body=buffer.getvalue())


def upload_thumbnail(storage_key: str, png_bytes: bytes) -> None:
    _client.put_object(Bucket=settings.object_storage_bucket, Key=storage_key, Body=png_bytes, ContentType="image/png")


def upload_staged_file(staging_key: str, data: bytes) -> None:
    """Stage a just-uploaded file's raw bytes in object storage under a
    `_staging/` prefix, so the Celery worker -- a separate container/
    process from this API -- can retrieve them. Local disk is not shared
    between the two, so staging must go through the one thing they do
    share: object storage.
    """
    _client.put_object(Bucket=settings.object_storage_bucket, Key=staging_key, Body=data)


def download_staged_file(staging_key: str) -> bytes:
    return _client.get_object(Bucket=settings.object_storage_bucket, Key=staging_key)["Body"].read()


def delete_staged_file(staging_key: str) -> None:
    _client.delete_object(Bucket=settings.object_storage_bucket, Key=staging_key)


def download_object(storage_key: str) -> bytes:
    """Generic read-back, used by the PyTorch export pipeline (app/
    pytorch_export.py) to re-fetch an already-ingested Instance's raw
    DICOM bytes for decoding -- unlike download_staged_file, the key here
    isn't necessarily under `_staging/`."""
    return _client.get_object(Bucket=settings.object_storage_bucket, Key=storage_key)["Body"].read()


def upload_export_object(storage_key: str, data: bytes) -> None:
    """Uploads one file (a Series' `.npy` array, or the export's own
    manifest.json) under an `exports/{export_id}/` prefix -- see app/
    pytorch_export.py."""
    _client.put_object(Bucket=settings.object_storage_bucket, Key=storage_key, Body=data)


def presigned_export_url(storage_key: str, expires_in: int = 86400) -> str:
    """A time-limited, browser-reachable download URL for one export
    object -- signed fresh on every call (never baked into the stored
    manifest.json) so it keeps working no matter how long ago the export
    actually finished. Default expiry is 24h, matching Celery's own
    default result_expires window this repo otherwise relies on for job
    status."""
    return _public_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.object_storage_bucket, "Key": storage_key},
        ExpiresIn=expires_in,
    )
