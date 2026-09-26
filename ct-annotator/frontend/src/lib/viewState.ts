/** What the viewer remembers in this browser between visits (UX-annot-1-08,
 * UX-annot-2-10: "every load resets to slice 1 and three panes"):
 *
 * - the layout -- which panes show, which one is maximized -- for every
 *   case (on a tablet, one big pane stays one big pane);
 * - where each case was left: the three slice positions, per series, the
 *   newest MAX_POSITIONS cases.
 *
 * The window is remembered on its own (lib/windowPreset.ts). A failing
 * storage only means nothing is remembered. */

export type LayoutPane = "sagittal" | "coronal" | "axial" | "three_d";
export interface Layout {
  visible: Record<LayoutPane, boolean>;
  maximized: LayoutPane | null;
}
export interface Position {
  axial: number;
  coronal: number | null;
  sagittal: number | null;
}

const LAYOUT_KEY = "vl.view.layout";
const POSITIONS_KEY = "vl.view.positions";
export const MAX_POSITIONS = 40;
const PANES: LayoutPane[] = ["sagittal", "coronal", "axial", "three_d"];

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // not remembered, nothing else
  }
}

/** The remembered layout, or null when there is none (or it is unusable:
 * no pane at all left visible). */
export function rememberedLayout(): Layout | null {
  const raw = read(LAYOUT_KEY) as Partial<Layout> | null;
  if (!raw || typeof raw !== "object" || !raw.visible) return null;
  const visible = Object.fromEntries(PANES.map((p) => [p, Boolean((raw.visible as Record<string, unknown>)[p])])) as Record<LayoutPane, boolean>;
  const maximized = PANES.includes(raw.maximized as LayoutPane) ? (raw.maximized as LayoutPane) : null;
  if (!maximized && !PANES.some((p) => visible[p])) return null;
  return { visible, maximized };
}

export function rememberLayout(layout: Layout): void {
  write(LAYOUT_KEY, layout);
}

type Positions = Record<string, Position & { at: number }>;

export function rememberedPosition(seriesId: string): Position | null {
  const all = read(POSITIONS_KEY) as Positions | null;
  const p = all && typeof all === "object" ? all[seriesId] : undefined;
  if (!p || typeof p.axial !== "number") return null;
  return { axial: p.axial, coronal: typeof p.coronal === "number" ? p.coronal : null, sagittal: typeof p.sagittal === "number" ? p.sagittal : null };
}

export function rememberPosition(seriesId: string, position: Position, now = Date.now()): void {
  const all = { ...((read(POSITIONS_KEY) as Positions | null) ?? {}) };
  all[seriesId] = { ...position, at: now };
  const newest = Object.entries(all)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_POSITIONS);
  write(POSITIONS_KEY, Object.fromEntries(newest));
}

/** A remembered slice that still fits the series (it may have changed). */
export function clampPosition(p: Position, dims: { slices: number; rows: number; columns: number }): Position {
  const clamp = (v: number, n: number) => Math.max(0, Math.min(n - 1, v));
  return {
    axial: clamp(p.axial, dims.slices),
    coronal: p.coronal === null ? null : clamp(p.coronal, dims.rows),
    sagittal: p.sagittal === null ? null : clamp(p.sagittal, dims.columns),
  };
}
