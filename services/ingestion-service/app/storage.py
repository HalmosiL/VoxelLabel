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
    dataset.save_as(buffer, write_like_original=True)
    buffer.seek(0)
    _client.put_object(Bucket=settings.object_storage_bucket, Key=storage_key, Body=buffer.getvalue())
