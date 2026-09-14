/** Pure, DOM/React-free flood-fill and polygon-rasterization helpers,
 * shared by the mask volume's flood-fill tool (predicate: "is this pixel
 * unowned background?") and the HU-threshold auto-contour tool
 * (predicate: "is this pixel's HU within tolerance of the seed?"). Both
 * only ever need one thing from a fill algorithm: given a width/height
 * grid and a starting point, which connected pixels satisfy some
 * predicate -- so one scanline (span-per-row) implementation serves
 * both, rather than each tool re-implementing its own flood fill. */

/** 4-connected scanline flood fill starting at (seedX, seedY): grows
 * through every pixel for which `isFillable` holds, stopping at any
 * pixel that doesn't (already-owned, out of tolerance, out of bounds).
 * Span-per-row, not pixel-per-row, so this stays fast even over a large
 * region. Returns a width*height mask, 1 where filled. If the seed
 * itself isn't fillable, returns an all-zero mask (nothing to grow
 * from) rather than throwing -- callers decide what that means. */
export function scanlineFill(
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  isFillable: (x: number, y: number) => boolean
): Uint8Array {
  const filled = new Uint8Array(width * height);
  const x0 = Math.floor(seedX);
  const y0 = Math.floor(seedY);
  if (x0 < 0 || x0 >= width || y0 < 0 || y0 >= height) return filled;
  if (!isFillable(x0, y0)) return filled;

  const isOpen = (x: number, y: number) => filled[y * width + x] === 0 && isFillable(x, y);

  const seeds: Array<[number, number]> = [[x0, y0]];
  while (seeds.length) {
    const [sx, sy] = seeds.pop()!;
    if (!isOpen(sx, sy)) continue; // may already have been filled by a later-queued overlapping span

    let left = sx;
    while (left - 1 >= 0 && isOpen(left - 1, sy)) left--;
    let right = sx;
    while (right + 1 < width && isOpen(right + 1, sy)) right++;
    for (let x = left; x <= right; x++) filled[sy * width + x] = 1;

    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= height) continue;
      let x = left;
      while (x <= right) {
        if (isOpen(x, ny)) {
          seeds.push([x, ny]);
          while (x <= right && isOpen(x, ny)) x++; // one seed per run, not one per pixel
        } else {
          x++;
        }
      }
    }
  }
  return filled;
}

/** Even-odd point-in-polygon rasterization of a closed polygon (points
 * in the same pixel space as the target grid) into a width*height mask,
 * 1 where inside. Span-per-row like scanlineFill, computed via
 * horizontal-edge-crossing per scanline rather than a per-pixel
 * point-in-polygon test, so it stays fast for a large fill area even
 * though a polygon typically has few vertices. */
export function polygonMask(points: { x: number; y: number }[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (points.length < 3) return mask;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));

  for (let y = y0; y <= y1; y++) {
    const scanY = y + 0.5; // sample scanlines through pixel centers, avoids vertex-on-scanline edge cases
    const crossings: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if ((a.y <= scanY && b.y > scanY) || (b.y <= scanY && a.y > scanY)) {
        const t = (scanY - a.y) / (b.y - a.y);
        crossings.push(a.x + t * (b.x - a.x));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const left = Math.max(0, Math.round(crossings[i]));
      const right = Math.min(width - 1, Math.round(crossings[i + 1]) - 1);
      for (let x = left; x <= right; x++) mask[y * width + x] = 1;
    }
  }
  return mask;
}
