/** Where the board was left, per study, in this browser: the board
 * re-fitted its zoom on every load, so a study admin re-found their place
 * on a large board each time (UX-ux-admin-14). The ⛶ control still fits
 * everything. A failing storage only means it isn't remembered. */

export interface BoardViewport {
  x: number;
  y: number;
  zoom: number;
}

const key = (studyId: string) => `vl.board.viewport.${studyId}`;

export function rememberedViewport(studyId: string): BoardViewport | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key(studyId)) ?? "null");
    if (raw && [raw.x, raw.y, raw.zoom].every((v) => typeof v === "number" && Number.isFinite(v)) && raw.zoom > 0) return { x: raw.x, y: raw.y, zoom: raw.zoom };
  } catch {
    // unreadable: as if never stored
  }
  return null;
}

export function rememberViewport(studyId: string, viewport: BoardViewport): void {
  try {
    localStorage.setItem(key(studyId), JSON.stringify({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }));
  } catch {
    // not remembered
  }
}
