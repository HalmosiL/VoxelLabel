// Every admin page has a tour that opens from the sidebar (or board
// header) Tutorial button -- never by itself --, every step's spotlight
// lands on a real element, Finish closes it and marks it seen, and the
// button replays it.
const { chromium } = require("playwright");
const { F } = require("./helpers");
const UI = "http://localhost:5173", STUDY = F.STUDY;
const results = [];
const check = (n, ok, extra) => { results.push({ n, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"} ${n}${ok ? "" : " " + JSON.stringify(extra)}`); };

async function walkTour(page) {
  const dialog = page.locator('[role="dialog"]');
  const titles = [];
  let spotlighted = 0;
  for (let i = 0; i < 40 && (await dialog.count()) > 0; i++) {
    titles.push((await dialog.getAttribute("aria-label")) || "");
    // a spotlight cut-out exists whenever the step has a target on screen
    if ((await page.locator("[data-guide-overlay] .ring-brand-500").count()) > 0) spotlighted++;
    const next = dialog.locator("[data-guide-next]");
    const label = await next.innerText();
    await next.click();
    await page.waitForTimeout(150);
    if (label === "Finish") break;
  }
  return { titles, spotlighted };
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|net::ERR/.test(m.text())) errors.push("console: " + m.text().slice(0, 160)); });

  await page.goto(`${UI}/`, { waitUntil: "networkidle" });
  await page.fill('input[autocomplete="username"]', "platform-admin");
  await page.fill('input[type="password"]', "platform-admin");
  await page.click('[data-testid="signin-submit"]');
  await page.waitForSelector("nav", { timeout: 15000 });

  // Landing on /studies -> the admin tours are click-only (they never
  // auto-open, unlike the My Jobs/Job/Case workbench tours).
  await page.waitForTimeout(1500);
  check("Studies: tour does not auto-open on first visit", (await page.locator('[role="dialog"]').count()) === 0);

  const pages = [
    ["/studies", "studies", 4],
    [`/studies/${STUDY}`, "study", 6],
    ["/patients", "patients", 4],
    ["/annotation-types", "annotation-types", 3],
    ["/deidentification-profiles", "deidentification", 3],
    ["/users", "users", 4],
    ["/notifications", "notifications", 5],
    ["/system", "system", 4],
  ];
  // Find a patient with cases for the patient page.
  for (const [path, key, minSteps] of pages) {
    await page.goto(`${UI}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    // Every admin page: open via the sidebar Tutorial button.
    await page.locator('[data-guide="tutorial-button"] button').click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 }).catch(() => {});
    const open = (await page.locator('[role="dialog"]').count()) === 1;
    check(`${key}: tour is open`, open);
    if (!open) continue;
    const { titles, spotlighted } = await walkTour(page);
    check(`${key}: >= ${minSteps} steps walked (${titles.length})`, titles.length >= minSteps, titles);
    check(`${key}: every step after the intro had a spotlight`, spotlighted >= titles.length - 1, { titles, spotlighted });
    check(`${key}: Finish closed it and marked it seen`, (await page.locator('[role="dialog"]').count()) === 0 && (await page.evaluate((k) => localStorage.getItem(`vl.guide.${k}.seen`), key)) === "1");
  }

  // Patient detail: pick the first patient that HAS cases (the case
  // steps of the tour are skipped on a patient without any).
  await page.goto(`${UI}/patients`, { waitUntil: "networkidle" });
  const firstPatient = page.locator("table tbody tr", { has: page.locator(".badge-gray", { hasNotText: /^0$/ }) }).locator("a[href^='/patients/']").first();
  if (await firstPatient.count()) {
    await firstPatient.click();
    await page.waitForURL(/\/patients\/[0-9a-f-]+/);
    await page.waitForTimeout(800);
    await page.locator('[data-guide="tutorial-button"] button').click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 }).catch(() => {});
    check("patient: tour opens from the Tutorial button", (await page.locator('[role="dialog"]').count()) === 1);
    const { titles } = await walkTour(page);
    check(`patient: >= 3 steps (${titles.length})`, titles.length >= 3, titles);
  }

  // Sidebar Tutorial button replays the current page's tour.
  await page.goto(`${UI}/users`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.locator('[data-guide="tutorial-button"] button').click();
  check("sidebar Tutorial button replays the page tour", (await page.locator('[role="dialog"]').count()) === 1);
  await page.keyboard.press("Escape");

  // Workflow board: own provider + own amber Tutorial button.
  await page.goto(`${UI}/studies/${STUDY}/workflow`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("board: tour does not auto-open", (await page.locator('[role="dialog"]').count()) === 0);
  check("board: header Tutorial button present", (await page.locator('[data-guide="board-tutorial"]').count()) === 1);
  await page.locator('[data-guide="board-tutorial"]').click();
  await page.waitForSelector('[role="dialog"]', { timeout: 15000 }).catch(() => {});
  check("board: Tutorial button opens the tour", (await page.locator('[role="dialog"]').count()) === 1);
  const board = await walkTour(page);
  check(`board: >= 5 steps (${board.titles.length})`, board.titles.length >= 5, board.titles);
  await page.locator('[data-guide="board-tutorial"]').click();
  check("board: Tutorial button replays", (await page.locator('[role="dialog"]').count()) === 1);
  await page.keyboard.press("Escape");

  check("no page/console errors across all admin pages", errors.length === 0, errors.slice(0, 5));
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`\nchecks ${results.length}, fails ${fails.length}`);
  process.exit(fails.length ? 1 : 0);
})();
