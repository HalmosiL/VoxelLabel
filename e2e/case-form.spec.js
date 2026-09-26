// UX-ux-admin-16: a per-case question (triage: "No finding / Nodule /
// Other") needed a fake object, because forms belonged to drawn objects.
// The Annotation Surface now asks case questions: the annotator answers
// them above the objects, the hand-in warns when one is open, the answers
// are saved with the annotation, and the reviewer sees them.
const { chromium } = require("playwright");
const { F, token } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174", A8010 = "http://localhost:8010";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function call(tok, method, path, body) {
  const r = await fetch(`${ADMIN}${path}`, { method, headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.status === 204 ? null : r.json().catch(() => null);
}
const QUESTION = { name: "Finding", kind: "choice", options: ["No finding", "Nodule", "Other"] };

async function openViewer(browser, user, jobId, seriesId, caseId) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${caseId}&jobId=${jobId}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", user); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  return page;
}

(async () => {
  const at = await token("platform-admin", "platform-admin");
  const board = await call(at, "GET", `/admin/studies/${F.STUDY}/workflow`);
  const surfaceEdge = board.edges.find((e) => e.target_card_id === F.ANNOT_CARD && e.target_handle === "surface_config");
  let surface, createdEdge = null, createdSurface = null;
  if (surfaceEdge) surface = board.cards.find((c) => c.id === surfaceEdge.source_card_id);
  else {
    createdSurface = surface = await call(at, "POST", `/admin/studies/${F.STUDY}/workflow/cards`, { type: "annotation_surface", title: "QA case questions", position_x: -600, position_y: -300, config: {} });
    createdEdge = await call(at, "POST", `/admin/studies/${F.STUDY}/workflow/edges`, { source_card_id: surface.id, source_handle: "surface_config", target_card_id: F.ANNOT_CARD, target_handle: "surface_config" });
  }
  const original = surface.config;
  const dt = await token("dr-test", "Test1234!");
  const job = (await call(dt, "GET", "/admin/my-jobs")).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const seriesId = (await (await fetch(`${F.DATA}/data/cases/${kase.id}/series`, { headers: { Authorization: `Bearer ${dt}` } })).json())[0].id;
  const browser = await chromium.launch();
  try {
    await call(at, "PATCH", `/admin/workflow-cards/${surface.id}`, { config: { ...original, case_fields: [QUESTION] } });
    let page = await openViewer(browser, "dr-test", F.ANNOT_CARD, seriesId, kase.id);
    const form = page.locator('[data-testid="case-form"]');
    check("the case questions are above the objects", await form.isVisible() && /Finding/i.test(await form.innerText()));
    // clear an earlier run's answer
    const noFinding = form.locator('[data-testid="field-choice-Finding-No finding"]');
    if ((await noFinding.getAttribute("aria-checked")) === "true") await noFinding.click();
    await page.locator("header button", { hasText: /^Mark as Annotated$/ }).click();
    const dialog = page.locator('[data-testid="handin-dialog"]');
    await dialog.waitFor({ timeout: 3000 }).catch(() => {});
    check("the hand-in says a case question is open", /The case: Finding not answered/.test(await dialog.innerText().catch(() => "")));
    await dialog.getByRole("button", { name: "Keep working" }).click();
    await noFinding.click();
    await page.locator("header button", { hasText: /^Mark as Annotated$/ }).click();
    check("... and not once it is answered", !/Finding not answered/.test(await dialog.innerText().catch(() => "")));
    await page.locator('[data-testid="handin-confirm"]').click();
    await page.waitForTimeout(3000);
    const saved = await (await fetch(`${A8010}/series/${seriesId}/mask-volume`, { headers: { Authorization: `Bearer ${dt}` } })).json();
    check("the answer is saved with the annotation", saved.case_answers && saved.case_answers.Finding === "No finding" && saved.version_status === "submitted", { a: saved.case_answers, s: saved.version_status });
    await page.context().close();

    page = await openViewer(browser, "dr-review", F.REVIEW_CARD, seriesId, kase.id);
    const reviewForm = page.locator('[data-testid="case-form"]');
    check("the reviewer sees the answer", (await reviewForm.locator('[data-testid="field-choice-Finding-No finding"]').getAttribute("aria-checked").catch(() => null)) === "true");
    await page.context().close();
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
