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
async function testDragAt(page, corCanvas, fx0, fy0, fx1, fy1, label) {
  const container = await corCanvas.evaluate((c) => {
    const r = c.parentElement.parentElement.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  const x0 = container.x + container.width * fx0, y0 = container.y + container.height * fy0;
  const x1 = container.x + container.width * fx1, y1 = container.y + container.height * fy1;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 10 });
  await page.waitForTimeout(200);

  // Independently recompute what toCanvasXY would have produced for
  // this drag's start/end -- i.e. the CONTENT-SPACE (0..256, 0..95)
  // box that the app's own applyAuto should be using as its `bounds`.
  const canvasRect = await corCanvas.evaluate((c) => {
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, contentWidth: c.width, contentHeight: c.height };
  });
  const toContent = (clientX, clientY) => ({
    x: ((clientX - canvasRect.left) * canvasRect.contentWidth) / canvasRect.width,
    y: ((clientY - canvasRect.top) * canvasRect.contentHeight) / canvasRect.height,
  });
  const c0 = toContent(x0, y0), c1 = toContent(x1, y1);
  const expectedBounds = { x0: Math.min(c0.x, c1.x), x1: Math.max(c0.x, c1.x), y0: Math.min(c0.y, c1.y), y1: Math.max(c0.y, c1.y) };

  const paintedRegion = await corCanvas.evaluate((c) => {
    const ctx = c.getContext("2d");
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (Math.abs(r - g) > 15 || Math.abs(g - b) > 15 || Math.abs(r - b) > 15) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          count++;
        }
      }
    }
    return { minX, minY, maxX, maxY, count };
  });
  await page.mouse.up();
  await page.waitForTimeout(100);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);

  if (paintedRegion.count === 0) {
    console.log(label + ': nothing painted');
    return;
  }
  // STRICT: the painted pixels' bounding box (content-space, since
  // getImageData reads the canvas's OWN internal bitmap) must be a
  // subset of the drag's expected content-space bounds, +/- a couple
  // pixels for rounding -- NOT just "close in screen distance", since
  // floodFillMask clamps to `bounds` and can legitimately paint an
  // off-center blob within those bounds. Any pixel outside the box's
  // true content-space extent means the box's overlay and the mask's
  // actual bounds disagree -- a real coordinate bug.
  // One content pixel: the mask is an integer grid, so a box edge at
  // e.g. y=82.6 legitimately rounds to pixel row 83.
  const PAD = 1;
  const withinBounds =
    paintedRegion.minX >= expectedBounds.x0 - PAD &&
    paintedRegion.maxX <= expectedBounds.x1 + PAD &&
    paintedRegion.minY >= expectedBounds.y0 - PAD &&
    paintedRegion.maxY <= expectedBounds.y1 + PAD;
  check(`${label}: painted pixels stay within the drag's own content-space bounds`, withinBounds, {
    expectedBounds, paintedRegion,
  });
}
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  await login(page, "dr-test", "Test1234!", `${VIEWER}/tutorial`);
  await page.waitForSelector("canvas", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await closeTour(page);

  const canvases = page.locator('[data-guide="panes"] canvas');
  const corCanvas = canvases.nth(1);

  await page.locator('[data-guide="tool-cursor"]').click();
  await corCanvas.hover();
  for (let i = 0; i < 6; i++) { await page.keyboard.press("ArrowUp"); await page.waitForTimeout(60); }
  await page.locator('[data-guide="tool-auto"]').click();

  await testDragAt(page, corCanvas, 0.15, 0.15, 0.25, 0.25, "top-left corner");
  await testDragAt(page, corCanvas, 0.75, 0.15, 0.85, 0.25, "top-right corner");
  await testDragAt(page, corCanvas, 0.15, 0.75, 0.25, 0.85, "bottom-left corner");
  await testDragAt(page, corCanvas, 0.40, 0.15, 0.48, 0.23, "upper-middle small box (matches screenshot)");
  await testDragAt(page, corCanvas, 0.80, 0.80, 0.90, 0.90, "bottom-right corner");
  await testDragAt(page, corCanvas, 0.45, 0.45, 0.55, 0.55, "center");

  const fails = results.filter(r => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 500));
  await browser.close();
  process.exitCode = fails.length ? 1 : 0;
})().catch(e => { console.error("EXC", e.message, e.stack); for (const r of results) console.log(r.ok ? "ok  " : "FAIL", r.n); process.exit(1); });
