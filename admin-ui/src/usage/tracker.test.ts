import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _reset, describeKey, describeTarget, flush, init, isEditableTarget, normalizeRoute, pendingEvents, setConfig, trackAction, trackPageView, UsageConfig } from "./tracker";

const ON: UsageConfig = {
  enabled: true,
  track_pages: true,
  track_actions: true,
  track_clicks: true,
  track_mouse: true,
  track_scroll: true,
  track_keys: true,
  track_errors: true,
  mouse_sample_ms: 100,
};

let clock = 1_000_000;
let posted: { url: string; init: RequestInit }[];

function fakeFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  // The config GET answers "everything on"; only event POSTs are recorded.
  if (init?.method === "POST") posted.push({ url: String(url), init });
  return Promise.resolve(new Response(JSON.stringify(ON), { status: 200 }));
}

function boot() {
  init({
    app: "admin-ui",
    configUrl: "http://api/config",
    eventsUrl: "http://api/events",
    getToken: () => "tok",
    fetchImpl: fakeFetch as typeof fetch,
    now: () => clock,
  });
  setConfig(ON);
}

beforeEach(() => {
  clock = 1_000_000;
  posted = [];
  boot();
});
afterEach(() => _reset());

describe("normalizeRoute", () => {
  it("replaces UUID segments and drops the query", () => {
    expect(normalizeRoute("/studies/4c6bfb9a-e10c-4000-9695-9952b28d891b/cases/aff78f3e-5371-4d8d-b660-426eec9a2b9e?jobId=x")).toBe("/studies/:id/cases/:id");
    expect(normalizeRoute("/my-jobs/")).toBe("/my-jobs");
    expect(normalizeRoute("/")).toBe("/");
  });
});

describe("page views", () => {
  it("emits a page_leave with the dwell time when the route changes", () => {
    trackPageView("/studies");
    clock += 4200;
    trackPageView("/studies/4c6bfb9a-e10c-4000-9695-9952b28d891b", { study_id: "s1" });
    const [view, leave, next] = pendingEvents();
    expect(view.event_type).toBe("page_view");
    expect(view.route).toBe("/studies");
    expect(leave).toMatchObject({ event_type: "page_leave", route: "/studies", duration_ms: 4200 });
    expect(next).toMatchObject({ event_type: "page_view", route: "/studies/:id", detail: { study_id: "s1" } });
    expect(next.detail?.viewport).toHaveLength(2);
  });

  it("actions inherit the page's ids", () => {
    trackPageView("/viewer/x", { case_id: "c1" });
    trackAction("tool.paint");
    expect(pendingEvents()[1]).toMatchObject({ event_type: "action", name: "tool.paint", detail: { case_id: "c1" } });
  });
});

describe("flushing", () => {
  it("posts the batch once 20 events are queued, and on demand", () => {
    trackPageView("/a");
    for (let i = 0; i < 19; i += 1) trackAction(`a${i}`);
    expect(posted).toHaveLength(1);
    const body = JSON.parse(String(posted[0].init.body)) as { events: unknown[] };
    expect(body.events).toHaveLength(20);
    expect((posted[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(pendingEvents()).toHaveLength(0);
    trackAction("one-more");
    flush();
    expect(posted).toHaveLength(2);
    // every batch is keepalive -- a navigation must not cancel it
    expect(posted.every((p) => p.init.keepalive === true)).toBe(true);
  });

  it("splits a batch that would exceed the keepalive body limit", () => {
    trackPageView("/a");
    const points = Array.from({ length: 600 }, (_, i) => [i * 100, i, i]);
    // ~10 KB each: 8 of them must go out as more than one request
    for (let i = 0; i < 8; i += 1) trackAction("noop", { points });
    flush();
    expect(posted.length).toBeGreaterThan(1);
    const total = posted.reduce((n, p) => n + (JSON.parse(String(p.init.body)) as { events: unknown[] }).events.length, 0);
    expect(total).toBe(9);
    expect(posted.every((p) => String(p.init.body).length <= 50_000)).toBe(true);
  });

  it("drops nothing on the floor silently below the cap and keeps the newest above it", () => {
    setConfig({ ...ON, track_actions: true });
    // never flushes: no token
    init({ app: "admin-ui", configUrl: "c", eventsUrl: "e", getToken: () => undefined, fetchImpl: fakeFetch as typeof fetch, now: () => clock });
    for (let i = 0; i < 250; i += 1) trackAction(`a${i}`);
    expect(pendingEvents()).toHaveLength(200);
    expect(pendingEvents()[0].name).toBe("a50");
  });
});

describe("switches", () => {
  it("records nothing when the master switch is off", () => {
    setConfig({ ...ON, enabled: false });
    trackPageView("/a");
    trackAction("x");
    expect(pendingEvents()).toHaveLength(0);
  });

  it("records only switched-on categories", () => {
    setConfig({ ...ON, track_mouse: false, track_keys: false });
    trackPageView("/a");
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 10, bubbles: true }));
    clock += 200;
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 20, clientY: 20, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("click", { clientX: 5, clientY: 6, bubbles: true }));
    const types = pendingEvents().map((e) => e.event_type);
    expect(types).toEqual(["page_view", "click"]);
  });
});

describe("clicks, mouse, keys", () => {
  it("describes the clicked control without reading inputs", () => {
    const button = document.createElement("button");
    button.textContent = "  Mark as   Annotated ";
    const icon = document.createElement("span");
    button.appendChild(icon);
    document.body.appendChild(button);
    expect(describeTarget(icon)).toBe("button:Mark as Annotated");
    button.setAttribute("data-testid", "tool-paint");
    expect(describeTarget(icon)).toBe("testid:tool-paint");
    const input = document.createElement("input");
    input.value = "secret";
    document.body.appendChild(input);
    expect(describeTarget(input)).toBe("input");
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(button)).toBe(false);
    document.body.removeChild(button);
    document.body.removeChild(input);
  });

  it("samples mouse movement at the configured rate into one trace", () => {
    trackPageView("/a");
    for (let i = 0; i < 5; i += 1) {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: i * 10, clientY: 0, bubbles: true }));
      clock += 50; // half the sample interval: every other move is kept
    }
    clock += 1000;
    trackPageView("/b");
    const trace = pendingEvents().find((e) => e.event_type === "mouse_trace");
    expect(trace?.detail?.points).toEqual([
      [0, 0, 0],
      [100, 20, 0],
      [200, 40, 0],
    ]);
    // stamped with the trace's start, so the replay can place each point
    expect(trace?.occurred_at).toBe(new Date(1_000_000).toISOString());
  });

  it("records shortcuts but never keys typed into a field", () => {
    trackPageView("/a");
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Z", ctrlKey: true, shiftKey: true, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true }));
    const keys = pendingEvents().filter((e) => e.event_type === "key").map((e) => e.name);
    expect(keys).toEqual(["Ctrl+Shift+z"]);
    document.body.removeChild(input);
    expect(describeKey(new KeyboardEvent("keydown", { key: " " }))).toBe("Space");
    expect(describeKey(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true }))).toBe("Alt+ArrowUp");
  });
});
