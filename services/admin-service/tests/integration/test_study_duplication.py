"""B-12: a duplicated study's DICOM files carry the copy's own UIDs --
the ones its database rows have -- so the copy is independent of the
original (downloads, re-imports and the viewer all agree with the DB)."""
import io
import uuid

import pydicom
import pytest
from app import storage
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian
from shared_models.models import Case, ImagingStudy, Instance, Series

from .conftest import make_case, make_study

ORIG = {"study": "1.2.826.0.1.3680043.77.1", "series": "1.2.826.0.1.3680043.77.1.1", "sop": "1.2.826.0.1.3680043.77.1.1.1"}


def _dicom_bytes():
    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID, fm.MediaStorageSOPInstanceUID, fm.TransferSyntaxUID = CTImageStorage, ORIG["sop"], ExplicitVRLittleEndian
    ds = Dataset()
    ds.file_meta = fm
    ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, ORIG["sop"]
    ds.StudyInstanceUID, ds.SeriesInstanceUID = ORIG["study"], ORIG["series"]
    ds.Modality, ds.PatientID = "CT", "P-1"
    ds.Rows = ds.Columns = 2
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated = ds.BitsStored = 16
    ds.HighBit, ds.PixelRepresentation = 15, 0
    ds.PixelData = bytes(range(8))
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


class _Bucket:
    """Stands in for the S3 client: objects kept in a dict."""

    def __init__(self):
        self.objects = {}

    def put_object(self, Bucket, Key, Body, **_):  # noqa: N803 -- boto3's own argument names
        self.objects[Key] = Body


@pytest.fixture
def bucket(monkeypatch):
    b = _Bucket()
    monkeypatch.setattr(storage, "_client", b)
    monkeypatch.setattr(storage, "download_object", lambda key: b.objects[key])
    return b


def test_copied_dicom_files_carry_the_copys_own_uids(client, db, bucket):
    study_id = make_study(client, "Dup source")
    case_id = make_case(client, study_id)["id"]
    imaging = ImagingStudy(case_id=uuid.UUID(case_id), study_instance_uid=ORIG["study"])
    db.add(imaging)
    db.flush()
    series = Series(imaging_study_id=imaging.id, series_instance_uid=ORIG["series"])
    db.add(series)
    db.flush()
    orig_key = f"{ORIG['study']}/{ORIG['series']}/{ORIG['sop']}.dcm"
    db.add(Instance(series_id=series.id, sop_instance_uid=ORIG["sop"], object_storage_key=orig_key))
    db.commit()
    bucket.objects[orig_key] = _dicom_bytes()

    r = client.post(f"/admin/studies/{study_id}/duplicate", json={"name": "Dup copy"})
    assert r.status_code == 200, r.text
    copy_id = r.json()["id"]

    db.expire_all()
    copy_case = db.query(Case).filter_by(study_id=uuid.UUID(copy_id)).one()
    copy_imaging = db.query(ImagingStudy).filter_by(case_id=copy_case.id).one()
    copy_series = db.query(Series).filter_by(imaging_study_id=copy_imaging.id).one()
    copy_instance = db.query(Instance).filter_by(series_id=copy_series.id).one()

    copied = pydicom.dcmread(io.BytesIO(bucket.objects[copy_instance.object_storage_key]))
    assert copied.StudyInstanceUID == copy_imaging.study_instance_uid
    assert copied.SeriesInstanceUID == copy_series.series_instance_uid
    assert copied.SOPInstanceUID == copy_instance.sop_instance_uid
    assert copied.file_meta.MediaStorageSOPInstanceUID == copy_instance.sop_instance_uid
    assert copied.PixelData == bytes(range(8))
    # the original file is untouched
    original = pydicom.dcmread(io.BytesIO(bucket.objects[orig_key]))
    assert (original.StudyInstanceUID, original.SeriesInstanceUID, original.SOPInstanceUID) == (ORIG["study"], ORIG["series"], ORIG["sop"])
