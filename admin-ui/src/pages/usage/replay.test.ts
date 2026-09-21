import { describe, expect, it } from "vitest";

import { UsageEventRow } from "../../api/adminApi";
import { advance, buildTimeline, markIndexAt, nextTick, pageAt } from "./replay";

const T0 = Date.parse("2026-09-21T10:00:00.000Z");
let n = 0;
function ev(type: string, route: string, atMs: number, detail: Record<string, unknown> | null = null, extra: Partial<UsageEventRow> = {}): UsageEventRow {
  n += 1;
  return { id: `e${n}`, user_id: "u1", session_id: "s1", app: "viewer", event_type: type, route, name: null, detail, duration_ms: null, occurred_at: new Date(T0 + atMs).toISOString(), ...extra };
}

const EVENTS = [
  ev("page_view", "/viewer/series/:id", 0, { viewport: [1600, 900] }),
  ev("page_leave", "/viewer/series/:id", 90, null, { duration_ms: 90 }),
  ev("page_view", "/viewer/:id", 90, { viewport: [1600, 900] }),
  // trace starts at 2 000 ms; points are relative to that start
  ev("mouse_trace", "/viewer/:id", 2000, { viewport: [1600, 900], points: [[0, 100, 100], [200, 200, 150], [400, 300, 200]] }),
  ev("click", "/viewer/:id", 3000, { x: 300, y: 200, target: "testid:tool-cursor", viewport: [1600, 900] }),
  ev("key", "/viewer/:id", 3100, null, { name: "Escape" }),
  // a long pause, then one more click
  ev("click", "/viewer/:id", 60000, { x: 10, y: 10, target: "button:Save", viewport: [1600, 900] }),
];

describe("buildTimeline", () => {
  it("places pages, pointer samples and clicks on one clock from the first event", () => {
    const tl = buildTimeline(EVENTS);
    expect(tl.pages.map((p) => [p.route, p.at])).toEqual([
      ["/viewer/series/:id", 0],
      ["/viewer/:id", 90],
    ]);
    expect(tl.points.map((p) => [p.t, p.x, p.y, p.page])).toEqual([
      [2000, 100, 100, 1],
      [2200, 200, 150, 1],
      [2400, 300, 200, 1],
    ]);
    expect(tl.clicks.map((c) => [c.t, c.target])).toEqual([
      [3000, "testid:tool-cursor"],
      [60000, "button:Save"],
    ]);
    // mouse traces are drawn, not listed
    expect(tl.marks.map((m) => m.event.event_type)).toEqual(["page_view", "page_leave", "page_view", "click", "key", "click"]);
    expect(tl.duration).toBe(60000);
    expect(tl.ticks).toEqual([0, 90, 2000, 2200, 2400, 3000, 3100, 60000]);
  });

  it("handles an empty session", () => {
    expect(buildTimeline([]).duration).toBe(0);
  });
});

describe("playback", () => {
  const tl = buildTimeline(EVENTS);

  it("finds the page open at a moment and the last mark before it", () => {
    expect(pageAt(tl.pages, 50)?.route).toBe("/viewer/series/:id");
    expect(pageAt(tl.pages, 90)?.route).toBe("/viewer/:id");
    expect(markIndexAt(tl.marks, 3050)).toBe(3); // the first click
    expect(markIndexAt(tl.marks, -1)).toBe(-1);
    expect(nextTick(tl.ticks, 3100)).toBe(60000);
    expect(nextTick(tl.ticks, 60000)).toBeNull();
  });

  it("advances at the chosen speed and skips a long pause to just before the next event", () => {
    expect(advance(tl, 0, 100, 4, false)).toBe(400);
    // 3 100 -> 60 000 is a 57 s pause: with skipping on, land 500 ms before the click
    expect(advance(tl, 3100, 100, 4, true)).toBe(59500);
    expect(advance(tl, 3100, 100, 4, false)).toBe(3500);
    // a short gap is played through at speed
    expect(advance(tl, 2000, 50, 4, true)).toBe(2200);
    // never past the end
    expect(advance(tl, 59900, 1000, 64, false)).toBe(60000);
  });
});
