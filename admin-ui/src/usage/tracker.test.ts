import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _reset, anchorOf, captureAnchors, captureLayout, captureSnapshot, structureKey, textHash, describeKey, describeTarget, flush, init, isEditableTarget, normalizeRoute, notePerf, pendingEvents, ratingDue, setConfig, settleClicks, trackAction, trackPageView, UsageConfig } from "./tracker";

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

describe("before the config arrives", () => {
  // Lets the fake config GET (a real Response, several microtasks deep) answer.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  function bootWithConfig(answer: UsageConfig | null) {
    _reset();
    init({
      app: "admin-ui",
      configUrl: "http://api/config",
      eventsUrl: "http://api/events",
      getToken: () => "tok",
      fetchImpl: ((url: string, i?: RequestInit) => {
        if (i?.method === "POST") posted.push({ url: String(url), init: i });
        return Promise.resolve(answer ? new Response(JSON.stringify(answer), { status: 200 }) : new Response("", { status: 403 }));
      }) as typeof fetch,
      now: () => clock,
    });
  }

  it("keeps a fresh load's first page_view until the config says pages are recorded", async () => {
    bootWithConfig(ON);
    trackPageView("/usage"); // fires before the config GET has answered
    expect(pendingEvents().map((e) => e.event_type)).toEqual(["page_view"]);
    flush();
    expect(posted).toHaveLength(0); // nothing leaves the browser yet
    await settle();
    expect(pendingEvents().map((e) => e.event_type)).toEqual(["page_view"]);
    flush();
    expect(posted).toHaveLength(1);
  });

  it("sifts the held events by the config once it arrives, and drops them all on a refusal", async () => {
    bootWithConfig({ ...ON, track_pages: false });
    trackPageView("/usage");
    trackAction("tool.paint");
    await settle();
    expect(pendingEvents().map((e) => e.event_type)).toEqual(["action"]);

    bootWithConfig(null);
    trackPageView("/usage");
    await settle();
    expect(pendingEvents()).toHaveLength(0);
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
    settleClicks();
    const types = pendingEvents().map((e) => e.event_type);
    expect(types).toEqual(["page_view", "click"]);
  });
});

