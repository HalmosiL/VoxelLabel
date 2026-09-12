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
async function checkTip(page, labelText, expectedDesc) {
  const label = page.locator("span.cursor-help", { hasText: labelText });
  const present = (await label.count()) > 0;
  check(`"${labelText}" label is hoverable (has Tip)`, present);
  if (!present) return;
  await label.hover();
  await page.waitForTimeout(400); // Tip's own 250ms show delay
  const tipVisible = await page.locator(`text=${expectedDesc}`).isVisible().catch(() => false);
  check(`"${labelText}" tooltip shows the real-viewer copy`, tipVisible, { expectedDesc });
  await page.mouse.move(5, 5); // move away to close the tip before the next check
  await page.waitForTimeout(150);
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

  await checkTip(page, "Overlay opacity", "0% hides the annotation, 100% covers the scan completely.");
  await checkTip(page, "Center", "The HU value shown as mid-grey (window level).");
  await checkTip(page, "Width", "The HU range from black to white (window width): narrow = more contrast.");
  await checkTip(page, "Edge enhancement", "0 is the original image; higher values sharpen boundaries.");
  await checkTip(page, "Brush size", "Radius of the Paint and Eraser brush, in screen pixels.");

  check("no page errors", errors.length === 0, errors);
  await browser.close();
  const fails = results.filter(r => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 300));
})().catch(e => { console.error("EXC", e.message, e.stack); for (const r of results) console.log(r.ok ? "ok  " : "FAIL", r.n); process.exit(1); });
