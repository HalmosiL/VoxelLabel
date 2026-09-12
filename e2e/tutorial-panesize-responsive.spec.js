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

  const canvases = page.locator('[data-guide="panes"] canvas');
  const wideBox = await canvases.nth(2).boundingBox();
  check("wide viewport: axial pane has a sane rendered size (>100px)", wideBox.width > 100, wideBox);

  // Narrow to a much smaller viewport, confirm no vertical layout
  // break and the pane genuinely shrinks (not stuck at a stale/huge
  // fallback size that would overflow horizontally off-screen).
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(400); // let the ResizeObserver fire
  const narrowBox = await canvases.nth(2).boundingBox();
  check("narrow viewport: axial pane shrank accordingly", narrowBox.width < wideBox.width, { wideBox, narrowBox });
  check("narrow viewport: pane still has a sane positive size", narrowBox.width > 50 && narrowBox.height > 50, narrowBox);

  // Confirm the pane row container doesn't force the page to scroll
  // vertically off-screen (row still fits within the flex column).
  const overflowCheck = await page.evaluate(() => {
    const panes = document.querySelector('[data-guide="panes"]');
    const rect = panes.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
  });
  check("pane row stays within the viewport vertically", overflowCheck.bottom <= overflowCheck.viewportHeight + 5, overflowCheck);

  // Drawing still works correctly at this narrower size (paneSize
  // recompute didn't break toCanvasXY's content-space mapping).
  await page.locator('[data-guide="tool-paint"]').click();
  const nb = await canvases.nth(2).boundingBox();
  await page.mouse.click(nb.x + nb.width * 0.5, nb.y + nb.height * 0.5);
  await page.waitForTimeout(200);
  check("painting still works at the narrower pane size", !(await page.locator("header button", { hasText: "Mark as Practice-Annotated" }).isDisabled()));

  check("no page errors", errors.length === 0, errors);
  await browser.close();
  const fails = results.filter(r => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 400));
})().catch(e => { console.error("EXC", e.message, e.stack); for (const r of results) console.log(r.ok ? "ok  " : "FAIL", r.n); process.exit(1); });
