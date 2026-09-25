import { API } from "../config";
import { ApiError, apiFetch } from "./client";
import keycloak from "../keycloak";
import type { ObjectAnswers, ObjectField } from "../components/ObjectForm";

export interface InstanceMetadata {
  rows: number | null;
  columns: number | null;
  window_center: number | null;
  window_width: number | null;
  rescale_slope: number;
  rescale_intercept: number;
}

export function getInstanceMetadata(instanceId: string): Promise<InstanceMetadata> {
  return apiFetch(API.annotator, `/instances/${instanceId}/metadata`);
}

/** Fetches a rendered PNG as a blob URL -- a plain <img>/<canvas> src
 * can't attach an Authorization header itself, so this can't just be a
 * bare URL string; the caller must fetch it via this function and
 * revoke the returned URL (`URL.revokeObjectURL`) once no longer needed. */
async function fetchBlobUrl(path: string, params: Record<string, string | number | null>): Promise<string> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) search.set(key, String(value));
  }
  const query = search.toString() ? `?${search.toString()}` : "";

  const response = await fetch(`${API.annotator}${path}${query}`, {
    headers: { Authorization: `Bearer ${keycloak.token}` },
  });
  if (!response.ok) {
    const raw = await response.text();
    // FastAPI's own error shape is {"detail": "..."} -- unwrap it so a
    // caller (e.g. the sagittal/coronal "not a real volume" case) can
    // show the human-readable reason directly, not raw JSON.
    let message = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.detail === "string") message = parsed.detail;
    } catch {
      // Not JSON -- use the raw body as-is.
    }
    throw new ApiError(response.status, message);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

// `sharpen` is an unsharp-mask amount applied server-side, after
// windowing (see backend/app/dicom_render.py's _unsharp_mask) -- 0 or
// null renders exactly as before (no filter pass at all, not just a
// zero-strength one). Optional and defaulted to null on every caller
// below so existing call sites (before the Sharpness slider existed)
// keep compiling.
export function fetchAxialBlobUrl(
  instanceId: string,
  wc: number | null,
  ww: number | null,
  sharpen: number | null = null
): Promise<string> {
  return fetchBlobUrl(`/instances/${instanceId}/render.png`, { wc, ww, sharpen });
}

/** Sagittal/coronal are reconstructed from the whole series' volume on
 * the backend (see backend/app/main.py's _get_volume) -- `x`/`y` are
 * pixel indices into the axial plane's columns/rows respectively. */
export function fetchSagittalBlobUrl(
  seriesId: string,
  x: number,
  wc: number | null,
  ww: number | null,
  sharpen: number | null = null
): Promise<string> {
  return fetchBlobUrl(`/series/${seriesId}/sagittal.png`, { x, wc, ww, sharpen });
}

export function fetchCoronalBlobUrl(
  seriesId: string,
  y: number,
  wc: number | null,
  ww: number | null,
  sharpen: number | null = null
): Promise<string> {
  return fetchBlobUrl(`/series/${seriesId}/coronal.png`, { y, wc, ww, sharpen });
}

export type SlabMode = "avg" | "mip" | "minip";

/** A thick slice on any plane: `thickness` neighbouring slices around
 * `index` averaged, or projected by maximum (MIP) / minimum (MinIP)
 * intensity -- see the backend's /series/{id}/slab.png. `index` is the
 * slice for axial, the column for sagittal, the row for coronal. */
export function fetchSlabBlobUrl(
  seriesId: string,
  plane: "axial" | "sagittal" | "coronal",
  index: number,
  thickness: number,
  mode: SlabMode,
  wc: number | null,
  ww: number | null,
  sharpen: number | null = null
): Promise<string> {
  return fetchBlobUrl(`/series/${seriesId}/slab.png`, { plane, index, thickness, mode, wc, ww, sharpen });
}

/** The Hounsfield-unit value at one voxel -- backs the viewer's Alt+click
 * readout. `x`/`y`/`z` are volume-space indices (columns/rows/slice),
 * same convention as the mask volume's own maskIndex in ViewerPage. */
export function fetchVoxelHU(seriesId: string, x: number, y: number, z: number): Promise<number> {
  return apiFetch<{ hu: number }>(API.annotator, `/series/${seriesId}/voxel-value?x=${x}&y=${y}&z=${z}`).then(
    (r) => r.hu
  );
}

