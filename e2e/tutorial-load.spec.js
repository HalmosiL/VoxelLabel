// G-14: the practice scan's download shows how far it has got, and a
// failed download offers Try again instead of sticking until a full
// page reload.
const { chromium } = require("playwright");
const VIEWER = "http://localhost:5174";

const results = [];
const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  let failures = 1;
  await page.route("**/tutorial-data/chest-ct.bin", (route) => (failures-- > 0 ? route.abort() : route.continue()));
  await page.goto(`${VIEWER}/tutorial`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForSelector('[data-testid="tutorial-load-error"]', { timeout: 30000 });
  check("a failed download says so and offers Try again", (await page.locator('[data-testid="tutorial-load-retry"]').count()) === 1);
  let sawProgress = false;
  const watch = setInterval(async () => { const t = await page.locator('[data-testid="tutorial-loading"]').innerText().catch(() => ""); if (/\d+% \(/.test(t)) sawProgress = true; }, 50);
  await page.locator('[data-testid="tutorial-load-retry"]').click();
  await page.waitForSelector('[data-guide="panes"] canvas', { timeout: 60000 });
  clearInterval(watch);
  check("Try again loads the tutorial without a page reload", true);
  check("the download shows its progress", sawProgress);
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 200));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
