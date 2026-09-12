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
  await login(page, "dr-test", "Test1234!", `${VIEWER}/tutorial`);
  await page.waitForSelector("canvas", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await closeTour(page);

  const canvases = page.locator('[data-guide="panes"] canvas'); // sagittal, coronal, axial
  const axBox = await canvases.nth(2).boundingBox();

  // Auto tool: dashed box should be VISIBLE mid-drag, before releasing.
  await page.locator('[data-guide="tool-auto"]').click();
  await page.mouse.move(axBox.x + axBox.width * 0.3, axBox.y + axBox.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(axBox.x + axBox.width * 0.6, axBox.y + axBox.height * 0.6, { steps: 8 });
  await page.waitForTimeout(150);
  const autoBoxVisible = await page.locator(".border-amber-500.border-dashed").isVisible().catch(() => false);
  check("Auto: dashed box visible DURING drag (before release)", autoBoxVisible);
  await page.mouse.up();
  await page.waitForTimeout(150);
  const autoBoxStillVisible = await page.locator(".border-amber-500.border-dashed").isVisible().catch(() => false);
  check("Auto: dashed box stays visible after release (tolerance panel open)", autoBoxStillVisible);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const autoBoxGoneAfterEscape = !(await page.locator(".border-amber-500.border-dashed").isVisible().catch(() => false));
  check("Auto: dashed box disappears after Escape", autoBoxGoneAfterEscape);

  // Histogram tool: dashed box should be VISIBLE mid-drag too.
  await page.locator('[data-guide="tool-histogram"]').click();
  await page.mouse.move(axBox.x + axBox.width * 0.3, axBox.y + axBox.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(axBox.x + axBox.width * 0.6, axBox.y + axBox.height * 0.6, { steps: 8 });
  await page.waitForTimeout(150);
  const histBoxVisible = await page.locator(".border-cyan-400.border-dashed").isVisible().catch(() => false);
  check("Histogram: dashed box visible DURING drag (before release)", histBoxVisible);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const histBoxGoneAfter = !(await page.locator(".border-cyan-400.border-dashed").isVisible().catch(() => false));
  check("Histogram: dashed drag-box gone after release (stats popup shown instead)", histBoxGoneAfter);
  check("Histogram: stats popup appears after release", await page.locator("text=Brightness in the box").isVisible().catch(() => false));

  await browser.close();
  const fails = results.filter(r => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra).slice(0, 300));
})().catch(e => { console.error("EXC", e.message, e.stack); process.exit(1); });
