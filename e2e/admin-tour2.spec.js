// The 10 admin-page tours must NOT open by themselves any more -- only
// the Tutorial button opens them. My Jobs/Job/Case keep auto-opening on
// a first visit, unchanged.
const { chromium } = require("playwright");
const { F } = require("./helpers");
const UI = "http://localhost:5173", STUDY = F.STUDY;
const results = [];
const check = (n, ok, extra) => { results.push({ n, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"} ${n}${ok ? "" : " " + JSON.stringify(extra)}`); };

async function walkTour(page) {
  const dialog = page.locator('[role="dialog"]');
  let steps = 0;
  for (let i = 0; i < 40 && (await dialog.count()) > 0; i++) {
    steps++;
    const next = dialog.locator("[data-guide-next]");
    const label = await next.innerText();
    await next.click();
    await page.waitForTimeout(120);
    if (label === "Finish") break;
  }
  return steps;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();

  await page.goto(`${UI}/`, { waitUntil: "networkidle" });
  await page.fill('input[autocomplete="username"]', "platform-admin");
  await page.fill('input[type="password"]', "platform-admin");
  await page.click('[data-testid="signin-submit"]');
  await page.waitForSelector("nav", { timeout: 15000 });

  // Fresh profile, never visited before -- these must NOT auto-open.
  const adminPages = [
    ["/studies", "Studies"],
    [`/studies/${STUDY}`, "Study"],
    ["/patients", "Patients"],
    ["/annotation-types", "Annotation types"],
    ["/deidentification-profiles", "De-identification"],
    ["/users", "Users"],
    ["/notifications", "Notifications"],
    ["/system", "System"],
    [`/studies/${STUDY}/workflow`, "Board"],
  ];
  for (const [path, label] of adminPages) {
    await page.goto(`${UI}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    check(`${label}: no auto-opened tour on first visit`, (await page.locator('[role="dialog"]').count()) === 0);
  }

  // But the Tutorial button still opens and completes each one.
  await page.goto(`${UI}/users`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.locator('[data-guide="tutorial-button"] button').click();
  check("Users: Tutorial button opens the tour", (await page.locator('[role="dialog"]').count()) === 1);
  const steps = await walkTour(page);
  check(`Users: tour walks through (${steps} steps) and closes`, steps >= 3 && (await page.locator('[role="dialog"]').count()) === 0);

  await page.goto(`${UI}/studies/${STUDY}/workflow`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.locator('[data-guide="board-tutorial"]').click();
  check("Board: header Tutorial button opens the tour", (await page.locator('[role="dialog"]').count()) === 1);
  await page.keyboard.press("Escape");

  // My Jobs/Job/Case (the workbench tours) still auto-open, unchanged --
  // a data manager/admin viewing them through the full UI.
  await page.goto(`${UI}/my-jobs`, { waitUntil: "networkidle" });
  await page.waitForSelector('[role="dialog"]', { timeout: 10000 }).catch(() => {});
  check("My Jobs: still auto-opens on first visit (unchanged workbench behavior)", (await page.locator('[role="dialog"]').count()) === 1);

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`\nchecks ${results.length}, fails ${fails.length}`);
  process.exit(fails.length ? 1 : 0);
})();
