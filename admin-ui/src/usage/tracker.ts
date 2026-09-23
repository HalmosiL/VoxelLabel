/**
 * Usage tracking for this app: what pages a signed-in person opens and
 * for how long, the curated actions they take, where they click, how
 * the mouse moves, scroll depth, keyboard shortcuts, focus/idle gaps and
 * JS errors -- batched and shipped to admin-service's /admin/usage/events
 * so the Usage page can show how the product is really used.
 *
 * What it will never send: patient data, DICOM tags, typed text or form
 * values. Event details carry internal ids (study/case/series/job),
 * geometry and short control descriptors only, and the server drops any
 * other key anyway. Keys are recorded only when the focused element is
 * not editable (shortcuts, not typing).
 *
 * Each click also records how it landed, so the Usage page can tell a
 * control that ignored someone from a click on empty space: whether it
 * hit a real control (`interactive`) or anything with a pointer cursor
 * (`pointer`), whether it was inside the tutorial overlay (`guide` --
 * the tour's own buttons aren't work), and whether anything on the page
 * changed within a second (`responded`: a DOM change, an action, a
 * navigation). The click is therefore queued a second late, stamped
 * with the moment it happened.
 *
 * Every event carries the app's build (`app_version`), so figures can be
 * compared release against release. Page views say whether the pointer
 * is a finger or a mouse (`device`). API request timings the browser
 * measured are summed per endpoint and sent once per flush as `perf`
 * events -- which calls people wait on, and which fail.
 *
 * Once per screen per session, shortly after it opens, the screen's
 * *layout* is recorded (`layout` events): where its panels, buttons,
 * inputs, headings and images are, with short control labels -- enough
 * to draw a miniature of the screen behind the click heatmap and the
 * replay. Never pixels: an image, canvas or video (the CT slices) is
 * only a grey "image" block, and no field's value is ever read.
 *
 * With a snapshotUrl, the same moment also sends a *snapshot*: the
 * screen's HTML and stylesheets, with every image, canvas, video and
 * iframe swapped for a same-sized "image" placeholder, scripts removed,
 * no typed values, and no url() in the CSS -- drawn behind the heatmap
 * and the replay in a sandboxed frame. Stylesheets go once per session.
 * Only when an admin switches on "case images" (track_screen_images)
 * do canvases and images go along too, as small inline pictures -- and
 * then the snapshot is refreshed every so often while someone works,
 * so the replay shows the slice they were on.
 *
 * Every category has a switch a platform admin flips on the Usage page;
 * the effective config is fetched at start and re-polled, so a change
 * reaches every open tab. Nothing here may ever break the app: every
 * network call is fire-and-forget with its errors swallowed, and the
 * queue is capped.
 *
 * The same file lives in ct-annotator (frontend/src/usage/tracker.ts) --
 * separate Vite projects with no shared package -- keep them identical.
 */
export type UsageApp = "admin-ui" | "viewer";
export type UsageEventType =
  | "page_view"
  | "page_leave"
  | "action"
  | "click"
  | "mouse_trace"
  | "scroll"
  | "key"
  | "focus"
  | "idle"
  | "error"
  | "perf"
  | "layout";

export interface UsageConfig {
  enabled: boolean;
  track_pages: boolean;
  track_actions: boolean;
  track_clicks: boolean;
  track_mouse: boolean;
  track_scroll: boolean;
  track_keys: boolean;
  track_errors: boolean;
  track_perf?: boolean;
  /** Put the case images (canvases, pictures) into screen snapshots. */
  track_screen_images?: boolean;
  mouse_sample_ms: number;
  /** Ask how demanding a finished case was after every n-th one (0 = never). */
  rating_every_n?: number;
}

export type LayoutElement = [number, number, number, number, string, string?, string?];
export type UsageDetail = Record<string, string | number | boolean | number[] | number[][] | LayoutElement[] | null | undefined>;

export interface UsageEvent {
  session_id: string;
  app: UsageApp;
  event_type: UsageEventType;
  route: string;
  name?: string;
  detail?: UsageDetail;
  duration_ms?: number;
  occurred_at: string;
  app_version?: string;
}

export interface TrackerOptions {
  app: UsageApp;
  configUrl: string;
  eventsUrl: string;
  getToken: () => string | undefined;
  /** This build's version, stamped on every event. */
  version?: string;
  /** Where screen snapshots go (admin-service /admin/usage/snapshots, or a proxy). */
  snapshotUrl?: string;
  /** Test seams -- default to the real fetch and Date.now. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_AT = 20;
const QUEUE_CAP = 200;
const CONFIG_POLL_MS = 5 * 60_000;
const IDLE_AFTER_MS = 30_000;
const IDLE_CHECK_MS = 5_000;
const MAX_TRACE_POINTS = 600;
const SESSION_KEY = "vl.usage.session";
/** How long after a click a page change still counts as its response. */
const RESPONSE_MS = 1000;
const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, label, summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="option"], [role="switch"], [role="link"], [contenteditable="true"]';
/** Id-like runs inside a control's label become "#" (the server does the same). */
const ID_LIKE = /[0-9A-Fa-f]{6,}|[0-9]{4,}/g;

