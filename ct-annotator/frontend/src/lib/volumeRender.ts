/** The pure parts of the 3D volume view (components/VolumeView.tsx): the
 * window in texture units, the object colours, the annotation mask at the
 * volume's size, and how the flying camera moves. */

export interface VolumeInfo {
  /** voxels across (columns), down (rows), and slices */
  dims: [number, number, number];
  /** mm per voxel along the same three axes */
  spacing: [number, number, number];
  /** how much the rows/columns were shrunk from the series' own */
  factor: number;
  huOffset: number;
  huStep: number;
}

/** A window (center/width in HU) as the [low, high] of the 8-bit texture,
 * 0..1 -- a texel v stands for HU offset + v * 255 * step. */
export function windowToUnit(center: number, width: number, info: Pick<VolumeInfo, "huOffset" | "huStep">): [number, number] {
  const toUnit = (hu: number) => (hu - info.huOffset) / info.huStep / 255;
  const lo = toUnit(center - width / 2);
  const hi = toUnit(center + width / 2);
  return [lo, Math.max(hi, lo + 1e-4)];
}

/** RGBA per object id (256 entries): its label's colour, transparent for
 * nothing (0), a hidden object or an unknown one. */
export function labelPalette(objects: { id: number; label_id: number; hidden: boolean }[], labels: { id: number; color: string }[]): Uint8Array {
  const out = new Uint8Array(256 * 4);
  const colorOf = new Map(labels.map((l) => [l.id, l.color]));
  for (const o of objects) {
    if (o.hidden || o.id <= 0 || o.id > 255) continue;
    const hex = colorOf.get(o.label_id);
    if (!hex) continue;
    const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
    out.set([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255], o.id * 4);
  }
  return out;
}

/** The mask (object id per voxel, slices x rows x columns) at the volume's
 * size: every `factor` x `factor` block of a slice becomes the first object
 * in it -- an average would lose a small nodule. */
export function shrinkMask(mask: Uint8Array, rows: number, columns: number, slices: number, factor: number): Uint8Array {
  if (factor <= 1) return mask;
  const ry = Math.floor(rows / factor);
  const rx = Math.floor(columns / factor);
  const out = new Uint8Array(ry * rx * slices);
  for (let z = 0; z < slices; z++) {
    const base = z * rows * columns;
    for (let y = 0; y < rows; y++) {
      const sy = Math.floor(y / factor);
      if (sy >= ry) break;
      const row = base + y * columns;
      const outRow = (z * ry + sy) * rx;
      for (let x = 0; x < columns; x++) {
        const v = mask[row + x];
        if (v === 0) continue;
        const sx = Math.floor(x / factor);
        if (sx < rx && out[outRow + sx] === 0) out[outRow + sx] = v;
      }
    }
  }
  return out;
}

export interface FlyKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

/** How far the camera moves this frame, in world units: forward/back along
 * where it looks (pitch included -- flying, not walking), left/right on
 * the level, up/down straight. `yaw` 0 looks along -Z (three.js' own). */
export function flyStep(keys: FlyKeys, yaw: number, pitch: number, speed: number, dt: number): [number, number, number] {
  const f = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const r = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const u = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
  const fx = -Math.sin(yaw) * Math.cos(pitch);
  const fy = Math.sin(pitch);
  const fz = -Math.cos(yaw) * Math.cos(pitch);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const d = speed * dt;
  return [(fx * f + rx * r) * d, (fy * f + u) * d, (fz * f + rz * r) * d];
}

/** The lung mask with what the lung encloses filled in, slice by slice:
 * vessels and nodules are denser than the threshold the lungs are found
 * by, so they are holes in it -- and "Only inside the lungs" would leave
 * out exactly what it is for. A hole is what can't be reached from the
 * slice's edge without crossing lung; the heart and the chest wall reach
 * the edge, so they stay out. (x fastest, then y, then z.) */
export function fillLungHoles(mask: Uint8Array, x: number, y: number, z: number): Uint8Array {
  const out = mask.slice();
  const seen = new Uint8Array(x * y);
  const stack = new Int32Array(x * y);
  for (let k = 0; k < z; k++) {
    const base = k * x * y;
    seen.fill(0);
    let top = 0;
    const push = (i: number) => {
      if (!seen[i] && !mask[base + i]) {
        seen[i] = 1;
        stack[top++] = i;
      }
    };
    for (let i = 0; i < x; i++) {
      push(i);
      push((y - 1) * x + i);
    }
    for (let j = 0; j < y; j++) {
      push(j * x);
      push(j * x + x - 1);
    }
    while (top > 0) {
      const i = stack[--top];
      const cx = i % x;
      if (cx > 0) push(i - 1);
      if (cx < x - 1) push(i + 1);
      if (i >= x) push(i - x);
      if (i < (y - 1) * x) push(i + x);
    }
    for (let i = 0; i < x * y; i++) if (!mask[base + i] && !seen[i]) out[base + i] = 1;
  }
  return out;
}

/** A 0/1 mask as a soft 0..255 field: blurred once along each axis with
 * [1 2 1]. Sampled with linear filtering and cut at the middle, its edge
 * becomes a smooth surface instead of voxel steps (x fastest, then y, z). */
export function softMask(mask: Uint8Array, x: number, y: number, z: number): Uint8Array {
  let a = new Uint16Array(mask.length);
  for (let i = 0; i < mask.length; i++) a[i] = mask[i] ? 255 : 0;
  const pass = (src: Uint16Array, stride: number, size: number, count: (i: number) => number) => {
    const out = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const c = count(i);
      const prev = c > 0 ? src[i - stride] : src[i];
      const next = c < size - 1 ? src[i + stride] : src[i];
      out[i] = (prev + 2 * src[i] + next + 2) >> 2;
    }
    return out;
  };
  a = pass(a, 1, x, (i) => i % x);
  a = pass(a, x, y, (i) => Math.floor(i / x) % y);
  a = pass(a, x * y, z, (i) => Math.floor(i / (x * y)));
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i];
  return out;
}
