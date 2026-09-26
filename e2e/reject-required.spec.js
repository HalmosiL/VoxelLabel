// Rejecting (UX-rev-2-02, UX-rev-1-09): a reject went through with no
// reason and no comment, the card jumped to the next object and showed the
// first one's reason chips under it. Now Reject stays on the object, the
// comment box takes the focus, and Submit waits for a reason and a comment.
// Sets the fixture case up as handed in; leaves it handed in, undecided.
const { chromium } = require("playwright");
const { F, token, saveMaskAs } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174", A8010 = "http://localhost:8010";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

(async () => {
  const at = await token("dr-test", "Test1234!");
  const job = (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const seriesId = (await api(at, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const current = await api(at, `${A8010}/series/${seriesId}/mask-volume`);
  if (!current.objects || current.objects.length < 2) { console.log("checks 0, fails 1\nFAIL the fixture case needs two objects"); process.exit(1); }
  const plain = current.objects.map((o) => ({ ...o, review_status: undefined, reject_reason: undefined, review_comment: undefined }));
  await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: plain });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.REVIEW_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-review"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  const card = page.locator('[data-testid="review-card"]');
  const before = await card.locator('[data-testid="review-object-name"]').innerText();
  await card.getByRole("button", { name: "Reject" }).click(); await page.waitForTimeout(300);
  check("Reject stays on the object it rejected", (await card.locator('[data-testid="review-object-name"]').innerText()) === before, before);
  check("... its reason chips are right there", (await card.locator('[data-testid="reject-reasons"]').count()) === 1);
  check("... and the comment box has the focus", await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "review-comment"));
  // decide the rest so only the rejected one's reason/comment is missing
  for (let i = 0; i < 80 && (await card.getByRole("button", { name: "Accept" }).count()); i++) {
    const pending = await page.locator('[data-testid^="review-dot-"][data-status="pending"]').count();
    if (pending === 0) break;
    await page.locator('[data-testid^="review-dot-"][data-status="pending"]').first().click(); await page.waitForTimeout(150);
    await card.getByRole("button", { name: "Accept" }).click(); await page.waitForTimeout(150);
  }
  const submit = page.locator("header button", { hasText: /^Submit review$/ });
  check("Submit waits for a reason and a comment", await submit.isDisabled());
  check("... and says what is missing", /needs a reason and a comment/i.test(await page.locator("body").innerText()));
  await page.locator('[data-testid^="review-dot-"][data-status="rejected"]').first().click(); await page.waitForTimeout(200);
  await card.locator('[data-testid^="reject-reason-"]').first().click();
  check("... a reason alone is not enough", await submit.isDisabled());
  await page.locator('[data-testid="review-comment"]').fill("The edge misses the upper part.");
  await page.waitForTimeout(300);
  check("... with both, Submit is on", !(await submit.isDisabled()));
  // the decisions save themselves: a reload (or a closed tab) keeps them (UX-rev-1-01, UX-rev-2-03)
  check("in review there is no Save button to forget", (await page.locator("header button", { hasText: /^Save$/ }).count()) === 0);
  await page.waitForTimeout(3500);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.locator('[data-testid^="review-dot-"][data-status="rejected"]').first().click().catch(() => {}); await page.waitForTimeout(300);
  check("after a reload the rejection, its reason and its comment are still there",
    (await page.locator('[data-testid^="review-dot-"][data-status="rejected"]').count()) === 1 &&
    (await page.locator('[data-testid="review-comment"]').inputValue()) === "The edge misses the upper part." &&
    (await page.locator('[data-testid="reject-reasons"] button.border-red-400').count()) === 1);
  await browser.close();
  // leave the fixture handed in, undecided
  await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: plain });

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