const CATEGORY: Record<UsageEventType, keyof UsageConfig> = {
  page_view: "track_pages",
  page_leave: "track_pages",
  focus: "track_pages",
  idle: "track_pages",
  action: "track_actions",
  click: "track_clicks",
  mouse_trace: "track_mouse",
  scroll: "track_scroll",
  key: "track_keys",
  error: "track_errors",
  perf: "track_perf",
  // the screen behind the click heatmap -- rides on the clicks switch
  layout: "track_clicks",
};

const OFF: UsageConfig = {
  enabled: false,
  track_pages: false,
  track_actions: false,
  track_clicks: false,
  track_mouse: false,
  track_scroll: false,
  track_keys: false,
  track_errors: false,
  track_perf: false,
  track_screen_images: false,
  mouse_sample_ms: 100,
  rating_every_n: 0,
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

interface State {
  options: TrackerOptions | null;
  config: UsageConfig;
  /** False until the first config response: until then nothing is
   * known about what may be recorded, so events queue unfiltered and
   * are sifted once the answer arrives (see push/setConfig). */
  configKnown: boolean;
  queue: UsageEvent[];
  sessionId: string;
  route: string | null;
  routeEnteredAt: number;
  pageDetail: UsageDetail | undefined;
  maxScroll: number;
  wheelTicks: number;
  trace: { t0: number; points: number[][] } | null;
  lastSampleAt: number;
  lastInputAt: number;
  idleSince: number | null;
  timers: number[];
  listening: boolean;
  /** Last moment the page visibly reacted: a DOM change, an action, a navigation. */
  lastResponseAt: number;
  /** Clicks waiting RESPONSE_MS to learn whether anything happened. */
  pendingClicks: { event: UsageEvent; at: number; measure: boolean; timer: number }[];
  observer: MutationObserver | null;
  /** API timings since the last flush, per normalised endpoint. */
  perf: Map<string, { count: number; ms: number; max: number; slow: number; failures: number }>;
  perfObserver: PerformanceObserver | null;
  /** Screens whose layout was already recorded this session. */
  layouts: Set<string>;
  layoutTimer: number;
  /** Stylesheet hashes already sent with a snapshot this session. */
  cssSent: Set<string>;
  /** The current page's last snapshotted structure, and how many snapshots it has had. */
  structureKey: string | null;
  pageSnapshots: number;
  structureTimer: number;
  /** When the current page's last snapshot went (image refreshes are spaced by it). */
  lastSnapshotAt: number;
}

const state: State = {
  options: null,
  config: OFF,
  configKnown: false,
  queue: [],
  sessionId: "",
  route: null,
  routeEnteredAt: 0,
  pageDetail: undefined,
  maxScroll: 0,
  wheelTicks: 0,
  trace: null,
  lastSampleAt: 0,
  lastInputAt: 0,
  idleSince: null,
  timers: [],
  listening: false,
  lastResponseAt: 0,
  pendingClicks: [],
  observer: null,
  perf: new Map(),
  perfObserver: null,
  layouts: new Set(),
  layoutTimer: 0,
  cssSent: new Set(),
  structureKey: null,
  pageSnapshots: 0,
  structureTimer: 0,
  lastSnapshotAt: 0,
};

function now(): number {
  return state.options?.now ? state.options.now() : Date.now();
}

function newSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

/** `/studies/3f2c…/cases/9a1b…` -> `/studies/:id/cases/:id`: one row per
 * screen on the Usage page, not one per study. */
export function normalizeRoute(pathname: string): string {
  const path = pathname.split("?")[0].split("#")[0].replace(UUID_RE, ":id");
  return path.length > 1 ? path.replace(/\/+$/, "") : path || "/";
}

export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(el.isContentEditable);
}

/** A short, stable description of what was clicked: the test id or
 * guide anchor when there is one, else the control's label or its tag +
 * visible text. Walks up a few ancestors so a click on an icon inside a
 * button still names the button. Never reads input values. */
export function describeTarget(el: EventTarget | null): string {
  return anchorOf(el).descriptor;
}

/** The element a click is "on" for analysis, and its name: the nearest
 * ancestor (up to six levels) with a test id, a tour anchor or an aria
 * label, or a button/link by its text -- else the clicked tag itself.
 * The same function names the elements of a snapshot, so a click and a
 * screen agree on what "the Save button" or "the axial pane" is. */
