// Usage tracking end to end: an annotator working in the real viewer
// produces page views, clicks, mouse traces and a shortcut; the admin's
// Usage page shows them (tiles, heatmap, the person, a session replay);
// a recording switch flipped there reaches the annotator's own config.
const { chromium } = require("playwright");
const { F } = require("./helpers");
const ADMIN = F.ADMIN, KC = F.KC, VIEWER = F.VIEWER, UI = F.UI;
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });

async function token(u, p) {
  const r = await fetch(`${KC}/realms/ct-platform/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: u, password: p }) });
  return (await r.json()).access_token;
}
async function api(t, url, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${t}`, "content-type": "application/json", ...(init.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function login(page, user, pass, url) {
  await page.goto(url);
  await Promise.race([page.waitForSelector("#username", { timeout: 30000 }), page.waitForSelector('[data-testid="signin-submit"]', { timeout: 30000 })]);
  if (await page.locator('[data-testid="signin-submit"]').isVisible().catch(() => false)) {
    await page.fill('input[autocomplete="username"]', user); await page.fill('input[type="password"]', pass); await page.click('[data-testid="signin-submit"]');
  } else {
    await page.fill("#username", user); await page.fill("#password", pass); await page.click("#kc-login");
  }
  await page.waitForURL((u) => !u.href.includes("localhost:8080"), { timeout: 30000 });
}
const seenGuides = () => { try { for (const k of ["workbench","job","case","annotate","review","studies","study","patients","annotation-types","deidentification","users","notifications","system","board","usage"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} };

(async () => {
  const admin = await token("platform-admin", "platform-admin");
  const annot = await token("dr-test", "Test1234!");
  // Start from "everything on" so the run is repeatable.
  await api(admin, `${ADMIN}/admin/usage/settings`, { method: "PUT", body: JSON.stringify({ enabled: true, track_mouse: true, track_clicks: true, track_keys: true }) });
  await api(admin, `${ADMIN}/admin/usage/settings/users/${F.ANNOTATOR.subject}`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const cfg = await api(annot, `${ADMIN}/admin/usage/config`);
  check("annotator's config: recording on", cfg.status === 200 && cfg.body.enabled === true && cfg.body.track_mouse === true, cfg.body);
  check("annotator cannot read the summary", (await api(annot, `${ADMIN}/admin/usage/summary`)).status === 403);

  const jobs = (await api(annot, `${ADMIN}/admin/my-jobs`)).body;
  const job = jobs.find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const series = (await api(annot, `${F.DATA}/data/cases/${kase.id}/series`)).body[0].id;

  const browser = await chromium.launch();
  // ---- annotator works in the real viewer ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    await ctx.addInitScript(seenGuides);
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    const posted = [];
    page.on("request", (r) => { if (r.url().endsWith("/usage/events") && r.method() === "POST") posted.push(r.postDataJSON()); });
    await login(page, "dr-test", "Test1234!", `${VIEWER}/viewer/series/${series}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`);
    await page.waitForFunction(() => document.querySelectorAll("canvas").length >= 1, null, { timeout: 60000 });
    await page.waitForTimeout(2500);
    for (let i = 0; i < 12; i++) { await page.mouse.move(300 + i * 40, 300 + (i % 3) * 60); await page.waitForTimeout(120); }
    await page.locator('[data-testid="tool-cursor"]').click();
    await page.keyboard.press("Escape");
    await page.locator("header h1").click();
    // The tracker flushes every 10 s; wait for the periodic flush.
    await page.waitForTimeout(11500);
    const all = posted.flatMap((b) => b.events);
    const types = new Set(all.map((e) => e.event_type));
    check("viewer shipped page_view, click, mouse_trace and key events", ["page_view", "click", "mouse_trace", "key"].every((t) => types.has(t)), [...types]);
    check("viewer page view carries the job/case ids, route normalised", all.some((e) => e.event_type === "page_view" && e.route === "/viewer/:id" && e.detail && e.detail.case_id === kase.id && e.detail.job_id === F.ANNOT_CARD), all.filter((e) => e.event_type === "page_view").map((e) => [e.route, e.detail]));
    check("viewer: no page errors", errors.length === 0, errors);
    await ctx.close();
  }

  const summary = (await api(admin, `${ADMIN}/admin/usage/summary?days=1`)).body;
  const me = summary.users.find((u) => u.user_id === F.ANNOTATOR.subject);
  check("summary lists dr-test with page views and clicks", Boolean(me) && me.username === "dr-test" && me.page_views >= 1 && me.clicks >= 1, me);
  check("summary has the viewer route", summary.routes.some((r) => r.route === "/viewer/:id"), summary.routes.map((r) => r.route));

  // ---- admin reads the Usage page ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await ctx.addInitScript(seenGuides);
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "platform-admin", "platform-admin", `${UI}/usage`);
    await page.waitForSelector('[data-testid="usage-tiles"]', { timeout: 30000 });
    check("nav has Usage", (await page.locator("nav a", { hasText: "Usage" }).count()) === 1);
    await page.locator('[data-testid="usage-range-7"]').click();
    await page.waitForTimeout(800);
    check("tiles render", (await page.locator('[data-testid="usage-tiles"] .stat-card').count()) === 6);
    check("recording card present with the mouse switch on", await page.locator('[data-testid="usage-switch-track_mouse"]').isChecked());
    // The bar list is the top 12 screens by time; which ones make it
    // depends on what else ran on this stack, so only check it draws.
    check("routes list renders rows", (await page.locator('[data-testid="usage-routes-list"] li').count()) >= 1);
    await page.locator('[data-testid="usage-heatmap-route"]').selectOption("/viewer/:id");
    await page.waitForTimeout(800);
    check("heatmap shows click dots", (await page.locator('[data-testid="usage-heatmap-svg"] circle').count()) >= 1);

    // Calendar: picking a specific day/hour window narrows the data, and
    // an empty window zeroes the tiles instead of erroring.
    await page.locator('[data-testid="usage-from-input"]').focus();
    await page.waitForTimeout(300);
    check("focusing From defaults to a real 24h window and clears the day-preset highlight", /Showing/.test(await page.locator('[data-testid="usage-range-label"]').innerText()) && !(await page.locator('[data-testid="usage-range-7"]').evaluate((el) => el.className.includes("bg-blue-600"))));
    await page.locator('[data-testid="usage-from-input"]').fill("2020-01-01T00:00");
    await page.locator('[data-testid="usage-to-input"]').fill("2020-01-02T00:00");
    await page.waitForTimeout(800);
    check("an empty calendar window zeroes the tiles", (await page.locator('[data-testid="usage-tiles"] .stat-value').first().innerText()) === "0");
    await page.locator('[data-testid="usage-calendar-clear"]').click();
    await page.waitForTimeout(800);
    check("clearing the calendar restores the 30-day preset", await page.locator('[data-testid="usage-range-30"]').evaluate((el) => el.className.includes("bg-blue-600")));
    check("people table lists dr-test", (await page.locator('[data-testid="usage-user-dr-test"]').count()) === 1);
    await page.locator('[data-testid="usage-open-dr-test"]').click();
    await page.waitForSelector('[data-testid="usage-session-row"]', { timeout: 15000 });
    // The newest session may be an admin-ui one with no mouse data (or a
    // curl check) -- open a viewer session, that's where the trace is.
    await page.locator('[data-testid="usage-session-row"]', { hasText: "viewer" }).first().click();
    await page.waitForSelector('[data-testid="usage-timeline"]', { timeout: 15000 });
    check("session replay draws the mouse trace", (await page.locator('[data-testid="usage-replay-svg"] polyline').count()) === 1);
    await page.locator('[data-testid="usage-replay-play"]').click();
    await page.waitForTimeout(400);
    check("timeline lists events", (await page.locator('[data-testid="usage-timeline"] li').count()) >= 3);
    await page.screenshot({ path: "usage-page.png", fullPage: true });

    // flip the mouse switch off, save, and see it land in the annotator's config
    await page.locator('[data-testid="usage-switch-track_mouse"]').uncheck();
    await page.locator('[data-testid="usage-save-settings"]').click();
    await page.waitForTimeout(800);
    const after = (await api(annot, `${ADMIN}/admin/usage/config`)).body;
    check("switch off reaches the annotator's config", after.track_mouse === false && after.track_clicks === true, after);
    check("admin-ui: no page errors", errors.length === 0, errors);
    await ctx.close();
  }
  // restore
  await api(admin, `${ADMIN}/admin/usage/settings`, { method: "PUT", body: JSON.stringify({ track_mouse: true }) });
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
