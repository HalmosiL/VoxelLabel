const { chromium } = require("playwright");
const { F } = require("./helpers");
const VIEWER = "http://localhost:5174";
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
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  await login(page, "dr-review", "Test1234!", `${VIEWER}/tutorial`);
  await page.waitForSelector("canvas", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await closeTour(page);
  const tools = ["cursor", "paint", "erase", "fill", "polygon", "auto", "histogram"];
  for (const t of tools) {
    check(`tool present: ${t}`, (await page.locator(`[data-guide="tool-${t}"]`).count()) === 1);
  }

  // A default instance is pre-seeded and active on entry -- every tool
  // should already be usable, no "select an object first" friction.
  check("Structure 1 pre-seeded and active by default", (await page.locator('[data-guide="objects"] li').count()) === 1);
  for (const t of tools) {
    check(`${t} enabled by default (instance pre-seeded)`, !(await page.locator(`[data-guide="tool-${t}"] button`).isDisabled()));
  }

  // Deleting that object genuinely disables the object-requiring tools
  // again -- confirms the gating logic itself still works, not just
  // that the default happens to be enabled.
  await page.locator('[data-guide="objects"] li button[title="Delete"]').first().click();
  await page.waitForTimeout(200);
  const needsObj = ["paint", "fill", "polygon", "auto"];
  for (const t of needsObj) {
    check(`${t} disabled once the active object is deleted`, await page.locator(`[data-guide="tool-${t}"] button`).isDisabled());
  }
  for (const t of ["cursor", "erase", "histogram"]) {
    check(`${t} stays enabled without an object`, !(await page.locator(`[data-guide="tool-${t}"] button`).isDisabled()));
  }

  // Recreating one re-enables everything -- data-guide="new-instance"
  // only applies to the label's + button while it has zero objects,
  // which is exactly the state the delete above just produced.
  await page.locator('button[aria-label="New Structure instance"]').click();
  await page.waitForTimeout(200);
  for (const t of tools) {
    check(`${t} re-enabled with a new active object`, !(await page.locator(`[data-guide="tool-${t}"] button`).isDisabled()));
  }

  // G-19: deleting an object asks first, and Undo right after doesn't bring
  // its painting back with no object owning it (Save/Mark would enable on
  // invisible paint).
  await page.locator('[data-guide="tool-paint"] button').click();
  const box = await page.locator("canvas").first().boundingBox();
  for (const [fx, fy] of [[0.4, 0.4], [0.45, 0.5]]) {
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * fx + i * 4, box.y + box.height * fy + i * 3);
    await page.mouse.up(); await page.waitForTimeout(150);
  }
  const mark = page.locator("button", { hasText: "Mark as Practice-Annotated" });
  check("painting enables Mark as Practice-Annotated", !(await mark.isDisabled()));
  dialogs.length = 0;
  await page.locator('[data-guide="objects"] li button[title="Delete"]').first().click();
  await page.waitForTimeout(200);
  check("deleting an object asks first", dialogs.length === 1 && /can't be undone/.test(dialogs[0]), dialogs);
  await page.keyboard.press("Control+z"); await page.waitForTimeout(300);
  check("Undo after a delete brings back no ownerless paint", await mark.isDisabled());

  // G-18: a Fill click that fills nothing (on paint) leaves the undo/redo history alone
  await page.locator('button[aria-label="New Structure instance"]').click(); await page.waitForTimeout(200);
  await page.locator('[data-guide="tool-paint"] button').click();
  for (const [fx, fy] of [[0.3, 0.3], [0.6, 0.6]]) {
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * fx + i * 4, box.y + box.height * fy + i * 3);
    await page.mouse.up(); await page.waitForTimeout(150);
  }
  await page.keyboard.press("Control+z"); await page.waitForTimeout(300);
  const redo = page.locator('button[aria-label="Redo"]');
  check("Redo is on after an undo", !(await redo.isDisabled()));
  await page.locator('[data-guide="tool-fill"] button').click();
  await page.mouse.click(box.x + box.width * 0.3 + 16, box.y + box.height * 0.3 + 12); await page.waitForTimeout(300); // on the first stroke's paint
  check("a Fill on paint keeps Redo", !(await redo.isDisabled()));

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 200));
})();
