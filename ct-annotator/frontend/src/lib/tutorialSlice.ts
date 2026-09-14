/** The Tutorial job's image: a real, de-identified chest CT already
 * loaded on the platform (the same LIDC-IDRI research series used
 * elsewhere in this platform's own test data -- see
 * public/tutorial-data/chest-ct.json's `sourceSeries`), not a computer-
 * generated picture. It's shipped as a small static asset (the FULL
 * series, in-plane downsampled, raw Hounsfield values) instead of being
 * fetched live through the authenticated per-study API, so the tutorial
 * keeps working for anyone regardless of which studies they're a member
 * of -- but every slice, and real sagittal/coronal reconstructions
 * through the whole stack, are still genuine, not a stand-in. */

export const TUTORIAL_SIZE = 256;
export const TUTORIAL_SLICES = 95;

/** All three MPR panes -- every one of them is a real drawing surface
 * (paint/erase/fill/polygon/auto/histogram all work on any of them),
 * matching the real viewer's own `handlePanePointerDown`. */
export type PaneKey = "sagittal" | "coronal" | "axial";

/** Pixel dimensions of a pane's own 2D image: the axial plane is a
 * square in-plane slice (TUTORIAL_SIZE x TUTORIAL_SIZE); the sagittal/
 * coronal reconstructions are TUTORIAL_SLICES rows (the z axis) by
 * TUTORIAL_SIZE columns (the other in-plane axis) -- see
 * sagittalView/coronalView below. Needed anywhere a mask or hu view for
 * a specific pane is built or walked. */
export function paneDims(pane: PaneKey): { width: number; height: number } {
  return pane === "axial" ? { width: TUTORIAL_SIZE, height: TUTORIAL_SIZE } : { width: TUTORIAL_SIZE, height: TUTORIAL_SLICES };
}
// A major vessel cross-section near the mediastinum, real and visible
// on most of these slices -- the tutorial's practice target, and the
// default position for the sagittal/coronal cut planes.
export const TARGET_X = 140.7;
export const TARGET_Y = 112.3;
export const TARGET_SLICE = 47;

// import.meta.env.BASE_URL (always slash-terminated) is Vite's own
// `base` config (see vite.config.ts) -- a plain "/tutorial-data/..."
// literal here would keep pointing at the domain root even when this
// app is deployed under a sub-path (e.g. /viewer/...), silently
// fetching whatever else happens to live at the real root (a 401-byte
// HTML page in that case, not the ~12MB volume) instead of a 404 --
// the RangeError from Int16Array's length check is what actually
// surfaces that, several layers away from the real cause.
const ASSET_BASE = `${import.meta.env.BASE_URL}tutorial-data/chest-ct`;

let volumePromise: Promise<Int16Array> | null = null;

/** Fetches the whole baked volume once (cached across the app's
 * lifetime, not just one page visit) and returns it as one flat
 * Int16Array of TUTORIAL_SLICES * TUTORIAL_SIZE^2 values, slice-major
 * (z * SIZE * SIZE + y * SIZE + x). */
export function loadTutorialVolume(): Promise<Int16Array> {
  if (!volumePromise) {
    volumePromise = fetch(`${ASSET_BASE}.bin`)
      .then((r) => {
        if (!r.ok) throw new Error(`Couldn't load the tutorial image (${r.status})`);
        return r.arrayBuffer();
      })
      .then((buf) => new Int16Array(buf));
  }
  return volumePromise;
}

/** A view into one axial slice of an already-loaded volume -- no copy. */
export function axialView(volume: Int16Array, index: number): Int16Array {
  const n = TUTORIAL_SIZE * TUTORIAL_SIZE;
  const clamped = Math.max(0, Math.min(index, TUTORIAL_SLICES - 1));
  return volume.subarray(clamped * n, (clamped + 1) * n);
}

/** A real sagittal reconstruction at a fixed column x: TUTORIAL_SLICES
 * rows (one per axial slice, front-to-back order matches the volume's
 * own z order) by TUTORIAL_SIZE columns (the in-plane y axis) -- the
 * same way the production viewer's own sagittal plane is built
 * (`volume[:, :, x]`), just done here client-side since the whole
 * volume is already in memory. A copy, not a view, since the source
 * voxels aren't contiguous. */
export function sagittalView(volume: Int16Array, x: number): Int16Array {
  const n = TUTORIAL_SIZE;
  const cx = Math.max(0, Math.min(Math.round(x), n - 1));
  const out = new Int16Array(TUTORIAL_SLICES * n);
  for (let z = 0; z < TUTORIAL_SLICES; z++) {
    const sliceOffset = z * n * n;
    for (let y = 0; y < n; y++) out[z * n + y] = volume[sliceOffset + y * n + cx];
  }
  return out;
}

