// The tutorial behaves like the real viewer (G-01..G-05): an Auto region
// is one undoable step, a polygon stays on its own pane, a locked object
// is protected, right-click without drag opens the object's form instead
// of erasing, and in review the panes follow the object on the card.
const { chromium } = require("playwright");
const { login } = require("./helpers");
const VIEWER = "http://localhost:5174";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

async function closeTour(page) {
  const dialog = page.locator('[role="dialog"]');
  for (let i = 0; i < 25 && (await dialog.count()) > 0; i++) {
    const next = dialog.locator("[data-guide-next]");
    const txt = await next.innerText();
    await next.click(); await page.waitForTimeout(150);
    if (txt === "Finish") break;
  }
}

async function open(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  await login(page, "dr-review", "Test1234!", url);
  await page.waitForSelector("canvas", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await closeTour(page);
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch();
  const { ctx, page } = await open(browser, `${VIEWER}/tutorial`);
  const pane = async (name) => page.locator(`[data-testid="crosshair-${name}"]`).boundingBox();
  const ax = await pane("axial");
  const at = (box, fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const tool = (t) => page.locator(`[data-guide="tool-${t}"] button`).click();
  const mark = page.locator("button", { hasText: "Mark as Practice-Annotated" });
  const undo = page.locator('header button[title="Undo"], button[aria-label="Undo"]').first();
  const drag = async (from, to, button = "left") => {
    await page.mouse.move(from.x, from.y); await page.mouse.down({ button });
    for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
    await page.mouse.up({ button }); await page.waitForTimeout(200);
  };

  // ---- G-01: an Auto region is one undoable step ----
  await tool("auto");
  await drag(at(ax, 0.40, 0.40), at(ax, 0.55, 0.55));
  await page.locator('[data-testid="auto-range"]').waitFor({ timeout: 10000 });
  await page.keyboard.press("Enter"); await page.waitForTimeout(300);
  const painted = !(await mark.isDisabled());
  await page.keyboard.press("Control+z"); await page.waitForTimeout(300);
  check("Auto + Enter paints, and Ctrl+Z takes it back", painted && (await mark.isDisabled()), { painted });

  // ---- G-02: a polygon ignores clicks on another pane ----
  await tool("polygon");
  const cor = await pane("coronal");
  for (const [fx, fy] of [[0.30, 0.30], [0.40, 0.30]]) { const p = at(ax, fx, fy); await page.mouse.click(p.x, p.y); await page.waitForTimeout(100); }
  const c = at(cor, 0.5, 0.5); await page.mouse.click(c.x, c.y); await page.waitForTimeout(200);
  check("a click on another pane adds no point to the polygon", (await page.locator('[data-testid="polygon-point"]').count()) === 2);
  await page.keyboard.press("Escape");

  // ---- G-03 + G-04: a locked object keeps its paint; right-click opens its form ----
  await tool("paint");
  await drag(at(ax, 0.60, 0.60), at(ax, 0.66, 0.60));
  const firstObject = page.locator('[data-testid^="object-"]').filter({ hasNot: page.locator("[data-testid^='object-form-']") }).first();
  const objectId = (await firstObject.getAttribute("data-testid")).replace("object-", "");
  const rc = at(ax, 0.63, 0.60);
  await page.mouse.click(rc.x, rc.y, { button: "right" }); await page.waitForTimeout(300);
  check("right-click without drag opens the object's form", (await page.locator(`[data-testid="object-form-${objectId}"]`).count()) === 1);
  check("... and doesn't erase anything", !(await mark.isDisabled()));
  await ctx.close();

  // ---- G-03 on a fresh page: the locked object is the only paint ----
  {
    const f = await open(browser, `${VIEWER}/tutorial`);
    const fax = await f.page.locator('[data-testid="crosshair-axial"]').boundingBox();
    const fat = (fx, fy) => ({ x: fax.x + fax.width * fx, y: fax.y + fax.height * fy });
    const fdrag = async (from, to, button = "left") => {
      await f.page.mouse.move(from.x, from.y); await f.page.mouse.down({ button });
      for (let i = 1; i <= 8; i++) await f.page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
      await f.page.mouse.up({ button }); await f.page.waitForTimeout(150);
    };
    const fmark = f.page.locator("button", { hasText: "Mark as Practice-Annotated" });
    await f.page.locator('[data-guide="tool-paint"] button').click();
    await fdrag(fat(0.60, 0.60), fat(0.66, 0.60));
    await f.page.locator('[data-guide="objects"] li button[title^="Lock"]').first().click(); await f.page.waitForTimeout(200);
    await f.page.locator('[data-guide="tool-erase"] button').click();
    for (let dy = -0.04; dy <= 0.04; dy += 0.01) await fdrag(fat(0.55, 0.60 + dy), fat(0.71, 0.60 + dy));
    for (let dy = -0.04; dy <= 0.04; dy += 0.02) await fdrag(fat(0.55, 0.60 + dy), fat(0.71, 0.60 + dy), "right");
    check("a locked object survives the eraser and right-drag", !(await fmark.isDisabled()));
    await f.ctx.close();
  }

  // ---- G-05: in review, the panes follow the object on the card ----
  const r = await open(browser, `${VIEWER}/tutorial?mode=review`);
  const sliders = async () => r.page.locator('input[type="range"]').evaluateAll((els) => els.map((e) => e.value).join(","));
  const before = await sliders();
  await r.page.locator('[data-guide="review-objects"] li').last().click(); await r.page.waitForTimeout(500);
  const after = await sliders();
  check("choosing another object moves the panes to it", before !== after, { before, after });
  await r.ctx.close();

  await browser.close();
  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
