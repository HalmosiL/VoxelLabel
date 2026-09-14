"""Pure DICOM decode/render helpers -- no networking, no caching, so these
are trivially unit-testable without a live DICOM file server. The main
platform's own DB never persists window center/width, rescale slope/
intercept, or pixel spacing (confirmed: the Instance columns exist but
nothing ever writes them), so every render re-reads the raw DICOM file's
own tags -- there is no shortcut through the platform's API for this.
"""
import io

import numpy as np
import pydicom
from PIL import Image
from scipy import ndimage


def parse_dataset(dicom_bytes: bytes) -> pydicom.Dataset:
    return pydicom.dcmread(io.BytesIO(dicom_bytes))


def _first(value):
    """WindowCenter/WindowWidth/RescaleSlope/RescaleIntercept can be
    single- or multi-valued (pydicom MultiValue) depending on the file --
    always return one float, or None if the tag is absent."""
    if value is None:
        return None
    try:
        return float(value[0])
    except TypeError:
        return float(value)


def extract_metadata(dataset: pydicom.Dataset) -> dict:
    return {
        "rows": getattr(dataset, "Rows", None),
        "columns": getattr(dataset, "Columns", None),
        "window_center": _first(getattr(dataset, "WindowCenter", None)),
        "window_width": _first(getattr(dataset, "WindowWidth", None)),
        "rescale_slope": _first(getattr(dataset, "RescaleSlope", None)) or 1.0,
        "rescale_intercept": _first(getattr(dataset, "RescaleIntercept", None)) or 0.0,
    }


def rescaled_pixels(dataset: pydicom.Dataset) -> np.ndarray:
    """The dataset's pixel array calibrated by its own rescale slope/
    intercept (e.g. raw values -> Hounsfield units for CT). Shared first
    step before either per-instance windowing (render_png) or stacking
    multiple instances into a volume for sagittal/coronal reconstruction
    (see main.py's _get_volume) -- a volume needs every slice on the same
    calibrated scale before it can be windowed as a whole."""
    pixel_array = dataset.pixel_array.astype(np.float32)
    slope = _first(getattr(dataset, "RescaleSlope", None)) or 1.0
    intercept = _first(getattr(dataset, "RescaleIntercept", None)) or 0.0
    return pixel_array * slope + intercept


# Blur radius (in pixels) the unsharp mask subtracts out before adding
# the difference back in -- fixed rather than exposed as its own
# parameter: `sharpen` alone already covers "how much", and a second
# free variable for "how fine the edges" would make the one slider's
# effect harder to predict for no real benefit here (unlike a photo
# editor, nobody's picking a print size against this).
_UNSHARP_SIGMA = 1.2


def _unsharp_mask(normalized: np.ndarray, amount: float) -> np.ndarray:
    """Classic unsharp masking, applied in the already-windowed 0..255
    space (not the raw HU data) -- so `amount` visibly sharpens exactly
    what's on screen, including the contrast the current window/level
    already picked out, rather than fighting or duplicating that step.
    `blurred` stands in for the image's own low-frequency (soft, out-of-
    focus-looking) content; subtracting it from the original isolates
    the edges, and adding a multiple of that back in is what makes them
    read as crisper. Clips back to a valid 0..255 range -- boosting
    contrast at an edge can overshoot past white/black otherwise."""
    blurred = ndimage.gaussian_filter(normalized, sigma=_UNSHARP_SIGMA)
    return np.clip(normalized + amount * (normalized - blurred), 0, 255)


def _window_and_encode(
    pixel_array: np.ndarray, window_center: float | None, window_width: float | None, sharpen: float | None = None
) -> bytes:
    if window_center is not None and window_width is not None and window_width > 0:
        low, high = window_center - window_width / 2, window_center + window_width / 2
        normalized = (np.clip(pixel_array, low, high) - low) / (high - low) * 255
    else:
        # No window available anywhere -- fall back to the same min-max
        # normalization the platform's ingestion-service thumbnail
        # generator uses.
        low, high = pixel_array.min(), pixel_array.max()
        normalized = (pixel_array - low) / (high - low) * 255 if high > low else np.zeros_like(pixel_array)

    if sharpen:
        normalized = _unsharp_mask(normalized, sharpen)

    image = Image.fromarray(normalized.astype(np.uint8), mode="L")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def render_png(
    dataset: pydicom.Dataset, window_center: float | None, window_width: float | None, sharpen: float | None = None
) -> bytes:
    """DICOM pixel data -> 8-bit grayscale PNG. Windows with the given (or
    the file's own) window center/width, then optionally sharpens (see
    _unsharp_mask) -- `sharpen` is 0/None for the original, unmodified
    look; the UI's Sharpness slider is what actually turns it on."""
    pixel_array = rescaled_pixels(dataset)
    wc = window_center if window_center is not None else _first(getattr(dataset, "WindowCenter", None))
    ww = window_width if window_width is not None else _first(getattr(dataset, "WindowWidth", None))
    return _window_and_encode(pixel_array, wc, ww, sharpen)


def render_plane(
    plane: np.ndarray, window_center: float | None, window_width: float | None, sharpen: float | None = None
) -> bytes:
    """Renders an already rescaled 2D plane -- e.g. a sagittal/coronal
    reconstruction slice cut from a full volume (see main.py's
    _get_volume) -- to an 8-bit grayscale PNG. Unlike render_png there is
    no single source DICOM dataset to fall back to for a default window,
    since a reconstructed plane is built from many instances at once; a
    missing window still falls back to min-max on that plane's own data."""
    return _window_and_encode(plane, window_center, window_width, sharpen)