/** A real coronal reconstruction at a fixed row y -- see sagittalView's
 * own comment; same idea (`volume[:, y, :]`), the other in-plane axis. */
export function coronalView(volume: Int16Array, y: number): Int16Array {
  const n = TUTORIAL_SIZE;
  const cy = Math.max(0, Math.min(Math.round(y), n - 1));
  const out = new Int16Array(TUTORIAL_SLICES * n);
  for (let z = 0; z < TUTORIAL_SLICES; z++) {
    const sliceOffset = z * n * n + cy * n;
    for (let x = 0; x < n; x++) out[z * n + x] = volume[sliceOffset + x];
  }
  return out;
}

/** A live, mutable view into one axial slice of the mask VOLUME -- a
 * subarray shares the same backing buffer, so painting into it commits
 * immediately, the same as axialView's own hu view. The mask volume is
 * laid out exactly like the CT volume itself (slice-major, one byte per
 * voxel: the object id painted there, or 0), so every pane can share
 * one mask covering the whole practice case rather than each pane only
 * ever remembering paint on its own current slice. */
export function axialMaskView(mask: Uint8Array, z: number): Uint8Array {
  const n = TUTORIAL_SIZE * TUTORIAL_SIZE;
  const clamped = Math.max(0, Math.min(z, TUTORIAL_SLICES - 1));
  return mask.subarray(clamped * n, (clamped + 1) * n);
}

/** A COPY of the mask volume's sagittal plane at column x -- the same
 * non-contiguous gather sagittalView does for HU values, since those
 * voxels aren't contiguous in the volume's own slice-major layout.
 * Pair with writeSagittalMaskView to commit edits back into the mask
 * volume after drawing into this view. */
export function sagittalMaskView(mask: Uint8Array, x: number): Uint8Array {
  const n = TUTORIAL_SIZE;
  const cx = Math.max(0, Math.min(Math.round(x), n - 1));
  const out = new Uint8Array(TUTORIAL_SLICES * n);
  for (let z = 0; z < TUTORIAL_SLICES; z++) {
    const sliceOffset = z * n * n;
    for (let y = 0; y < n; y++) out[z * n + y] = mask[sliceOffset + y * n + cx];
  }
  return out;
}
export function writeSagittalMaskView(mask: Uint8Array, x: number, view: Uint8Array): void {
  const n = TUTORIAL_SIZE;
  const cx = Math.max(0, Math.min(Math.round(x), n - 1));
  for (let z = 0; z < TUTORIAL_SLICES; z++) {
    const sliceOffset = z * n * n;
    for (let y = 0; y < n; y++) mask[sliceOffset + y * n + cx] = view[z * n + y];
  }
}

/** Coronal counterpart of sagittalMaskView/writeSagittalMaskView --
 * same idea, the other fixed in-plane axis (row y instead of column x). */
export function coronalMaskView(mask: Uint8Array, y: number): Uint8Array {
  const n = TUTORIAL_SIZE;
  const cy = Math.max(0, Math.min(Math.round(y), n - 1));
  const out = new Uint8Array(TUTORIAL_SLICES * n);
  for (let z = 0; z < TUTORIAL_SLICES; z++) {
    const sliceOffset = z * n * n + cy * n;
    for (let x = 0; x < n; x++) out[z * n + x] = mask[sliceOffset + x];
  }
  return out;
}
export function writeCoronalMaskView(mask: Uint8Array, y: number, view: Uint8Array): void {
  const n = TUTORIAL_SIZE;
  const cy = Math.max(0, Math.min(Math.round(y), n - 1));
  for (let z = 0; z < TUTORIAL_SLICES; z++) {
    const sliceOffset = z * n * n + cy * n;
    for (let x = 0; x < n; x++) mask[sliceOffset + x] = view[z * n + x];
  }
}

/** Standard CT windowing: maps one HU value to a 0-255 grey level for a
 * given center/width -- the exact formula a real viewer uses. */
