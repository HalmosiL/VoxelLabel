// A study's workflow analytics page on the seeded study: headline tiles,
// the board with per-card figures, the case / label / people tables with
// their CSV exports -- and that it is for the study's managers only.
const fs = require("fs");
const { chromium } = require("playwright");
const { F, login, token } = require("./helpers");
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });
const seen = () => { try { for (const k of ["studies", "study", "study-analytics", "usage"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} };

(async () => {
  const annot = await token("dr-test", "Test1234!");
  const denied = await fetch(`${F.ADMIN}/admin/studies/${F.STUDY}/analytics`, { headers: { Authorization: `Bearer ${annot}` } });
  check("an annotator on the study may not read its analytics", denied.status === 403, denied.status);
  const admin = await token("platform-admin", "platform-admin");
  const body = await (await fetch(`${F.ADMIN}/admin/studies/${F.STUDY}/analytics`, { headers: { Authorization: `Bearer ${admin}` } })).json();
  check("the API counts the seeded cases, with one finished and one sent back", body.headline.cases >= 6 && body.headline.states.done >= 1 && body.cases.some((c) => c.sent_back >= 1), body.headline);
  check("every case carries the steps it went through", body.cases.filter((c) => c.rounds > 0).every((c) => c.path.length >= 1 && c.path[0].kind === "submitted" && c.path[0].step), body.cases.map((c) => c.path.length));
  check("the board's two job steps are counted", body.headline.steps === 2 && typeof body.headline.slices === "number");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  await ctx.addInitScript(seen);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await login(page, "platform-admin", "platform-admin", `${F.UI}/studies/${F.STUDY}`);
  await page.waitForSelector('[data-testid="study-analytics-link"]', { timeout: 30000 });
  await page.locator('[data-testid="study-analytics-link"]').click();
  await page.waitForSelector('[data-testid="analytics-tiles"]', { timeout: 30000 });
  check("the study page links to its analytics", page.url().endsWith(`/studies/${F.STUDY}/analytics`), page.url());
  check("four headline tiles", (await page.locator('[data-testid="analytics-tiles"] .stat-card').count()) === 4);
  check("the finished tile reads n / total", /^\d+ \/ \d+$/.test(await page.locator('[data-testid="analytics-tile-progress"] .stat-value').innerText()));

  await page.waitForSelector('[data-testid="analytics-node-annotation"]', { timeout: 20000 });
  check("the graph draws the annotation and review cards with their figures", (await page.locator('[data-testid="analytics-node-annotation"]').innerText()).includes("In · submitted · here now") && (await page.locator('[data-testid="analytics-node-review"]').innerText()).includes("Approved · sent back"));
  check("the graph draws the board's connections", (await page.locator('[data-testid="analytics-graph"] .react-flow__edge').count()) >= 2);
  check("week by week shows bars", (await page.locator('[data-testid="analytics-weekly"] rect').count()) >= 1);
  await page.screenshot({ path: "study-analytics.png", fullPage: true });

  const downloaded = async (testId) => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.locator(`[data-testid="${testId}"]`).click()]);
    return fs.readFileSync(await dl.path(), "utf8");
  };
  await page.locator('[data-testid="analytics-tab-cases"]').click();
  const all = await page.locator('[data-testid="analytics-case-row"]').count();
  check("the cases tab lists every case", all === body.cases.length, { all, api: body.cases.length });
  check("the cases tab lists the cases that went back and forth (or says there are none)", (await page.locator('[data-testid="analytics-problems"]').count()) === 1 && (await page.locator('[data-testid="analytics-problem-case"]').count()) === body.cases.filter((c) => c.sent_back >= 2).length);
  check("each worked case shows its steps as a path", (await page.locator('[data-testid="analytics-case-row"] [data-testid="analytics-case-path"]').count()) >= 1);
  await page.locator('[data-testid="analytics-filter-done"]').click();
  const doneRows = await page.locator('[data-testid="analytics-case-row"]').count();
  // narrows, unless every case is done (the shared fixture reaches that state)
  check("filtering by state narrows the table", doneRows === body.headline.states.done && (doneRows < all || body.headline.states.done === all), { doneRows, all });
  const casesCsv = await downloaded("analytics-export-cases");
  check("cases CSV has rounds, lead time and who", /^\uFEFFCase,Case id,State,Waiting at,Steps,Rounds,Reviews,Sent back,Passed first time/.test(casesCsv));

  await page.locator('[data-testid="analytics-tab-labels"]').click();
  check("the labels tab renders (a table or its empty state)", (await page.locator('[data-testid="analytics-labels"]').count()) === 1);
  await page.locator('[data-testid="analytics-tab-people"]').click();
  const people = await page.locator('[data-testid="analytics-person-row"]').allInnerTexts();
  check("the people tab lists the annotator and the reviewer by name", people.some((t) => t.includes("Anna Annotator")) && people.some((t) => t.includes("Rita Reviewer")), people);
  const peopleCsv = await downloaded("analytics-export-people");
  check("people CSV has both sides of the work", /Cases annotated,.*Reviews,/.test(peopleCsv.split(/\r?\n/)[0]));
  check("no page errors", errors.length === 0, errors);
  await ctx.close();

  // the annotator sees no Analytics link on the study page
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx2.addInitScript(seen);
  const page2 = await ctx2.newPage();
  await login(page2, "dr-test", "Test1234!", `${F.UI}/studies/${F.STUDY}`);
  await page2.waitForTimeout(3000);
  check("an annotator's study page has no Analytics link", (await page2.locator('[data-testid="study-analytics-link"]').count()) === 0);

  // G-11: a first visit doesn't spring the tour open, like every other admin page
  const ctx3 = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx3.addInitScript(() => { try { for (const k of ["studies", "study"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page3 = await ctx3.newPage();
  await login(page3, "platform-admin", "platform-admin", `${F.UI}/studies/${F.STUDY}/analytics`);
  await page3.waitForSelector('[data-testid="analytics-tiles"]', { timeout: 30000 });
  await page3.waitForTimeout(2500);
  check("the analytics tour doesn't open by itself on a first visit", (await page3.locator('[role="dialog"]').count()) === 0);
  await browser.close();

  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
