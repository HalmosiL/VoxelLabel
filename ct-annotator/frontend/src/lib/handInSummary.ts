/** What a case holds at the moment it is handed in, for the summary the
 * annotator confirms before "Mark as Annotated" goes through: every object
 * with the slices it is painted on, and what looks unfinished -- an object
 * with nothing painted, or form questions left unanswered.
 *
 * The mask volume stores each voxel's object id (0 = nothing), slice by
 * slice (z * rows * columns + y * columns + x). */
import type { SegLabel, SegObject } from "../api/annotatorApi";
import { usableFields } from "../components/ObjectForm";

export interface HandInRow {
  id: number;
  name: string;
  color: string;
  /** painted voxels; 0 = the object is empty */
  voxels: number;
  /** 1-based slice numbers, as the slice counter shows them; null when empty */
  firstSlice: number | null;
  lastSlice: number | null;
  sliceCount: number;
  /** the label's form questions this object has no answer to (a tick box
   * left unticked is an answer, so only choices and scales count) */
  unanswered: string[];
  /** the reviewer sent it back last round (a rework) */
  sentBack: boolean;
}

export interface HandInSummary {
  rows: HandInRow[];
  empty: HandInRow[];
  unanswered: HandInRow[];
  sentBack: HandInRow[];
}

export function handInSummary(volume: Uint8Array | null, sliceSize: number, objects: SegObject[], labels: SegLabel[]): HandInSummary {
  const voxels = new Map<number, number>();
  const slices = new Map<number, Set<number>>();
  if (volume && sliceSize > 0) {
    for (let i = 0; i < volume.length; i++) {
      const id = volume[i];
      if (id === 0) continue;
      voxels.set(id, (voxels.get(id) ?? 0) + 1);
      const z = Math.floor(i / sliceSize);
      let set = slices.get(id);
      if (!set) slices.set(id, (set = new Set()));
      set.add(z);
    }
  }
  const rows = objects.map((obj): HandInRow => {
    const label = labels.find((l) => l.id === obj.label_id);
    const zs = [...(slices.get(obj.id) ?? [])].sort((a, b) => a - b);
    const unanswered = usableFields(label?.fields)
      .filter((f) => f.kind !== "check")
      .filter((f) => {
        const answer = obj.attributes?.[f.name];
        return answer === undefined || answer === null || answer === "";
      })
      .map((f) => f.name);
    return {
      id: obj.id,
      name: label ? `${label.name} ${obj.instance_number}` : `Object ${obj.instance_number}`,
      color: label?.color ?? "#9ca3af",
      voxels: voxels.get(obj.id) ?? 0,
      firstSlice: zs.length ? zs[0] + 1 : null,
      lastSlice: zs.length ? zs[zs.length - 1] + 1 : null,
      sliceCount: zs.length,
      unanswered,
      sentBack: obj.review_status === "rejected",
    };
  });
  return { rows, empty: rows.filter((r) => r.voxels === 0), unanswered: rows.filter((r) => r.unanswered.length > 0), sentBack: rows.filter((r) => r.sentBack) };
}

/** "slice 12", "slices 12–18 (7)", or "not painted". */
export function sliceSpanText(row: HandInRow): string {
  if (row.firstSlice === null || row.lastSlice === null) return "not painted";
  if (row.firstSlice === row.lastSlice) return `slice ${row.firstSlice}`;
  const span = row.lastSlice - row.firstSlice + 1;
  const gaps = span !== row.sliceCount ? `, painted on ${row.sliceCount}` : "";
  return `slices ${row.firstSlice}–${row.lastSlice} (${span}${gaps})`;
}