export function anchorOf(el: EventTarget | null): { descriptor: string; element: Element | null } {
  let node: Element | null = el instanceof Element ? el : null;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    const testId = node.getAttribute("data-testid");
    if (testId) return { descriptor: `testid:${testId}`, element: node };
    const guide = node.getAttribute("data-guide");
    if (guide) return { descriptor: `guide:${guide}`, element: node };
    const aria = node.getAttribute("aria-label");
    if (aria) return { descriptor: `aria:${aria.slice(0, 40)}`, element: node };
    const tag = node.tagName.toLowerCase();
    if (tag === "button" || tag === "a") {
      const text = (node.textContent ?? "").trim().replace(/\s+/g, " ").replace(ID_LIKE, "#").slice(0, 40);
      return { descriptor: text ? `${tag}:${text}` : tag, element: node };
    }
  }
  return { descriptor: el instanceof Element ? el.tagName.toLowerCase() : "unknown", element: el instanceof Element ? el : null };
}

/** "Ctrl+Shift+Z", "Escape", "ArrowUp", "p" -- null for a bare modifier. */
export function describeKey(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(e.key === " " ? "Space" : e.key.length === 1 ? e.key.toLowerCase() : e.key);
  return parts.join("+");
}

function allows(type: UsageEventType): boolean {
  return state.config.enabled && Boolean(state.config[CATEGORY[type]]);
}

function viewport(): number[] {
  return [window.innerWidth, window.innerHeight];
}

/** Queues one event. Before the config has arrived the event is kept
 * regardless -- a fresh page load fires its first page_view before the
 * config GET has answered, and dropping it there left every reload's
 * page_leave without a page_view (bounce rates over 100%, lost task
 * timings). setConfig sifts the queue once it knows. */
function push(type: UsageEventType, fields: Partial<UsageEvent> = {}): void {
  if (!state.options) return;
  if (state.configKnown && !allows(type)) return;
  state.queue.push({
    session_id: state.sessionId,
    app: state.options.app,
    event_type: type,
    route: fields.route ?? state.route ?? "/",
    occurred_at: new Date(now()).toISOString(),
    ...(state.options.version ? { app_version: state.options.version } : {}),
    ...fields,
  });
  if (state.queue.length > QUEUE_CAP) state.queue.splice(0, state.queue.length - QUEUE_CAP);
  if (state.queue.length >= FLUSH_AT) flush();
}

// Browsers cap a keepalive request body at 64 KB; stay well under it.
const MAX_BODY_BYTES = 50_000;

/** Ships everything queued. Always `keepalive`: a plain fetch still in
 * flight when the page navigates away is cancelled by the browser (a
 * full page load between admin-ui screens lost whole batches that way),
 * while a keepalive one is allowed to finish. sendBeacon can't carry the
 * Authorization header this API needs, so it's fetch either way. Split
 * into chunks under the keepalive body limit. */
export function flush(_keepalive = true): void {
  const options = state.options;
  // Nothing leaves the browser until the config has said what may.
  if (!options || !state.configKnown || state.queue.length === 0) return;
  const token = options.getToken();
  if (!token) return;
  const events = state.queue.splice(0, state.queue.length);
  const doFetch = options.fetchImpl ?? fetch;
  const send = (chunk: UsageEvent[]) => {
    try {
      doFetch(options.eventsUrl, {
        method: "POST",
        keepalive: true,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ events: chunk }),
      }).catch(() => undefined);
    } catch {
      // never let tracking surface as an app error
    }
  };
  let chunk: UsageEvent[] = [];
  let size = 0;
  for (const event of events) {
    const length = JSON.stringify(event).length + 1;
    if (chunk.length > 0 && size + length > MAX_BODY_BYTES) {
      send(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(event);
    size += length;
  }
  if (chunk.length > 0) send(chunk);
}

function fetchConfig(): void {
  const options = state.options;
  if (!options) return;
  const token = options.getToken();
  if (!token) return;
  const doFetch = options.fetchImpl ?? fetch;
  try {
    doFetch(options.configUrl, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? (r.json() as Promise<UsageConfig>) : OFF))
      .then((config) => setConfig(config))
      // A network failure leaves the config unknown: the queue holds
      // (capped) and the next poll tries again. A definite non-OK
      // answer is the server saying no, and applies OFF.
      .catch(() => undefined);
  } catch {
    // ignore
  }
}

/** Applies a config -- normally the one fetched, directly in tests. */
export function setConfig(config: UsageConfig): void {
  state.config = { ...OFF, ...config };
  state.configKnown = true;
  state.queue = state.queue.filter((e) => allows(e.event_type));
}

/** Packs the buffered samples into one mouse_trace event, stamped with
 * the trace's *start* (each point's t is relative to it). Called on
 * page leave, at 600 points, and on every periodic flush -- so an hour
 * in the viewer ships its traces as it goes rather than only when the
 * tab finally closes (when a keepalive request may not make it out). */
function emitTrace(): void {
  if (state.trace && state.trace.points.length > 1) {
    push("mouse_trace", {
      detail: { points: state.trace.points, viewport: viewport() },
      occurred_at: new Date(state.trace.t0).toISOString(),
    });
  }
  state.trace = null;
}

function endIdle(): void {
  if (state.idleSince !== null) {
    push("idle", { duration_ms: now() - state.idleSince });
    state.idleSince = null;
  }
}

function noteInput(): void {
  state.lastInputAt = now();
  endIdle();
}

