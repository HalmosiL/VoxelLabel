const { chromium } = require("playwright");
const { F } = require("./helpers");
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " " + JSON.stringify(extra)}`);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  await page.goto("http://localhost:5173/my-jobs", { waitUntil: "networkidle" });
  await page.fill('input[autocomplete="username"]', "platform-admin");
  await page.fill('input[type="password"]', "platform-admin");
  await page.click('[data-testid="signin-submit"]');
  await page.waitForSelector("nav", { timeout: 15000 });

  const link = page.locator("a", { hasText: "Start the tutorial" }).first();
  const href = await link.getAttribute("href").catch(() => null);
  check("Tutorial link found", !!href);
  check("Tutorial link carries the token handoff in the fragment", !!href && href.includes("#at="), href?.split("#")[0]);

  const tutorialPage = await ctx.newPage();
  await tutorialPage.goto(href, { waitUntil: "networkidle" });
  await tutorialPage.waitForTimeout(3000);
  const bodyText = await tutorialPage.locator("body").innerText().catch(() => "");
  check("Tutorial page did NOT show a Keycloak login form", !/Sign in to your account/i.test(bodyText), bodyText.slice(0, 150));
  check("fragment stripped from the address bar", !tutorialPage.url().includes("#at="), tutorialPage.url());

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`\nchecks ${results.length}, fails ${fails.length}`);
  process.exit(fails.length ? 1 : 0);
})();
