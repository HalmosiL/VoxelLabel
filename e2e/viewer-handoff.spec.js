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

  // Sign into admin-ui via the new AuthPage (ROPC, no Keycloak SSO cookie).
  await page.goto("http://localhost:5173/studies", { waitUntil: "networkidle" });
  await page.fill('input[autocomplete="username"]', "platform-admin");
  await page.fill('input[type="password"]', "platform-admin");
  await page.click('[data-testid="signin-submit"]');
  await page.waitForSelector("nav", { timeout: 15000 });
  check("signed into admin-ui", true);

  // Go to a known case with a series and grab the "Open in Viewer" href.
  const STUDY = F.STUDY;
  const CASE = F.CASE;
  await page.goto(`http://localhost:5173/studies/${STUDY}/cases/${CASE}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const link = page.locator("a", { hasText: "Open in Viewer" }).first();
  const href = await link.getAttribute("href").catch(() => null);
  check("Open in Viewer link found", !!href, href);
  check("handoff tokens are in the URL fragment, not the query string", !!href && href.includes("#at=") && !href.includes("?at="), href?.split("#")[0]);

  // Open it in a fresh tab -- exactly what target="_blank" does -- and
  // confirm it renders straight into the viewer, no Keycloak login form.
  const viewerPage = await ctx.newPage();
  await viewerPage.goto(href, { waitUntil: "networkidle" });
  await viewerPage.waitForTimeout(4000);
  const bodyText = await viewerPage.locator("body").innerText().catch(() => "");
  check("viewer did NOT show a Keycloak login form", !/Sign in to your account/i.test(bodyText), bodyText.slice(0, 150));
  check("the fragment was stripped from the address bar", !viewerPage.url().includes("#at="), viewerPage.url());
  const canvases = await viewerPage.locator("canvas").count();
  check(">= 1 canvas rendered in the viewer", canvases >= 1, canvases);

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`\nchecks ${results.length}, fails ${fails.length}`);
  process.exit(fails.length ? 1 : 0);
})();
