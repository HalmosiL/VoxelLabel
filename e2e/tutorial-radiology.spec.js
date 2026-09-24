// The practice page (/tutorial) teaches the same viewer the radiologist
// asked for: the wheel pages slices (Ctrl+wheel zooms), the slice strip
// along each pane's right edge, mouse window/level, the crosshair open in
// the middle, thick slabs, the Auto tool's HU range and small polygon
// points at any zoom -- and the tour describes them.
const { chromium } = require("playwright");
const VIEWER = "http://localhost:5174";
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });

async function closeTour(page) {
  const dialog = page.locator('[role="dialog"]');
  const seen = [];
  for (let i = 0; i < 30 && (await dialog.count()) > 0; i++) {
    seen.push(await dialog.innerText());
    const next = dialog.locator("[data-guide-next]");
    const txt = await next.innerText();
    await next.click(); await page.waitForTimeout(120);
    if (txt === "Finish") break;
  }
  return seen.join("\n");
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.removeItem("vl.viewer.crosshair"); } catch {} });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${VIEWER}/tutorial`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForSelector('[data-guide="panes"] canvas', { timeout: 30000 });
  await page.waitForTimeout(1200);
  const tour = await closeTour(page);
  check("the tour teaches the wheel, mouse windowing, the crosshair and the slab", /Scroll<?\/?b?>? changes slice|Scroll changes slice/.test(tour) && /right mouse button/.test(tour) && /crosshair/i.test(tour) && /Thick slices \(slab\)/.test(tour), tour.slice(0, 300));

  const canvases = page.locator('[data-guide="panes"] canvas'); // sagittal, coronal, axial
  const sliders = () => page.evaluate(() => Array.from(document.querySelectorAll('[data-guide="pane-sliders"] input[type=range]')).map((i) => Number(i.value)));
  const scale = (i) => canvases.nth(i).evaluate((c) => { const m = /scale\(([\d.]+)\)/.exec(c.parentElement.style.transform); return m ? Number(m[1]) : 1; });
  const ax = await canvases.nth(2).boundingBox();
  const cx = ax.x + ax.width / 2, cy = ax.y + ax.height / 2;
  await page.locator('[data-guide="tool-cursor"]').click();

  // wheel = slice, Ctrl+wheel = zoom
  const s0 = await sliders();
  await page.mouse.move(cx, cy); await page.mouse.wheel(0, 100); await page.waitForTimeout(150);
  const s1 = await sliders();
  check("the wheel pages the axial slice", s1[2] === s0[2] + 1 && (await scale(2)) === 1, { s0, s1 });
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -100); await page.keyboard.up("Control"); await page.waitForTimeout(150);
  check("Ctrl+wheel zooms", (await scale(2)) > 1);
  await canvases.nth(2).dblclick(); await page.waitForTimeout(150);

  // the slice strips stand along each pane's right edge
  const strips = page.locator('[data-testid="slice-strip"]');
  const stripBox = await strips.nth(2).boundingBox();
  check("every pane has a slice strip along its right edge", (await strips.count()) === 3 && stripBox.x >= ax.x + ax.width - 2 && stripBox.height > ax.height * 0.8, { stripBox, ax });
  const drag = strips.nth(2).locator('[data-testid="slice-drag"]');
  const db = await drag.boundingBox();
  const before = (await sliders())[2];
  await page.mouse.move(db.x + db.width / 2, db.y + 8); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(db.x + db.width / 2, db.y + 8 + i * 5);
  await page.mouse.up(); await page.waitForTimeout(150);
  const after = (await sliders())[2];
  check("dragging the strip pages relative to where it began", after > before && after - before <= 12, { before, after });

  // right-drag windows the image, instantly (client-side render)
  const wv = () => page.locator('[data-guide="window"] input[type=range]').evaluateAll((els) => els.map((e) => Number(e.value)));
  const pixel = () => canvases.nth(2).evaluate((c) => Array.from(c.getContext("2d").getImageData(128, 128, 1, 1).data.slice(0, 3)));
  const w0 = await wv(); const p0 = await pixel();
  await page.mouse.move(cx, cy); await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 8, cy + i * 6);
  await page.mouse.up({ button: "right" }); await page.waitForTimeout(200);
  const w1 = await wv(); const p1 = await pixel();
  check("right-drag moves the level and the width, and the image follows", w1[0] > w0[0] && w1[1] > w0[1] && JSON.stringify(p0) !== JSON.stringify(p1), { w0, w1, p0, p1 });
  await page.locator('[data-guide="tool-paint"]').click();
  const m0 = await wv();
  await page.mouse.move(cx, cy); await page.mouse.down({ button: "middle" });
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx - i * 6, cy - i * 5);
  await page.mouse.up({ button: "middle" }); await page.waitForTimeout(200);
  const m1 = await wv();
  check("middle-drag windows with a drawing tool", m1[0] < m0[0] && m1[1] < m0[1], { m0, m1 });
  await page.locator('[data-guide="tool-cursor"]').click();

  // crosshair, open in the middle; C toggles
  const lines = await page.locator('svg[data-testid="crosshair-axial"] line').evaluateAll((els) => els.map((l) => ["x1", "y1", "x2", "y2"].map((a) => Number(l.getAttribute(a)))));
  const v = lines.filter(([x1, , x2]) => x1 === x2), h = lines.filter(([, y1, , y2]) => y1 === y2);
  const vx = v[0] && v[0][0], hy = h[0] && h[0][1];
  const coversCentre = lines.some(([x1, y1, x2, y2]) => Math.min(x1, x2) <= vx && Math.max(x1, x2) >= vx && Math.min(y1, y2) <= hy && Math.max(y1, y2) >= hy);
  check("the crosshair shows both other planes and leaves the middle open", (await page.locator('svg[data-testid^="crosshair-"]').count()) === 3 && v.length === 2 && h.length === 2 && !coversCentre, lines);
  await page.mouse.move(cx, cy); await page.keyboard.press("c"); await page.waitForTimeout(100);
  check("C hides the crosshair", (await page.locator('svg[data-testid^="crosshair-"]').count()) === 0);
  await page.keyboard.press("c");

  // slab: MIP brightens the picture (the brightest voxel through 5 slices)
  const mean = () => canvases.nth(2).evaluate((c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let t = 0; for (let i = 0; i < d.length; i += 4) t += d[i]; return t / (d.length / 4); });
  const single = await mean();
  await page.locator('[data-testid="slab-mode-mip"]').click(); await page.waitForTimeout(250);
  const mip = await mean();
  check("MIP makes each pane a 5-slice slab, brighter than one slice, and says so", mip > single && (await page.locator('[data-testid="pane-slab"]').count()) === 3 && (await page.locator('[data-testid="pane-slab"]').first().innerText()) === "MIP 5", { single, mip });
  await page.locator('[data-testid="slab-thickness-1"]').click(); await page.waitForTimeout(150);

  // polygon points stay small when zoomed
  for (let i = 0; i < 4; i++) { await page.mouse.move(cx, cy); await page.keyboard.down("Control"); await page.mouse.wheel(0, -100); await page.keyboard.up("Control"); await page.waitForTimeout(60); }
  const afterWheel = await scale(2);
  await page.locator('[data-guide="tool-polygon"]').click();
  const afterTool = await scale(2);
  await page.mouse.click(cx - 15, cy - 15); await page.mouse.click(cx + 15, cy - 15); await page.mouse.click(cx + 15, cy + 15);
  await page.waitForTimeout(150);
  const radii = await page.locator('[data-testid="polygon-point"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width / 2));
  const zoomedTo = await scale(2);
  check("polygon points stay small at any zoom", zoomedTo > 1.5 && radii.length === 3 && radii.every((r) => r <= 4), { zoomedTo, afterWheel, afterTool, radii });
  await page.keyboard.press("Escape");
  await canvases.nth(2).dblclick().catch(() => undefined);

  // Auto: a HU range suggested from the box, open at the top, fill holes on
  await page.locator('[data-guide="tool-auto"]').click();
  await canvases.nth(2).dblclick().catch(() => undefined);
  await page.mouse.move(cx - 25, cy - 25); await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(cx - 25 + i * 10, cy - 25 + i * 10);
  await page.mouse.up(); await page.waitForTimeout(200);
  const range = await page.locator('[data-testid="auto-range"]').innerText().catch(() => "");
  check("Auto offers a HU range from the box and fill holes", /… max$/.test(range) && (await page.locator('[data-testid="auto-fill-holes"]').isChecked()), range);
  await page.keyboard.press("Escape");

  check("the footer teaches the new mouse", /Scroll=Slice · Ctrl\+Scroll=Zoom/.test(await page.locator('[data-guide="footer"]').innerText()));
  check("no page errors", errors.length === 0, errors);
  await page.screenshot({ path: "tutorial-radiology.png" });
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 400));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
