// Verifies the guided tours + hover tooltips end to end for an annotator
// and a reviewer, and re-captures the guide's screenshots from the final UI.
const { chromium } = require("playwright");
const { F } = require("./helpers");
const fs = require("fs");
const ADMIN = "http://localhost:8004", KC = "http://localhost:8080", VIEWER = "http://localhost:5174", UI = "http://localhost:5173";
const ANNOT_CARD = F.ANNOT_CARD, REVIEW_CARD = F.REVIEW_CARD;
const STUDY = F.STUDY;
const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

async function token(user, pass) {
  const r = await fetch(`${KC}/realms/ct-platform/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: user, password: pass, scope: "openid" }) });
  return (await r.json()).access_token;
}
// Full token set (access+refresh+id), for handing to the viewer page the
// same way admin-ui's own "Open in Viewer" link does now (see
// auth/viewerHandoff.ts) -- ct-annotator no longer gets a free ride off
// a shared Keycloak SSO cookie, since admin-ui's own login is now a
// direct password exchange that never visits Keycloak's hosted page.
async function tokenSet(user, pass) {
  const r = await fetch(`${KC}/realms/ct-platform/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: user, password: pass, scope: "openid" }) });
  const j = await r.json();
  return new URLSearchParams({ at: j.access_token, rt: j.refresh_token, it: j.id_token }).toString();
}
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }
// admin-ui (:5173) shows its own AuthPage now instead of redirecting to
// Keycloak's hosted login (see main.tsx) -- ct-annotator (:5174) still
// does, unchanged. Wait for whichever one actually shows up.
async function login(page, user, pass, url) {
  await page.goto(url);
  await Promise.race([
    page.waitForSelector("#username", { timeout: 30000 }),
    page.waitForSelector('[data-testid="signin-submit"]', { timeout: 30000 }),
  ]);
  if (await page.locator('[data-testid="signin-submit"]').isVisible().catch(() => false)) {
    await page.fill('input[autocomplete="username"]', user);
    await page.fill('input[type="password"]', pass);
    await page.click('[data-testid="signin-submit"]');
  } else {
    await page.fill("#username", user);
    await page.fill("#password", pass);
    await page.click("#kc-login");
  }
  await page.waitForURL((u) => !u.href.includes("localhost:8080"), { timeout: 30000 });
}
async function shot(loc, name) { try { await loc.screenshot({ path: `guide/${name}.png` }); } catch (e) { console.log("shot failed", name, e.message); } }
/** A card-proportioned (380x176 at 2x) crop centred on an element, so the guide's images show the control in context. */
async function shotAround(page, loc, name, w = 760, h = 352) {
  try {
    const b = await loc.boundingBox(); const vp = page.viewportSize();
    let x = b.x + b.width / 2 - w / 2, y = b.y + b.height / 2 - h / 2;
    x = Math.max(0, Math.min(x, vp.width - w)); y = Math.max(0, Math.min(y, vp.height - h));
    await page.screenshot({ path: `guide/${name}.png`, clip: { x, y, width: w, height: h } });
  } catch (e) { console.log("shotAround failed", name, e.message); }
}

/** Walks an open tour to the end, recording each step's title and whether a spotlight was drawn for targeted steps. */
async function walkTour(page, label) {
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ timeout: 8000 });
  const seen = [];
  for (let i = 0; i < 40; i++) {
    const title = await dialog.locator("h2").innerText();
    const counter = await dialog.locator("p", { hasText: /Step \d+ of \d+/ }).innerText();
    const spot = await page.locator('[data-guide-overlay] .ring-2').count();
    const img = await dialog.locator("img").count();
    const imgOk = img ? await dialog.locator("img").evaluate((el) => el.complete && el.naturalWidth > 0 && el.style.display !== "none") : null;
    seen.push({ title, counter, spot, img: imgOk });
    if (/drawing tools|Decide object|^One job$/.test(title)) await page.screenshot({ path: `tour-${label.replace(/\W+/g, "-")}.png` });
    const next = dialog.locator("[data-guide-next]");
    const txt = await next.innerText();
    await next.click();
    await page.waitForTimeout(250);
    if (txt === "Finish") break;
  }
  check(`${label}: tour walked to Finish`, (await dialog.count()) === 0, seen.map((s) => `${s.counter} ${s.title} spot=${s.spot} img=${s.img}`));
  const missingImg = seen.filter((s) => s.img === false);
  check(`${label}: all tour images loaded`, missingImg.length === 0, missingImg.map((s) => s.title));
  return seen;
}

