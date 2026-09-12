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

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n);
})();