export interface PlaneHU {
  data: Int16Array;
  width: number;
  height: number;
  x0: number;
  y0: number;
}

/** Raw Hounsfield-unit values for a rectangular box within one plane's
 * current slice -- backs the auto-contour tool's region-growing preview,
 * which runs entirely client-side against this once it's fetched (see
 * ViewerPage's autoPreviewMask) rather than round-tripping per tolerance
 * change. Binary transfer (int16, little-endian) rather than JSON since
 * a box can be tens of thousands of pixels. `x0`/`y0` in the response
 * reflect the *clamped* box origin (may differ from the request if the
 * drawn box crossed the image edge), needed to map filled pixels back
 * to the pane's native slice-pixel space when committing. */
export async function fetchPlaneHU(
  seriesId: string,
  pane: "axial" | "sagittal" | "coronal",
  index: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): Promise<PlaneHU> {
  const params = new URLSearchParams({
    pane,
    index: String(index),
    x0: String(x0),
    y0: String(y0),
    x1: String(x1),
    y1: String(y1),
  });
  const response = await fetch(`${API.annotator}/series/${seriesId}/plane-hu?${params}`, {
    headers: { Authorization: `Bearer ${keycloak.token}` },
  });
  if (!response.ok) throw new Error(`HU fetch failed: ${response.status} ${await response.text()}`);
  const buffer = await response.arrayBuffer();
  return {
    data: new Int16Array(buffer),
    width: Number(response.headers.get("X-Box-Width")),
    height: Number(response.headers.get("X-Box-Height")),
    x0: Number(response.headers.get("X-Box-X0")),
    y0: Number(response.headers.get("X-Box-Y0")),
  };
}

// base64ToArrayBuffer is declared further down in this file -- a plain
// function declaration, hoisted, so referencing it here (before its
// textual position) is fine.

