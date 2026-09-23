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
  | "error";

export interface UsageConfig {
  enabled: boolean;
  track_pages: boolean;
  track_actions: boolean;
  track_clicks: boolean;
  track_mouse: boolean;
  track_scroll: boolean;
  track_keys: boolean;
  track_errors: boolean;
  mouse_sample_ms: number;
}

export type UsageDetail = Record<string, string | number | boolean | number[] | number[][] | null | undefined>;

export interface UsageEvent {
  session_id: string;
  app: UsageApp;
  event_type: UsageEventType;
  route: string;
  name?: string;
  detail?: UsageDetail;
  duration_ms?: number;
  occurred_at: string;
}

export interface TrackerOptions {
  app: UsageApp;
  configUrl: string;
  eventsUrl: string;
  getToken: () => string | undefined;
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
  mouse_sample_ms: 100,
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
  let node: Element | null = el instanceof Element ? el : null;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    const testId = node.getAttribute("data-testid");
    if (testId) return `testid:${testId}`;
    const guide = node.getAttribute("data-guide");
    if (guide) return `guide:${guide}`;
    const aria = node.getAttribute("aria-label");
    if (aria) return `aria:${aria.slice(0, 40)}`;
    const tag = node.tagName.toLowerCase();
    if (tag === "button" || tag === "a") {
      const text = (node.textContent ?? "").trim().replace(/\s+/g, " ").replace(ID_LIKE, "#").slice(0, 40);
      return text ? `${tag}:${text}` : tag;
    }
  }
  return el instanceof Element ? el.tagName.toLowerCase() : "unknown";
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
  push("page_view", { detail: { ...detail, viewport: viewport() } });
}

export function trackAction(name: string, detail?: UsageDetail): void {
  noteResponse();
  push("action", { name, detail: detail ?? state.pageDetail });
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
  const event: UsageEvent = {
    session_id: state.sessionId,
    app: state.options.app,
    event_type: "click",
    route: state.route ?? "/",
    occurred_at: new Date(at).toISOString(),
    detail: {
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      target: describeTarget(e.target),
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
    emitTrace();
    flush(true);
  }
}

function onPageHide(): void {
  settleClicks();
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
  if (typeof MutationObserver !== "undefined") {
    state.observer = new MutationObserver(noteResponse);
    state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  state.timers.push(
    window.setInterval(() => {
      emitTrace();
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
  });
}
