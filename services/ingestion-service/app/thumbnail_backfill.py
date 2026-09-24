"""Puts back the preview thumbnails a case page shows, wherever one is
missing: an instance with no thumbnail key (its DICOM couldn't be
decoded when it was ingested), or one whose key points at an object no
longer in the bucket (storage restored or moved without it, or a study
duplicated from such a source). Regenerated from the instance's own
DICOM, with the same generator ingestion uses. Idempotent -- run it as
often as you like; an instance that already has its thumbnail is only
checked, never rewritten.

    python -m app.thumbnail_backfill          # fix what's missing
    python -m app.thumbnail_backfill --check  # only count it

scripts/setup-test-server.sh runs it after every deploy.
"""
import argparse
import io
import sys

import pydicom
from shared_models.database import SessionLocal
from shared_models.models import Instance
from sqlalchemy.orm import Session

from app.storage import download_object, object_exists, upload_thumbnail
from app.thumbnail import ThumbnailGenerationError, generate_thumbnail


def backfill(db: Session, *, check_only: bool = False, exists=object_exists, download=download_object, upload=upload_thumbnail) -> dict:
    """Returns counts: checked, missing, fixed, failed (DICOM missing or undecodable)."""
    counts = {"checked": 0, "missing": 0, "fixed": 0, "failed": 0}
    # Read everything first: the loop commits every 200 fixes, which would
    # close a server-side cursor still being iterated.
    rows = [(instance, instance.thumbnail_key, instance.object_storage_key) for instance in db.query(Instance).order_by(Instance.id).all()]
    for instance, thumbnail_key, dicom_key in rows:
        counts["checked"] += 1
        if thumbnail_key and exists(thumbnail_key):
            continue
        counts["missing"] += 1
        if check_only:
            continue
        try:
            dataset = pydicom.dcmread(io.BytesIO(download(dicom_key)))
            png = generate_thumbnail(dataset)
        except (ThumbnailGenerationError, pydicom.errors.InvalidDicomError, OSError, ValueError):
            counts["failed"] += 1
            continue
        except Exception as exc:  # noqa: BLE001 -- a missing DICOM object is S3's own ClientError; skip it, keep going
            if exc.__class__.__name__ != "ClientError":
                raise
            counts["failed"] += 1
            continue
        key = thumbnail_key or f"thumbnails/{instance.id}.png"
        upload(key, png)
        instance.thumbnail_key = key
        counts["fixed"] += 1
        if counts["fixed"] % 200 == 0:
            db.commit()
    db.commit()
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="only count what's missing")
    args = parser.parse_args(argv)
    db = SessionLocal()
    try:
        counts = backfill(db, check_only=args.check)
    finally:
        db.close()
    print("thumbnails: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
