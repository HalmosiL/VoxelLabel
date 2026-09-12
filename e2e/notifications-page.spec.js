const { chromium } = require("playwright");
const { F } = require("./helpers");
const UI = "http://localhost:5173";
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });
// admin-ui (:5173) shows its own AuthPage now instead of redirecting to
// Keycloak's hosted login (see main.tsx) -- ct-annotator (:5174) still
// does, unchanged. Wait for whichever one actually shows up.
async function login(page, user, pass, url) {
  await page.goto(url);
  await Promise.race([
    page.waitForSelector("#username", { timeout: 30000 }),
    page.waitForSelector('[data-testid="signin-submit"]', { timeout: 30000 }),
  ]);
  if (await page.locator('[data-testid="signin-submit"]').isVisible().catch(() => false)) {
    await page.fill('input[autocomplete="username"]', user);
    await page.fill('input[type="password"]', pass);
    await page.click('[data-testid="signin-submit"]');
  } else {
    await page.fill("#username", user);
    await page.fill("#password", pass);
    await page.click("#kc-login");
  }
  await page.waitForURL((u) => !u.href.includes("localhost:8080"), { timeout: 30000 });
}
async function closeTour(page) {
  const dialog = page.locator('[role="dialog"]');
  for (let i = 0; i < 30 && (await dialog.count()) > 0; i++) {
    const next = dialog.locator("[data-guide-next]"); const txt = await next.innerText();
    await next.click(); await page.waitForTimeout(120); if (txt === "Finish") break;
  }
}
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  // Guided tours auto-open on a first visit and their overlay blocks clicks -- irrelevant here.
  await ctx.addInitScript(() => { try { for (const k of ["workbench","job","case","studies","study","patients","patient","annotation-types","deidentification","users","notifications","system","board"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const consoleErrors = []; page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await login(page, "platform-admin", "platform-admin", `${UI}/my-jobs`);
  await page.waitForTimeout(1200); await closeTour(page);
  check("My Jobs shows the 'Email me about my jobs' toggle", (await page.locator('[data-testid="email-notifications-toggle"]').count()) === 1);

  await page.locator("aside a", { hasText: "Notifications" }).click();
  await page.waitForURL(/\/notifications$/); await page.waitForTimeout(1500);
  check("Notifications page: status card", (await page.locator('[data-testid="notification-status"]').count()) === 1);
  check("Notifications page: status says delivery is on (enabled earlier via API)", /Email delivery is on/.test(await page.locator('[data-testid="notification-status"]').innerText()));
  check("Notifications page: settings form prefilled with mailpit", (await page.locator('[data-testid="notification-settings"] input').first().evaluate(() => true)) && (await page.locator('[data-testid="notification-settings"]').innerText()).includes("Email delivery"));
  const hostVal = await page.locator('[data-testid="notification-settings"] input.input').first().inputValue();
  check("SMTP host field shows 'mailpit'", hostVal === "mailpit", hostVal);
  const prefRows = await page.locator('[data-testid="notification-preferences"] tbody tr').count();
  check("preferences table lists realm users", prefRows >= 3, prefRows);
  const prefHead = await page.locator('[data-testid="notification-preferences"] thead').innerText();
  check("preferences have New job + Job status columns only (no per-case column)", /new job/i.test(prefHead) && /job status/i.test(prefHead) && !/cases/i.test(prefHead), prefHead);
  check("header says never per case", /Never per case/.test(await page.locator("h1, p").allInnerTexts().then((t) => t.join(" "))));
  check("preferences show dr-test's address", /dr-test@example.test/.test(await page.locator('[data-testid="notification-preferences"]').innerText()));
  const logRows = await page.locator('[data-testid="notification-log"] tbody tr').count();
  check("delivery log lists the emails sent so far", logRows >= 3, logRows);
  check("delivery log shows a 'New job' entry", /New job/.test(await page.locator('[data-testid="notification-log"]').innerText()));
  // Click a job-related row specifically (not just the newest row) --
  // other flows (e.g. registration requests) also write to this same
  // log now, so "first row" is no longer reliably a job email.
  await page.locator('[data-testid="notification-log"] tbody tr', { hasText: "New job" }).first().click();
  const logDetailText = await page.locator('[data-testid="notification-log"]').innerText();
  check(
    "log detail includes 'What this means' / 'What to do' guidance",
    logDetailText.includes("What this means") && logDetailText.includes("What to do"),
    logDetailText.slice(0, 200)
  );

  // Send a test email from the UI and see it in the log + Mailpit.
  await page.locator('[data-testid="notification-settings"] input[placeholder^="test address"]').fill("ui-test@example.test");
  await page.locator("button", { hasText: "Send test email" }).click();
  await page.waitForTimeout(1500);
  check("test email notice shown", /Test email sent to ui-test@example.test/.test(await page.innerText("body")));
  const mp = await (await fetch("http://localhost:8025/api/v1/messages")).json();
  check("Mailpit received the UI test email", mp.messages.some((m) => m.To.some((t) => t.Address === "ui-test@example.test")));

  // "Check for changes now" works from the UI
  await page.locator("button", { hasText: "Check for changes now" }).click(); await page.waitForTimeout(1500);
  check("run-now notice shown", /Checked \d+ jobs?/.test(await page.innerText("body")));

  // Toggle a user's preference and verify it round-trips
  const firstRowCheckbox = page.locator('[data-testid="notification-preferences"] tbody tr').filter({ hasText: "dr-review" }).locator('input[type=checkbox]').first();
  const before = await firstRowCheckbox.isChecked();
  await firstRowCheckbox.click(); await page.waitForTimeout(600);
  await page.reload(); await page.waitForTimeout(1500); await closeTour(page);
  const after = await page.locator('[data-testid="notification-preferences"] tbody tr').filter({ hasText: "dr-review" }).locator('input[type=checkbox]').first().isChecked();
  check("toggling a user's 'Any email' preference persists across reload", after === !before, { before, after });
  // restore
  await page.locator('[data-testid="notification-preferences"] tbody tr').filter({ hasText: "dr-review" }).locator('input[type=checkbox]').first().click(); await page.waitForTimeout(500);

  check("no page errors", errors.length === 0, errors);
  check("no console errors (e.g. React key warnings)", consoleErrors.filter((e) => !/favicon|net::ERR/.test(e)).length === 0, consoleErrors.slice(0, 3));
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 400));
})().catch((e) => { console.error("EXC", e.message); for (const r of results) console.log(r.ok ? "ok  " : "FAIL", r.n); process.exit(1); });
