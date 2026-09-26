// Only handed-in work is reviewed, and a decision stands (F-07, F-09),
// and the reviewer saving their progress doesn't take the case back out
// of "handed in" (F-01). Leaves the open case handed in, with a reviewer
// draft on it -- still reviewable for the specs that follow.
const { chromium } = require("playwright");
const { F, token, saveMaskAs } = require("./helpers");
const ADMIN = "http://localhost:8004", KC_VIEWER = "http://localhost:5174";

async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }
const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

async function openReview(browser, seriesId, caseId) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review", "workbench", "job", "case"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(`${KC_VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${caseId}&jobId=${F.REVIEW_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-review"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  return { ctx, page };
}
const headerButton = (page, name) => page.locator("header button", { hasText: new RegExp(`^${name}$`) });

(async () => {
  const at = await token("dr-test", "Test1234!");
  const rt = await token("dr-review", "Test1234!");
  const reviewJob = async () => (await api(rt, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.REVIEW_CARD);
  const annotJob = async () => (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const seriesOf = async (caseId) => (await api(rt, `${F.DATA}/data/cases/${caseId}/series`))[0].id;
  const browser = await chromium.launch();

  // ---- F-07: a decided case can't be re-decided from the viewer ----
  const decided = (await reviewJob()).cases.find((c) => c.status === "done");
  if (decided) {
    const { ctx, page } = await openReview(browser, await seriesOf(decided.id), decided.id);
    check("a decided case says so", /already (approved|rejected)/.test(await page.locator('[data-testid="review-blocked"]').innerText().catch(() => "")));
    check("... and Submit review is off (and there is no Save button: decisions save themselves)", (await headerButton(page, "Submit review").isDisabled()) && (await headerButton(page, "Save").count()) === 0);
    await ctx.close();
  } else check("a decided case exists to check", false);

  // The open case: the annotator's draft means it isn't handed in.
  const open = (await annotJob()).cases.find((c) => c.status !== "done") ?? (await annotJob()).cases[0];
  const openSeries = await seriesOf(open.id);
  await saveMaskAs(at, openSeries, F.STUDY, "draft");

  // ---- F-09: work that wasn't handed in can't be reviewed ----
  {
    const { ctx, page } = await openReview(browser, openSeries, open.id);
    check("a case not handed in says so", /hasn't been handed in/.test(await page.locator('[data-testid="review-blocked"]').innerText().catch(() => "")));
    check("... and Submit review is off", await headerButton(page, "Submit review").isDisabled());
    await ctx.close();
  }

  // ---- F-01: the reviewer's saved work (saved as they go) keeps the case handed in ----
  await saveMaskAs(at, openSeries, F.STUDY, "submitted");
  {
    const { ctx, page } = await openReview(browser, openSeries, open.id);
    check("a handed-in case can be reviewed", (await page.locator('[data-testid="review-blocked"]').count()) === 0);
    await page.locator("aside button", { hasText: "Accept" }).first().click(); // a decision, which saves itself
    await page.waitForTimeout(3500);
    const annCase = (await annotJob()).cases.find((c) => c.id === open.id);
    const revCase = (await reviewJob()).cases.find((c) => c.id === open.id);
    check("after the reviewer's Save the annotator still sees it handed in", annCase.status === "done", annCase);
    check("... and the review queue still has it to decide", Boolean(revCase.pending_annotation_id), revCase);
    await ctx.close();
  }

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
