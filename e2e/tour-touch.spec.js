// Tours on a touch tablet (G-08, G-20): the viewer's cards name the
// gestures a tablet has (pinch, two-finger drag) instead of scroll,
// right-drag and keys, and the admin tour skips steps whose target sits
// in the closed sidebar drawer, off screen.
const { chromium } = require("playwright");
const { login } = require("./helpers");
const VIEWER = "http://localhost:5174", UI = "http://localhost:5173";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

async function stepsOf(page) {
  const dialog = page.locator('[role="dialog"]');
  const steps = [];
  for (let i = 0; i < 40 && (await dialog.count()) > 0; i++) {
    steps.push({ title: ((await dialog.locator("h2").first().innerText().catch(() => "")) || "").trim(), text: await dialog.innerText() });
    const next = dialog.locator("[data-guide-next]");
    const label = await next.innerText();
    await next.click(); await page.waitForTimeout(150);
    if (label === "Finish") break;
  }
  return steps;
}

(async () => {
  const browser = await chromium.launch();
  const tablet = { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

  // ---- viewer tutorial tour: touch wording ----
  {
    const ctx = await browser.newContext(tablet);
    const page = await ctx.newPage();
    await login(page, "dr-review", "Test1234!", `${VIEWER}/tutorial`);
    await page.waitForSelector('[role="dialog"]', { timeout: 20000 });
    const steps = await stepsOf(page);
    const panes = steps.find((s) => /image panes/i.test(s.title) || /image panes/i.test(s.text));
    check("the panes step names tablet gestures", panes && /pinch/i.test(panes.text) && !/Ctrl\+scroll/i.test(panes.text), panes && panes.text.slice(0, 300));
    const all = steps.map((s) => s.text).join(" ");
    check("no card tells a tablet user to right-drag or press Ctrl+Z", !/right-drag|Ctrl\s*\+\s*Z/i.test(all));
    await ctx.close();
  }

  // ---- admin tour in the compact layout: no spotlight in the closed drawer ----
  {
    const ctx = await browser.newContext({ ...tablet, viewport: { width: 768, height: 1024 } });
    const page = await ctx.newPage();
    await login(page, "platform-admin", "platform-admin", `${UI}/studies`);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Tutorial" }).first().click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
    const titles = (await stepsOf(page)).map((s) => s.title);
    check("steps aimed at the closed drawer are skipped", !titles.includes("Getting around") && !titles.includes("Replay any tour"), titles);
    await ctx.close();
  }

  await browser.close();
  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
