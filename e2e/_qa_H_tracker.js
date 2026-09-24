// QA workstream H: drive real tracker sessions in admin-ui and the viewer,
// type a unique marker into every kind of input, and dump what the tracker
// posted. Output: /w/_qa_H_out/tracker-*.json (moved to .qa-review/H-probe after).
const fs = require("fs");
const zlib = require("zlib");
const { chromium } = require("playwright");
const { login, seenGuides } = require("./helpers");
const UI = "http://localhost:5173", VIEWER = "http://localhost:5174";
const MARK = process.env.MARK || "QAHSECRET";
const phase = process.argv[2] || "admin";
const cfg = JSON.parse(process.env.QA_CFG || "{}");
fs.mkdirSync("/w/_qa_H_out", { recursive: true });

function wire(page, out) {
  out.events = []; out.snapshots = []; out.errors = []; out.failed = [];
  page.on("pageerror", (e) => out.errors.push(e.message));
  page.on("requestfailed", (r) => out.failed.push(r.url()));
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    if (/usage\/events$/.test(r.url())) { try { out.events.push(...r.postDataJSON().events); } catch {} }
    if (/usage\/snapshots$/.test(r.url())) {
      try {
        const b = r.postDataJSON();
        const html = b.html_gz ? zlib.gunzipSync(Buffer.from(b.html_gz, "base64")).toString() : b.html || "";
        out.snapshots.push({ route: b.route, at: b.occurred_at, anchors: (b.anchors || []).length, anchorSample: (b.anchors || []).slice(0, 5), study_id: b.study_id, job_id: b.job_id, len: html.length, hasMark: html.includes(MARK), markCtx: html.includes(MARK) ? html.slice(Math.max(0, html.indexOf(MARK) - 300), html.indexOf(MARK) + 80) : null });
      } catch (e) { out.snapshots.push({ err: String(e) }); }
    }
  });
}

let n = 0;
async function fillAll(page, tag) {
  const loc = page.locator('input:visible, textarea:visible');
  const count = await loc.count();
  const done = [];
  for (let i = 0; i < count; i++) {
    const el = loc.nth(i);
    const type = ((await el.getAttribute("type").catch(() => "")) || "text").toLowerCase();
    if (["checkbox", "radio", "file", "range", "color", "hidden", "submit", "button"].includes(type)) continue;
    const val = type === "number" ? "4242" : type === "email" ? `${MARK.toLowerCase()}${++n}@x.org` : type === "date" ? "2026-01-02" : `${MARK}${tag}${++n}`;
    try {
      await el.click({ timeout: 2000 });
      await el.pressSequentially(val, { delay: 15, timeout: 8000 });
      done.push({ type, val });
    } catch (e) { done.push({ type, err: String(e).slice(0, 80) }); }
  }
  return done;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(seenGuides);
  const page = await ctx.newPage();
  const out = { phase, log: [] };
  wire(page, out);
  const log = (m) => { out.log.push([new Date().toISOString(), m]); console.log(m); };
  if (phase === "admin") {
    await login(page, cfg.user, "Test1234!", `${UI}/studies`);
    await page.waitForTimeout(3500);
    log("studies: " + JSON.stringify(await fillAll(page, "studies")));
    // open the "new study" modal if there is one and type into it
    for (const re of [/New study/i, /Create study/i]) {
      const b = page.getByRole("button", { name: re }).first();
      if (await b.isVisible().catch(() => false)) { await b.click(); await page.waitForTimeout(800); log("modal: " + JSON.stringify(await fillAll(page, "newstudy"))); await page.waitForTimeout(2000); await page.getByText(/Name/).first().click().catch(() => {}); await page.waitForTimeout(2500); await page.keyboard.press("Escape"); break; }
    }
    await page.goto(`${UI}/users`); await page.waitForTimeout(3500);
    log("users: " + JSON.stringify(await fillAll(page, "users")));
    for (const re of [/Create user/i, /New user/i, /Add user/i]) {
      const b = page.getByRole("button", { name: re }).first();
      if (await b.isVisible().catch(() => false)) { await b.click(); await page.waitForTimeout(800); log("usermodal: " + JSON.stringify(await fillAll(page, "newuser"))); await page.waitForTimeout(2500); await page.keyboard.press("Escape"); break; }
    }
    await page.goto(`${UI}/patients`); await page.waitForTimeout(3500);
    log("patients: " + JSON.stringify(await fillAll(page, "patients")));
    await page.goto(`${UI}/studies/${cfg.study}`); await page.waitForTimeout(3500);
    log("study: " + JSON.stringify(await fillAll(page, "study")));
    // keyboard shortcuts outside any field, scroll, wheel, mouse
    await page.locator("body").click({ position: { x: 800, y: 10 } }).catch(() => {});
    await page.keyboard.press("Escape"); await page.keyboard.press("?"); await page.keyboard.press("Control+k").catch(() => {});
    for (let i = 0; i < 15; i++) { await page.mouse.move(200 + i * 50, 200 + (i % 4) * 40); await page.waitForTimeout(110); }
    await page.mouse.wheel(0, 600); await page.waitForTimeout(300); await page.mouse.wheel(0, 600);
    // blur / focus, errors
    await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
    await page.evaluate(() => { setTimeout(() => { throw new Error("qa-h-thrown-error"); }, 0); Promise.reject(new Error("qa-h-rejection")); });
    // idle: no input for > 30 s (idle is checked every 5 s), then a move ends it
    log("idle start"); await page.waitForTimeout(41000); await page.mouse.move(10, 10); log("idle end");
    await page.waitForTimeout(12000);
    await page.goto(`${UI}/my-jobs`); await page.waitForTimeout(4000);
    await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForTimeout(11000);
  } else if (phase === "viewer") {
    const url = `${VIEWER}/viewer/series/${cfg.series}?studyId=${cfg.study}&caseId=${cfg.case}&jobId=${cfg.job}`;
    await login(page, cfg.user, "Test1234!", url);
    await page.waitForFunction(() => document.querySelectorAll("canvas").length >= 1, null, { timeout: 60000 });
    await page.waitForTimeout(8000);
    for (let i = 0; i < 20; i++) { await page.mouse.move(400 + i * 30, 300 + (i % 3) * 50); await page.waitForTimeout(110); }
    for (const t of ["tool-brush", "tool-cursor"]) await page.locator(`[data-testid="${t}"]`).click().catch(() => {});
    await page.keyboard.press("Escape"); await page.keyboard.press("b"); await page.keyboard.press("Control+z");
    log("viewer: " + JSON.stringify(await fillAll(page, "viewer")));
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(3000);
    await page.locator("header h1").click().catch(() => {});
    await page.waitForTimeout(12000);
    await page.goto(`${VIEWER}/tutorial`); await page.waitForTimeout(6000);
    log("tutorial: " + JSON.stringify(await fillAll(page, "tutorial")));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(12000);
  }
  await page.close(); await ctx.close(); await browser.close();
  fs.writeFileSync(`/w/_qa_H_out/tracker-${phase}.json`, JSON.stringify(out, null, 1));
  console.log("events", out.events.length, "snapshots", out.snapshots.length, "errors", out.errors.length);
})().catch((e) => { console.error(e); process.exit(1); });
