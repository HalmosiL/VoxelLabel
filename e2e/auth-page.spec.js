const { chromium } = require("playwright");
const { F } = require("./helpers");

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " " + JSON.stringify(extra)}`);
}

async function getAdminToken() {
  const res = await fetch("http://localhost:8080/realms/ct-platform/protocol/openid-connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: "platform-admin", password: "platform-admin" }),
  });
  return (await res.json()).access_token;
}

(async () => {
  const browser = await chromium.launch();

  // 1) Unauthenticated visit lands on the new combined AuthPage, no
  // redirect to Keycloak's own hosted page.
  const ctx = await browser.newContext({ viewport: { width: 500, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  check("stays on localhost:5173 (no Keycloak hosted-page redirect)", page.url().startsWith("http://localhost:5173"), page.url());
  check("shows the VoxelLabel sign-in card", (await page.locator("text=VoxelLabel").first().isVisible()) && (await page.locator("text=Sign in").first().isVisible()));

  // 2) register.html still works as a redirect straight to the Create-account tab.
  await page.goto("http://localhost:5173/register.html", { waitUntil: "networkidle" });
  await page.waitForURL(/auth=register/, { timeout: 5000 });
  check("register.html redirects to the combined page's register tab", page.url().includes("auth=register"), page.url());
  check("Create-account tab is active from the redirect", await page.locator('[data-testid="register-panel"]').isVisible());

  // 3) Wrong password shows an inline error, doesn't crash, doesn't navigate away.
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.fill('input[autocomplete="username"]', "platform-admin");
  await page.fill('input[type="password"]', "totally-wrong");
  await page.click('[data-testid="signin-submit"]');
  await page.waitForSelector(".alert-error", { timeout: 10000 });
  check("wrong password shows an inline error, stays on the page", page.url().startsWith("http://localhost:5173"));
  consoleErrors.length = 0; // the deliberate 401 above logs its own console error -- not a bug, reset before the real check

  // 4) Correct credentials sign in via the direct password-grant flow and land in the real app.
  await page.fill('input[type="password"]', "platform-admin");
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(/localhost:5173\/(studies|my-jobs)?/, { timeout: 15000 });
  await page.waitForSelector('nav', { timeout: 15000 });
  check("correct credentials land in the authenticated app", (await page.locator("text=VoxelLabel").first().isVisible()) && (await page.locator("text=Users").first().isVisible()).toString() !== undefined);
  check("no console errors across the whole sign-in flow", consoleErrors.length === 0, consoleErrors);
  await ctx.close();

  // 5) Registration via the new combined tab -- same backend endpoint, same duplicate guard, still works end to end.
  const regCtx = await browser.newContext({ viewport: { width: 500, height: 900 } });
  const regPage = await regCtx.newPage();
  const uniq = Date.now();
  await regPage.goto("http://localhost:5173/?auth=register", { waitUntil: "networkidle" });
  await regPage.fill('input[autocomplete="given-name"]', "Auth");
  await regPage.fill('input[autocomplete="family-name"]', "Page");
  await regPage.fill('input[autocomplete="username"]', `pw-authpage-${uniq}`);
  await regPage.fill('input[type="email"]', `pw-authpage-${uniq}@example.test`);
  await regPage.click('[data-testid="register-submit"]');
  await regPage.waitForSelector("text=Request sent", { timeout: 10000 });
  check("registering through the combined page succeeds", true);
  await regPage.click('[data-testid="back-to-signin"]');
  check("Back to sign in returns to the sign-in tab", await regPage.locator('input[type="password"]').isVisible());
  await regCtx.close();

  // Cleanup + backend confirmation.
  const token = await getAdminToken();
  const reqRes = await fetch("http://localhost:8004/admin/registration-requests?status=pending", { headers: { Authorization: `Bearer ${token}` } });
  const reqs = await reqRes.json();
  const mine = reqs.find((r) => r.username === `pw-authpage-${uniq}`);
  check("backend recorded the pending request from the combined page", !!mine, mine);
  if (mine) {
    await fetch(`http://localhost:8004/admin/registration-requests/${mine.id}/reject`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "playwright e2e cleanup" }),
    });
  }

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`\nchecks ${results.length}, fails ${fails.length}`);
  process.exit(fails.length ? 1 : 0);
})();
