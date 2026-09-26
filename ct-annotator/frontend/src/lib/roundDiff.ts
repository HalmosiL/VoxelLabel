/** Round 2 of a review: what changed since the reviewer sent the case
 * back (UX-rev-1-16: "the new rectangular block was found only thanks to
 * the reviewer's own round-1 montages"). Both masks hold each voxel's
 * object id, the same volume. */
import type { SegLabel, SegObject } from "../api/annotatorApi";

export interface ObjectChange {
  /** voxels the object had last round, and has now */
  before: number;
  after: number;
  /** voxels painted since, and taken away since */
  added: number;
  removed: number;
}

export function diffByObject(prev: Uint8Array, now: Uint8Array): Map<number, ObjectChange> {
  const out = new Map<number, ObjectChange>();
  const entry = (id: number) => {
    let e = out.get(id);
    if (!e) out.set(id, (e = { before: 0, after: 0, added: 0, removed: 0 }));
    return e;
  };
  const n = Math.min(prev.length, now.length);
  for (let i = 0; i < n; i++) {
    const p = prev[i];
    const q = now[i];
    if (p) entry(p).before++;
    if (q) entry(q).after++;
    if (p === q) continue;
    if (p) entry(p).removed++;
    if (q) entry(q).added++;
  }
  return out;
}

/** One line for the review card. `existed`: the object was in the last
 * round's list (an object with nothing painted has no voxels to compare,
 * and is not new for that). */
export function roundChangeText(change: ObjectChange | undefined, existed: boolean): string {
  if (!existed) return "New since the last round";
  if (!change || (change.added === 0 && change.removed === 0)) return "Unchanged since the last round";
  return `Changed since the last round: +${change.added} / −${change.removed} voxels (${change.before} → ${change.after})`;
}

/** The objects of the last round that are gone now, by name. */
export function deletedSince(prevObjects: SegObject[], nowObjects: SegObject[], labels: SegLabel[]): string[] {
  const now = new Set(nowObjects.map((o) => o.id));
  return prevObjects
    .filter((o) => !now.has(o.id))
    .map((o) => {
      const label = labels.find((l) => l.id === o.label_id);
      return label ? `${label.name} ${o.instance_number}` : `Object ${o.instance_number}`;
    });
}
