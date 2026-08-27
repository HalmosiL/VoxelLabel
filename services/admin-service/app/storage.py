"""Object storage access for generic (non-DICOM) files this service owns
the write side of: clinical data files and study cover images.

Two clients, deliberately: `_client` (internal hostname) performs real
uploads from inside the container; `_public_client` (browser-reachable
hostname) only ever signs presigned URLs handed back to the browser --
signing needs no network call, so it's safe to point at a host this
container itself can't reach. Same reasoning as data-service's
OBJECT_STORAGE_ENDPOINT -- see services/data-service/app/storage.py.
"""
import mimetypes

import boto3

from app.core.config import settings

_client = boto3.client(
    "s3",
    endpoint_url=settings.object_storage_endpoint,
    aws_access_key_id=settings.object_storage_access_key,
    aws_secret_access_key=settings.object_storage_secret_key,
)

_public_client = boto3.client(
    "s3",
    endpoint_url=settings.object_storage_public_endpoint,
    aws_access_key_id=settings.object_storage_access_key,
    aws_secret_access_key=settings.object_storage_secret_key,
)


def upload_clinical_data_file(storage_key: str, data: bytes) -> None:
    # Without a real ContentType, MinIO/S3 serves the object as
    # application/octet-stream regardless of what it actually is -- a
    # browser then downloads a PDF instead of rendering it inline when
    # a user clicks to view it (see CaseDetailPage's DocumentsSection).
    # Guessed from the key's own extension, same one the upload kept it
    # under (see create_clinical_data_item); None (can't guess, or no
    # extension) falls back to boto3's own default, same as before.
    content_type, _ = mimetypes.guess_type(storage_key)
    extra_args = {"ContentType": content_type} if content_type else {}
    _client.put_object(Bucket=settings.object_storage_bucket, Key=storage_key, Body=data, **extra_args)


def delete_object(storage_key: str) -> None:
    """Delete one object from the shared bucket -- used when deleting an
    ImagingStudy/Series/Instance (pixel data + thumbnail) or a
    ClinicalDataItem's attached file. All three services share one bucket
    (`ct-pixel-data`), so this works regardless of which service
    originally wrote the key.
    """
    _client.delete_object(Bucket=settings.object_storage_bucket, Key=storage_key)


def upload_study_cover_image(storage_key: str, data: bytes) -> None:
    _client.put_object(Bucket=settings.object_storage_bucket, Key=storage_key, Body=data)


def presigned_study_cover_image_url(storage_key: str, expires_in: int = 300) -> str:
    return _public_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.object_storage_bucket, "Key": storage_key},
        ExpiresIn=expires_in,
    )
