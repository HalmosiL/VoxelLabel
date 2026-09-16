"""Unit tests for thumbnail generation -- pure pixel-array-to-PNG logic,
no DB/object storage/Celery needed."""
import io

import numpy as np
import pytest
from app.thumbnail import ThumbnailGenerationError, generate_thumbnail
from PIL import Image


class _FakeDataset:
    """Stands in for a pydicom Dataset -- only `.pixel_array` is used by
    generate_thumbnail."""

    def __init__(self, pixel_array: np.ndarray) -> None:
        self.pixel_array = pixel_array


def test_generates_a_valid_png_at_thumbnail_size() -> None:
    pixel_array = np.random.default_rng(1).integers(0, 4000, size=(256, 256), dtype=np.int16)
    png_bytes = generate_thumbnail(_FakeDataset(pixel_array))

    image = Image.open(io.BytesIO(png_bytes))
    assert image.format == "PNG"
    assert image.mode == "L"
    assert image.size == (128, 128)


def test_normalizes_full_range_to_0_255() -> None:
    pixel_array = np.array([[0, 1000], [500, 1000]], dtype=np.int16)
    png_bytes = generate_thumbnail(_FakeDataset(pixel_array))

    image = np.array(Image.open(io.BytesIO(png_bytes)))
    assert image.min() == 0
    assert image.max() == 255


def test_constant_pixel_array_does_not_divide_by_zero() -> None:
    pixel_array = np.full((16, 16), 42, dtype=np.int16)
    png_bytes = generate_thumbnail(_FakeDataset(pixel_array))

    image = np.array(Image.open(io.BytesIO(png_bytes)))
    assert (image == 0).all()


def test_raises_thumbnail_generation_error_when_pixel_array_unavailable() -> None:
    class _BrokenDataset:
        @property
        def pixel_array(self):
            raise ValueError("unsupported transfer syntax")

    with pytest.raises(ThumbnailGenerationError):
        generate_thumbnail(_BrokenDataset())
