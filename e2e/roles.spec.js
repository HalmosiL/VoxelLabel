const { chromium } = require("playwright");
const { F } = require("./helpers");
const BASE = "http://localhost:5173";

// admin-ui shows its own AuthPage now instead of redirecting to
// Keycloak's hosted login (see main.tsx).
async function login(page, user, pass) {
  await page.goto(BASE + "/");
  await page.waitForSelector('[data-testid="signin-submit"]', { timeout: 30000 });
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', pass);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(/localhost:5173/, { timeout: 30000 });
}

async function run(user, pass, expectJobsOnly) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // The guided tour opens by itself on a fresh profile and blocks clicks; mark it seen.
  await ctx.addInitScript(() => { try { for (const k of ["workbench","job","case","studies","study","patients","patient","annotation-types","deidentification","users","notifications","system","board"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  const out = { user, expectJobsOnly, checks: [] };
  const check = (name, ok, extra) => out.checks.push({ name, ok, extra });
  try {
    await login(page, user, pass);
    await page.waitForTimeout(1500);
    check("landing url", expectJobsOnly ? page.url().includes("/my-jobs") : page.url().includes("/studies"), page.url());
    const sidebar = await page.locator("aside").count();
    const header = await page.locator("header").count();
    check("layout", expectJobsOnly ? sidebar === 0 && header === 1 : sidebar === 1, { sidebar, header });
    const navTexts = await page.locator("nav a").allInnerTexts();
    check("nav items", expectJobsOnly ? navTexts.length === 1 && /My Jobs/.test(navTexts[0]) : navTexts.length > 1, navTexts);
    await page.goto(BASE + "/my-jobs");
    await page.waitForTimeout(1500);
    const sections = await page.locator("main h2").allInnerTexts();
    const boardLinks = await page.locator("main a", { hasText: /^Board$/ }).count();
    check("my-jobs sections", true, { sections, boardLinks });
    check("board links hidden", expectJobsOnly ? boardLinks === 0 : true, boardLinks);
    await page.screenshot({ path: `shot-${user}-jobs.png`, fullPage: true });
    // open first job
    const open = page.locator("main a.btn-secondary", { hasText: "Open" }).first();
    if (await open.count()) {
      await open.click();
      await page.waitForURL(/my-jobs\//, { timeout: 10000 });
      await page.waitForTimeout(1200);
      const boardOnJob = await page.locator("main a", { hasText: "Open workflow board" }).count();
      check("job detail board link", expectJobsOnly ? boardOnJob === 0 : boardOnJob === 1, boardOnJob);
      await page.screenshot({ path: `shot-${user}-job.png`, fullPage: true });
      const openCase = page.locator("main a", { hasText: "Open case" }).first();
      if (await openCase.count()) {
        await openCase.click();
        await page.waitForURL(/cases\//, { timeout: 10000 });
        await page.waitForTimeout(1500);
        const back = await page.locator("main nav a").allInnerTexts();
        const viewer = await page.locator("a", { hasText: "Open in Viewer" }).count();
        check("case page", viewer > 0 && /job/.test(back.join(" ")), { back, viewer });
        await page.screenshot({ path: `shot-${user}-case.png`, fullPage: true });
      } else check("job has cases", false);
    } else check("has open job", false);
    // guarded routes
    for (const path of ["/studies", "/patients", "/users", "/system", "/annotation-types"]) {
      await page.goto(BASE + path);
      await page.waitForTimeout(1000);
      const u = page.url();
      check("guard " + path, expectJobsOnly ? u.includes("/my-jobs") : u.includes(path), u);
    }
    // workflow board guard (needs a study id)
    const study = "e6e46193";
    const res = await page.evaluate(async () => {
      const r = await fetch("http://localhost:8004/admin/me", { headers: {} });
      return r.status;
    }).catch(() => null);
    await page.goto(BASE + "/studies/e6e46193-0000-0000-0000-000000000000/workflow");
    await page.waitForTimeout(1000);
    check("guard board", expectJobsOnly ? page.url().includes("/my-jobs") : page.url().includes("/workflow"), page.url());
    void study; void res;
  } catch (e) {
    check("exception", false, e.message);
  }
  out.errors = errors.filter((e) => !/favicon|ERR_CONNECTION|401|403|404/.test(e));
  await browser.close();
  return out;
}

(async () => {
  const results = [];
  results.push(await run("dr-test", "Test1234!", true));
  results.push(await run("dr-review", "Test1234!", true));
  results.push(await run("platform-admin", "platform-admin", false));
  console.log(JSON.stringify(results, null, 1));
})();
