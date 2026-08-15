"""Object storage access for generic (non-DICOM) files this service owns
the write side of: clinical data files and project cover images.

Two clients, deliberately: `_client` (internal hostname) performs real
uploads from inside the container; `_public_client` (browser-reachable
hostname) only ever signs presigned URLs handed back to the browser --
signing needs no network call, so it's safe to point at a host this
container itself can't reach. Same reasoning as data-service's
OBJECT_STORAGE_ENDPOINT -- see services/data-service/app/storage.py.
"""
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
    _client.put_object(Bucket=settings.object_storage_bucket, Key=storage_key, Body=data)


def upload_project_cover_image(storage_key: str, data: bytes) -> None:
    _client.put_object(Bucket=settings.object_storage_bucket, Key=storage_key, Body=data)


def presigned_project_cover_image_url(storage_key: str, expires_in: int = 300) -> str:
    return _public_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.object_storage_bucket, "Key": storage_key},
        ExpiresIn=expires_in,
    )
