"""Read-only object storage access for the data service.

What the browser gets for a stored object is a *signed link* to this
service's own /data/objects (object_link below, see
shared_auth.object_links), streamed from MinIO over the internal
network by read_object -- so images and files work wherever the API
does, whether or not the browser can reach MinIO's port. The presigned
helpers below remain for callers that still want a direct MinIO URL.

The note that follows is about those presigned URLs:

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
from shared_auth.object_links import link_secret, sign_object_link

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


def presigned_thumbnail_url(storage_key: str, expires_in: int = 300) -> str:
    return _presigned_url(storage_key, expires_in)


_internal_client = boto3.client(
    "s3",
    endpoint_url=settings.object_storage_internal_endpoint,
    aws_access_key_id=settings.object_storage_access_key,
    aws_secret_access_key=settings.object_storage_secret_key,
)
LINK_SECRET = link_secret(settings.object_storage_secret_key)
OBJECTS_PATH = "/data/objects"


def object_link(storage_key: str) -> str:
    """A signed link to /data/objects for one stored object -- a path;
    the browser prefixes the data API's own base URL."""
    return sign_object_link(OBJECTS_PATH, storage_key, LINK_SECRET)


def read_object(storage_key: str):
    """(streaming body, content type, length) of a stored object."""
    obj = _internal_client.get_object(Bucket=settings.object_storage_bucket, Key=storage_key)
    return obj["Body"], obj.get("ContentType") or "application/octet-stream", obj.get("ContentLength")
