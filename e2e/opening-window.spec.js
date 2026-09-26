// K8: every case opened in the image's own window, so in a lung-nodule job
// some opened in soft tissue, where a ground-glass nodule is invisible. A
// job's Surface now names the window cases open in, and its Review job
// inherits it. Sets the fixture job's surface to Lung for the check and puts
// it back afterwards.
const { chromium } = require("playwright");
const { F, token } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function call(tok, method, path, body) {
  const r = await fetch(`${ADMIN}${path}`, { method, headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => null);
}

async function openedWindow(browser, user, jobId, seriesId, caseId) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); for (const k of Object.keys(localStorage)) if (k.startsWith("vl.viewer.window.")) localStorage.removeItem(k); } catch {} });
  const page = await ctx.newPage();
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${caseId}&jobId=${jobId}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", user); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  if ((await page.locator('[data-testid="panel-toggle"]').count()) > 0) await page.locator('[data-testid="panel-toggle"]').click();
  const lung = page.locator("button", { hasText: /^Lung$/ }).first();
  const on = /border-blue-500/.test((await lung.getAttribute("class")) ?? "");
  await ctx.close();
  return on;
}

(async () => {
  const at = await token("platform-admin", "platform-admin");
  const board = await call(at, "GET", `/admin/studies/${F.STUDY}/workflow`);
  const surfaceEdge = board.edges.find((e) => e.target_card_id === F.ANNOT_CARD && e.target_handle === "surface_config");
  let surface, createdEdge = null, createdSurface = null;
  if (surfaceEdge) surface = board.cards.find((c) => c.id === surfaceEdge.source_card_id);
  else {
    createdSurface = surface = await call(at, "POST", `/admin/studies/${F.STUDY}/workflow/cards`, { type: "annotation_surface", title: "QA K8 surface", position_x: -600, position_y: -300, config: {} });
    createdEdge = await call(at, "POST", `/admin/studies/${F.STUDY}/workflow/edges`, { source_card_id: surface.id, source_handle: "surface_config", target_card_id: F.ANNOT_CARD, target_handle: "surface_config" });
  }
  const original = surface.config;
  const dt = await token("dr-test", "Test1234!");
  const job = (await call(dt, "GET", "/admin/my-jobs")).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const seriesId = (await (await fetch(`${F.DATA}/data/cases/${kase.id}/series`, { headers: { Authorization: `Bearer ${dt}` } })).json())[0].id;
  const browser = await chromium.launch();
  try {
    await call(at, "PATCH", `/admin/workflow-cards/${surface.id}`, { config: { ...original, default_window: "Lung" } });
    check("the annotator's case opens in the Surface's Lung window", await openedWindow(browser, "dr-test", F.ANNOT_CARD, seriesId, kase.id));
    check("... and the review job inherits it", await openedWindow(browser, "dr-review", F.REVIEW_CARD, seriesId, kase.id));
  } finally {
    await browser.close();
    if (createdEdge) await call(at, "DELETE", `/admin/workflow-edges/${createdEdge.id}`);
    if (createdSurface) await call(at, "DELETE", `/admin/workflow-cards/${createdSurface.id}`);
    else await call(at, "PATCH", `/admin/workflow-cards/${surface.id}`, { config: original });
  }
  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
