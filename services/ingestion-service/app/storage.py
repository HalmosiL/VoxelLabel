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
