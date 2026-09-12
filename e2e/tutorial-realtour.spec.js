const { chromium } = require("playwright");
const { F } = require("./helpers");
const VIEWER = "http://localhost:5174";
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });
async function login(page, user, pass, url) {
  await page.goto(url); await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", user); await page.fill("#password", pass); await page.click("#kc-login");
  await page.waitForURL((u) => !u.href.includes("localhost:8080"), { timeout: 30000 });
}
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));

  await login(page, "dr-test", "Test1234!", `${VIEWER}/tutorial`);
  await page.waitForSelector("canvas", { timeout: 15000 });
  await page.waitForTimeout(1200);
  check("guide auto-opens on entry", (await page.locator('[role="dialog"]').count()) === 1);

  const dialog = page.locator('[role="dialog"]');
  const titles = [];
  let steps = 0;
  for (let i = 0; i < 40 && (await dialog.count()) > 0; i++) {
    const title = (await dialog.getAttribute("aria-label")) || "";
    titles.push(title);
    const next = dialog.locator("[data-guide-next]");
    const txt = await next.innerText();
    await next.click();
    await page.waitForTimeout(150);
    steps++;
    if (txt === "Finish") break;
  }
  check("tour ran through several steps without getting stuck", steps >= 5 && steps < 40, { steps, titles });
  check("tour closed after Finish (no dialog left)", (await dialog.count()) === 0);
  check("first step is the real viewer's welcome copy", /annotation workspace/i.test(titles[0] || ""));
  console.log("Annotate tour titles:", JSON.stringify(titles, null, 2));

  // Now check the Review phase's tour too, via the ?mode=review entry.
  const t2 = await ctx.newPage();
  const t2err = []; t2.on("pageerror", e => t2err.push(e.message));
  await t2.goto(`${VIEWER}/tutorial?mode=review`);
  await t2.waitForSelector("canvas", { timeout: 15000 });
  await t2.waitForTimeout(1200);
  check("review tour auto-opens", (await t2.locator('[role="dialog"]').count()) === 1);
  const rTitles = [];
  let rSteps = 0;
  const rDialog = t2.locator('[role="dialog"]');
  for (let i = 0; i < 40 && (await rDialog.count()) > 0; i++) {
    const title = (await rDialog.getAttribute("aria-label")) || "";
    rTitles.push(title);
    const next = rDialog.locator("[data-guide-next]");
    const txt = await next.innerText();
    await next.click();
    await t2.waitForTimeout(150);
    rSteps++;
    if (txt === "Finish") break;
  }
  check("review tour ran through several steps", rSteps >= 3 && rSteps < 40, { rSteps, rTitles });
  check("review tour's first step is the real reviewer welcome copy", /review surface/i.test(rTitles[0] || ""));
  console.log("Review tour titles:", JSON.stringify(rTitles, null, 2));

  check("no page errors (annotate tab)", errors.length === 0, errors);
  check("no page errors (review tab)", t2err.length === 0, t2err);

  await browser.close();
  const fails = results.filter(r => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 500));
})().catch(e => { console.error("EXC", e.message, e.stack); process.exit(1); });
