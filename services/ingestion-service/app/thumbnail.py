"""Generates a small PNG preview from a DICOM instance's pixel data.

Deliberately simple: min-max normalizes the raw pixel array to 8-bit
grayscale and resizes it -- no attempt at proper DICOM windowing
(WindowCenter/WindowWidth can be multi-valued and modality-specific),
since this is a UI preview thumbnail, not a diagnostic rendering.
"""
import io

import numpy as np
from PIL import Image

THUMBNAIL_SIZE = (128, 128)


class ThumbnailGenerationError(Exception):
    """Raised when a thumbnail can't be produced (e.g. an unsupported
    transfer syntax pydicom can't decode without an extra codec plugin).
    Ingestion should continue without a thumbnail rather than fail."""


def generate_thumbnail(dataset) -> bytes:
    try:
        pixel_array = dataset.pixel_array.astype(np.float32)
    except Exception as exc:
        raise ThumbnailGenerationError(str(exc)) from exc

    low, high = pixel_array.min(), pixel_array.max()
    normalized = (pixel_array - low) / (high - low) * 255 if high > low else np.zeros_like(pixel_array)

    image = Image.fromarray(normalized.astype(np.uint8), mode="L")
    image.thumbnail(THUMBNAIL_SIZE)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()