describe("click response", () => {
  const microtask = () => new Promise((resolve) => setTimeout(resolve, 0));
  function click(el: Element) {
    el.dispatchEvent(new MouseEvent("click", { clientX: 1, clientY: 2, bubbles: true }));
  }

  it("marks a click on a control that changed nothing as not responded, and one that did as responded", async () => {
    trackPageView("/a");
    const button = document.createElement("button");
    button.textContent = "Save";
    document.body.appendChild(button);
    await microtask();
    clock += 10;
    click(button);
    clock += 100;
    settleClicks();
    click(button);
    clock += 100;
    button.textContent = "Saved"; // the page reacted
    await microtask();
    settleClicks();
    const clicks = pendingEvents().filter((e) => e.event_type === "click");
    expect(clicks.map((c) => [c.detail?.interactive, c.detail?.responded])).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it("flags tutorial-overlay clicks, leaves the canvas unjudged and masks ids in labels", async () => {
    trackPageView("/a");
    const overlay = document.createElement("div");
    overlay.setAttribute("data-guide-overlay", "");
    const next = document.createElement("button");
    next.textContent = "Next";
    overlay.appendChild(next);
    const canvas = document.createElement("canvas");
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = "Patient 09a1d4c3 case 20931";
    document.body.append(overlay, canvas, link);
    await microtask();
    click(next);
    click(canvas);
    click(link);
    settleClicks();
    const [tour, draw, row] = pendingEvents().filter((e) => e.event_type === "click");
    expect(tour.detail?.guide).toBe(true);
    expect(draw.detail).toMatchObject({ interactive: true, guide: false });
    expect(draw.detail && "responded" in draw.detail).toBe(false);
    expect(row.detail?.target).toBe("a:Patient # case #");
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

describe("versions, devices, request timings, rating cadence", () => {
  it("stamps the build on every event and the input device on page views", () => {
    _reset();
    init({ app: "viewer", configUrl: "c", eventsUrl: "e", getToken: () => undefined, fetchImpl: fakeFetch as typeof fetch, now: () => clock, version: "0.1.0+test" });
    setConfig(ON);
    trackPageView("/viewer/x");
    trackAction("tool.paint");
    const [view, action] = pendingEvents();
    expect(view.app_version).toBe("0.1.0+test");
    expect(action.app_version).toBe("0.1.0+test");
    expect(["mouse", "touch"]).toContain(view.detail?.device);
  });

  it("sums request timings per endpoint and sends them on the next flush, skipping its own calls", () => {
    setConfig({ ...ON, track_perf: true });
    trackPageView("/viewer/x");
    notePerf("http://api:8002/data/series/4c6bfb9a-e10c-4000-9695-9952b28d891b/volume", 1500, 200);
    notePerf("http://api:8002/data/series/aff78f3e-5371-4d8d-b660-426eec9a2b9e/volume", 500, 500);
    notePerf("http://api:8004/admin/usage/events", 50, 200);
    notePerf("http://ui/assets/index-abc.js", 50, 200);
    window.dispatchEvent(new Event("pagehide"));
    const sent = posted.flatMap((p) => (JSON.parse(String(p.init.body)) as { events: { event_type: string; detail: Record<string, unknown> }[] }).events);
    const perf = sent.filter((e) => e.event_type === "perf");
    expect(perf).toHaveLength(1);
    expect(perf[0].detail).toEqual({ endpoint: "/data/series/:id/volume", count: 2, ms: 2000, max: 1500, slow: 1, failures: 1 });
  });

  it("asks for a rating on every n-th finished case, and never when it is off", () => {
    sessionStorage.clear();
    setConfig({ ...ON, rating_every_n: 2 });
    expect([ratingDue(), ratingDue(), ratingDue(), ratingDue()]).toEqual([false, true, false, true]);
    setConfig({ ...ON, rating_every_n: 0 });
    expect(ratingDue()).toBe(false);
  });
});

describe("screen layout", () => {
  function place(el: Element, x: number, y: number, w: number, h: number) {
    el.getBoundingClientRect = () => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON: () => ({}) }) as DOMRect;
    return el;
  }

  it("records boxes and short labels -- media only as a box, inputs never with their value", () => {
    const root = document.createElement("div");
    const panel = place(document.createElement("aside"), 0, 0, 300, 700);
    const canvas = place(document.createElement("canvas"), 300, 0, 800, 600);
    const button = place(document.createElement("button"), 10, 10, 120, 30);
    button.textContent = "Mark as annotated";
    const input = place(document.createElement("input"), 10, 50, 200, 24) as HTMLInputElement;
    input.value = "secret";
    const tiny = place(document.createElement("button"), 0, 0, 2, 2);
    const overlay = document.createElement("div");
    overlay.setAttribute("data-guide-overlay", "");
    const tourButton = place(document.createElement("button"), 500, 500, 80, 30);
    tourButton.textContent = "Next";
    overlay.appendChild(tourButton);
    root.append(panel, canvas, button, input, tiny, overlay);
    const { elements, viewport } = captureLayout(root);
    expect(viewport).toHaveLength(2);
    expect(elements.map((e) => e[4])).toEqual(["panel", "media", "input", "button"]);
    expect(elements.find((e) => e[4] === "button")?.[5]).toBe("Mark as annotated");
    expect(elements.find((e) => e[4] === "input")).toEqual([10, 50, 200, 24, "input"]);
    expect(JSON.stringify(elements)).not.toContain("secret");
    expect(elements.find((e) => e[4] === "media")).toEqual([300, 0, 800, 600, "media"]);
  });
});

describe("screen snapshot", () => {
  it("keeps the page's HTML but no pictures, scripts, typed values or tour", () => {
    document.body.innerHTML = `
      <main><h1>Viewer</h1>
        <canvas class="pane" width="512" height="512"></canvas>
        <img src="/scan.png" alt="scan">
        <button>Mark as annotated</button>
        <input value="typed secret"><textarea>more secret</textarea>
        <script>window.x = 1</script>
        <div data-guide-overlay><button>Next</button></div>
      </main>`;
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const { html, cssHash } = captureSnapshot();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<h1>Viewer</h1>");
    expect(html).toContain("Mark as annotated");
    for (const gone of ["<canvas", "<img", "scan.png", "<script", "window.x", "typed secret", "more secret", "data-guide-overlay"]) expect(html).not.toContain(gone);
    expect(html).toContain('<span data-vl-image="" class="pane" style="width:800px;height:600px;">image</span>');
    expect(cssHash).toMatch(/^[0-9a-f]+$/);
    // the live page is untouched
    expect(document.querySelector("canvas")).not.toBeNull();
  });

  it("with case images on, puts a drawn canvas in as a small inline picture -- nothing else", () => {
    document.body.innerHTML = `<main><canvas class="pane" width="512" height="512"></canvas><img src="/scan.png" alt="scan"><video></video></main>`;
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const drawn: number[][] = [];
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return { drawImage: (_s: unknown, _x: number, _y: number, w: number, h: number) => drawn.push([w, h]) } as unknown as CanvasRenderingContext2D;
    } as never);
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/webp;base64,AAAA");
    try {
      const off = captureSnapshot(document);
      expect(off.images).toBe(0);
      expect(off.html).not.toContain("data-vl-shot");
      const on = captureSnapshot(document, { images: true });
      expect(on.images).toBe(1);
      expect(on.html).toContain('<img data-vl-shot="" class="pane" src="data:image/webp;base64,AAAA" style="width:800px;height:600px;object-fit:fill;">');
      // scaled down to the longest side cap, never full resolution
      expect(Math.max(...drawn[0])).toBeLessThanOrEqual(640);
      // an image that hasn't loaded and a video stay grey blocks
      expect(on.html).not.toContain("scan.png");
      expect(on.html).not.toContain("<video");
      expect((on.html.match(/data-vl-image/g) ?? []).length).toBe(2);
    } finally {
      getContext.mockRestore();
      toDataURL.mockRestore();
    }
  });

  it("hashes text stably and tells different texts apart", () => {
    expect(textHash(".a{color:red}")).toBe(textHash(".a{color:red}"));
    expect(textHash(".a{color:red}")).not.toBe(textHash(".a{color:blue}"));
  });
});

describe("clicks tied to elements", () => {
  function place(el: Element, x: number, y: number, w: number, h: number) {
    el.getBoundingClientRect = () => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON: () => ({}) }) as DOMRect;
    return el;
  }

  it("records where inside its element a click landed", async () => {
    trackPageView("/viewer/x");
    const pane = place(document.createElement("div"), 100, 200, 400, 400);
    pane.setAttribute("data-testid", "pane-axial");
    const canvas = document.createElement("canvas");
    pane.appendChild(canvas);
    document.body.appendChild(pane);
    canvas.dispatchEvent(new MouseEvent("click", { clientX: 300, clientY: 300, bubbles: true }));
    settleClicks();
    const click = pendingEvents().find((e) => e.event_type === "click");
    expect(click?.detail).toMatchObject({ target: "testid:pane-axial", rx: 0.5, ry: 0.25 });
    expect(anchorOf(canvas).element).toBe(pane);
  });

  it("lists every identifiable element with its box, and keys the screen by what it shows", () => {
    document.body.innerHTML = "";
    const coronal = place(document.createElement("div"), 0, 0, 400, 400);
    coronal.setAttribute("data-testid", "pane-coronal");
    const axial = place(document.createElement("div"), 400, 0, 400, 400);
    axial.setAttribute("data-testid", "pane-axial");
    const save = place(document.createElement("button"), 10, 500, 60, 20);
    save.textContent = "Save";
    const icon = place(document.createElement("span"), 12, 502, 10, 10);
    save.appendChild(icon);
    document.body.append(coronal, axial, save);
    expect(captureAnchors()).toEqual([
      ["testid:pane-coronal", 0, 0, 400, 400],
      ["testid:pane-axial", 400, 0, 400, 400],
      ["button:Save", 10, 500, 60, 20],
    ]);
    const both = structureKey();
    place(axial, 0, 0, 0, 0); // the axial pane switched off
    expect(structureKey()).not.toBe(both);
  });
});