function leavePage(): void {
  if (state.route === null) return;
  emitTrace();
  endIdle();
  if (state.maxScroll > 0) push("scroll", { detail: { depth: Math.round(state.maxScroll * 1000) / 1000 } });
  if (state.wheelTicks > 0) push("scroll", { name: "wheel", detail: { depth: state.wheelTicks } });
  push("page_leave", { duration_ms: now() - state.routeEnteredAt, detail: state.pageDetail });
  state.route = null;
}

/** Call on every route change. `detail` is the page's internal ids
 * (study_id, case_id, job_id, series_id) -- nothing else. */
export function trackPageView(pathname: string, detail?: UsageDetail): void {
  noteResponse();
  leavePage();
  state.route = normalizeRoute(pathname);
  state.routeEnteredAt = now();
  state.pageDetail = detail;
  state.maxScroll = 0;
  state.wheelTicks = 0;
  state.trace = null;
  push("page_view", { detail: { ...detail, viewport: viewport(), device: inputDevice() } });
  state.structureKey = null;
  state.pageSnapshots = 0;
  if (typeof window !== "undefined") {
    window.clearTimeout(state.layoutTimer);
    window.clearTimeout(state.structureTimer);
    // let the screen load its data and draw before taking its layout
    state.layoutTimer = window.setTimeout(() => recordLayout(), LAYOUT_DELAY_MS);
  }
}

const LAYOUT_DELAY_MS = 2500;
const MAX_LAYOUT_ELEMENTS = 350;
const LAYOUT_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="tab"], canvas, img, video, svg, h1, h2, h3, nav, aside, header, main, section, [data-guide], [data-testid]';
const PANEL_TAGS = new Set(["nav", "aside", "header", "main", "section"]);

function colorOf(el: Element): string | undefined {
  try {
    const bg = window.getComputedStyle(el).backgroundColor;
    return bg && bg !== "transparent" && !bg.startsWith("rgba(0, 0, 0, 0)") ? bg.slice(0, 32) : undefined;
  } catch {
    return undefined;
  }
}

function shortLabel(el: Element): string | undefined {
  const aria = el.getAttribute("aria-label") ?? el.getAttribute("title");
  const text = (aria ?? el.textContent ?? "").trim().replace(/\s+/g, " ").replace(ID_LIKE, "#");
  return text ? text.slice(0, 28) : undefined;
}

/** The current screen as boxes: [x, y, w, h, kind, label?, background?]
 * in viewport pixels. Kinds: panel, media, heading, button, link, input.
 * Media is only its box; inputs carry no label and never their value. */
export function captureLayout(root: ParentNode = document): { elements: LayoutElement[]; viewport: number[]; bg?: string } {
  const [vw, vh] = viewport();
  const out: LayoutElement[] = [];
  const nodes = Array.from(root.querySelectorAll(LAYOUT_SELECTOR)).slice(0, 4000);
  for (const el of nodes) {
    if (out.length >= MAX_LAYOUT_ELEMENTS) break;
    if (el.closest("[data-guide-overlay]")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
    const tag = el.tagName.toLowerCase();
    const area = r.width * r.height;
    let kind: string | null = null;
    let label: string | undefined;
    let bg: string | undefined;
    if (tag === "canvas" || tag === "img" || tag === "video" || (tag === "svg" && area > 4000)) kind = "media";
    else if (tag === "svg") continue;
    else if (tag === "input" || tag === "select" || tag === "textarea") kind = "input";
    else if (tag === "button" || el.getAttribute("role") === "button" || el.getAttribute("role") === "tab") {
      kind = "button";
      label = shortLabel(el);
      bg = colorOf(el);
    } else if (tag === "a") {
      kind = "link";
      label = shortLabel(el);
    } else if (tag === "h1" || tag === "h2" || tag === "h3") {
      kind = "heading";
      label = shortLabel(el);
    } else if ((PANEL_TAGS.has(tag) || el.hasAttribute("data-guide") || el.hasAttribute("data-testid")) && area >= vw * vh * 0.01) {
      kind = "panel";
      bg = colorOf(el);
    }
    if (!kind) continue;
    const box: LayoutElement = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), kind];
    if (label || bg) box.push(label ?? "");
    if (bg) box.push(bg);
    out.push(box);
  }
  // panels first, so everything else draws on top of them
  const order: Record<string, number> = { panel: 0, media: 1, heading: 2, input: 3, link: 4, button: 5 };
  out.sort((a, b) => order[a[4]] - order[b[4]]);
  let pageBg: string | undefined;
  try {
    pageBg = colorOf(document.body) ?? colorOf(document.documentElement);
  } catch {
    pageBg = undefined;
  }
  return { elements: out, viewport: [vw, vh], bg: pageBg };
}

const LAYOUT_RETRY_MS = 4000;

