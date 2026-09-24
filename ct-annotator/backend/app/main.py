"""Thin backend for the standalone CT annotation-drawing viewer.

Adds exactly two capabilities the main platform doesn't have: rendering
DICOM pixel data to a plain PNG with real window/level (the platform's
own thumbnail generator deliberately does a fixed-size min-max normalize,
not real windowing), and storing freehand pixel-mask annotations. Every
other concern -- imaging metadata, annotation CRUD, RBAC -- is proxied
straight through to the main platform's existing data-service/
annotation-service under the caller's own Keycloak token. Nothing is
duplicated locally: no database, no annotations table, no study-role
table -- see app/auth.py for why that's deliberate, not an oversight.
"""
import asyncio
import base64
import gzip
import time

import httpx
import numpy as np
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from scipy import ndimage

from app.auth import CurrentUser, get_current_user
from app.config import (
    ADMIN_SERVICE_URL,
    ANNOTATION_SERVICE_URL,
    CORS_ALLOWED_ORIGINS,
    DATA_SERVICE_URL,
    RENDER_CACHE_TTL_SECONDS,
)
from app.dicom_render import SLAB_MODES, extract_metadata, parse_dataset, render_plane, render_png, rescaled_pixels, slab_plane
from app.storage import download_bytes, download_object, presigned_mask_url, upload_mask, upload_mask_volume

app = FastAPI(title="CT Annotator Viewer -- thin backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Custom response headers aren't in the browser's default CORS-safelisted
    # set -- get_plane_hu's X-Box-* headers need this to be readable from
    # the frontend's fetch() call (a cross-origin request, different ports).
    expose_headers=["X-Box-Width", "X-Box-Height", "X-Box-X0", "X-Box-Y0"],
)

# Parsed pydicom Dataset per instance id, so a window/level tweak doesn't
# re-fetch+re-decode the same file -- see RENDER_CACHE_TTL_SECONDS.
_dataset_cache: dict[str, tuple[float, object]] = {}

# Both caches used to grow without bound: an entry only ever went away
# when it was *read* after its TTL, so every series ever opened stayed
# resident (a full-resolution volume is ~100 MB) -- the backend held
# ~1 GB after a single afternoon of use on a 7 GB host. Now every
# insert prunes expired entries and keeps only the most recent few.
_MAX_CACHED_VOLUMES = 3
_MAX_CACHED_DATASETS = 600


def _prune_cache(cache: dict, max_entries: int) -> None:
    now = time.monotonic()
    for key in [k for k, (stamp, _) in cache.items() if now - stamp >= RENDER_CACHE_TTL_SECONDS]:
        cache.pop(key, None)
    while len(cache) > max_entries:
        oldest = min(cache, key=lambda k: cache[k][0])
        cache.pop(oldest, None)

# Shared across requests (not one-per-call) so building a volume can fire
# many concurrent downloads over pooled connections instead of each
# opening its own client/connection.
_http_client = httpx.AsyncClient()


@app.on_event("shutdown")
async def _close_http_client() -> None:
    await _http_client.aclose()


def _auth_headers(user: CurrentUser) -> dict:
    return {"Authorization": f"Bearer {user.token}"}


async def _fetch_dicom_bytes(instance_id: str, user: CurrentUser) -> bytes:
    """Asks the main platform's data-service for the instance's file (this
    is also the RBAC checkpoint -- a 403 there propagates as a 403 here),
    then reads the raw DICOM bytes.

    Read straight from object storage by storage key when data-service
    says which key it is -- this is a server-to-server fetch, and the
    presigned URL it also returns is signed for the *browser-facing*
    host (PUBLIC_MINIO_URL). Behind a tunnel or reverse proxy that host
    is a public https:// name this backend can't, and shouldn't, reach
    (the real failure: every sagittal/coronal build 500ing with a TLS
    ConnectError once the platform was exposed through ngrok). The
    presigned download stays as the fallback for an older data-service
    that doesn't send the key yet."""
    resp = await _http_client.get(
        f"{DATA_SERVICE_URL}/data/instances/{instance_id}/pixel-data-url", headers=_auth_headers(user)
    )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    payload = resp.json()
    storage_key = payload.get("storage_key")
    if storage_key:
        return await asyncio.to_thread(download_bytes, storage_key)

    dicom_resp = await _http_client.get(payload["url"])
    dicom_resp.raise_for_status()
    return dicom_resp.content


