/** Where a card added without dragging (the Library's "+") goes: the
 * middle of the view, stepped down-right past any card already sitting
 * there. Every "+" used to drop its card on the same spot, stacked on the
 * previous ones, so only the top card could be clicked (C-21). */

type Point = { x: number; y: number };

/** How far apart two cards' corners must be to count as not stacked. */
const NEAR = 30;
const STEP = 40;
const MAX_STEPS = 50;

export function freeSpot(wanted: Point, taken: Point[]): Point {
  let spot = wanted;
  for (let i = 0; i < MAX_STEPS; i++) {
    const busy = taken.some((p) => Math.abs(p.x - spot.x) < NEAR && Math.abs(p.y - spot.y) < NEAR);
    if (!busy) return spot;
    spot = { x: spot.x + STEP, y: spot.y + STEP };
  }
  return spot;
}
