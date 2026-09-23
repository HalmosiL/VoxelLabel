import { UsageEventRow, UsageLayout } from "../../api/adminApi";

/** A session laid out on one clock, for playing back what a person did
 * in the order and at the pace it happened: the pages they were on,
 * every pointer sample and click placed on that page, and the rest of
 * the events as marks. All times are ms since the session's first
 * event. */
export interface ReplayPage {
  index: number;
  route: string;
  /** When the page was opened. */
  at: number;
  viewport: [number, number] | null;
  /** The page's recorded layout, to draw behind the pointer. */
  layout: UsageLayout | null;
  /** The kind of job the page was opened from (viewer pages), else null. */
  jobType: "annotation" | "review" | null;
}

export interface ReplayPoint {
  t: number;
  x: number;
  y: number;
  page: number;
}

export interface ReplayClick extends ReplayPoint {
  target: string | null;
}

export interface ReplayMark {
  t: number;
  event: UsageEventRow;
}

export interface Timeline {
  /** Session length in ms. */
  duration: number;
  pages: ReplayPage[];
  points: ReplayPoint[];
  clicks: ReplayClick[];
  /** Every event but the mouse traces, in order -- the log beside the stage. */
  marks: ReplayMark[];
  /** Every moment something happened, sorted -- what "skip the pauses" jumps between. */
  ticks: number[];
}

/** Pauses longer than this are skipped over in playback (when enabled). */
export const GAP_MS = 3000;
/** ...landing this far before the next thing that happens. */
export const GAP_LEAD_MS = 500;

function viewportOf(detail: Record<string, unknown>): [number, number] | null {
  const vp = detail.viewport;
  return Array.isArray(vp) && vp.length === 2 && Number(vp[0]) > 0 && Number(vp[1]) > 0 ? [Number(vp[0]), Number(vp[1])] : null;
}

export function buildTimeline(events: UsageEventRow[]): Timeline {
  if (events.length === 0) return { duration: 0, pages: [], points: [], clicks: [], marks: [], ticks: [] };
  const start = Date.parse(events[0].occurred_at);
  const pages: ReplayPage[] = [];
  const points: ReplayPoint[] = [];
  const clicks: ReplayClick[] = [];
  const marks: ReplayMark[] = [];
  let end = 0;
  let current: ReplayPage | null = null;
  for (const e of events) {
    const t = Math.max(0, Date.parse(e.occurred_at) - start);
    const detail = e.detail ?? {};
    end = Math.max(end, t);
    if (e.event_type === "page_view") {
      const jobType = detail.job_type === "annotation" || detail.job_type === "review" ? detail.job_type : null;
      current = { index: pages.length, route: e.route, at: t, viewport: viewportOf(detail), layout: null, jobType };
      pages.push(current);
      marks.push({ t, event: e });
    } else if (e.event_type === "perf") {
      // request timings summed over a flush -- not a step the person took
      continue;
    } else if (e.event_type === "layout") {
      // a picture of the screen, not something the person did
      if (current && !current.layout && Array.isArray(detail.elements)) {
        const vp = viewportOf(detail);
        if (vp) current.layout = { elements: detail.elements as UsageLayout["elements"], viewport: vp, bg: typeof detail.bg === "string" ? detail.bg : undefined };
      }
    } else if (e.event_type === "mouse_trace") {
      // Stamped with the trace's start; each point's own t is relative to it.
      if (current && Array.isArray(detail.points)) {
        if (!current.viewport) current.viewport = viewportOf(detail);
        for (const p of detail.points as number[][]) {
          const pt = t + Number(p[0]);
          points.push({ t: pt, x: Number(p[1]), y: Number(p[2]), page: current.index });
          end = Math.max(end, pt);
        }
      }
    } else {
      if (current && e.event_type === "click" && typeof detail.x === "number" && typeof detail.y === "number") {
        if (!current.viewport) current.viewport = viewportOf(detail);
        clicks.push({ t, x: detail.x, y: detail.y, page: current.index, target: typeof detail.target === "string" ? detail.target : null });
      }
      marks.push({ t, event: e });
    }
  }
  points.sort((a, b) => a.t - b.t);
  const ticks = [...new Set([...points.map((p) => p.t), ...marks.map((m) => m.t)])].sort((a, b) => a - b);
  return { duration: Math.max(end, ticks[ticks.length - 1] ?? 0), pages, points, clicks, marks, ticks };
}

/** The first moment after `t` that something happens, or null at the end. */
export function nextTick(ticks: number[], t: number): number | null {
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo < ticks.length ? ticks[lo] : null;
}

/** Where the playhead lands after `dt` ms of real time at `speed`,
 * skipping a pause longer than GAP_MS when `skipGaps` is on: instead of
 * sitting through a two-minute idle stretch, playback jumps to just
 * before the next thing that happened. */
export function advance(timeline: Timeline, head: number, dt: number, speed: number, skipGaps: boolean): number {
  let next = head + dt * speed;
  if (skipGaps) {
    const upcoming = nextTick(timeline.ticks, head);
    if (upcoming !== null && upcoming - head > GAP_MS && next < upcoming - GAP_LEAD_MS) next = upcoming - GAP_LEAD_MS;
  }
  return Math.min(next, timeline.duration);
}

/** The page open at `t` (the last one opened at or before it). */
export function pageAt(pages: ReplayPage[], t: number): ReplayPage | null {
  let found: ReplayPage | null = null;
  for (const p of pages) {
    if (p.at <= t) found = p;
    else break;
  }
  return found;
}

/** Index of the last mark at or before `t`, or -1. */
export function markIndexAt(marks: ReplayMark[], t: number): number {
  let lo = 0;
  let hi = marks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
