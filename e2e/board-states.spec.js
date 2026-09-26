// UX-ux-admin-10/21: the job state on the board was unreadable -- the job
// card's Run button said "Refresh from upstream", and a Review fed straight
// from its Annotation (with "(rejected)" fed back) read "stale" right after
// every Run. Uses the UX pilot study's Lane A (Annotation -> Review A,
// rejected branch back into the Annotation).
const { chromium } = require("playwright");
const { login, seenGuides, token } = require("./helpers");
const ADMIN = "http://localhost:8004", UI = "http://localhost:5173";
const STUDY = "a1706417-e9b1-4cec-ac9a-d4c46e577499";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

(async () => {
  const t = await token("platform-admin", "platform-admin");
  const board = await (await fetch(`${ADMIN}/admin/studies/${STUDY}/workflow`, { headers: { Authorization: `Bearer ${t}` } })).json();
  const review = board.cards.find((c) => c.title === "Review A");
  if (!review) { console.log("checks 0, fails 1\nFAIL the UX pilot board has no Review A"); process.exit(1); }
  const run = await fetch(`${ADMIN}/admin/workflow-cards/${review.id}/run`, { method: "POST", headers: { Authorization: `Bearer ${t}` } });
  check("Review A runs", run.status === 200, run.status);
  const after = await (await fetch(`${ADMIN}/admin/studies/${STUDY}/workflow`, { headers: { Authorization: `Bearer ${t}` } })).json();
  const outOfDate = after.cards.filter((c) => c.stale).map((c) => c.title);
  check("right after Run, nothing on the board is out of date", outOfDate.length === 0, outOfDate);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  if (seenGuides) await ctx.addInitScript(seenGuides);
  const page = await ctx.newPage();
  await login(page, "platform-admin", "platform-admin", `${UI}/studies/${STUDY}/workflow`);
  await page.waitForSelector(".react-flow__node", { timeout: 30000 });
  await page.waitForTimeout(2000);
  check("the board shows no out-of-date badge", (await page.locator('[data-testid="card-out-of-date"]').count()) === 0);
  await page.locator(".react-flow__node", { hasText: "Review A" }).first().click();
  await page.waitForTimeout(800);
  const panel = await page.locator("aside").last().innerText();
  check("the job's Run button says what it does", /Update the case list/.test(panel) && !/Refresh from upstream/.test(panel), panel.slice(0, 400));
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
