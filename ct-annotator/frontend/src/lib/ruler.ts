/** The viewer's ruler (UX-rev-1-03: "no measuring tool -- can't verify
 * 18 mm vs 8 mm"): a line on one pane's slice, in that plane's native
 * pixel coordinates, and its length in millimetres from the series'
 * spacing. The sagittal and coronal panes run along the slices
 * vertically, so their vertical step is the slice spacing. */

export type RulerPane = "sagittal" | "coronal" | "axial";
export interface RulerPoint {
  x: number;
  y: number;
}
export interface Ruler {
  pane: RulerPane;
  /** the slice it was drawn on: shown only there */
  index: number;
  a: RulerPoint;
  b: RulerPoint;
}

/** (slice, row, column) spacing in mm, as the backend's /spacing gives it. */
export type Spacing = [number, number, number];

/** mm per native pixel across and down a pane. */
export function paneSpacing(pane: RulerPane, spacing: Spacing): { across: number; down: number } {
  const [dz, dy, dx] = spacing;
  if (pane === "axial") return { across: dx, down: dy };
  if (pane === "sagittal") return { across: dy, down: dz }; // across = rows, down = slices
  return { across: dx, down: dz }; // coronal: across = columns, down = slices
}

/** The ruler's length in mm, or null without a spacing. */
export function rulerLengthMm(r: Ruler, spacing: Spacing | null): number | null {
  if (!spacing) return null;
  const { across, down } = paneSpacing(r.pane, spacing);
  return Math.hypot((r.b.x - r.a.x) * across, (r.b.y - r.a.y) * down);
}

/** "18.4 mm", or the pixels when the spacing is unknown. */
export function rulerLabel(r: Ruler, spacing: Spacing | null): string {
  const mm = rulerLengthMm(r, spacing);
  if (mm !== null) return `${mm.toFixed(1)} mm`;
  return `${Math.round(Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y))} px (no spacing in the files)`;
}
