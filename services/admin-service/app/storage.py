"""Object storage access for generic (non-DICOM) clinical data files.

Uses the internal object storage hostname -- unlike data-service, this
performs a real upload from inside the container, not just presigned-URL
signing. See services/data-service/app/storage.py for that distinction.
"""
import boto3

from app.core.config import settings

_client = boto3.client(
    "s3",
    endpoint_url=settings.object_storage_endpoint,
    aws_access_key_id=settings.object_storage_access_key,
    aws_secret_access_key=settings.object_storage_secret_key,
)


def upload_clinical_data_file(storage_key: str, data: bytes) -> None:
    _client.put_object(Bucket=settings.object_storage_bucket, Key=storage_key, Body=data)
