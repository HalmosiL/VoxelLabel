// The admin-only "View as" rail is now ONE persistent element (mounted
// once in App.tsx, outside every layout) instead of being wired
// separately into the sidebar/workbench header/board header -- this
// checks it behaves identically from wherever it's operated.
const { chromium } = require("playwright");
const { F } = require("./helpers");
const UI = "http://localhost:5173";
const STUDY = F.STUDY;
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });
// admin-ui (:5173) shows its own AuthPage now instead of redirecting to
// Keycloak's hosted login (see main.tsx). Wait for whichever surface
// actually shows up.
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
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // Guided tours auto-open on a first visit -- irrelevant to what this
  // script checks, and would otherwise block clicks with their overlay.
  await ctx.addInitScript(() => { try { for (const k of ["workbench","job","case","studies","study","patients","patient","annotation-types","deidentification","users","notifications","system","board"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await login(page, "platform-admin", "platform-admin", `${UI}/studies`);
  await page.waitForTimeout(1200);
  const rail = page.locator('[data-testid="view-as"]');
  check("admin: rail present, outside any header/aside (global)", (await rail.count()) === 1);
  check("admin: rail is its own column, not inside header or aside", (await page.locator('header [data-testid="view-as"], aside [data-testid="view-as"]').count()) === 0);
  check("admin: 4 tabs", (await rail.locator('[role="tab"]').count()) === 4, await rail.locator('[role="tab"]').allInnerTexts());
  const navTexts = async () => page.locator("nav a").allInnerTexts();
  check("admin: full nav", (await navTexts()).length === 8, await navTexts());

  // -> Annotator
  await rail.locator('[role="tab"]', { hasText: "Annotator" }).click();
  await page.waitForTimeout(1000);
  check("annotator: on /my-jobs", page.url().endsWith("/my-jobs"), page.url());
  check("annotator: workbench header, no sidebar", (await page.locator("aside").count()) === 0 && (await page.locator("header").count()) === 1);
  check("annotator: rail still present in workbench", (await rail.count()) === 1);
  check("annotator: nav only My Jobs", (await navTexts()).join() === "My Jobs", await navTexts());
  check("annotator: Annotator tab selected", (await rail.locator('[aria-selected="true"]').innerText()) === "Annotator");
  await page.goto(`${UI}/users`); await page.waitForTimeout(800);
  check("annotator: /users redirected to my-jobs", page.url().endsWith("/my-jobs"));
  await page.reload(); await page.waitForTimeout(1000);
  check("annotator: survives reload", (await rail.locator('[aria-selected="true"]').innerText()) === "Annotator");
  await page.screenshot({ path: "viewas-annotator.png" });

  // -> Reviewer
  await rail.locator('[role="tab"]', { hasText: "Reviewer" }).click(); await page.waitForTimeout(800);
  check("reviewer: still workbench", (await page.locator("aside").count()) === 0);

  // -> Data manager
  await rail.locator('[role="tab"]', { hasText: "Data manager" }).click(); await page.waitForTimeout(1200);
  check("dm: on /studies with sidebar", page.url().endsWith("/studies") && (await page.locator("aside").count()) === 1, page.url());
  check("dm: nav = My Jobs + Studies", (await navTexts()).join() === "My Jobs,Studies", await navTexts());
  await page.goto(`${UI}/studies/${STUDY}`); await page.waitForTimeout(1500);
  const bodyText = await page.locator("main").innerText();
  check("dm: study page shows New case (canManage)", /New case/.test(bodyText));
  check("dm: study page hides Inspect / restore (not admin)", !/Inspect \/ restore/.test(bodyText));
  await page.goto(`${UI}/studies/${STUDY}/workflow`); await page.waitForTimeout(2000);
  check("dm: board page has the rail too", (await rail.count()) === 1);
  check("dm: board editable (Undo button present)", (await page.locator("button", { hasText: /^Undo$/ }).count()) === 1);
  await page.screenshot({ path: "viewas-board.png" });

  // -> Admin (from board, stays on page)
  await rail.locator('[role="tab"]', { hasText: "Admin" }).click(); await page.waitForTimeout(800);
  check("admin: stays on board when switching dm->admin", page.url().includes("/workflow"), page.url());
  await page.goto(`${UI}/studies`); await page.waitForTimeout(1000);
  check("admin: full nav back", (await navTexts()).length === 8);
  check("admin: chip Global admin", /Global admin/.test(await page.locator("aside").innerText()));
  check("admin: no page errors", errors.length === 0, errors);
  await ctx.close();

  // non-admin must not see the rail anywhere
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript(() => { try { for (const k of ["workbench","job","case","studies","study","patients","patient","annotation-types","deidentification","users","notifications","system","board"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const p2 = await ctx2.newPage();
  await login(p2, "dr-test", "Test1234!", `${UI}/my-jobs`); await p2.waitForTimeout(1200);
  check("dr-test: no rail", (await p2.locator('[data-testid="view-as"]').count()) === 0);
  await p2.evaluate(() => localStorage.setItem("vl.viewAs", "admin"));
  await p2.reload(); await p2.waitForTimeout(1000);
  check("dr-test: stale viewAs ignored (still workbench)", (await p2.locator("aside").count()) === 0 && (await p2.locator('[data-testid="view-as"]').count()) === 0);
  await ctx2.close(); await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra).slice(0, 200));
})().catch((e) => { console.error("EXC", e.message); for (const r of results) console.log(r.ok ? "ok  " : "FAIL", r.n); process.exit(1); });