function recordLayout(retried = false): void {
  if (!state.options || state.route === null || (state.configKnown && !allows("layout"))) return;
  const [vw] = viewport();
  const key = `${state.route}|${state.pageDetail?.job_id ?? ""}|${Math.round(vw / 200)}`;
  if (state.layouts.has(key)) return;
  try {
    const layout = captureLayout();
    // a viewer page whose image hasn't drawn yet isn't the screen people
    // work on -- give it one more chance
    if (!retried && state.route.startsWith("/viewer") && !layout.elements.some((b) => b[4] === "media")) {
      state.layoutTimer = window.setTimeout(() => recordLayout(true), LAYOUT_RETRY_MS);
      return;
    }
    state.layouts.add(key);
    push("layout", { detail: layout });
    if (state.options.snapshotUrl) {
      void sendSnapshot();
      // the slices may still be loading: with case images on, look again
      if (imagesOn()) state.structureTimer = window.setTimeout(scheduleStructureCheck, IMAGE_REFRESH_MS - STRUCTURE_CHECK_MS);
    }
  } catch {
    // never let tracking surface as an app error
  }
}

const MEDIA_SELECTOR = "img, canvas, video, iframe, picture, object, embed";
const DROP_SELECTOR = "script, noscript, template, link, style, base, [data-guide-overlay]";

/** 64-bit-ish content hash (two FNV-1a passes) -- crypto.subtle only
 * exists on https, and a test server is often plain http. */
