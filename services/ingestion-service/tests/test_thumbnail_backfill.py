"""The thumbnail backfill: regenerates exactly the missing previews, from
each instance's own DICOM, and leaves the rest alone. No DB/MinIO -- a
stand-in session and in-memory storage."""
import io
import uuid
from types import SimpleNamespace

import numpy as np
import pydicom
from app.thumbnail_backfill import backfill
from pydicom.dataset import FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid


def _dicom_bytes() -> bytes:
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
    meta.MediaStorageSOPInstanceUID = generate_uid()
    ds = pydicom.Dataset()
    ds.file_meta = meta
    ds.Rows, ds.Columns = 32, 32
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated = ds.BitsStored = 16
    ds.HighBit, ds.PixelRepresentation = 15, 0
    ds.PixelData = np.arange(32 * 32, dtype=np.uint16).reshape(32, 32).tobytes()
    buf = io.BytesIO()
    pydicom.dcmwrite(buf, ds, enforce_file_format=True)
    return buf.getvalue()


class _Query(list):
    def order_by(self, *_):
        return self

    def all(self):
        return list(self)


class _Db:
    def __init__(self, rows):
        self.rows, self.commits = rows, 0

    def query(self, _model):
        return _Query(self.rows)

    def commit(self):
        self.commits += 1


def _instance(thumbnail_key, dicom_key):
    return SimpleNamespace(id=uuid.uuid4(), thumbnail_key=thumbnail_key, object_storage_key=dicom_key)


def test_regenerates_only_the_missing_thumbnails():
    store = {"a.dcm": _dicom_bytes(), "b.dcm": _dicom_bytes(), "c.dcm": _dicom_bytes(), "thumbnails/ok.png": b"png"}
    ok = _instance("thumbnails/ok.png", "a.dcm")
    gone = _instance("thumbnails/gone.png", "b.dcm")  # key in the DB, object not in the bucket
    never = _instance(None, "c.dcm")  # never had one
    no_dicom = _instance(None, "missing.dcm")
    db = _Db([ok, gone, never, no_dicom])

    def download(key):
        if key not in store:
            raise OSError("NoSuchKey")
        return store[key]

    def upload(key, data):
        store[key] = data

    counts = backfill(db, exists=lambda k: k in store, download=download, upload=upload)
    assert counts == {"checked": 4, "missing": 3, "fixed": 2, "failed": 1}
    assert gone.thumbnail_key == "thumbnails/gone.png" and store["thumbnails/gone.png"].startswith(b"\x89PNG")
    assert never.thumbnail_key == f"thumbnails/{never.id}.png" and store[never.thumbnail_key].startswith(b"\x89PNG")
    assert ok.thumbnail_key == "thumbnails/ok.png" and store["thumbnails/ok.png"] == b"png"
    assert no_dicom.thumbnail_key is None and db.commits >= 1


def test_check_only_counts_and_changes_nothing():
    db = _Db([_instance(None, "x.dcm")])
    counts = backfill(db, check_only=True, exists=lambda k: False, download=lambda k: b"", upload=lambda k, d: None)
    assert counts == {"checked": 1, "missing": 1, "fixed": 0, "failed": 0}
