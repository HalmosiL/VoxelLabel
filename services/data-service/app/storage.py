"""Read-only object storage access for the data service.

`OBJECT_STORAGE_ENDPOINT` here must be the hostname a *browser* can reach
(e.g. a published port like `http://localhost:9000`), not the internal
docker/k8s service hostname -- generating a presigned URL is a purely local
signing operation (no network call to object storage happens), but the
signed URL is only valid for requests to the host it was signed for, and
that request is made by the browser, not this service. Contrast with
`services/ingestion-service/app/storage.py`, which performs real uploads
from inside the network and so uses the internal hostname instead. Same
category of issue as the Keycloak issuer/JWKS split -- see
`libs/shared-auth/README.md`.
"""
import boto3

from app.core.config import settings

_client = boto3.client(
    "s3",
    endpoint_url=settings.object_storage_endpoint,
    aws_access_key_id=settings.object_storage_access_key,
    aws_secret_access_key=settings.object_storage_secret_key,
)


def _presigned_url(storage_key: str, expires_in: int) -> str:
    return _client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.object_storage_bucket, "Key": storage_key},
        ExpiresIn=expires_in,
    )


def presigned_pixel_data_url(storage_key: str, expires_in: int = 300) -> str:
    """Generate a short-lived presigned GET URL for a DICOM object, so
    clients fetch pixel data directly from object storage rather than
    proxying large binaries through this service."""
    return _presigned_url(storage_key, expires_in)


def presigned_clinical_data_url(storage_key: str, expires_in: int = 300) -> str:
    """Same as presigned_pixel_data_url, for a ClinicalDataItem's attached
    file instead of a DICOM instance."""
    return _presigned_url(storage_key, expires_in)
