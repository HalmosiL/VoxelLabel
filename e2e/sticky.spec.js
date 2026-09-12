const { chromium } = require("playwright");
const { F } = require("./helpers");
const UI = "http://localhost:5173", STUDY = F.STUDY;
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 700 } });
  await ctx.addInitScript(() => { try { for (const k of ["workbench","job","case","studies","study","patients","patient","annotation-types","deidentification","users","notifications","system","board"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); localStorage.removeItem("vl.viewAs"); } catch {} });
  const page = await ctx.newPage();
  // admin-ui shows its own AuthPage now instead of redirecting to
  // Keycloak's hosted login (see main.tsx).
  await page.goto(`${UI}/studies`); await page.waitForSelector('[data-testid="signin-submit"]');
  await page.fill('input[autocomplete="username"]', "platform-admin"); await page.fill('input[type="password"]', "platform-admin"); await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(/localhost:5173/); await page.waitForTimeout(1000);
  const out = [];
  for (const path of ["/studies", `/studies/${STUDY}`, "/patients", "/users", "/system", `/studies/${STUDY}/workflow`, "/my-jobs", "/annotation-types"]) {
    await page.goto(UI + path); await page.waitForTimeout(1500);
    await page.mouse.wheel(0, 5000); await page.waitForTimeout(400);
    const sw = page.locator('[data-testid="view-as"]');
    const n = await sw.count();
    const box = n ? await sw.first().boundingBox() : null;
    const vp = page.viewportSize();
    const inView = box && box.y >= 0 && box.y + box.height <= vp.height && box.x >= 0;
    const scrollY = await page.evaluate(() => window.scrollY);
    out.push({ path, count: n, inView: Boolean(inView), y: box && Math.round(box.y), scrollY });
    if (path === `/studies/${STUDY}`) await page.screenshot({ path: "sticky-study.png" });
  }
  console.table(out);
  console.log(out.every((o) => o.count === 1 && o.inView) ? "ALL VISIBLE" : "SOME MISSING");
  await browser.close();
})();
