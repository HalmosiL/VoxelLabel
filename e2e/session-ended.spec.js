// A stored session Keycloak no longer accepts must land on OUR sign-in
// form with a notice -- never on Keycloak's hosted page, never a blank
// page, never a reload loop.
const { chromium } = require("playwright");
const { F } = require("./helpers");
const results = [];
const check = (n, ok, extra) => { results.push({ n, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${n}${ok ? "" : " " + JSON.stringify(extra)}`); };

(async () => {
  // A real-looking but dead token set: sign in, then log that session out server-side.
  const r = await fetch("http://localhost:8080/realms/ct-platform/protocol/openid-connect/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: "platform-admin", password: "platform-admin", scope: "openid" }) });
  const t = await r.json();
  await fetch("http://localhost:8080/realms/ct-platform/protocol/openid-connect/logout", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "ct-platform", refresh_token: t.refresh_token }) });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addInitScript((dead) => { try { if (!localStorage.getItem("vl.session.seeded")) { localStorage.setItem("vl.session", JSON.stringify(dead)); localStorage.setItem("vl.session.seeded", "1"); } } catch {} },
    { token: t.access_token, refreshToken: t.refresh_token, idToken: t.id_token });
  const page = await ctx.newPage();
  let navs = 0;
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs++; });
  await page.goto("http://localhost:5173/studies", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  check("dead stored session -> our sign-in form (not Keycloak's page)", page.url().startsWith("http://localhost:5173") && (await page.locator('[data-testid="signin-submit"]').isVisible()), page.url());
  check("shows the 'session ended' notice", await page.locator('[data-testid="auth-notice"]').isVisible());
  check("stored dead session was cleared", (await page.evaluate(() => localStorage.getItem("vl.session"))) === null);
  check("no reload loop (<= 3 navigations)", navs <= 3, navs);

  // And signing in from there works, with the new build's cache-busted, handed-off tutorial link.
  await page.fill('input[autocomplete="username"]', "platform-admin");
  await page.fill('input[type="password"]', "platform-admin");
  await page.click('[data-testid="signin-submit"]');
  await page.waitForSelector("nav", { timeout: 15000 });
  await page.goto("http://localhost:5173/my-jobs", { waitUntil: "networkidle" });
  const href = await page.locator("a", { hasText: "Start the tutorial" }).first().getAttribute("href");
  check("tutorial link carries the cache-buster and the handoff", /\?cb=\d{8}-\d/.test(href) && href.includes("#at="), href?.slice(0, 80));
  const tut = await ctx.newPage(); await tut.goto(href, { waitUntil: "networkidle" }); await tut.waitForTimeout(3000);
  const body = await tut.locator("body").innerText().catch(() => "");
  check("tutorial opens without a login prompt", body.trim().length > 0 && !/Sign in to your account/i.test(body), body.slice(0, 100));
  await browser.close();
  const fails = results.filter((x) => !x.ok);
  console.log(`\nchecks ${results.length}, fails ${fails.length}`);
  process.exit(fails.length ? 1 : 0);
})();