async function gunzipToUint8Array(gzipBytes: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([gzipBytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface LungMask {
  data: Uint8Array; // 1 = lung voxel, 0 = not -- same numSlices*rows*columns index convention as the mask volume
  numSlices: number;
  rows: number;
  columns: number;
}

/** A whole-series boolean lung mask, auto-segmented server-side from
 * the HU volume (threshold + connected-component filtering -- see
 * backend/app/main.py's _segment_lungs) -- backs the 3D pane's "Lung"
 * toggle, which runs the same client-side marching cubes it already
 * uses for painted objects against this. Gzip+base64-encoded exactly
 * like the mask-volume endpoints' own payload. */
export async function fetchLungMask(seriesId: string): Promise<LungMask> {
  const result = await apiFetch<{ mask_gzip_base64: string; num_slices: number; rows: number; columns: number }>(
    API.annotator,
    `/series/${seriesId}/lung-mask`
  );
  const data = await gunzipToUint8Array(base64ToArrayBuffer(result.mask_gzip_base64));
  return { data, numSlices: result.num_slices, rows: result.rows, columns: result.columns };
}

export interface SurfaceConfig {
  tools: string[];
  panes: string[];
  show_3d: boolean;
  // Labels an Annotation Surface pre-defines for this job (e.g.
  // "Nodule") -- seeded into ViewerPage's own label list the first time
  // a series with no saved annotation yet loads, so every annotator on
  // the job creates instances under the same name/color instead of each
  // typing their own. Empty for an unrestricted job or a Review one.
  // `fields` is the label's per-object form (see components/ObjectForm.tsx):
  // what an annotator fills for each instance next to its comment.
  // For a Review job the labels come from the upstream Annotation
  // job's surface, so the reviewer sees the same form.
  labels: { name: string; color: string; fields?: ObjectField[] }[];
  // The underlying job's own card type ("annotation" or "review") --
  // lets the viewer tell a Review job apart from an Annotation one and
  // switch to the simplified, view-and-decide-only review surface.
  card_type: string;
  // The job's own todo/in_progress/done status -- see updateJobStatus.
  status: string;
}

/** The mandatory tool/pane/3D restriction for a job (a workflow card id
 * passed as `jobId` in the viewer's URL) -- proxied through this
 * backend to admin-service (see backend/app/main.py's
 * get_job_surface_config), same CORS reason as every other admin-service
 * read here. Returns the permissive default (everything enabled) when
 * no Surface card is connected to the job, so a restricted-looking
 * response is only ever a deliberate configuration. */
export function fetchSurfaceConfig(jobId: string): Promise<SurfaceConfig> {
  return apiFetch(API.annotator, `/jobs/${jobId}/surface-config`);
}

/** Re-runs the job's own workflow card -- called right after "Mark as
 * Annotated" so the case shows up immediately in that job's
 * materialized "(annotated)" Dataset (if materialize_dataset is on)
 * instead of waiting for someone to click Run on the board. Authorized
 * on the admin-service side by a self-service carve-out (the assignee
 * may Run their own Annotation/Review card); failures here are
 * swallowed by the caller rather than surfaced as a save error, since
 * the save itself already succeeded. */
export interface JobRunResult {
  // Present for Annotation/Review cards -- how many of the job's cases
  // (across the whole job, not just the one just saved) already have a
  // real submitted-or-later annotation. Used to tell "one case done" apart
  // from "the whole job is done" when deciding whether to auto-advance
  // the job's own status (see ViewerPage's handleSave).
  annotation_progress?: { annotated: number; total: number };
}

export function runJob(jobId: string): Promise<JobRunResult> {
  return apiFetch(API.annotator, `/jobs/${jobId}/run`, { method: "POST" });
}

export interface JobCase {
  id: string;
  title: string;
  status: "pending" | "done" | "rejected";
  latest_annotation_id: string | null;
  // Review jobs only -- the id of a still-SUBMITTED (undecided)
  // annotation on this case, null once it's been approved/rejected.
  pending_annotation_id?: string | null;
}

/** Every case in this job (Annotation or Review), in the same scope
 * admin-ui's My Jobs detail page lists -- backs the viewer's Prev/Next
 * case arrows so a whole job's queue can be stepped through without
 * returning to admin-ui between cases. */
export function fetchJobCases(jobId: string): Promise<JobCase[]> {
  return apiFetch(API.annotator, `/jobs/${jobId}/cases`);
}

/** The real approve/reject decision on an Annotation record (its
 * `status`) -- the same action admin-ui's ReviewQueuePanel already
 * performs, reachable here so ct-annotator's review mode ("Submit
 * review") can act on the object-by-object Accept/Reject the reviewer
 * just did, instead of that only ever living in the payload. Requires
 * the caller to actually hold the "reviewer"/"admin" study role. */
export function submitAnnotationReview(
  annotationId: string,
  decision: "approve" | "reject",
  comment?: string
): Promise<unknown> {
  return apiFetch(API.annotator, `/annotations/${annotationId}/review`, {
    method: "POST",
    body: JSON.stringify(comment ? { decision, comment } : { decision }),
  });
}

export interface AnnotationSummary {
  id: string;
  status: string;
  type_id: string;
  type_name: string | null;
  payload: { mask_storage_key?: string };
  mask_url?: string;
}

export function listAnnotations(targetType: string, targetId: string): Promise<AnnotationSummary[]> {
  return apiFetch(API.annotator, `/annotations?target_type=${targetType}&target_id=${targetId}`);
}

export interface AnnotationType {
  id: string;
  name: string;
}

export function listAnnotationTypes(): Promise<AnnotationType[]> {
  return apiFetch(API.annotator, "/annotation-types");
}

/** instance id -> annotation count, for the picker's "already annotated"
 * badges. One call per series, not per instance -- see the backend's
 * get_annotation_counts, which fans this out server-side instead. */
export function getAnnotationCounts(seriesId: string): Promise<Record<string, number>> {
  return apiFetch(API.annotator, `/series/${seriesId}/annotation-counts`);
}

export function createAnnotation(
  studyId: string,
  targetId: string,
  maskPngBase64: string
): Promise<{ id: string; status: string }> {
  return apiFetch(API.annotator, "/annotations", {
    method: "POST",
    body: JSON.stringify({
      study_id: studyId,
      target_type: "instance",
      target_id: targetId,
      mask_png_base64: maskPngBase64,
    }),
  });
}

// CVAT-style multi-object segmentation: a volume voxel stores an
// *object id* (0 = background), not just painted/unpainted -- labels
// are reusable named/colored categories, objects are concrete numbered
// instances of a label (e.g. "Nodule 1"). See
// ~/.claude/plans/unified-splashing-blossom.md.
export interface SegLabel {
  id: number;
  name: string;
  color: string;
  // The per-object form this label carries (components/ObjectForm.tsx),
  // copied from the Annotation Surface when the label is seeded so the
  // definition is saved with the annotation itself.
  fields?: ObjectField[];
}

export interface SegObject {
  id: number;
  label_id: number;
  instance_number: number;
  locked: boolean;
  hidden: boolean;
  comment?: string;
  // Set by the simplified Review surface (see ViewerPage's reviewMode);
  // absent/undefined is treated the same as "pending" -- an object an
  // annotator created is never implicitly accepted or rejected.
  review_status?: "pending" | "accepted" | "rejected";
  // Why the reviewer rejected it, picked from REJECT_REASONS (ViewerPage)
  // -- the categories the Usage page counts.
  reject_reason?: string;
  // The reviewer's comment to the annotator on this object -- apart from
  // the annotator's own `comment` (F-02).
  review_comment?: string;
  // The last finished review round's verdict, kept when the case is
  // handed in again (see lib/reviewRound.ts, F-06).
  previous_review?: { status: "accepted" | "rejected"; reject_reason?: string; review_comment?: string };
  // The label's form filled for this object (field name -> true for a
  // tick, the chosen option, or the scale's number) -- see
  // components/ObjectForm.tsx.
  attributes?: ObjectAnswers;
}

export interface SegmentationVolume {
  gzipBytes: ArrayBuffer;
  labels: SegLabel[];
  objects: SegObject[];
}

/** What a series' saved segmentation is: the volume (null when nothing
 * has been saved yet) and the id of that saved version -- sent back with
 * the next save so a newer save by someone else is never overwritten. */
export interface LoadedSegmentation {
  volume: SegmentationVolume | null;
  versionId: string | null;
  // The loaded version's status and, for a reviewer's draft, the handed-in
  // version it reviews -- see lib/reviewState.ts.
  versionStatus: string | null;
  reviewOfId: string | null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000; // fromCharCode has an argument-count limit, so encode in chunks
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Fetches the series' saved segmentation (volume + label/object
 * definitions), or null if none has been saved yet -- the caller
 * (ViewerPage) ungzips the volume into its own Uint8Array; this backend
 * never interprets voxel values or the label/object payload. */
export async function fetchSegmentationVolume(seriesId: string): Promise<LoadedSegmentation> {
  const result = await apiFetch<{
    mask_gzip_base64: string | null;
    labels: SegLabel[];
    objects: SegObject[];
    version_id?: string | null;
    version_status?: string | null;
    review_of_id?: string | null;
  }>(API.annotator, `/series/${seriesId}/mask-volume`);
  const version = { versionId: result.version_id ?? null, versionStatus: result.version_status ?? null, reviewOfId: result.review_of_id ?? null };
  // no volume = nothing saved for this series yet (a normal 200 answer,
  // see the backend's get_mask_volume) -- start from an empty volume.
  if (!result.mask_gzip_base64) return { volume: null, ...version };
  return { volume: { gzipBytes: base64ToArrayBuffer(result.mask_gzip_base64), labels: result.labels, objects: result.objects }, ...version };
}

export function saveSegmentationVolume(
  seriesId: string,
  studyId: string,
  gzipBytes: ArrayBuffer,
  labels: SegLabel[],
  objects: SegObject[],
  // "draft" (default) for a regular Save; "submitted" for "Mark as
  // Annotated" -- see ViewerPage's handleSave.
  status: "draft" | "submitted" = "draft",
  // The version this save was edited from (null = the series had nothing
  // saved): a newer save made meanwhile makes this one fail with 409.
  baseVersionId?: string | null,
  // Set while reviewing: the handed-in version under review, so this save
  // is a reviewer's draft that keeps the case handed in (F-01).
  reviewOf?: string | null
): Promise<{ id: string; status: string }> {
  return apiFetch(API.annotator, `/series/${seriesId}/mask-volume`, {
    method: "POST",
    body: JSON.stringify({
      study_id: studyId,
      mask_gzip_base64: arrayBufferToBase64(gzipBytes),
      labels,
      objects,
      status,
      ...(baseVersionId !== undefined ? { base_version_id: baseVersionId ?? "" } : {}),
      ...(reviewOf ? { review_of: reviewOf } : {}),
    }),
  });
}