export function windowToGrey(hu: number, center: number, width: number): number {
  const lo = center - width / 2;
  const v = ((hu - lo) / width) * 255;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

const hexCache = new Map<string, [number, number, number]>();
function hexToRgb(hex: string): [number, number, number] {
  let rgb = hexCache.get(hex);
  if (!rgb) {
    const n = parseInt(hex.slice(1), 16);
    rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    hexCache.set(hex, rgb);
  }
  return rgb;
}

/** Renders one windowed plane, optionally with an object mask
 * composited on top, into a canvas via putImageData in one pass.
 * `mask`/`colorForObjectId` are only meaningful for the axial (drawing)
 * plane -- pass `null` for the read-only sagittal/coronal planes. Width
 * and height are independent since a sagittal/coronal reconstruction
 * isn't square like the axial pane. */
export function renderPlane(
  ctx: CanvasRenderingContext2D,
  hu: Int16Array,
  width: number,
  height: number,
  mask: Uint8Array | null,
  colorForObjectId: ((id: number) => string | null) | null,
  windowCenter: number,
  windowWidth: number,
  sharpness: number,
  overlayOpacity: number
): void {
  const img = ctx.createImageData(width, height);
  const alpha = overlayOpacity / 100;
  const colorCache = new Map<number, [number, number, number]>();
  for (let i = 0; i < width * height; i++) {
    let g = windowToGrey(hu[i], windowCenter, windowWidth);
    if (sharpness > 0) {
      g = 128 + (g - 128) * (1 + sharpness * 0.15);
      g = g < 0 ? 0 : g > 255 ? 255 : g;
    }
    const o = i * 4;
    const objId = mask ? mask[i] : 0;
    if (objId !== 0 && alpha > 0 && colorForObjectId) {
      let rgb = colorCache.get(objId);
      if (!rgb) {
        const hex = colorForObjectId(objId);
        rgb = hex ? hexToRgb(hex) : [255, 255, 255];
        colorCache.set(objId, rgb);
      }
      img.data[o] = g * (1 - alpha) + rgb[0] * alpha;
      img.data[o + 1] = g * (1 - alpha) + rgb[1] * alpha;
      img.data[o + 2] = g * (1 - alpha) + rgb[2] * alpha;
    } else {
      img.data[o] = g;
      img.data[o + 1] = g;
      img.data[o + 2] = g;
    }
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Flood-fills `mask` starting at (x0, y0) with `objectId`, spreading to
 * 4-connected neighbours whose HU is within `tolerance` of the seed --
 * backs both the Fill tool (fixed tolerance, whole plane) and the Auto
 * tool (tolerance from its slider, constrained to a drag box). `width`/
 * `height` describe the 2D plane being walked -- TUTORIAL_SIZE square
 * for the axial pane, TUTORIAL_SIZE x TUTORIAL_SLICES for a sagittal/
 * coronal reconstruction (see paneDims), since those aren't square.
 * Returns the number of pixels painted. */
export function floodFillMask(
  hu: Int16Array,
  mask: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  objectId: number,
  tolerance: number,
  bounds?: { x0: number; y0: number; x1: number; y1: number }
): number {
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return 0;
  const seed = hu[y0 * width + x0];
  const bx0 = bounds ? Math.max(0, bounds.x0) : 0;
  const by0 = bounds ? Math.max(0, bounds.y0) : 0;
  const bx1 = bounds ? Math.min(width - 1, bounds.x1) : width - 1;
  const by1 = bounds ? Math.min(height - 1, bounds.y1) : height - 1;
  const visited = new Uint8Array(width * height);
  const stack: number[] = [x0, y0];
  let painted = 0;
  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
    const i = y * width + x;
    if (visited[i]) continue;
    visited[i] = 1;
    if (Math.abs(hu[i] - seed) > tolerance) continue;
    mask[i] = objectId;
    painted++;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  return painted;
}

/** Real min/mean/max plus an 8-bucket histogram of the HU values inside
 * a rectangular region -- genuine numbers read from the real CT data.
 * `width`/`height` are the enclosing plane's own dimensions (see
 * floodFillMask's own comment on why that varies by pane). */
export function regionHistogram(
  hu: Int16Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): { min: number; max: number; mean: number; buckets: number[] } {
  const bx0 = Math.max(0, Math.min(x0, x1));
  const bx1 = Math.min(width - 1, Math.max(x0, x1));
  const by0 = Math.max(0, Math.min(y0, y1));
  const by1 = Math.min(height - 1, Math.max(y0, y1));
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  const values: number[] = [];
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const v = hu[y * width + x];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      count++;
      values.push(v);
    }
  }
  const buckets = new Array(8).fill(0);
  const range = max - min || 1;
  for (const v of values) {
    const b = Math.min(7, Math.floor(((v - min) / range) * 8));
    buckets[b]++;
  }
  return { min, max, mean: count > 0 ? sum / count : 0, buckets };
}
