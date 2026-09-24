/** The Auto tool's region grow, DOM/React-free so it can be unit tested.
 *
 * A structure is picked by a HU *range* [low, high] rather than "within
 * ± tolerance of the centre pixel": a nodule with a calcified core has a
 * centre far brighter than its soft tissue, so a tolerance around that
 * centre either stays inside the calcification or has to be so wide it
 * swallows the lung. With a range the natural choice is "denser than the
 * lung around it" -- no upper bound, so calcification is simply part of
 * it -- and suggestRange picks that split from the box itself.
 *
 * Grown from the in-range pixel nearest the box centre (the centre
 * itself may fall in a gap), 4-connected; with fillHoles, anything the
 * region fully encloses (a calcification kept out by a lower `high`, an
 * air bubble, a vessel end-on) is filled in too. */
import { scanlineFill } from "./scanlineFill";

export const HU_MIN = -1024;
export const HU_MAX = 3071;

export interface HuPatch {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

/** Otsu's threshold over the patch's values: the split that best
 * separates it into two classes (lung vs tissue, typically). */
export function otsuThreshold(values: ArrayLike<number>, binSize = 8): number {
  const n = values.length;
  if (n === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = Math.max(HU_MIN, Math.min(HU_MAX, values[i]));
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < binSize) return Math.round((min + max) / 2);
  const bins = Math.ceil((max - min + 1) / binSize);
  const hist = new Float64Array(bins);
  for (let i = 0; i < n; i++) hist[Math.floor((Math.max(HU_MIN, Math.min(HU_MAX, values[i])) - min) / binSize)] += 1;
  let total = 0;
  for (let b = 0; b < bins; b++) total += b * hist[b];
  let weightLow = 0;
  let sumLow = 0;
  let best = -1;
  let split = 0;
  for (let b = 0; b < bins; b++) {
    weightLow += hist[b];
    if (weightLow === 0) continue;
    const weightHigh = n - weightLow;
    if (weightHigh === 0) break;
    sumLow += b * hist[b];
    const meanLow = sumLow / weightLow;
    const meanHigh = (total - sumLow) / weightHigh;
    const between = weightLow * weightHigh * (meanLow - meanHigh) ** 2;
    if (between > best) {
      best = between;
      split = b;
    }
  }
  return Math.round(min + (split + 1) * binSize);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** The range to start from: the box split in two (Otsu), and whichever
 * side its centre belongs to -- for a nodule, "denser than the lung",
 * open at the top so a calcified core is included. */
export function suggestRange(patch: HuPatch): { low: number; high: number } {
  const t = otsuThreshold(patch.data);
  const cx = Math.floor(patch.width / 2);
  const cy = Math.floor(patch.height / 2);
  const r = Math.max(1, Math.floor(Math.min(patch.width, patch.height) / 8));
  const around: number[] = [];
  for (let y = Math.max(0, cy - r); y <= Math.min(patch.height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(patch.width - 1, cx + r); x++) around.push(patch.data[y * patch.width + x]);
  }
  return median(around) >= t ? { low: t, high: HU_MAX } : { low: HU_MIN, high: t };
}

/** The in-range pixel nearest the centre, searching outward ring by ring. */
export function nearestSeed(patch: HuPatch, inRange: (v: number) => boolean): { x: number; y: number } | null {
  const cx = Math.floor(patch.width / 2);
  const cy = Math.floor(patch.height / 2);
  const maxR = Math.max(patch.width, patch.height);
  for (let r = 0; r <= maxR; r++) {
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue; // this ring only
        if (x < 0 || y < 0 || x >= patch.width || y >= patch.height) continue;
        if (!inRange(patch.data[y * patch.width + x])) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    if (best) return { x: best.x, y: best.y };
  }
  return null;
}

/** Fills every region `mask` fully encloses: whatever the outside can't
 * reach from the patch border without crossing the mask. */
export function fillHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
  const outside = new Uint8Array(width * height);
  const reach = (sx: number, sy: number) => {
    if (mask[sy * width + sx] || outside[sy * width + sx]) return;
    const grown = scanlineFill(width, height, sx, sy, (x, y) => !mask[y * width + x] && !outside[y * width + x]);
    for (let i = 0; i < grown.length; i++) if (grown[i]) outside[i] = 1;
  };
  for (let x = 0; x < width; x++) {
    reach(x, 0);
    reach(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    reach(0, y);
    reach(width - 1, y);
  }
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] || !outside[i] ? 1 : 0;
  return out;
}

/** The region: pixels in [low, high] connected to the seed nearest the
 * centre, holes filled when asked. All zero when nothing is in range. */
export function growRegion(patch: HuPatch, range: { low: number; high: number }, opts: { fillHoles?: boolean } = {}): Uint8Array {
  const inRange = (v: number) => v >= range.low && v <= range.high;
  const seed = nearestSeed(patch, inRange);
  if (!seed) return new Uint8Array(patch.width * patch.height);
  const region = scanlineFill(patch.width, patch.height, seed.x, seed.y, (x, y) => inRange(patch.data[y * patch.width + x]));
  return opts.fillHoles ? fillHoles(region, patch.width, patch.height) : region;
}
