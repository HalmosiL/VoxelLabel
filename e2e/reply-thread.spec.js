// UX-rev-1-21 / UX-rev-2-24: an annotator who disagreed with a rejection
// ("that's a crossing vessel") could only say so in their own note, and in
// round 2 the reviewer never saw it. A rejected object now has a "Reply to
// the reviewer" box; at the hand-in the reply travels with the verdict,
// and the reviewer reads it under "Last round". Leaves the case handed in.
const { chromium } = require("playwright");
const { F, token, saveMaskAs } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174", A8010 = "http://localhost:8010";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

async function open(browser, user, jobId, seriesId, caseId) {
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
  const at = await token("dr-test", "Test1234!");
  const rt = await token("dr-review", "Test1234!");
  const job = (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const seriesId = (await api(at, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const current = await api(at, `${A8010}/series/${seriesId}/mask-volume`);
  const plain = current.objects.map((o) => ({ ...o, hidden: false, review_status: undefined, reject_reason: undefined, review_comment: undefined, previous_review: undefined, reply: undefined }));
  const sub = await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: plain });
  const verdicts = plain.map((o, i) => ({ ...o, review_status: i === 0 ? "rejected" : "accepted", ...(i === 0 ? { reject_reason: "missed", review_comment: "add slice 55" } : {}) }));
  const draft = await saveMaskAs(rt, seriesId, F.STUDY, "draft", { objects: verdicts, review_of: sub.body.id });
  await fetch(`${A8010}/annotations/${draft.body.id}/review`, { method: "POST", headers: { Authorization: `Bearer ${rt}`, "content-type": "application/json" }, body: JSON.stringify({ decision: "reject", comment: "see object 1" }) });

  const browser = await chromium.launch();
  let page = await open(browser, "dr-test", F.ANNOT_CARD, seriesId, kase.id);
  const rejected = plain[0].id;
  await page.locator(`[data-testid="form-toggle-${rejected}"]`).click();
  const reply = page.locator(`[data-testid="reply-${rejected}"]`);
  check("a rejected object offers a reply to the reviewer", await reply.isVisible().catch(() => false));
  check("... accepted ones don't", (await page.locator(`[data-testid="reply-${plain[1].id}"]`).count()) === 0);
  await reply.fill("That is a crossing vessel, not the nodule.");
  await page.locator("header button", { hasText: /^Mark as Annotated$/ }).click();
  await page.locator('[data-testid="handin-confirm"]').click();
  await page.waitForTimeout(3000);
  const handed = await api(at, `${A8010}/series/${seriesId}/mask-volume`);
  const prev = (handed.objects.find((o) => o.id === rejected) || {}).previous_review || {};
  check("the reply travels with the verdict", prev.reply === "That is a crossing vessel, not the nodule." && handed.version_status === "submitted", prev);
  await page.context().close();

  page = await open(browser, "dr-review", F.REVIEW_CARD, seriesId, kase.id);
  const last = await page.locator('[data-testid="previous-review"]').innerText().catch(() => "");
  check("the reviewer reads it under Last round", /annotator's reply: That is a crossing vessel/.test(last), last);
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
