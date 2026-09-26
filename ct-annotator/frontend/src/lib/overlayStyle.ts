/** How the painted objects are drawn over the scan: filled, or only their
 * outline -- a reviewer found a clipped edge only by dragging the opacity
 * down and back (UX-rev-1-04, UX-rev-2-05). The choice is remembered in
 * this browser. */

export type OverlayStyle = "fill" | "outline";
const KEY = "vl.view.overlay";

/** An outline is drawn at least this strong, whatever the opacity slider
 * says: a faint one-pixel line is no line. */
export const OUTLINE_MIN_ALPHA = 230;

/** A pixel is on the outline when a 4-neighbour belongs to something else
 * (another object, nothing, or the edge of the image: undefined). */
export function isEdge(value: number, neighbours: (number | undefined)[]): boolean {
  return value !== 0 && neighbours.some((n) => n !== value);
}

export function rememberedOverlayStyle(): OverlayStyle {
  try {
    return localStorage.getItem(KEY) === "outline" ? "outline" : "fill";
  } catch {
    return "fill";
  }
}

export function rememberOverlayStyle(style: OverlayStyle): void {
  try {
    localStorage.setItem(KEY, style);
  } catch {
    // not remembered
  }
}

/** A copy of a slice's mask (width x height, object ids) holding only
 * its outline pixels -- for renderers that take a whole mask (the
 * tutorial's renderPlane). */
export function outlineMask(mask: Uint8Array | null, width: number, height: number): Uint8Array | null {
  if (!mask) return null;
  const out = new Uint8Array(mask.length);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? undefined : mask[y * width + x]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = mask[y * width + x];
      if (isEdge(v, [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)])) out[y * width + x] = v;
    }
  }
  return out;
}
