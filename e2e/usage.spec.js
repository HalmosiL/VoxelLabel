// Usage tracking end to end: an annotator working in the real viewer
// produces page views, clicks, mouse traces and a shortcut; the admin's
// Usage page shows them (tiles, heatmap, the person, a session replay);
// a recording switch flipped there reaches the annotator's own config.
const fs = require("fs");
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
    const layouts = all.filter((e) => e.event_type === "layout");
    const boxes = layouts.flatMap((e) => e.detail.elements);
    check("viewer recorded the screen's layout once: the image as a bare block, controls with labels", layouts.length >= 1 && boxes.some((b) => b[4] === "media" && b.length === 5) && boxes.some((b) => b[4] === "button" && b[5]), layouts.map((e) => e.detail.elements.length));
    check("every viewer event carries its build", all.length > 0 && all.every((e) => typeof e.app_version === "string" && e.app_version.length > 0), [...new Set(all.map((e) => e.app_version))]);
    check("viewer page views say mouse or touch", all.some((e) => e.event_type === "page_view" && ["mouse", "touch"].includes(e.detail && e.detail.device)));
    check("viewer sent request timings per endpoint", all.some((e) => e.event_type === "perf" && e.detail && e.detail.endpoint && e.detail.count >= 1), all.filter((e) => e.event_type === "perf").slice(0, 3));
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
    // A browser in Budapest time: the calendar hands over wall-clock
    // values, and a UTC-only run would never notice them being misread.
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true, timezoneId: "Europe/Budapest" });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
    await ctx.addInitScript(seenGuides);
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "platform-admin", "platform-admin", `${UI}/usage`);
    await page.waitForSelector('[data-testid="usage-tiles"]', { timeout: 30000 });
    check("nav has Usage", (await page.locator("nav a", { hasText: "Usage" }).count()) === 1);
    const tab = async (name) => { await page.locator(`[data-testid="usage-tab-${name}"]`).click(); await page.waitForTimeout(300); };
    const downloaded = async (testId) => {
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.locator(`[data-testid="${testId}"]`).click()]);
      return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), "utf8") };
    };
    await page.locator('[data-testid="usage-range-7"]').click();
    await page.waitForTimeout(800);

    // ---- Overview: findings, tiles, cycle time, export ----
    check("six tabs, Overview selected", (await page.locator('[data-testid="usage-tabs"] [role="tab"]').count()) === 6 && (await page.locator('[data-testid="usage-tab-overview"]').getAttribute("aria-selected")) === "true");
    check("tiles render (incl. friction score)", (await page.locator('[data-testid="usage-tiles"] .stat-card').count()) === 6);
    check("every judged tile says which direction is better", (await page.locator('[data-testid="usage-tiles"] .stat-card', { hasText: /is better/ }).count()) === 6);
    check("the header says what the figures are built from and who is left out", /\d+ sessions, [\d,]+ events/.test(await page.locator('[data-testid="usage-basis"]').innerText()) && /not counted/.test(await page.locator('[data-testid="usage-basis"]').innerText()));
    check("admin accounts are left out of the figures by default", (await api(admin, `${ADMIN}/admin/usage/summary?days=7`)).body.users.every((u) => u.username !== "platform-admin"));
    await page.waitForSelector('[data-testid="usage-finding"]', { timeout: 15000 });
    const severities = await page.locator('[data-testid="usage-finding"]').evaluateAll((els) => els.map((el) => el.dataset.severity));
    // seed.py leaves a rejected case waiting on the Review card with no
    // history to compare against -> "open, no history" or, if the stack
    // has been up long enough for the flat 7-day rule, a flagged one.
    check("findings render with at least one item", severities.length >= 1, severities);
    check("findings are sorted by severity", severities.join(",") === [...severities].sort((a, b) => ["critical", "warn", "info", "good"].indexOf(a) - ["critical", "warn", "info", "good"].indexOf(b)).join(","), severities);
    const goto = page.locator('[data-testid="usage-finding-goto"]').first();
    if (await goto.count()) {
      const label = (await goto.innerText()).replace(/\s*→\s*$/, "").toLowerCase();
      await goto.click();
      await page.waitForTimeout(300);
      check(`a finding's jump link opens the ${label} tab`, (await page.locator(`[data-testid="usage-tab-${label}"]`).getAttribute("aria-selected")) === "true");
      await tab("overview");
    }
    check("release by release lists a stamped viewer build", (await page.locator('[data-testid="usage-release-row"]', { hasText: "viewer" }).filter({ hasNotText: "unknown" }).count()) >= 1);
    check("cycle-time tiles render", (await page.locator('[data-testid="usage-cycle-tiles"] .stat-card').count()) === 5);
    check("cycle-time bar draws at least one segment", (await page.locator('[data-testid="usage-cycle-bar"] > div').count()) >= 1);

    const cycle = await downloaded("usage-export-cycle-time");
    check("cycle-time CSV has the header and four legs", /^﻿Leg,Median \(ms\)/.test(cycle.text) && cycle.text.trim().split(/\r?\n/).length === 5 && /^usage-cycle-time-\d{8}-\d{8}\.csv$/.test(cycle.name), cycle.name);
    const events = await downloaded("usage-export-events");
    // (.trim() would eat the BOM -- it counts as whitespace -- so test it on the raw text.)
    const eventLines = events.text.trim().split(/\r?\n/);
    check("raw event CSV streams with the BOM and the documented header", events.text.startsWith("﻿") && eventLines[0] === "occurred_at,user_id,username,session_id,app,event_type,route,name,duration_ms,detail,app_version", eventLines[0]);
    check("raw event CSV has rows and no mouse traces by default", eventLines.length > 10 && !events.text.includes(",mouse_trace,"), eventLines.length);
    await page.locator('[data-testid="usage-export-include-mouse"]').check();
    const withMouse = await downloaded("usage-export-events");
    check("include-mouse adds mouse_trace rows", withMouse.text.includes(",mouse_trace,") && withMouse.text.length > events.text.length);
    const report = await downloaded("usage-export-report");
    check("markdown report downloads with title, findings and headline numbers", report.name.endsWith(".md") && /^# Usage report/.test(report.text) && report.text.includes("## Findings") && report.text.includes("## Headline numbers"), report.text.slice(0, 200));
    const bundle = await downloaded("usage-export-bundle");
    const parsed = JSON.parse(bundle.text);
    check("JSON bundle carries every dataset", bundle.name.endsWith(".json") && parsed.summary && parsed.findings && parsed.pipeline_health && Array.isArray(parsed.learning_curve) && parsed.range, Object.keys(parsed));
    await page.locator('[data-testid="usage-export-copy-report"]').click();
    await page.waitForTimeout(500);
    check("copy summary reports success (or a clipboard-denied error, never a crash)", (await page.locator('[data-testid="usage-export-done"]').count()) === 1 || (await page.locator(".alert-error").count()) === 1);

    // ---- Behaviour ----
    await tab("behaviour");
    // The bar list is the top 12 screens by time; which ones make it
    // depends on what else ran on this stack, so only check it draws.
    check("routes list renders rows", (await page.locator('[data-testid="usage-routes-list"] li').count()) >= 1);
    check("navigation map draws screens and the moves between them", (await page.locator('[data-testid="usage-navmap-node"]').count()) >= 2 && (await page.locator('[data-testid="usage-navmap-edge"]').count()) >= 1);
    await page.locator('[data-testid="usage-heatmap-route"]').selectOption("/viewer/:id");
    await page.waitForTimeout(800);
    check("heatmap shows click dots", (await page.locator('[data-testid="usage-heatmap-dot"]').count()) >= 1);
    check("the screen is drawn behind the clicks, with its image as a grey block", (await page.locator('[data-testid="usage-heatmap-svg"] [data-testid="usage-layout-backdrop"]').count()) === 1 && (await page.locator('[data-testid="usage-layout-backdrop"] text', { hasText: "image" }).count()) >= 1);
    check("clicks are split by the kind of job they were made in", (await page.locator('[data-testid="usage-heatmap-mode-annotation"]').count()) === 1);
    await page.locator('[data-testid="usage-heatmap-mode-annotation"]').click();
    await page.waitForTimeout(800);
    const modesShown = await page.locator('[data-testid="usage-heatmap-dot"]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-mode")))]);
    check("filtering to annotation jobs leaves only annotation-job clicks", modesShown.length === 1 && modesShown[0] === "annotation", modesShown);
    await page.locator('[data-testid="usage-heatmap-mode-all"]').click();
    await page.waitForTimeout(800);
    // One colour per person: the legend appears once two people have
    // clicked on the screen, and hiding a person hides their dots.
    const heat = (await api(admin, `${ADMIN}/admin/usage/heatmap?route=${encodeURIComponent("/viewer/:id")}&days=7`)).body;
    const legendItems = await page.locator('[data-testid="usage-heatmap-legend-item"]').count();
    check("heatmap legend lists each person who clicked (none for a single person)", heat.users.length >= 2 ? legendItems === Math.min(heat.users.length, 5) + (heat.users.length > 5 ? 1 : 0) : legendItems === 0, { users: heat.users.length, legendItems });
    check("heatmap points carry who clicked", heat.points.every((p) => typeof p.user_id === "string"));
    if (heat.users.length >= 2) {
      const before = await page.locator('[data-testid="usage-heatmap-dot"]').count();
      await page.locator('[data-testid="usage-heatmap-legend-item"]').first().click();
      await page.waitForTimeout(200);
      const after = await page.locator('[data-testid="usage-heatmap-dot"]').count();
      check("hiding a person in the legend removes their dots", after === before - heat.users[0].clicks, { before, after, clicks: heat.users[0].clicks });
      await page.locator('[data-testid="usage-heatmap-legend-item"]').first().click();
    }
    const screens = await downloaded("usage-export-screens");
    check("screens CSV matches the list", /^﻿Screen,Views,Total \(ms\),Average stay \(ms\)/.test(screens.text) && screens.text.includes("/viewer/:id"));

    // ---- Friction ----
    await tab("friction");
    check("requests people wait on lists endpoints", (await page.locator('[data-testid="usage-perf-row"]').count()) >= 1);
    const frictionRows = page.locator('[data-testid="usage-friction-row"]');
    check("screens-by-friction table lists every screen with a score chip", (await frictionRows.count()) >= 1 && (await frictionRows.first().locator("td").nth(1).locator("span").count()) === 1);
    const scores = await frictionRows.evaluateAll((rows) => rows.map((r) => Number(r.querySelectorAll("td")[1].innerText)));
    check("friction table is ranked by score, descending", scores.every((s, i) => i === 0 || scores[i - 1] >= s), scores);
    check("bottlenecks lists the still-open rejected case", (await page.locator('[data-testid="usage-bottleneck-row"]').count()) >= 1);
    check("assignee load lists dr-test and/or dr-review", (await page.locator('[data-testid="usage-load-row"]').count()) >= 1);
    await page.screenshot({ path: "usage-friction.png", fullPage: true });

    // Calendar: picking a specific day/hour window narrows the data, and
    // an empty window zeroes the tiles instead of erroring.
    await tab("overview");
    await page.locator('[data-testid="usage-from-input"]').focus();
    await page.waitForTimeout(300);
    check("focusing From defaults to a real 24h window and clears the day-preset highlight", /Showing/.test(await page.locator('[data-testid="usage-range-label"]').innerText()) && !(await page.locator('[data-testid="usage-range-7"]').evaluate((el) => el.className.includes("bg-blue-600"))));
    await page.locator('[data-testid="usage-from-input"]').fill("2020-01-01T00:00");
    await page.locator('[data-testid="usage-to-input"]').fill("2020-01-02T00:00");
    // A range change now also refetches pipeline-health + its previous
    // period alongside the usage summary, so a fixed sleep is a race
    // under real system load (this ran fine solo, then flaked inside
    // the full suite) -- poll for the real settled value instead.
    const basis = page.locator('[data-testid="usage-basis"]');
    let settled = null;
    for (let i = 0; i < 20; i++) {
      settled = await basis.innerText();
      if (/ 0 people, 0 sessions, 0 events/.test(settled)) break;
      await page.waitForTimeout(300);
    }
    check("an empty calendar window zeroes the figures", / 0 people, 0 sessions, 0 events/.test(settled), settled);
    await page.locator('[data-testid="usage-calendar-clear"]').click();
    await page.waitForTimeout(800);
    check("clearing the calendar restores the 30-day preset", await page.locator('[data-testid="usage-range-30"]').evaluate((el) => el.className.includes("bg-blue-600")));
    // The last hour in the browser's own (Budapest) time must contain the
    // annotator's session from a minute ago -- read as UTC it would be
    // two hours off and empty.
    const localNow = await page.evaluate(() => { const d = new Date(); const at = (m) => new Date(d.getTime() + m * 60000 - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); return { from: at(-60), to: at(5) }; });
    await page.locator('[data-testid="usage-from-input"]').fill(localNow.from);
    await page.locator('[data-testid="usage-to-input"]').fill(localNow.to);
    let recent = null;
    for (let i = 0; i < 20; i++) {
      recent = Number((/(\d+) (?:person|people),/.exec(await basis.innerText()) || [])[1] ?? 0);
      if (recent >= 1) break;
      await page.waitForTimeout(300);
    }
    check("the calendar reads times in the browser's own time zone", Number(recent) >= 1, { recent, localNow });
    await page.locator('[data-testid="usage-calendar-clear"]').click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: "usage-page.png", fullPage: true });

    // ---- Cases ----
    await tab("cases");
    check("the cases tab lists the case dr-test just opened, with its slices", (await page.locator('[data-testid="usage-case-row"]').count()) >= 1 && /\b8\b/.test(await page.locator('[data-testid="usage-case-row"]').first().innerText()));
    check("the cases tab explains what drives effort and how demanding cases feel", (await page.locator('[data-testid="usage-case-drivers"]').count()) === 1 && (await page.locator('[data-testid="usage-felt"]').count()) === 1);
    const casesCsv = await downloaded("usage-export-cases");
    check("cases CSV has the case properties", /^\uFEFFCase,Case id,Job,Job id,People,Sittings,Hands-on \(ms\),Slices,Objects/.test(casesCsv.text));

    // ---- People: table, sessions, replay, learning curve ----
    await tab("people");
    check("people table lists dr-test", (await page.locator('[data-testid="usage-user-dr-test"]').count()) === 1);
    const people = await downloaded("usage-export-people");
    check("people CSV lists dr-test", /^﻿Person,Email,User id,Sessions/.test(people.text) && people.text.includes("dr-test"));
    // "Replay" goes straight to the person's newest sitting.
    await page.locator('[data-testid="usage-replay-dr-test"]').click();
    await page.waitForSelector('[data-testid="usage-timeline"]', { timeout: 15000 });
    check("Replay opens the newest session without picking one", (await page.locator('[data-testid="usage-session-row"]').count()) >= 1 && (await page.locator('[data-testid="usage-replay-clock"]').innerText()).startsWith("0:00 /"));
    // The newest session may be an admin-ui one with no mouse data (or a
    // curl check) -- open a viewer session, that's where the trace is.
    await page.locator('[data-testid="usage-session-row"]', { hasText: "viewer" }).first().click();
    await page.waitForSelector('[data-testid="usage-timeline"]', { timeout: 15000 });
    check("replay starts at the beginning with nothing drawn yet", (await page.locator('[data-testid="usage-replay-svg"] polyline').count()) === 0);
    await page.locator('[data-testid="usage-replay-speed"]').selectOption("32");
    await page.locator('[data-testid="usage-replay-play"]').click();
    let traced = false;
    for (let i = 0; i < 40 && !traced; i++) {
      traced = (await page.locator('[data-testid="usage-replay-svg"] polyline').count()) === 1;
      if (!traced) await page.waitForTimeout(250);
    }
    check("playing draws the pointer path as it happened", traced);
    check("the replay draws the screen behind the pointer and says it was an annotation job", (await page.locator('[data-testid="usage-replay-svg"] [data-testid="usage-layout-backdrop"]').count()) === 1 && (await page.locator('[data-testid="usage-replay-job-type"]').innerText()) === "Annotation job");
    const clockText = await page.locator('[data-testid="usage-replay-clock"]').innerText();
    check("the replay clock advances", !clockText.startsWith("0:00 /"), clockText);
    check("the log lists the session's events", (await page.locator('[data-testid="usage-timeline"] li').count()) >= 3);
    // scrubbing to the end shows every click of the last page
    await page.locator('[data-testid="usage-replay-scrub"]').evaluate((el) => { el.value = el.max; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.waitForTimeout(200);
    check("scrubbing to the end pauses at the full length", (await page.locator('[data-testid="usage-replay-play"]').innerText()).includes("Play") && /^(\d+:\d\d) \/ \1$/.test(await page.locator('[data-testid="usage-replay-clock"]').innerText()), await page.locator('[data-testid="usage-replay-clock"]').innerText());
    const sessionCsv = await downloaded("usage-export-session-events");
    check("a session's events export as CSV with JSON detail", /^﻿Occurred at,Type,Screen,Name,Duration \(ms\),Detail/.test(sessionCsv.text) && sessionCsv.text.includes("page_view"));
    const learningEmpty = (await page.locator('[data-testid="usage-learning-curve"] .empty-state').count()) === 1;
    const learningFigures = await page.locator('[data-testid="usage-learning-curve-figure"]').count();
    check("learning curve either has figures or explains it needs more weeks of history", learningEmpty || learningFigures >= 1, { learningEmpty, learningFigures });

    // ---- Settings: who counts; flip the mouse switch off, save, and see it land in the annotator's config ----
    await tab("settings");
    check("settings shows the rating cadence and the request-timing switch", (await page.locator('[data-testid="usage-rating-every"]').inputValue()) === "3" && (await page.locator('[data-testid="usage-switch-track_perf"]').isChecked()));
    check("settings lists every account with its recorded/counted switches", (await page.locator('[data-testid^="usage-person-"]').count()) >= 3 && (await page.locator('[data-testid="usage-exclude-admins"]').isChecked()));
    check("an admin account shows as left out by the admin rule", /admin account/.test(await page.locator('[data-testid="usage-person-platform-admin"]').innerText()));
    await page.locator('[data-testid="usage-count-dr-review"]').uncheck();
    await page.waitForTimeout(800);
    check("a test account switched off stops counting (and says so)", /test account/.test(await page.locator('[data-testid="usage-person-dr-review"]').innerText()) && (await api(admin, `${ADMIN}/admin/usage/settings`)).body.excluded_user_ids.length === 1);
    await page.locator('[data-testid="usage-count-dr-review"]').check();
    await page.waitForTimeout(500);
    check("recording card present with the mouse switch on", await page.locator('[data-testid="usage-switch-track_mouse"]').isChecked());
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
