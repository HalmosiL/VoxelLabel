"""Read-only object storage access for the data service."""
import boto3

from app.core.config import settings

_client = boto3.client(
    "s3",
    endpoint_url=settings.object_storage_endpoint,
    aws_access_key_id=settings.object_storage_access_key,
    aws_secret_access_key=settings.object_storage_secret_key,
)


def presigned_pixel_data_url(storage_key: str, expires_in: int = 300) -> str:
    """Generate a short-lived presigned GET URL for a DICOM object, so
    clients fetch pixel data directly from object storage rather than
    proxying large binaries through this service."""
    return _client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.object_storage_bucket, "Key": storage_key},
        ExpiresIn=expires_in,
    )
