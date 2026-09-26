/** Touch support for the viewer surfaces -- what a tablet needs that a
 * mouse never did.
 *
 * A mouse has a wheel (zoom, slice), three buttons and modifier keys
 * (Alt+click = HU readout, Ctrl+click = jump all planes, right-drag =
 * erase); a finger has none of them. This module gives the two viewer
 * pages one shared vocabulary for the touch equivalents:
 *
 *   one finger        the current tool (draw), or pan when zoomed
 *   two fingers       pinch = zoom (anchored between the fingers),
 *                     drag = pan -- in every tool, even mid-stroke
 *                     (the stroke the first finger started is undone)
 *   long-press        HU value under the finger (= Alt+click)
 *   double-tap        reset this pane's zoom (= double-click)
 *   two-finger tap    jump all planes here (= Ctrl+click)
 *
 * TouchTracker does the pointer bookkeeping and the pinch math;
 * TapDetector turns raw down/move/up into the three tap gestures. Both
 * are plain classes held in refs -- pointermove fires far too often to
 * push through React state, and the pages already mutate refs for the
 * same reason (see drawingRef and friends). */
import { useEffect, useState } from "react";

/** React to a CSS media query (re-renders when it flips). */
export function useMediaQuery(query: string): boolean {
  const read = () => (typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** A finger (or a stylus), not a mouse: bigger targets, no hover, no
 * wheel, no modifier keys. */
export const useCoarsePointer = (): boolean => useMediaQuery("(pointer: coarse)");

/** Not enough width for the side panel to sit next to three panes
 * (tablets in both orientations, small laptops): the panel becomes a
 * drawer opened from the header instead. */
export const useCompactLayout = (): boolean => useMediaQuery("(max-width: 1100px)");

/** Too narrow for the side panel beside even one pane (a phone, a
 * portrait tablet): below this the panel covers the panes as a drawer;
 * above it, on a landscape tablet, it pushes the pane aside instead of
 * covering it (UX-annot-2-04). */
export const NARROW_QUERY = "(max-width: 899px)";
export const useNarrowLayout = (): boolean => useMediaQuery(NARROW_QUERY);

/** True now, without a hook -- for a state's first value. */
export function compactNow(): boolean {
  return typeof window !== "undefined" && "matchMedia" in window && window.matchMedia("(max-width: 1100px)").matches;
}

type Pt = { x: number; y: number };

/** What one pointermove of a two-finger gesture amounts to: the scale
 * change between the fingers, how far their midpoint moved, and where
 * that midpoint is now (the zoom anchor). */
export type PinchDelta = { factor: number; dx: number; dy: number; cx: number; cy: number };

export class TouchTracker {
  private points = new Map<number, Pt>();
  private lastCenter: Pt | null = null;
  private lastDistance = 0;

  get count(): number {
    return this.points.size;
  }

  down(id: number, x: number, y: number): void {
    this.points.set(id, { x, y });
    this.resetFrame();
  }

  /** Returns the pinch delta while exactly two fingers are down, else null. */
  move(id: number, x: number, y: number): PinchDelta | null {
    if (!this.points.has(id)) return null;
    this.points.set(id, { x, y });
    if (this.points.size !== 2) return null;
    const center = this.center();
    const distance = this.distance();
    const prevCenter = this.lastCenter;
    const prevDistance = this.lastDistance;
    this.lastCenter = center;
    this.lastDistance = distance;
    if (!prevCenter || prevDistance === 0) return null;
    return { factor: distance / prevDistance, dx: center.x - prevCenter.x, dy: center.y - prevCenter.y, cx: center.x, cy: center.y };
  }

  up(id: number): void {
    this.points.delete(id);
    this.resetFrame();
  }

  clear(): void {
    this.points.clear();
    this.resetFrame();
  }

  center(): Pt {
    let x = 0;
    let y = 0;
    for (const p of this.points.values()) {
      x += p.x;
      y += p.y;
    }
    const n = Math.max(1, this.points.size);
    return { x: x / n, y: y / n };
  }

  private distance(): number {
    const [a, b] = Array.from(this.points.values());
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private resetFrame(): void {
    // A finger joining or leaving changes what "the midpoint" means --
    // start measuring deltas afresh from the next move, or the view
    // would jump by the difference.
    this.lastCenter = this.points.size === 2 ? this.center() : null;
    this.lastDistance = this.points.size === 2 ? this.distance() : 0;
  }
}

export type TapGesture = "long-press" | "double-tap" | "two-finger-tap";

const MOVE_TOLERANCE_PX = 12;
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 320;
const TWO_FINGER_TAP_MS = 400;

/** Single-surface tap recognizer. Feed it every touch pointer's
 * down/move/up together with how many touch pointers are down on the
 * surface; it calls back with the gesture and its viewport position.
 * `long-press` fires while the finger is still down (and suppresses the
 * tap that release would otherwise count as); `double-tap` fires on
 * the second release; `two-finger-tap` when both fingers lift quickly
 * without having moved. */
export class TapDetector {
  private start: { id: number; x: number; y: number; t: number } | null = null;
  private moved = false;
  private longTimer: number | null = null;
  private longFired = false;
  private lastTap: { x: number; y: number; t: number } | null = null;
  private multi: { x: number; y: number; t: number; moved: boolean } | null = null;

  constructor(private readonly onGesture: (gesture: TapGesture, x: number, y: number) => void) {}

  down(id: number, x: number, y: number, countAfter: number, center: Pt): void {
    if (countAfter >= 2) {
      this.cancelLongPress();
      this.multi = { x: center.x, y: center.y, t: performance.now(), moved: false };
      this.start = null;
      return;
    }
    this.start = { id, x, y, t: performance.now() };
    this.moved = false;
    this.longFired = false;
    this.longTimer = window.setTimeout(() => {
      this.longTimer = null;
      if (this.moved || !this.start) return;
      this.longFired = true;
      this.onGesture("long-press", this.start.x, this.start.y);
    }, LONG_PRESS_MS);
  }

  move(id: number, x: number, y: number): void {
    if (this.multi) {
      // Either finger drifting past the tolerance turns the pair into a
      // pinch/pan, never a tap -- checked against the midpoint they had
      // when the second finger landed.
      if (Math.hypot(x - this.multi.x, y - this.multi.y) > MOVE_TOLERANCE_PX * 4) this.multi.moved = true;
      return;
    }
    if (this.start && this.start.id === id && Math.hypot(x - this.start.x, y - this.start.y) > MOVE_TOLERANCE_PX) {
      this.moved = true;
      this.cancelLongPress();
    }
  }

  /** `countBefore`: touch pointers down *before* this one lifted. */
  up(id: number, x: number, y: number, countBefore: number): void {
    this.cancelLongPress();
    if (this.multi) {
      const m = this.multi;
      this.multi = null;
      if (!m.moved && countBefore === 2 && performance.now() - m.t < TWO_FINGER_TAP_MS) this.onGesture("two-finger-tap", m.x, m.y);
      this.start = null;
      this.lastTap = null;
      return;
    }
    const start = this.start;
    this.start = null;
    if (!start || start.id !== id) return;
    if (this.longFired) {
      this.longFired = false;
      this.lastTap = null;
      return;
    }
    if (this.moved || performance.now() - start.t > DOUBLE_TAP_MS * 2) return;
    const now = performance.now();
    if (this.lastTap && now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < MOVE_TOLERANCE_PX * 3) {
      this.lastTap = null;
      this.onGesture("double-tap", x, y);
      return;
    }
    this.lastTap = { x, y, t: now };
  }

  /** True while a long-press has fired for the finger still down --
   * the page uses it to not also treat the release as a tap/dot. */
  get longPressActive(): boolean {
    return this.longFired;
  }

  private cancelLongPress(): void {
    if (this.longTimer !== null) {
      window.clearTimeout(this.longTimer);
      this.longTimer = null;
    }
  }
}

/** How long a tap's own action (a paint dot, a fill) is held back so a
 * second tap can still turn the pair into a double-tap instead. */
export const TAP_ACTION_DELAY_MS = DOUBLE_TAP_MS;
