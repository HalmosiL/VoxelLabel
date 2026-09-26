// K7: handing in a reworked case (its objects carry the last round's
// verdicts) moved on to the next case with "You have unsaved changes on
// this case. Leave without saving them?" -- the check compared the saved
// hand-in with the objects as they were before it. Sets up: case A sent
// back by the reviewer, case B still open; the annotator hands A in.
const { chromium } = require("playwright");
const { F, login, token, saveMaskAs } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174", A8010 = "http://localhost:8010";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }
const seriesOf = async (tok, caseId) => (await api(tok, `${F.DATA}/data/cases/${caseId}/series`))[0].id;

(async () => {
  const at = await token("dr-test", "Test1234!");
  const rt = await token("dr-review", "Test1234!");
  const job = (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  if (job.cases.length < 2) { console.log("checks 0, fails 1\nFAIL the fixture job needs two cases"); process.exit(1); }
  const [a, b] = job.cases;
  const seriesA = await seriesOf(at, a.id), seriesB = await seriesOf(at, b.id);
  const current = await api(at, `${A8010}/series/${seriesA}/mask-volume`);
  if (!current.objects || current.objects.length === 0) { console.log("checks 0, fails 1\nFAIL the fixture case has no objects"); process.exit(1); }

  // case A: handed in, then sent back with one object rejected
  const plain = current.objects.map((o) => ({ ...o, review_status: undefined, reject_reason: undefined, review_comment: undefined, previous_review: undefined }));
  const sub = await saveMaskAs(at, seriesA, F.STUDY, "submitted", { objects: plain });
  const verdicts = plain.map((o, i) => ({ ...o, review_status: i === 0 ? "rejected" : "accepted", ...(i === 0 ? { reject_reason: "boundary", review_comment: "tighten the edge" } : {}) }));
  const draft = await saveMaskAs(rt, seriesA, F.STUDY, "draft", { objects: verdicts, review_of: sub.body.id });
  await fetch(`${A8010}/annotations/${draft.body.id}/review`, { method: "POST", headers: { Authorization: `Bearer ${rt}`, "content-type": "application/json" }, body: JSON.stringify({ decision: "reject", comment: "see object 1" }) });
  // case B: still to do (a draft is not handed in)
  await saveMaskAs(at, seriesB, F.STUDY, "draft");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await page.goto(`${VIEWER}/viewer/series/${seriesA}?studyId=${F.STUDY}&caseId=${a.id}&jobId=${F.ANNOT_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  // what came back is said at the top, with a way to each object (UX "Most")
  const banner = page.locator('[data-testid="rework-banner"]');
  check("a sent-back case says so at the top", await banner.isVisible());
  check("... with the reviewer's reason and comment", /boundary off: tighten the edge/i.test(await banner.innerText().catch(() => "")));
  // ... and My Jobs counts it
  const jobsPage = await ctx.newPage();
  await login(jobsPage, "dr-test", "Test1234!", "http://localhost:5173/my-jobs");
  await jobsPage.waitForSelector('[data-guide="job-card"], .card', { timeout: 30000 }).catch(() => {});
  await jobsPage.waitForTimeout(2000);
  const rejected = (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD).cases.filter((c) => c.status === "rejected").length;
  const chips = await jobsPage.locator('[data-testid="sent-back-count"]').allInnerTexts();
  check("My Jobs shows how many cases came back", chips.includes(`Sent back: ${rejected}`), { chips, rejected });
  await jobsPage.close();
  const mark = page.locator("header button", { hasText: /^Mark as Annotated$/ });
  await mark.click();
  // the hand-in may first show its summary; confirm it if so
  const confirm = page.locator('[data-testid="handin-confirm"]');
  if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) await confirm.click();
  await page.waitForTimeout(4000);
  check("handing in a reworked case asks nothing about unsaved changes", !dialogs.some((m) => /unsaved changes/i.test(m)), dialogs);
  check("... and moves on to the open case", page.url().includes(b.id) || page.url().includes(seriesB), page.url());
  const latest = await api(at, `${A8010}/series/${seriesA}/mask-volume`);
  check("case A really is handed in", latest.version_status === "submitted", latest.version_status);
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