async def _get_dataset(instance_id: str, user: CurrentUser):
    cached = _dataset_cache.get(instance_id)
    now = time.monotonic()
    if cached is not None and now - cached[0] < RENDER_CACHE_TTL_SECONDS:
        return cached[1]
    dicom_bytes = await _fetch_dicom_bytes(instance_id, user)
    dataset = parse_dataset(dicom_bytes)
    _dataset_cache[instance_id] = (now, dataset)
    _prune_cache(_dataset_cache, _MAX_CACHED_DATASETS)
    return dataset


@app.get("/instances/{instance_id}/metadata")
async def get_instance_metadata(instance_id: str, user: CurrentUser = Depends(get_current_user)) -> dict:
    dataset = await _get_dataset(instance_id, user)
    return extract_metadata(dataset)


@app.get("/instances/{instance_id}/render.png")
async def get_instance_render(
    instance_id: str,
    wc: float | None = Query(default=None),
    ww: float | None = Query(default=None),
    sharpen: float | None = Query(default=None),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    dataset = await _get_dataset(instance_id, user)
    png_bytes = render_png(dataset, wc, ww, sharpen)
    return Response(content=png_bytes, media_type="image/png")


# Full-series volume (num_slices, rows, columns), HU-calibrated, built by
# downloading and decoding every instance in the series once -- this is
# the expensive step multi-planar reconstruction needs that a single
# axial render doesn't. Reuses _get_dataset's own per-instance cache, so
# building a volume also warms the axial cache for those same slices.
_volume_cache: dict[str, tuple[float, np.ndarray]] = {}

# Caps how many instance downloads/decodes run at once when building a
# volume -- unbounded concurrency for a 100+ slice series would open that
# many simultaneous connections to data-service/MinIO.
_VOLUME_BUILD_CONCURRENCY = 16


async def _get_volume(series_id: str, user: CurrentUser) -> np.ndarray:
    cached = _volume_cache.get(series_id)
    now = time.monotonic()
    if cached is not None and now - cached[0] < RENDER_CACHE_TTL_SECONDS:
        return cached[1]

    instances = await _proxy_get(f"{DATA_SERVICE_URL}/data/series/{series_id}/instances", user)
    ordered = sorted(instances, key=lambda i: i.get("instance_number") or 0)
    if not ordered:
        raise HTTPException(status_code=404, detail="Series has no instances")

    # A real axial CT stack has 2+ slices, each with its own distinct
    # instance_number -- sorting by it is what gives np.stack a
    # physically meaningful Z order. A scout/localizer series (one or
    # several independent 2D reference images, e.g. "Surview") fails
    # this in one of two ways: it shares the same instance_number across
    # every image (never meant to be stacked at all), or -- just as
    # broken, and easy to miss since it trivially has "distinct" numbers
    # with nothing to collide with -- it's a single lone image, which is
    # just as meaningless to slice a cross-section through as any other
    # non-stack. Either way stacking still succeeds shape-wise (same
    # rows/columns) but produces a meaningless "volume" -- slicing across
    # it for sagittal/coronal reconstruction samples one column from
    # unrelated (or nonexistent) neighboring images, rendering as pure
    # vertical noise (or, for the single-image case, the one real image
    # stretched into noise-like bands). Caught here, before that render,
    # with a clear error instead.
    if len(ordered) < 2 or len({i.get("instance_number") for i in ordered}) < len(ordered):
        raise HTTPException(
            status_code=422,
            detail="This series doesn't have multiple images with a distinct instance number each, so it can't "
            "form a real 3D stack (it looks like a scout/localizer series, not consecutive axial slices) -- "
            "sagittal/coronal reconstruction isn't meaningful for it. View it slice by slice on the axial pane "
            "instead.",
        )

    semaphore = asyncio.Semaphore(_VOLUME_BUILD_CONCURRENCY)

    async def _load(instance: dict) -> np.ndarray:
        async with semaphore:
            dataset = await _get_dataset(instance["id"], user)
            return rescaled_pixels(dataset)

    slices = await asyncio.gather(*(_load(instance) for instance in ordered))
    volume = np.stack(slices, axis=0)
    _volume_cache[series_id] = (now, volume)
    _prune_cache(_volume_cache, _MAX_CACHED_VOLUMES)
    return volume


@app.get("/series/{series_id}/sagittal.png")
async def get_sagittal_render(
    series_id: str,
    x: int = Query(...),
    wc: float | None = Query(default=None),
    ww: float | None = Query(default=None),
    sharpen: float | None = Query(default=None),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    volume = await _get_volume(series_id, user)
    x = max(0, min(x, volume.shape[2] - 1))
    png_bytes = render_plane(volume[:, :, x], wc, ww, sharpen)
    return Response(content=png_bytes, media_type="image/png")


@app.get("/series/{series_id}/coronal.png")
async def get_coronal_render(
    series_id: str,
    y: int = Query(...),
    wc: float | None = Query(default=None),
    ww: float | None = Query(default=None),
    sharpen: float | None = Query(default=None),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    volume = await _get_volume(series_id, user)
    y = max(0, min(y, volume.shape[1] - 1))
    png_bytes = render_plane(volume[:, y, :], wc, ww, sharpen)
    return Response(content=png_bytes, media_type="image/png")


@app.get("/series/{series_id}/slab.png")
async def get_slab_render(
    series_id: str,
    plane: str = Query(..., pattern="^(axial|sagittal|coronal)$"),
    index: int = Query(...),
    thickness: int = Query(default=1, ge=1, le=51),
    mode: str = Query(default="avg", pattern="^(" + "|".join(SLAB_MODES) + ")$"),
    wc: float | None = Query(default=None),
    ww: float | None = Query(default=None),
    sharpen: float | None = Query(default=None),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """A thick slice ("slab") on any plane: `thickness` neighbouring
    slices around `index` averaged, or projected by maximum (MIP) or
    minimum (MinIP) intensity -- see dicom_render.slab_plane. `index` is
    the slice for axial, the column (x) for sagittal, the row (y) for
    coronal, the same indices the single-slice endpoints take."""
    volume = await _get_volume(series_id, user)
    png_bytes = render_plane(slab_plane(volume, plane, index, thickness, mode), wc, ww, sharpen)
    return Response(content=png_bytes, media_type="image/png")


@app.get("/series/{series_id}/voxel-value")
async def get_voxel_value(
    series_id: str,
    x: int = Query(...),
    y: int = Query(...),
    z: int = Query(...),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """The Hounsfield-unit value at one voxel (already rescale-calibrated,
    see rescaled_pixels) -- backs the viewer's Alt+click "what's the HU
    here" readout. Reuses the same cached volume _get_volume builds for
    sagittal/coronal reconstruction, so this is cheap after the first
    call for a series."""
    volume = await _get_volume(series_id, user)
    if not (0 <= z < volume.shape[0] and 0 <= y < volume.shape[1] and 0 <= x < volume.shape[2]):
        raise HTTPException(status_code=400, detail="Coordinates out of bounds")
    return {"hu": float(volume[z, y, x])}


@app.get("/series/{series_id}/plane-hu")
async def get_plane_hu(
    series_id: str,
    pane: str = Query(...),
    index: int = Query(...),
    x0: int = Query(...),
    y0: int = Query(...),
    x1: int = Query(...),
    y1: int = Query(...),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """Raw HU values for a rectangular box within one plane's current
    slice -- backs the viewer's auto-contour tool, which fetches a box
    once and then runs region growing entirely client-side as the
    tolerance slider moves (see ViewerPage.tsx's autoPreviewMask), so
    this only needs to be called once per drawn box, not once per
    tolerance tick. Slices the same cached volume every other MPR
    endpoint here already builds -- axial has no volume-based accessor
    elsewhere (render.png renders per-instance instead), but the volume
    already holds the same calibrated data at volume[index, :, :]."""
    volume = await _get_volume(series_id, user)
    num_slices, rows, columns = volume.shape
    if pane == "axial":
        index = max(0, min(index, num_slices - 1))
        plane = volume[index, :, :]
    elif pane == "sagittal":
        index = max(0, min(index, columns - 1))
        plane = volume[:, :, index]
    elif pane == "coronal":
        index = max(0, min(index, rows - 1))
        plane = volume[:, index, :]
    else:
        raise HTTPException(status_code=400, detail=f"Unknown pane: {pane}")

    height, width = plane.shape
    cx0, cx1 = max(0, min(x0, x1)), min(width, max(x0, x1))
    cy0, cy1 = max(0, min(y0, y1)), min(height, max(y0, y1))
    box = np.ascontiguousarray(plane[cy0:cy1, cx0:cx1]).astype(np.int16)
    return Response(
        content=box.tobytes(),
        media_type="application/octet-stream",
        headers={
            "X-Box-Width": str(box.shape[1]),
            "X-Box-Height": str(box.shape[0]),
            "X-Box-X0": str(cx0),
            "X-Box-Y0": str(cy0),
        },
    )


# Lung-mask threshold/labeling is a second or so of real work over a full
# chest CT -- cached briefly (same TTL/dict pattern as _volume_cache
# above) so toggling the 3D view's "Lung" button on/off within a session
# doesn't redo it every time.
_lung_mask_cache: dict[str, tuple[float, np.ndarray]] = {}

# HU cutoff separating air/lung parenchyma from soft tissue -- a
# commonly used threshold for this kind of coarse lung extraction, not
# meant to be diagnostically precise (see the plan doc for why a simple
# threshold + connected-component approach is the right scope here).
_LUNG_HU_THRESHOLD = -400
_LUNG_MIN_COMPONENT_VOXELS = 5000
_LUNG_MAX_COMPONENTS = 2


def _segment_lungs(volume: np.ndarray) -> np.ndarray:
    """Boolean lung mask via threshold + connected-component filtering:
    candidate air/lung voxels are labeled into connected components, and
    any component touching the volume's *X/Y* outer face -- the
    scanner's circular field-of-view boundary, always the surrounding
    room air -- is discarded as not-lung. Deliberately does NOT check
    the Z (slice) faces: a "routine chest" protocol is commonly cropped
    tight enough that the lung apex/base itself reaches the first/last
    slice, which isn't "outside the body" the way the X/Y border is --
    confirmed against the real test series, where excluding on Z too
    discarded the entire lung volume (it's one component spanning
    almost the whole Z range) while wrongly keeping small bowel-gas
    pockets that only touch a middle Z slice. Among the surviving
    components, the largest (there's often one spanning both lungs via
    the trachea, sometimes two separate ones) are kept. No hole-filling
    -- vessels/airways show as cavities in the resulting surface, an
    acceptable approximation for a 3D preview rather than a diagnostic
    tool."""
    candidate = volume < _LUNG_HU_THRESHOLD
    labeled, count = ndimage.label(candidate)
    if count == 0:
        return np.zeros(volume.shape, dtype=np.uint8)

    border_labels = set(
        np.unique(
            np.concatenate(
                [
                    labeled[:, 0, :].ravel(),
                    labeled[:, -1, :].ravel(),
                    labeled[:, :, 0].ravel(),
                    labeled[:, :, -1].ravel(),
                ]
            )
        )
    ) - {0}

    sizes = ndimage.sum(candidate, labeled, index=range(1, count + 1))
    internal = [
        (label, int(size))
        for label, size in zip(range(1, count + 1), sizes)
        if label not in border_labels and size >= _LUNG_MIN_COMPONENT_VOXELS
    ]
    internal.sort(key=lambda pair: pair[1], reverse=True)
    kept_labels = [label for label, _ in internal[:_LUNG_MAX_COMPONENTS]]

    return np.isin(labeled, kept_labels).astype(np.uint8)


@app.get("/series/{series_id}/lung-mask")
async def get_lung_mask(series_id: str, user: CurrentUser = Depends(get_current_user)) -> dict:
    """A boolean lung mask for the whole series (see _segment_lungs),
    gzip+base64-encoded exactly like the mask-volume endpoints' own
    payload -- the viewer's 3D pane runs the same client-side
    marching-cubes it already uses for painted objects against this,
    so no mesh-extraction work happens server-side."""
    cached = _lung_mask_cache.get(series_id)
    now = time.monotonic()
    if cached is not None and now - cached[0] < RENDER_CACHE_TTL_SECONDS:
        mask = cached[1]
    else:
        volume = await _get_volume(series_id, user)
        mask = _segment_lungs(volume)
        _lung_mask_cache[series_id] = (now, mask)

    gzip_bytes = gzip.compress(mask.tobytes())
    return {
        "mask_gzip_base64": base64.b64encode(gzip_bytes).decode(),
        "num_slices": mask.shape[0],
        "rows": mask.shape[1],
        "columns": mask.shape[2],
    }


# AnnotationType rows are essentially static (added by an admin one-off,
# never edited per-request), so this can sit far longer than the render
# caches above without going stale.
_ANNOTATION_TYPES_CACHE_TTL_SECONDS = 300
_annotation_types_cache: tuple[float, list[dict]] | None = None


async def _get_annotation_types(user: CurrentUser) -> list[dict]:
    global _annotation_types_cache
    now = time.monotonic()
    if _annotation_types_cache is not None and now - _annotation_types_cache[0] < _ANNOTATION_TYPES_CACHE_TTL_SECONDS:
        return _annotation_types_cache[1]
    types = await _proxy_get(f"{ADMIN_SERVICE_URL}/admin/annotation-types", user)
    _annotation_types_cache = (now, types)
    return types


@app.get("/annotation-types")
async def list_annotation_types(user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    return await _get_annotation_types(user)


class CreateAnnotationBody(BaseModel):
    study_id: str
    target_type: str = "instance"
    target_id: str
    mask_png_base64: str


@app.post("/annotations", status_code=201)
async def create_annotation(
    body: CreateAnnotationBody, user: CurrentUser = Depends(get_current_user)
) -> dict:
    mask_bytes = base64.b64decode(body.mask_png_base64)
    storage_key = upload_mask(mask_bytes)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{ANNOTATION_SERVICE_URL}/annotations/studies/{body.study_id}",
            params={"target_type": body.target_type, "target_id": body.target_id, "type_name": "freehand_mask"},
            json={"mask_storage_key": storage_key},
            headers=_auth_headers(user),
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


@app.get("/annotations")
async def list_annotations(
    target_type: str, target_id: str, user: CurrentUser = Depends(get_current_user)
) -> list[dict]:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{ANNOTATION_SERVICE_URL}/annotations/{target_type}/{target_id}", headers=_auth_headers(user)
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    annotations = resp.json()
    type_names = {t["id"]: t["name"] for t in await _get_annotation_types(user)}
    for annotation in annotations:
        annotation["type_name"] = type_names.get(annotation.get("type_id"))
        mask_key = (annotation.get("payload") or {}).get("mask_storage_key")
        if mask_key:
            annotation["mask_url"] = presigned_mask_url(mask_key)
    return annotations


class SaveMaskVolumeBody(BaseModel):
    study_id: str
    mask_gzip_base64: str
    labels: list[dict]
    objects: list[dict]
    # "draft" for a regular in-progress Save, "submitted" for the
    # annotator explicitly marking the case done via "Mark as Annotated"
    # -- forwarded as-is to annotation-service's create_annotation,
    # which rejects anything else (approved/rejected only ever come from
    # the reviewer-only /review endpoint).
    status: str = "draft"


@app.get("/series/{series_id}/mask-volume")
async def get_mask_volume(series_id: str, user: CurrentUser = Depends(get_current_user)) -> dict:
    """Returns the latest saved CVAT-style segmentation for this series:
    the 3D volume as gzip bytes (base64) plus the label/object
    definitions those voxel ids refer to -- the browser holds/edits the
    decompressed array itself (see ViewerPage.tsx), this service never
    interprets voxel values. A series with no saved segmentation yet
    answers 200 with `mask_gzip_base64: null` (the frontend starts from
    an empty volume, no labels/objects) -- it used to be a 404, which
    browsers log as an error on every first open of a fresh series."""
    resp = await _http_client.get(
        f"{ANNOTATION_SERVICE_URL}/annotations/series/{series_id}", headers=_auth_headers(user)
    )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    type_names = {t["id"]: t["name"] for t in await _get_annotation_types(user)}
    volume_annotations = [a for a in resp.json() if type_names.get(a.get("type_id")) == "segmentation_volume"]
    if not volume_annotations:
        return {"mask_gzip_base64": None, "labels": [], "objects": []}

    # The list endpoint doesn't return created_at, so "latest" relies on
    # Postgres returning unindexed rows in roughly insertion order (true
    # in practice for this app's low write volume) -- the last element is
    # the best available approximation of "most recently saved".
    payload = volume_annotations[-1]["payload"]
    gzip_bytes = download_bytes(payload["mask_volume_key"])
    return {
        "mask_gzip_base64": base64.b64encode(gzip_bytes).decode(),
        "labels": payload["labels"],
        "objects": payload["objects"],
    }


@app.post("/series/{series_id}/mask-volume", status_code=201)
async def save_mask_volume(
    series_id: str, body: SaveMaskVolumeBody, user: CurrentUser = Depends(get_current_user)
) -> dict:
    gzip_bytes = base64.b64decode(body.mask_gzip_base64)
    storage_key = upload_mask_volume(gzip_bytes)

    resp = await _http_client.post(
        f"{ANNOTATION_SERVICE_URL}/annotations/studies/{body.study_id}",
        params={
            "target_type": "series",
            "target_id": series_id,
            "type_name": "segmentation_volume",
            "status": body.status,
        },
        json={"mask_volume_key": storage_key, "labels": body.labels, "objects": body.objects},
        headers=_auth_headers(user),
    )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


# How many annotations exist per instance in a series, for the picker's
# "already annotated" badges -- fans the per-instance annotation-service
# lookups out with the same bounded-concurrency pattern _get_volume uses,
# since annotation-service has no bulk "by series" endpoint to call once.
_ANNOTATION_COUNT_CONCURRENCY = 16


@app.get("/series/{series_id}/annotation-counts")
async def get_annotation_counts(series_id: str, user: CurrentUser = Depends(get_current_user)) -> dict[str, int]:
    instances = await _proxy_get(f"{DATA_SERVICE_URL}/data/series/{series_id}/instances", user)
    semaphore = asyncio.Semaphore(_ANNOTATION_COUNT_CONCURRENCY)

    async def _count(instance_id: str) -> tuple[str, int]:
        async with semaphore:
            resp = await _http_client.get(
                f"{ANNOTATION_SERVICE_URL}/annotations/instance/{instance_id}", headers=_auth_headers(user)
            )
            resp.raise_for_status()
            return instance_id, len(resp.json())

    counts = await asyncio.gather(*(_count(i["id"]) for i in instances))
    return dict(counts)


async def _proxy_get(url: str, user: CurrentUser) -> list[dict]:
    """The admin-service/data-service picker reads below have no new logic
    of their own -- they exist purely because those services' own CORS
    allowlists are locked to admin-ui's origin, so the browser can't call
    them directly from this frontend's origin. Proxying through here
    (whose CORS is already configured for this frontend) avoids having to
    touch the main platform's config at all, matching every other route
    in this file."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(url, headers=_auth_headers(user))
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


@app.get("/studies")
async def list_studies(user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    return await _proxy_get(f"{ADMIN_SERVICE_URL}/admin/studies", user)


@app.get("/studies/{study_id}/cases")
async def list_cases(study_id: str, user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    return await _proxy_get(f"{DATA_SERVICE_URL}/data/studies/{study_id}/cases", user)


@app.get("/cases/{case_id}/imaging-studies")
async def list_imaging_studies(case_id: str, user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    return await _proxy_get(f"{DATA_SERVICE_URL}/data/cases/{case_id}/imaging-studies", user)


@app.get("/imaging-studies/{imaging_study_id}/series")
async def list_series(imaging_study_id: str, user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    return await _proxy_get(f"{DATA_SERVICE_URL}/data/imaging-studies/{imaging_study_id}/series", user)


@app.get("/series/{series_id}/instances")
async def list_instances(series_id: str, user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    instances = await _proxy_get(f"{DATA_SERVICE_URL}/data/series/{series_id}/instances", user)
    # data-service's thumbnails are signed links to its own /data/objects,
    # which this app's browser doesn't talk to -- point them at /objects
    # below, which relays them.
    for instance in instances:
        url = instance.get("thumbnail_url")
        if isinstance(url, str) and url.startswith("/data/objects?"):
            instance["thumbnail_url"] = "/objects?" + url.split("?", 1)[1]
    return instances


@app.get("/objects")
async def relay_object(request: Request) -> Response:
    """A data-service signed object link (a thumbnail), relayed. The
    signature is the access check -- data-service verifies it -- so no
    token, and it works as a plain <img src>."""
    resp = await _http_client.get(f"{DATA_SERVICE_URL}/data/objects", params=dict(request.query_params))
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "application/octet-stream"),
        headers={"Cache-Control": resp.headers.get("cache-control", "private, max-age=3600")},
    )


@app.get("/cases/{case_id}/documents")
async def list_case_documents(case_id: str, user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    """Proxies the case's clinical documents (admin-ui's own "Documents"
    section, data-service's clinical-data-items) -- backs the viewer's
    Documents tab, so an annotator can check the case's reports/notes
    without leaving the viewer for admin-ui."""
    return await _proxy_get(f"{DATA_SERVICE_URL}/data/cases/{case_id}/clinical-data-items", user)


@app.get("/documents/{item_id}/file-url")
async def get_document_file_url(item_id: str, user: CurrentUser = Depends(get_current_user)) -> dict:
    """Proxies a presigned, one-time download URL for a single document's
    file -- opened directly in a new browser tab, same as admin-ui's own
    DocumentModal already does."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{DATA_SERVICE_URL}/data/clinical-data-items/{item_id}/file-url", headers=_auth_headers(user))
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


@app.get("/documents/{item_id}/file")
async def get_document_file(item_id: str, user: CurrentUser = Depends(get_current_user)) -> Response:
    """The document's file itself, served inline -- what the viewer's
    in-page document preview reads (it renders PDFs page by page in the
    browser, which a tablet can't do from a bare presigned URL: iPadOS
    shows only a PDF's first page inside an <iframe>, and a "download"
    leaves the annotation screen). data-service's file-url endpoint is
    still the access check (a 403 there propagates as a 403 here); the
    bytes are read straight from the bucket by storage key, like
    _fetch_dicom_bytes, since the presigned URL is signed for the
    browser-facing host and isn't reachable from inside the network."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{DATA_SERVICE_URL}/data/clinical-data-items/{item_id}/file-url", headers=_auth_headers(user))
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    storage_key = resp.json().get("storage_key")
    if not storage_key:
        raise HTTPException(status_code=502, detail="data-service returned no storage key for this document")
    body, content_type = await asyncio.to_thread(download_object, storage_key)
    filename = storage_key.rsplit("/", 1)[-1]
    return Response(
        content=body,
        media_type=content_type,
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@app.get("/jobs/{job_id}/surface-config")
async def get_job_surface_config(job_id: str, user: CurrentUser = Depends(get_current_user)) -> dict:
    """Proxies admin-service's surface-config lookup for a workflow card
    (a job) -- same CORS reason as _proxy_get, just returning a dict
    instead of a list so it can't reuse that helper as-is."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{ADMIN_SERVICE_URL}/admin/workflow-cards/{job_id}/surface-config", headers=_auth_headers(user)
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


@app.get("/jobs/{job_id}/cases")
async def get_job_cases(job_id: str, user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    """Proxies the job's own case list (admin-service's
    _cases_with_annotated_status, the same data My Jobs' detail page
    lists) -- backs the viewer's Prev/Next case arrows so stepping
    through a whole Annotation/Review queue doesn't require going back
    to admin-ui between every case."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ADMIN_SERVICE_URL}/admin/workflow-cards/{job_id}/cases", headers=_auth_headers(user))
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


@app.post("/jobs/{job_id}/run")
async def run_job(job_id: str, user: CurrentUser = Depends(get_current_user)) -> dict:
    """Proxies a Run of the job's own workflow card -- called right after
    "Mark as Annotated" so a case the annotator just finished shows up
    immediately in that job's materialized "(annotated)" Dataset, instead
    of waiting for someone to click Run on the board. admin-service's own
    permission carve-out (the assignee may Run their own Annotation/
    Review card) is what actually authorizes this, not anything here."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{ADMIN_SERVICE_URL}/admin/workflow-cards/{job_id}/run", headers=_auth_headers(user))
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


class UsageEventsBody(BaseModel):
    events: list[dict]


@app.get("/usage/config")
async def usage_config(user: CurrentUser = Depends(get_current_user)) -> dict:
    """The caller's usage-recording switches, proxied from admin-service
    (whose CORS isn't open to this frontend's origin -- see _proxy_get).
    The frontend's tracker polls this so an admin flipping a switch on
    the Usage page reaches an open viewer tab too."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ADMIN_SERVICE_URL}/admin/usage/config", headers=_auth_headers(user))
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


@app.post("/usage/events")
async def usage_events(body: UsageEventsBody, user: CurrentUser = Depends(get_current_user)) -> dict:
    """Forwards the viewer's batched usage events verbatim; admin-service
    validates them, stamps the caller's subject and applies the switches."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{ADMIN_SERVICE_URL}/admin/usage/events", json=body.model_dump(), headers=_auth_headers(user))
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


@app.post("/usage/snapshots")
async def usage_snapshot(body: dict, user: CurrentUser = Depends(get_current_user)) -> dict:
    """Forwards one screen snapshot (see the tracker's captureSnapshot)
    verbatim; admin-service cleans it, stamps the caller and applies the
    switches. A snapshot can be a few hundred KB, hence the timeout."""
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{ADMIN_SERVICE_URL}/admin/usage/snapshots", json=body, headers=_auth_headers(user))
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


class SubmitAnnotationReviewBody(BaseModel):
    decision: str
    comment: str | None = None


@app.post("/annotations/{annotation_id}/review")
async def submit_annotation_review(
    annotation_id: str, body: SubmitAnnotationReviewBody, user: CurrentUser = Depends(get_current_user)
) -> dict:
    """Proxies the real approve/reject decision (Annotation.status) to
    annotation-service -- the same endpoint admin-ui's ReviewQueuePanel
    already calls, just reachable from ct-annotator's own "Submit
    review" (see ViewerPage's handleSubmitReview) so the reviewer's
    object-by-object Accept/Reject actually lands somewhere the rest of
    the platform (annotation_progress, My Jobs' "Annotated" status)
    already knows how to read, instead of staying a payload-only detail
    nothing else sees. Requires the caller to actually hold the
    "reviewer" (or "admin") study role -- annotation-service's own
    role check is what enforces that, not anything here."""
    params = {"decision": body.decision}
    if body.comment:
        params["comment"] = body.comment
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{ANNOTATION_SERVICE_URL}/annotations/{annotation_id}/review",
            params=params,
            headers=_auth_headers(user),
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
