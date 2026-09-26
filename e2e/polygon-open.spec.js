// K4: an outline that was never closed was silently left out of the save
// (the tablet resident lost 4 of 6 slices while "✓ Saved" showed), and it
// stayed on screen when she moved to another slice. Now the open outline
// belongs to its own slice, a bar says where it is with Close / Drop, a
// save waits until it is closed or dropped, and on a touch screen the
// first point is a finger-sized target.
const zlib = require("zlib");
const { chromium } = require("playwright");
const { F, token } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174", API = "http://localhost:8010";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

async function openViewer(browser, url, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, ...opts });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review", "workbench", "job", "case"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  const compact = (await page.locator('[data-testid="panel-toggle"]').count()) > 0;
  if (compact) { await page.locator('[data-testid="panel-toggle"]').click(); await page.waitForTimeout(400); }
  if ((await page.locator('[data-testid^="object-"]').count()) === 0) {
    await page.locator('input[placeholder="New label…"]').fill("QA structure");
    await page.locator('input[placeholder="New label…"]').press("Enter");
    await page.waitForTimeout(300);
    await page.locator('[data-testid^="add-object-"]').first().click();
    await page.waitForTimeout(300);
  }
  await page.locator('[data-testid^="object-"]').first().click().catch(() => {});
  if (compact) { await page.locator('[data-testid="panel-toggle"]').click(); await page.waitForTimeout(400); }
  return { ctx, page };
}

(async () => {
  const t = await token("dr-test", "Test1234!");
  const job = (await api(t, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases.find((c) => c.status !== "done") || job.cases[0];
  const seriesId = (await api(t, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const url = `${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`;
  const versionOf = async () => (await api(await token("dr-test", "Test1234!"), `${API}/series/${seriesId}/mask-volume`)).version_id;
  const browser = await chromium.launch();

  {
    const { ctx, page } = await openViewer(browser, url);
    await page.locator('[data-testid="tool-polygon"]').click();
    const box = await page.locator('[data-testid="pane-axial"]').boundingBox();
    const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
    for (const [fx, fy] of [[0.40, 0.40], [0.48, 0.40], [0.48, 0.48]]) { await page.mouse.click(...at(fx, fy)); await page.waitForTimeout(120); }
    const bar = page.locator('[data-testid="polygon-open"]');
    check("an open outline shows its bar with the slice", (await bar.count()) === 1 && /slice \d+/i.test(await bar.innerText()), await bar.innerText().catch(() => ""));
    await page.mouse.move(...at(0.5, 0.6));
    await page.keyboard.press("ArrowRight"); await page.waitForTimeout(400);
    check("... on another slice its points are not drawn", (await page.locator('[data-testid="polygon-point"]').count()) === 0);
    const before = await versionOf();
    await page.locator("header button", { hasText: /^Save$/ }).click(); await page.waitForTimeout(1500);
    check("a save waits while an outline is open, and says why", (await versionOf()) === before && /outline/i.test(await page.locator("body").innerText()));
    await page.locator('[data-testid="polygon-goto"]').click(); await page.waitForTimeout(400);
    check("'Go to its slice' brings the points back", (await page.locator('[data-testid="polygon-point"]').count()) === 3);
    await page.locator('[data-testid="polygon-close"]').click(); await page.waitForTimeout(400);
    check("'Close shape' fills it and the bar goes away", (await bar.count()) === 0);
    await page.locator("header button", { hasText: /^Save$/ }).click(); await page.waitForTimeout(2000);
    check("... then the save goes through", (await versionOf()) !== before);
    await ctx.close();
  }

  {
    // touch: a tap within a finger's width of the first point closes the outline
    const { ctx, page } = await openViewer(browser, url, { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });
    await page.locator('[data-testid="tool-polygon"]').tap();
    const box = await page.locator('[data-testid="pane-axial"]').boundingBox();
    const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
    for (const [fx, fy] of [[0.40, 0.40], [0.55, 0.40], [0.55, 0.55]]) { await page.touchscreen.tap(...at(fx, fy)); await page.waitForTimeout(150); }
    const [x0, y0] = at(0.40, 0.40);
    await page.touchscreen.tap(x0 + 16, y0 + 12); await page.waitForTimeout(400); // 20 px away
    check("on touch a tap 20 px from the first point closes the outline", (await page.locator('[data-testid="polygon-open"]').count()) === 0 && (await page.locator('[data-testid="polygon-point"]').count()) === 0);
    await ctx.close();
  }

  {
    // the tutorial teaches the same behaviour
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
    const page = await ctx.newPage();
    await page.goto(`${VIEWER}/tutorial`);
    await page.waitForSelector("#username", { timeout: 30000 });
    await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
    await page.waitForSelector('[data-guide="panes"] canvas', { timeout: 30000 }); await page.waitForTimeout(1500);
    if ((await page.locator('[role="dialog"]').count()) > 0) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
    await page.locator('[data-guide="tool-polygon"] button').click();
    const canvas = page.locator('[data-guide="panes"] canvas').last();
    const box = await canvas.boundingBox();
    for (const [fx, fy] of [[0.40, 0.40], [0.50, 0.40], [0.50, 0.50]]) { await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy); await page.waitForTimeout(120); }
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
    await page.keyboard.press("ArrowRight"); await page.waitForTimeout(300);
    check("tutorial: the open outline stays on its slice, with the bar", (await page.locator('[data-testid="polygon-open"]').count()) === 1 && (await page.locator('[data-testid="polygon-close"]').isDisabled()));
    await page.locator('[data-testid="polygon-goto"]').click(); await page.waitForTimeout(300);
    await page.locator('[data-testid="polygon-close"]').click(); await page.waitForTimeout(300);
    check("tutorial: back on its slice it closes", (await page.locator('[data-testid="polygon-open"]').count()) === 0);
    await ctx.close();
  }

  await browser.close();
  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
