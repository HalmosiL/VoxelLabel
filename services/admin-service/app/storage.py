"""Object storage access for generic (non-DICOM) files this service owns
the write side of: clinical data files and study cover images.

One client, on the internal hostname: it uploads, and it streams what
the browser is shown (cover images) behind signed links to this API
(study_cover_image_link, app/api/objects.py) -- the browser never needs
to reach MinIO itself.
"""
import mimetypes
from collections.abc import Callable

import boto3
from shared_auth.object_links import link_secret, sign_object_link
from shared_auth.storage_errors import storage_client_config

from app.core.config import settings

_client = boto3.client(
    "s3",
    endpoint_url=settings.object_storage_endpoint,
    aws_access_key_id=settings.object_storage_access_key,
    aws_secret_access_key=settings.object_storage_secret_key,
    config=storage_client_config(),  # fail fast when storage is down
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
    # A bare "text/plain" with no charset leaves the browser to guess
    # the encoding when rendering it inline (ct-annotator's Documents
    # panel does exactly that, in an <iframe>) -- files created by this
    # platform are always written as UTF-8 (every upload here comes
    # through Python's own text handling, never a raw byte-for-byte
    # passthrough of some other tool's output), so declaring it avoids
    # non-ASCII text (e.g. Hungarian accented characters) rendering as
    # mojibake purely because the browser guessed Latin-1 instead.
    if content_type == "text/plain":
        content_type = "text/plain; charset=utf-8"
    extra_args = {"ContentType": content_type} if content_type else {}
    _client.put_object(Bucket=settings.object_storage_bucket, Key=storage_key, Body=data, **extra_args)


def download_object(storage_key: str) -> bytes:
    return _client.get_object(Bucket=settings.object_storage_bucket, Key=storage_key)["Body"].read()


def copy_object_bytes(src_key: str, dst_key: str, transform: Callable[[bytes], bytes] | None = None) -> None:
    """Duplicates one object under a new key with a real download+
    reupload -- not S3's own server-side copy_object, deliberately: the
    caller (see app/duplication.py) needs the result to behave exactly
    as if the bytes had been freshly uploaded, and a get+put roundtrip is
    the one approach that's unambiguously that regardless of how any
    given S3-compatible backend implements CopySource under the hood.
    `transform`, if given, rewrites the bytes on the way (a duplicated
    DICOM file gets the copy's own UIDs)."""
    data = download_object(src_key)
    if transform is not None:
        data = transform(data)
    content_type, _ = mimetypes.guess_type(dst_key)
    extra_args = {"ContentType": content_type} if content_type else {}
    _client.put_object(Bucket=settings.object_storage_bucket, Key=dst_key, Body=data, **extra_args)


def delete_object(storage_key: str) -> None:
    """Delete one object from the shared bucket -- used when deleting an
    ImagingStudy/Series/Instance (pixel data + thumbnail) or a
    ClinicalDataItem's attached file. All three services share one bucket
    (`ct-pixel-data`), so this works regardless of which service
    originally wrote the key.
    """
    _client.delete_object(Bucket=settings.object_storage_bucket, Key=storage_key)


def delete_prefix(prefix: str) -> None:
    """Delete every object whose key starts with `prefix` -- e.g. all of a
    deleted study's cover images (B-14)."""
    paginator = _client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=settings.object_storage_bucket, Prefix=prefix):
        keys = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
        if keys:
            _client.delete_objects(Bucket=settings.object_storage_bucket, Delete={"Objects": keys})


def upload_study_cover_image(storage_key: str, data: bytes) -> None:
    _client.put_object(Bucket=settings.object_storage_bucket, Key=storage_key, Body=data)


LINK_SECRET = link_secret(settings.object_storage_secret_key)
OBJECTS_PATH = "/admin/objects"


def study_cover_image_link(storage_key: str) -> str:
    """A signed link to /admin/objects (a path -- the browser prefixes the
    admin API's base URL); see app/api/objects.py."""
    return sign_object_link(OBJECTS_PATH, storage_key, LINK_SECRET)


def read_object(storage_key: str):
    """(streaming body, content type, length) of a stored object, over the internal endpoint."""
    obj = _client.get_object(Bucket=settings.object_storage_bucket, Key=storage_key)
    content_type = obj.get("ContentType") or mimetypes.guess_type(storage_key)[0] or "application/octet-stream"
    return obj["Body"], content_type, obj.get("ContentLength")


def storage_check() -> None:
    """For /health/ready: the bucket is reachable."""
    _client.head_bucket(Bucket=settings.object_storage_bucket)
