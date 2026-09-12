const { chromium } = require("playwright");
const { F } = require("./helpers");
const VIEWER = "http://localhost:5174";
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });
async function login(page, user, pass, url) {
  await page.goto(url); await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", user); await page.fill("#password", pass); await page.click("#kc-login");
  await page.waitForURL((u) => !u.href.includes("localhost:8080"), { timeout: 30000 });
}
async function closeTour(page) {
  const dialog = page.locator('[role="dialog"]');
  for (let i = 0; i < 25 && (await dialog.count()) > 0; i++) {
    const next = dialog.locator("[data-guide-next]");
    const txt = await next.innerText();
    await next.click(); await page.waitForTimeout(150);
    if (txt === "Finish") break;
  }
}
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await login(page, "dr-test", "Test1234!", `${VIEWER}/tutorial`);
  await page.waitForSelector("canvas", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await closeTour(page);

  const btn = page.locator("button[aria-label='Tutorial']");
  check("Tutorial button present", (await btn.count()) === 1);
  check("Tutorial button shows a text label, not icon-only", /Tutorial/.test(await btn.innerText()));
  const cls = await btn.getAttribute("class");
  check("Tutorial button uses amber accent styling (stands out from neutral gray icons)", /amber/.test(cls || ""), cls);

  await page.screenshot({ path: "tutorial-help-button-header.png", clip: { x: 900, y: 0, width: 600, height: 60 } });

  await btn.click();
  await page.waitForTimeout(300);
  check("clicking it still opens the guide tour", (await page.locator('[role="dialog"]').count()) === 1);
  await closeTour(page);

  check("no page errors", errors.length === 0, errors);
  await browser.close();
  const fails = results.filter(r => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 300));
})().catch(e => { console.error("EXC", e.message, e.stack); for (const r of results) console.log(r.ok ? "ok  " : "FAIL", r.n); process.exit(1); });
