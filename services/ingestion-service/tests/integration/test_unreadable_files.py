"""B-06: a DICOM whose image data can't be read (e.g. cut short) is
refused, not "imported" and then unopenable -- one such slice broke the
whole series' 3D views. B-07: a DICOM without preamble / File Meta is
stored as a proper DICOM file, readable without force."""
import io
import uuid

import numpy as np
import pydicom
import pytest
from pydicom.dataset import Dataset
from shared_models.models import Case, Patient, Study

from app import pipeline, storage

UID = "1.2.826.0.1.3680043.55"


def _image(sop):
    ds = Dataset()
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.SOPInstanceUID, ds.Modality = UID, UID + ".1", sop, "CT"
    ds.Rows = ds.Columns = 8
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated = ds.BitsStored = 16
    ds.HighBit, ds.PixelRepresentation = 15, 0
    ds.PixelData = np.arange(64, dtype=np.uint16).tobytes()
    return ds


def _raw_file(ds) -> bytes:
    """No preamble, no group 0002: implicit VR little endian, as some exporters write."""
    buf = io.BytesIO()
    fp = pydicom.filebase.DicomFileLike(buf)
    fp.is_implicit_VR, fp.is_little_endian = True, True
    pydicom.filewriter.write_dataset(fp, ds)
    return buf.getvalue()


@pytest.fixture
def case(db):
    study, patient = Study(name=f"u-{uuid.uuid4().hex[:6]}"), Patient(pseudonym_id=uuid.uuid4().hex)
    db.add_all([study, patient])
    db.flush()
    c = Case(study_id=study.id, patient_id=patient.id)
    db.add(c)
    db.commit()
    return c


@pytest.fixture
def stored(monkeypatch):
    objects = {}
    monkeypatch.setattr(pipeline, "upload_pixel_data", lambda key, ds: objects.__setitem__(key, storage.dicom_file_bytes(ds)))
    monkeypatch.setattr(pipeline, "upload_thumbnail", lambda key, png: None)
    return objects


def test_a_file_whose_image_data_is_cut_short_is_refused(db, case, stored):
    ds = pydicom.dcmread(io.BytesIO(_raw_file(_image(UID + ".1.1"))[:-40]), force=True)
    with pytest.raises(pipeline.DicomValidationError, match="image data can't be read"):
        pipeline._ingest_one_instance(db, case, ds)
    assert stored == {}


def test_a_file_without_file_meta_is_stored_as_proper_dicom(db, case, stored):
    ds = pydicom.dcmread(io.BytesIO(_raw_file(_image(UID + ".1.2"))), force=True)
    assert pipeline._ingest_one_instance(db, case, ds)["status"] == "completed"
    (data,) = stored.values()
    reread = pydicom.dcmread(io.BytesIO(data))  # no force
    assert reread.file_meta.MediaStorageSOPInstanceUID == UID + ".1.2"
    assert reread.pixel_array.shape == (8, 8)
