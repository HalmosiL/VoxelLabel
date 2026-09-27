/** Where the crosshair sits in a pane, and whether a pointer grabbed it.
 * Pure geometry for ViewerPage (which draws it, and lets it be dragged or
 * tapped into place). */

export type Plane = "axial" | "sagittal" | "coronal";

/** How close to the crosshair's middle a press grabs it, in screen
 * pixels: a fingertip is a blob, a mouse pointer a point. */
export const CROSSHAIR_GRAB_PX = { touch: 28, mouse: 10 };

/** The crosshair's middle in a pane's square display (0..size): x where
 * the plane drawn vertically cuts it, y the one drawn horizontally. A
 * native index i of n sits at (i + 0.5) / n of the side. */
export function crosshairPoint(
  pane: Plane,
  index: { axial: number; sagittal: number | null; coronal: number | null },
  dims: { columns: number; rows: number; numSlices: number },
  size: number
): { x: number; y: number } {
  const at = (i: number | null, n: number) => (((i ?? 0) + 0.5) / n) * size;
  if (pane === "axial") return { x: at(index.sagittal, dims.columns), y: at(index.coronal, dims.rows) };
  if (pane === "sagittal") return { x: at(index.coronal, dims.rows), y: at(index.axial, dims.numSlices) };
  return { x: at(index.sagittal, dims.columns), y: at(index.axial, dims.numSlices) };
}

/** A display coordinate on screen, relative to the pane's container: the
 * image is translated by `pan` and scaled around the container's centre
 * (the inverse of ViewerPage's screenToDisplayLocal). */
export function displayToScreen(display: number, containerCenter: number, scale: number, pan: number, size: number): number {
  return containerCenter + pan + scale * (display - size / 2);
}

/** Whether a press at `press` (screen, container-relative) grabs a
 * crosshair whose middle is at `middle`. */
export function grabsCrosshair(press: { x: number; y: number }, middle: { x: number; y: number }, pointerType: string): boolean {
  const reach = pointerType === "touch" || pointerType === "pen" ? CROSSHAIR_GRAB_PX.touch : CROSSHAIR_GRAB_PX.mouse;
  return Math.hypot(press.x - middle.x, press.y - middle.y) <= reach;
}
