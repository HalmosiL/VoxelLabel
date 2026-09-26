// Handing in and deciding, with a last look and a way back (UX "Most"):
// "Mark as Annotated" shows what is being handed in (the objects and their
// slices, what looks unfinished) before it goes through; afterwards an
// "Undo" stays on screen for a few seconds, also across the move to the
// next case, and takes the hand-in back. The same Undo follows a review
// decision. Leaves the fixture case awaiting a decision.
const { chromium } = require("playwright");
const { F, token, saveMaskAs } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174", A8010 = "http://localhost:8010";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

async function signIn(browser, url, user) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.goto(url);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", user); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  return page;
}

(async () => {
  const at = await token("dr-test", "Test1234!");
  const job = (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const seriesId = (await api(at, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const current = await api(at, `${A8010}/series/${seriesId}/mask-volume`);
  if (!current.objects || current.objects.length === 0) { console.log("checks 0, fails 1\nFAIL the fixture case has no objects"); process.exit(1); }
  const plain = current.objects.map((o) => ({ ...o, review_status: undefined, reject_reason: undefined, review_comment: undefined, previous_review: undefined }));
  await saveMaskAs(at, seriesId, F.STUDY, "draft", { objects: plain });
  const status = async () => (await api(at, `${A8010}/series/${seriesId}/mask-volume`)).version_status;

  const browser = await chromium.launch();
  // ---- the annotator ----
  let page = await signIn(browser, `${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`, "dr-test");
  const mark = page.locator("header button", { hasText: /^Mark as Annotated$/ });
  await mark.click();
  const dialog = page.locator('[data-testid="handin-dialog"]');
  check("Mark as Annotated first shows what is being handed in", await dialog.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false));
  const listed = await dialog.locator('[data-testid="handin-objects"] li').count();
  check("... every object, with its slices", listed === plain.length && /slice/i.test(await dialog.innerText()), { listed, objects: plain.length });
  await dialog.getByRole("button", { name: "Keep working" }).click();
  check("Keep working closes it and hands nothing in", !(await dialog.isVisible()) && (await status()) === "draft");
  await mark.click();
  await page.locator('[data-testid="handin-confirm"]').click();
  const toast = page.locator('[data-testid="undo-toast"]');
  check("after the hand-in an Undo is offered", await toast.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false));
  check("... the case really is handed in", (await status()) === "submitted");
  await page.waitForTimeout(2500); // the viewer moves on to the next case meanwhile
  check("... and the offer is still there after the move on", await toast.isVisible());
  await page.locator('[data-testid="undo-button"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="undo-result"]'), null, { timeout: 10000 }).catch(() => {});
  check("Undo says it was taken back", /taken back/i.test(await page.locator('[data-testid="undo-result"]').innerText().catch(() => "")));
  check("... the case is a draft again", (await status()) === "draft");
  await page.waitForTimeout(3000);
  check("... and it is open again", page.url().includes(kase.id), page.url());
  await page.context().close();

  // ---- the reviewer ----
  await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: plain });
  page = await signIn(browser, `${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.REVIEW_CARD}`, "dr-review");
  const card = page.locator('[data-testid="review-card"]');
  for (let i = 0; i < 80; i++) {
    const pending = page.locator('[data-testid^="review-dot-"][data-status="pending"]');
    if ((await pending.count()) === 0) break;
    await pending.first().click(); await page.waitForTimeout(120);
    await card.getByRole("button", { name: "Accept" }).click(); await page.waitForTimeout(120);
  }
  await page.locator("header button", { hasText: /^Submit review$/ }).click();
  // ... which first shows the decision it makes
  const reviewDialog = page.locator('[data-testid="review-submit-dialog"]');
  check("Submit review first shows the decision", await reviewDialog.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false));
  check("... approve, with every object counted", /Approve/.test(await reviewDialog.innerText().catch(() => "")) && (await page.locator('[data-testid="review-submit-counts"]').innerText().catch(() => "")).startsWith(`${plain.length} accepted`));
  await page.locator('[data-testid="review-submit-confirm"]').click();
  const reviewToast = page.locator('[data-testid="undo-toast"]');
  check("after a decision an Undo is offered too", await reviewToast.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false));
  check("... the case is approved", (await status()) === "approved");
  await page.locator('[data-testid="undo-button"]').click();
  await page.waitForTimeout(3000);
  const after = await api(at, `${A8010}/series/${seriesId}/mask-volume`);
  check("Undo takes the decision back: awaiting a decision again", after.version_status === "draft" && Boolean(after.review_of_id), { s: after.version_status, of: after.review_of_id });
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