export function textHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}${text.length.toString(16)}`;
}

/** The screen as HTML without its pictures: every image, canvas, video
 * and iframe replaced by a same-sized "image" placeholder; scripts,
 * stylesheets (sent separately), the tutorial overlay and every typed
 * value removed. Plus the page's CSS with its url()s taken out. */
const ANCHOR_SELECTOR = "[data-testid], [data-guide], [aria-label], button, a[href]";
const MAX_ANCHORS = 1500;
const MAX_PAGE_SNAPSHOTS = 6;
const STRUCTURE_CHECK_MS = 1500;
/** With case images on: a fresh picture at most this often while
 * someone works (the slice changes without the structure changing),
 * up to this many per page view. */
const IMAGE_REFRESH_MS = 8000;
const MAX_PAGE_SNAPSHOTS_WITH_IMAGES = 30;
/** A captured picture's longer side, and the total inline image budget per snapshot. */
const SHOT_MAX_SIDE = 640;
const SHOT_BUDGET_CHARS = 2_500_000;

function imagesOn(): boolean {
  return state.configKnown && state.config.enabled && Boolean(state.config.track_screen_images);
}

function visibleBox(el: Element): DOMRect | null {
  const r = el.getBoundingClientRect();
  const [vw, vh] = viewport();
  return r.width >= 1 && r.height >= 1 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh ? r : null;
}

/** Every identifiable element on screen with its box: [descriptor, x,
 * y, w, h] -- only elements that name themselves (anchorOf returns the
 * element itself), so each box is the element a click on it reports. */
export function captureAnchors(doc: Document = document): [string, number, number, number, number][] {
  const out: [string, number, number, number, number][] = [];
  for (const el of Array.from(doc.querySelectorAll(ANCHOR_SELECTOR))) {
    if (out.length >= MAX_ANCHORS) break;
    if (el.closest("[data-guide-overlay]")) continue;
    const anchor = anchorOf(el);
    if (anchor.element !== el) continue;
    const r = visibleBox(el);
    if (r) out.push([anchor.descriptor, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
  }
  return out;
}

/** Which identifiable parts the screen shows right now -- a pane
 * switched off, a panel opened or a list grown changes it. */
export function structureKey(doc: Document = document): string {
  const ids: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("[data-testid], [data-guide]"))) {
    if (el.closest("[data-guide-overlay]") || !visibleBox(el)) continue;
    ids.push(el.getAttribute("data-testid") ?? `g:${el.getAttribute("data-guide")}`);
  }
  const [vw] = viewport();
  return textHash(`${Math.round(vw / 200)}|${ids.sort().join(",")}`);
}

/** After a click, a key or a wheel turn, look again (debounced): if the
 * screen's structure changed since its last snapshot, take another one.
 * With case images on, also when the last one is IMAGE_REFRESH_MS old --
 * the image on screen has most likely moved on. */
function scheduleStructureCheck(): void {
  if (typeof window === "undefined" || !state.options?.snapshotUrl) return;
  window.clearTimeout(state.structureTimer);
  state.structureTimer = window.setTimeout(() => {
    if (state.route === null || state.structureKey === null) return;
    if (state.configKnown && !allows("click")) return;
    const images = imagesOn();
    if (state.pageSnapshots >= (images ? MAX_PAGE_SNAPSHOTS_WITH_IMAGES : MAX_PAGE_SNAPSHOTS)) return;
    try {
      if (structureKey() !== state.structureKey || (images && now() - state.lastSnapshotAt >= IMAGE_REFRESH_MS)) void sendSnapshot();
    } catch {
      // never let tracking surface as an app error
    }
  }, STRUCTURE_CHECK_MS);
}

/** A canvas or a loaded image as a small inline picture, or null (not
 * drawn yet, too small, from another origin, or over the budget). WebP
 * keeps transparency (an overlay canvas stays see-through); a browser
 * that can't write WebP falls back to PNG on its own. */
function shotOf(source: Element, budget: { left: number }): string | null {
  const tag = source.tagName.toLowerCase();
  let w = 0;
  let h = 0;
  if (tag === "canvas") {
    w = (source as HTMLCanvasElement).width;
    h = (source as HTMLCanvasElement).height;
  } else if (tag === "img") {
    const img = source as HTMLImageElement;
    if (!img.complete) return null;
    w = img.naturalWidth;
    h = img.naturalHeight;
  } else {
    return null;
  }
  const box = source.getBoundingClientRect();
  if (w < 8 || h < 8 || box.width < 8 || box.height < 8) return null;
  try {
    const scale = Math.min(1, SHOT_MAX_SIDE / Math.max(w, h));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(w * scale));
    out.height = Math.max(1, Math.round(h * scale));
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source as CanvasImageSource, 0, 0, out.width, out.height);
    const url = out.toDataURL("image/webp", 0.7);
    if (!/^data:image\/(webp|png|jpeg);base64,/.test(url) || url.length > budget.left) return null;
    budget.left -= url.length;
    return url;
  } catch {
    return null; // a tainted canvas, or no 2D context in this environment
  }
}

export function captureSnapshot(doc: Document = document, opts: { images?: boolean } = {}): { html: string; css: string; cssHash: string; images: number } {
  const live = Array.from(doc.querySelectorAll(MEDIA_SELECTOR));
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  const budget = { left: SHOT_BUDGET_CHARS };
  let images = 0;
  Array.from(clone.querySelectorAll(MEDIA_SELECTOR)).forEach((node, i) => {
    const source = live[i];
    const box = source?.getBoundingClientRect();
    const style = source && typeof window !== "undefined" ? window.getComputedStyle(source) : null;
    const cls = node.getAttribute("class");
    const position = style?.position && style.position !== "static" ? `position:${style.position};left:${style.left};top:${style.top};` : "";
    const size = `width:${Math.round(box?.width ?? 0)}px;height:${Math.round(box?.height ?? 0)}px;`;
    const shot = opts.images && source ? shotOf(source, budget) : null;
    if (shot) {
      // Attribute order matters: the server keeps exactly this shape
      // (data-vl-shot, class, src, style) and strips any other <img>.
      const img = doc.createElement("img");
      img.setAttribute("data-vl-shot", "");
      if (cls) img.setAttribute("class", cls);
      img.setAttribute("src", shot);
      img.setAttribute("style", `${position}${size}object-fit:fill;`);
      node.replaceWith(img);
      images += 1;
      return;
    }
    const placeholder = doc.createElement("span");
    placeholder.setAttribute("data-vl-image", "");
    placeholder.textContent = "image";
    if (cls) placeholder.setAttribute("class", cls);
    placeholder.setAttribute("style", `${position}${size}`);
    node.replaceWith(placeholder);
  });
  clone.querySelectorAll(DROP_SELECTOR).forEach((node) => node.remove());
  clone.querySelectorAll("input").forEach((input) => input.removeAttribute("value"));
  clone.querySelectorAll("textarea").forEach((area) => (area.textContent = ""));
  const html = `<!doctype html>${clone.outerHTML}`;
  const css = Array.from(doc.styleSheets)
    .map((sheet) => {
      try {
        return Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
      } catch {
        return "";
      }
    })
    .join("\n")
    .replace(/url\([^)]*\)/g, "none");
  return { html, css, cssHash: textHash(css), images };
}

async function pack(key: string, text: string): Promise<Record<string, string>> {
  if (typeof CompressionStream === "undefined" || typeof Blob === "undefined") return { [key]: text };
  const buffer = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { [`${key}_gz`]: btoa(binary) };
}

async function sendSnapshot(): Promise<void> {
  const options = state.options;
  const token = options?.getToken();
  if (!options?.snapshotUrl || !token || state.route === null) return;
  try {
    const key = structureKey();
    state.structureKey = key;
    state.pageSnapshots += 1;
    state.lastSnapshotAt = now();
    const anchors = captureAnchors();
    const snap = captureSnapshot(document, { images: imagesOn() });
    const withCss = !state.cssSent.has(snap.cssHash);
    const body = {
      session_id: state.sessionId,
      app: options.app,
      app_version: options.version,
      route: state.route,
      job_id: typeof state.pageDetail?.job_id === "string" ? state.pageDetail.job_id : undefined,
      viewport: viewport(),
      occurred_at: new Date(now()).toISOString(),
      css_hash: snap.cssHash,
      anchors,
      study_id: typeof state.pageDetail?.study_id === "string" ? state.pageDetail.study_id : undefined,
      structure_key: key,
      ...(await pack("html", snap.html)),
      ...(withCss ? await pack("css", snap.css) : {}),
    };
    const response = await (options.fetchImpl ?? fetch)(options.snapshotUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok && withCss) state.cssSent.add(snap.cssHash);
  } catch {
    // never let tracking surface as an app error
  }
}

export function trackAction(name: string, detail?: UsageDetail): void {
  noteResponse();
  push("action", { name, detail: detail ?? state.pageDetail });
}

/** "touch" when the main pointer is a finger (tablet), else "mouse". */
function inputDevice(): string {
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches ? "touch" : "mouse";
  } catch {
    return "mouse";
  }
}

const SLOW_MS = 1000;
const STATIC_RE = /\.(js|mjs|css|png|jpe?g|svg|gif|webp|ico|woff2?|ttf|map)$/i;

/** One API request the browser finished: summed into its endpoint's
 * bucket (ids replaced, so every study's /studies/:id counts together).
 * The tracker's own calls and static files are left out. */
export function notePerf(url: string, durationMs: number, status: number): void {
  if (!state.options) return;
  let path: string;
  try {
    path = new URL(url, typeof location !== "undefined" ? location.href : "http://x").pathname;
  } catch {
    return;
  }
  if (STATIC_RE.test(path) || path.includes("/usage/")) return;
  const endpoint = normalizeRoute(path).replace(ID_LIKE, "#");
  const bucket = state.perf.get(endpoint) ?? { count: 0, ms: 0, max: 0, slow: 0, failures: 0 };
  const ms = Math.max(0, Math.round(durationMs));
  bucket.count += 1;
  bucket.ms += ms;
  bucket.max = Math.max(bucket.max, ms);
  if (ms >= SLOW_MS) bucket.slow += 1;
  if (status >= 400) bucket.failures += 1;
  state.perf.set(endpoint, bucket);
}

/** Queues one perf event per endpoint seen since the last call. */
function emitPerf(): void {
  if (state.perf.size === 0) return;
  for (const [endpoint, b] of state.perf) push("perf", { detail: { endpoint, count: b.count, ms: b.ms, max: b.max, slow: b.slow, failures: b.failures } });
  state.perf.clear();
}

/** True when this finished case is one to ask "how demanding was it?"
 * about: every rating_every_n-th finished case in this browser session. */
export function ratingDue(): boolean {
  const every = state.config.enabled ? state.config.rating_every_n ?? 0 : 0;
  if (!every) return false;
  let n = 0;
  try {
    n = Number(sessionStorage.getItem("vl.usage.finished") ?? "0") + 1;
    sessionStorage.setItem("vl.usage.finished", String(n));
  } catch {
    n += 1;
  }
  return n % every === 0;
}

/** Where inside an element a point is, 0..1 each way -- what lets the
 * click be put on the same element of a screen laid out differently. */
function relativeIn(el: Element | null, x: number, y: number): { rx?: number; ry?: number } {
  const r = el?.getBoundingClientRect();
  if (!r || r.width < 1 || r.height < 1) return {};
  const clamp = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 1000) / 1000;
  return { rx: clamp((x - r.left) / r.width), ry: clamp((y - r.top) / r.height) };
}

function noteResponse(): void {
  state.lastResponseAt = now();
}

/** Queues every click still waiting on its response, with the verdict so far. */
export function settleClicks(): void {
  const pending = state.pendingClicks.splice(0, state.pendingClicks.length);
  for (const p of pending) {
    if (typeof window !== "undefined") window.clearTimeout(p.timer);
    if (p.measure && p.event.detail) p.event.detail.responded = state.lastResponseAt > p.at;
    push("click", p.event);
  }
}

function onClick(e: MouseEvent): void {
  noteInput();
  if (!state.options || (state.configKnown && !allows("click"))) return;
  const el = e.target instanceof Element ? e.target : null;
  const onCanvas = el?.tagName.toLowerCase() === "canvas";
  let pointer = false;
  try {
    pointer = el ? window.getComputedStyle(el).cursor === "pointer" : false;
  } catch {
    // ignore
  }
  const at = now();
  const anchor = anchorOf(e.target);
  scheduleStructureCheck();
  const event: UsageEvent = {
    session_id: state.sessionId,
    app: state.options.app,
    event_type: "click",
    route: state.route ?? "/",
    occurred_at: new Date(at).toISOString(),
    detail: {
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      target: anchor.descriptor,
      ...relativeIn(anchor.element, e.clientX, e.clientY),
      viewport: viewport(),
      button: e.button,
      interactive: onCanvas || Boolean(el?.closest(INTERACTIVE_SELECTOR)),
      pointer,
      guide: Boolean(el?.closest("[data-guide-overlay]")),
    },
  };
  // Drawing on the viewer's canvas doesn't touch the DOM -- whether it
  // "responded" can't be told from here, so it isn't claimed either way.
  const entry = { event, at, measure: !onCanvas, timer: 0 };
  entry.timer = window.setTimeout(() => {
    const i = state.pendingClicks.indexOf(entry);
    if (i < 0) return;
    state.pendingClicks.splice(i, 1);
    if (entry.measure && event.detail) event.detail.responded = state.lastResponseAt > at;
    push("click", event);
  }, RESPONSE_MS);
  state.pendingClicks.push(entry);
}

function onMouseMove(e: MouseEvent): void {
  noteInput();
  if (!allows("mouse_trace")) return;
  const t = now();
  if (t - state.lastSampleAt < state.config.mouse_sample_ms) return;
  state.lastSampleAt = t;
  if (!state.trace) state.trace = { t0: t, points: [] };
  state.trace.points.push([t - state.trace.t0, Math.round(e.clientX), Math.round(e.clientY)]);
  if (state.trace.points.length >= MAX_TRACE_POINTS) emitTrace();
}

function onWheel(): void {
  noteInput();
  state.wheelTicks += 1;
  // scrolling through slices changes the image -- worth a fresh picture
  if (imagesOn()) scheduleStructureCheck();
}

function onScroll(): void {
  noteInput();
  const doc = document.documentElement;
  const height = Math.max(doc.scrollHeight, 1);
  const seen = (window.scrollY + window.innerHeight) / height;
  if (seen > state.maxScroll) state.maxScroll = Math.min(seen, 1);
}

function onKeyDown(e: KeyboardEvent): void {
  noteInput();
  if (isEditableTarget(e.target)) return;
  const name = describeKey(e);
  if (name) push("key", { name });
  // a shortcut can switch a pane or a panel just like a click can
  if (name) scheduleStructureCheck();
}

function onFocus(): void {
  push("focus", { name: "focus" });
}

function onBlur(): void {
  push("focus", { name: "blur" });
}

function onError(e: ErrorEvent): void {
  push("error", { detail: { message: String(e.message ?? "error").slice(0, 200) } });
}

function onRejection(e: PromiseRejectionEvent): void {
  const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
  push("error", { name: "unhandledrejection", detail: { message: reason.slice(0, 200) } });
}

function onVisibility(): void {
  if (document.visibilityState === "hidden") {
    settleClicks();
    emitPerf();
    emitTrace();
    flush(true);
  }
}

function onPageHide(): void {
  settleClicks();
  emitPerf();
  leavePage();
  flush(true);
}

function checkIdle(): void {
  if (state.idleSince === null && state.lastInputAt && now() - state.lastInputAt > IDLE_AFTER_MS) {
    state.idleSince = state.lastInputAt;
  }
}

function listen(): void {
  if (state.listening || typeof window === "undefined") return;
  state.listening = true;
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousemove", onMouseMove, { passive: true });
  document.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  if (typeof PerformanceObserver !== "undefined") {
    try {
      state.perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
          if (entry.initiatorType !== "fetch" && entry.initiatorType !== "xmlhttprequest") continue;
          notePerf(entry.name, entry.duration, (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus ?? 0);
        }
      });
      state.perfObserver.observe({ type: "resource", buffered: false });
    } catch {
      state.perfObserver = null;
    }
  }
  if (typeof MutationObserver !== "undefined") {
    state.observer = new MutationObserver(noteResponse);
    state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  state.timers.push(
    window.setInterval(() => {
      emitTrace();
      emitPerf();
      flush();
    }, FLUSH_INTERVAL_MS)
  );
  state.timers.push(window.setInterval(fetchConfig, CONFIG_POLL_MS));
  state.timers.push(window.setInterval(checkIdle, IDLE_CHECK_MS));
}

/** Wire the tracker up once per app load. Safe to call again (a React
 * effect re-run): the options are refreshed, listeners stay single. */
export function init(options: TrackerOptions): void {
  state.options = options;
  if (!state.sessionId) state.sessionId = newSessionId();
  state.lastInputAt = now();
  fetchConfig();
  listen();
}

/** The queue as it stands -- for tests and debugging. */
export function pendingEvents(): readonly UsageEvent[] {
  return state.queue;
}

/** Tears everything down -- tests only. */
export function _reset(): void {
  if (typeof window !== "undefined" && state.listening) {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("wheel", onWheel);
    window.removeEventListener("scroll", onScroll);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    state.timers.forEach((t) => window.clearInterval(t));
    state.pendingClicks.forEach((p) => window.clearTimeout(p.timer));
    state.observer?.disconnect();
    state.perfObserver?.disconnect();
    window.clearTimeout(state.layoutTimer);
  }
  Object.assign(state, {
    options: null,
    config: OFF,
    configKnown: false,
    queue: [],
    sessionId: "",
    route: null,
    routeEnteredAt: 0,
    pageDetail: undefined,
    maxScroll: 0,
    wheelTicks: 0,
    trace: null,
    lastSampleAt: 0,
    lastInputAt: 0,
    idleSince: null,
    timers: [],
    listening: false,
    lastResponseAt: 0,
    pendingClicks: [],
    observer: null,
    perf: new Map(),
    perfObserver: null,
    layouts: new Set(),
    layoutTimer: 0,
    cssSent: new Set(),
    structureKey: null,
    pageSnapshots: 0,
    structureTimer: 0,
    lastSnapshotAt: 0,
  });
}
