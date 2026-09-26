/** Text for an object's measurements (api ObjectStats) and the slices it
 * is painted on -- the review card's numbers and slice list (UX-rev-1-17,
 * UX-rev-2-06: a reviewer walked every slice and guessed the diameter). */
import type { ObjectDistance, ObjectStats } from "../api/annotatorApi";

/** Above this share of air (< -500 HU) a mask is flagged: painted over lung. */
export const AIR_WARNING_SHARE = 0.25;

/** "slices 29–34 · 1.20 mL · long axis 18.4 mm (slice 31) · mean −120 HU (−760 … 92)" */
export function measurementParts(s: ObjectStats): string[] {
  const parts = [s.first_slice === s.last_slice ? `slice ${s.first_slice}` : `slices ${s.first_slice}–${s.last_slice}`];
  if (s.volume_ml !== null) parts.push(`${s.volume_ml < 0.1 ? s.volume_ml.toFixed(3) : s.volume_ml.toFixed(2)} mL`);
  if (s.long_axis_mm !== null) parts.push(`long axis ${s.long_axis_mm.toFixed(1)} mm${s.long_axis_slice ? ` (slice ${s.long_axis_slice})` : ""}`);
  if (s.hu_mean !== null) parts.push(`mean ${Math.round(s.hu_mean)} HU (${Math.round(s.hu_min ?? 0)} … ${Math.round(s.hu_max ?? 0)})`);
  return parts;
}

/** A sentence when much of the object is lung-dense, else null. Ground
 * glass is meant to be (a real GGN measured 66%); a solid nodule is not --
 * the reviewer judges which (0709's clipped block over lung was found by
 * Alt+clicking slice after slice). */
export function airWarning(s: ObjectStats): string | null {
  if (s.below_minus_500 === null || s.below_minus_500 < AIR_WARNING_SHARE) return null;
  return `${Math.round(s.below_minus_500 * 100)}% of it is below −500 HU: expected for ground glass, not for a solid nodule.`;
}

/** The 0-based slices (z) holding `objectId`, in order. */
export function objectSlices(volume: Uint8Array | null, sliceSize: number, objectId: number): number[] {
  if (!volume || sliceSize <= 0) return [];
  const out: number[] = [];
  const slices = Math.floor(volume.length / sliceSize);
  for (let z = 0; z < slices; z++) {
    const base = z * sliceSize;
    for (let i = base; i < base + sliceSize; i++) {
      if (volume[i] === objectId) {
        out.push(z);
        break;
      }
    }
  }
  return out;
}

/** "touches the pleura · 8.0 mm from the nearest segmented bronchus" */
export function distanceText(d: ObjectDistance, airwaysFound: boolean): string {
  const pleura = d.touches_pleura || d.pleura_mm === 0 ? "touches the pleura" : d.pleura_mm === null ? "no lung surface found" : `${d.pleura_mm.toFixed(1)} mm from the pleura`;
  const bronchus = !airwaysFound || d.bronchus_mm === null ? "no airway tree found" : d.bronchus_mm === 0 ? "on a segmented bronchus" : `${d.bronchus_mm.toFixed(1)} mm from the nearest segmented bronchus`;
  return `${pleura} · ${bronchus}`;
}