async function hoverTip(page, locator, label) {
  await locator.hover();
  await page.waitForTimeout(500);
  const tip = page.locator('[role="tooltip"]');
  const n = await tip.count();
  const text = n ? await tip.first().innerText() : "";
  check(`${label}: tooltip`, n === 1 && text.length > 10, text.slice(0, 80));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
}

(async () => {
  const t = await token("dr-test", "Test1234!");
  const jobs = await api(t, `${ADMIN}/admin/my-jobs`);
  const job = jobs.find((j) => j.card_id === ANNOT_CARD);
  const kase = job.cases.find((c) => c.status === "rejected") ?? job.cases.find((c) => c.status !== "done");
  const series = (await api(t, `http://localhost:8002/data/cases/${kase.id}/series`))[0].id;
  const browser = await chromium.launch();

  // ---- annotator: workbench tours (fresh profile => auto-start) ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "dr-test", "Test1234!", `${UI}/my-jobs`);
    await page.waitForTimeout(1500);
    check("workbench: Tutorial button in header", (await page.locator("header button", { hasText: "Tutorial" }).count()) === 1);
    await walkTour(page, "my-jobs");
    // replay from the button, then close with Escape
    await page.locator("header button", { hasText: "Tutorial" }).click();
    await page.locator('[role="dialog"]').waitFor();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check("my-jobs: tour replays from Tutorial and closes on Esc", (await page.locator('[role="dialog"]').count()) === 0);
    await shot(page, "workbench-jobs");
    // reload: must not auto-open again
    await page.reload(); await page.waitForTimeout(1500);
    check("my-jobs: no auto-open on second visit", (await page.locator('[role="dialog"]').count()) === 0);
    // job page
    await page.goto(`${UI}/my-jobs/${ANNOT_CARD}`); await page.waitForTimeout(1500);
    const jobSeen = await walkTour(page, "job");
    check("job: reviewer-comment step present", jobSeen.some((s) => /reviewer said/.test(s.title)));
    await shot(page, "workbench-job");
    // case page
    await page.goto(`${UI}/studies/${STUDY}/cases/${kase.id}?jobId=${ANNOT_CARD}`); await page.waitForTimeout(2500);
    const caseSeen = await walkTour(page, "case");
    check("case: Open in Viewer step present", caseSeen.some((s) => /Open in Viewer/.test(s.title)));
    await shot(page, "workbench-case");
    check("workbench: no page errors", errors.length === 0, errors);

    // ---- viewer (annotate) tour + tooltips ----
    const vpage = await ctx.newPage();
    await vpage.setViewportSize({ width: 1600, height: 950 });
    const verrors = [];
    vpage.on("pageerror", (e) => verrors.push(e.message));
    const drTestHandoff = await tokenSet("dr-test", "Test1234!");
    await vpage.goto(`${VIEWER}/viewer/series/${series}?studyId=${STUDY}&caseId=${kase.id}&jobId=${ANNOT_CARD}&returnUrl=${encodeURIComponent(UI + "/my-jobs")}#${drTestHandoff}`);
    await vpage.waitForFunction(() => document.querySelectorAll("canvas").length >= 1, null, { timeout: 60000 });
    await vpage.waitForTimeout(3500);
    const aSeen = await walkTour(vpage, "viewer-annotate");
    check("viewer-annotate: >= 12 steps", aSeen.length >= 12, aSeen.length);
    check("viewer-annotate: every targeted step got a spotlight", aSeen.filter((s, i) => i > 0 && i < aSeen.length - 1).every((s) => s.spot === 1));
    // tooltips
    await hoverTip(vpage, vpage.locator('[data-guide="tool-paint"]'), "viewer: Paint tool");
    await hoverTip(vpage, vpage.locator('[data-guide="tool-auto"]'), "viewer: Auto tool");
    await hoverTip(vpage, vpage.locator('[data-guide="mark-annotated"]'), "viewer: Mark as Annotated");
    await hoverTip(vpage, vpage.locator('[data-guide="save"]'), "viewer: Save");
    await hoverTip(vpage, vpage.locator("aside button", { hasText: "Lung" }), "viewer: Lung preset");
    await hoverTip(vpage, vpage.locator('[data-guide="window"] span.cursor-help').first(), "viewer: section help icon");
    await hoverTip(vpage, vpage.locator('header button[aria-label="Tutorial"]'), "viewer: Tutorial button");
    // Tutorial button replays
    await vpage.locator('header button[aria-label="Tutorial"]').click();
    await vpage.locator('[role="dialog"]').waitFor();
    check("viewer: Tutorial button replays", true);
    await vpage.keyboard.press("Escape");
    await vpage.waitForTimeout(300);
    // fresh screenshots for the guide
    await vpage.locator('[data-testid^="object-"]').first().click().catch(() => {});
    await vpage.locator('[data-testid="tool-paint"]').click().catch(() => {});
    await vpage.waitForTimeout(300);
    await shot(vpage, "viewer-annotate");
    { // the toolbar column is full-height; anchor the crop on its first button instead
      const b = await vpage.locator('[data-guide="tool-cursor"]').boundingBox();
      await vpage.screenshot({ path: "guide/viewer-toolbar.png", clip: { x: 0, y: Math.max(0, b.y - 12), width: 520, height: 352 } });
    }
    await shotAround(vpage, vpage.locator('[data-guide="objects"]'), "viewer-objects");
    await shotAround(vpage, vpage.locator("header > div").last(), "viewer-header", 900, 200);
    // tooltip visual check
    await vpage.locator('[data-guide="tool-auto"]').hover(); await vpage.waitForTimeout(600);
    await vpage.screenshot({ path: "tooltip-auto.png", clip: { x: 0, y: 200, width: 420, height: 220 } });
    await vpage.mouse.move(5, 5);
    check("viewer-annotate: no page errors", verrors.length === 0, verrors);
    await ctx.close();
  }

  // ---- reviewer ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const rt = await token("dr-review", "Test1234!");
    const rjob = (await api(rt, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === REVIEW_CARD);
    const rcase = rjob.cases.find((c) => c.pending_annotation_id) ?? rjob.cases[0];
    const rseries = (await api(rt, `http://localhost:8002/data/cases/${rcase.id}/series`))[0].id;
    await login(page, "dr-review", "Test1234!", `${UI}/my-jobs`);
    await page.waitForTimeout(1500);
    const seen = await walkTour(page, "reviewer my-jobs");
    check("reviewer my-jobs: tour has no annotation-section step", !seen.some((s) => /Annotation jobs/.test(s.title)), seen.map((s) => s.title));
    const vpage = await ctx.newPage();
    await vpage.setViewportSize({ width: 1600, height: 950 });
    const drReviewHandoff = await tokenSet("dr-review", "Test1234!");
    await vpage.goto(`${VIEWER}/viewer/series/${rseries}?studyId=${STUDY}&caseId=${rcase.id}&jobId=${REVIEW_CARD}&returnUrl=${encodeURIComponent(UI + "/my-jobs")}#${drReviewHandoff}`);
    await vpage.waitForFunction(() => document.querySelectorAll("canvas").length >= 1, null, { timeout: 60000 });
    await vpage.waitForTimeout(3500);
    check("review viewer title", (await vpage.locator("header h1").innerText()) === "Review");
    const rSeen = await walkTour(vpage, "viewer-review");
    check("viewer-review: mentions Submit review", rSeen.some((s) => /Submit/.test(s.title)));
    await hoverTip(vpage, vpage.locator("aside button", { hasText: "Reject" }), "review: Reject");
    await hoverTip(vpage, vpage.locator("aside button", { hasText: "Accept" }), "review: Accept");
    await hoverTip(vpage, vpage.locator('[data-guide="submit-review"]'), "review: Submit review");
    await shot(vpage, "viewer-review");
    await shotAround(vpage, vpage.locator('[data-guide="review-card"]'), "viewer-review-card");
    await shotAround(vpage, vpage.locator('[data-guide="review-objects"]'), "viewer-review-objects");
    check("reviewer: no page errors", errors.length === 0, errors);
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync("tour-results.json", JSON.stringify(results, null, 1));
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const r of results) if (!r.ok) console.log("FAIL", r.name, JSON.stringify(r.extra));
})().catch((e) => { console.error("EXC", e); process.exit(1); });
