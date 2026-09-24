const { chromium } = require("playwright");
const { F } = require("./helpers");
const UI = "http://localhost:5173", VIEWER = "http://localhost:5174";
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
  const titles = [];
  for (let i = 0; i < 30 && (await dialog.count()) > 0; i++) {
    titles.push((await dialog.getAttribute("aria-label")) || "");
    const next = dialog.locator("[data-guide-next]");
    const txt = await next.innerText();
    await next.click(); await page.waitForTimeout(120);
    if (txt === "Finish") break;
  }
  return titles;
}
const sliders = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[data-guide="pane-sliders"] input[type=range]')).map((i) => Number(i.value)));
const transforms = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[data-guide="panes"] canvas')).map((c) => getComputedStyle(c.parentElement).transform));
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));

  // ── Part B: Tutorial page ──
  await login(page, "dr-test", "Test1234!", `${VIEWER}/tutorial`);
  await page.waitForSelector("canvas", { timeout: 15000 }); await page.waitForTimeout(1000);
  const titles = await closeTour(page);
  check("tour now includes the 'New instance, quickly' step (header anchor)", titles.some((t) => /New instance, quickly/.test(t)), titles);

  const canvases = page.locator('[data-guide="panes"] canvas');
  const ax = canvases.nth(2);
  const axBox = await ax.boundingBox();
  const cx = axBox.x + axBox.width / 2, cy = axBox.y + axBox.height / 2;

  // B1 the plain wheel steps the slice, not the zoom (radiologist convention)
  const s0 = await sliders(page); const t0 = await transforms(page);
  await page.mouse.move(cx, cy); await page.mouse.wheel(0, 120); await page.waitForTimeout(150);
  const s1 = await sliders(page); const t1 = await transforms(page);
  check("scroll on axial steps its slice by 1", s1[2] === s0[2] + 1 && s1[0] === s0[0] && s1[1] === s0[1], { s0, s1 });
  check("scroll does not zoom", t1[2] === t0[2], { t0: t0[2], t1: t1[2] });

  // B2 Ctrl+scroll zooms, even with Paint selected
  await page.locator('[data-guide="tool-paint"]').click();
  await page.mouse.move(cx, cy); await page.keyboard.down("Control"); await page.mouse.wheel(0, -120); await page.keyboard.up("Control"); await page.waitForTimeout(150);
  const t2 = await transforms(page);
  check("Ctrl+scroll zooms with the Paint tool active", t2[2] !== t1[2], { t1: t1[2], t2: t2[2] });
  await page.locator('[data-guide="tool-cursor"]').click(); await ax.dblclick(); await page.waitForTimeout(120);

  // B3 Ctrl+click jumps the other panes
  const before = await sliders(page);
  await page.keyboard.down("Control"); await page.mouse.click(axBox.x + axBox.width * 0.25, axBox.y + axBox.height * 0.75); await page.keyboard.up("Control"); await page.waitForTimeout(150);
  const after = await sliders(page);
  check("Ctrl+click on axial moves sagittal to ~x=64 and coronal to ~y=192", Math.abs(after[0] - 64) <= 2 && Math.abs(after[1] - 192) <= 2 && after[2] === before[2], { before, after });

  // B4 lock toggle disables drawing tools
  await page.locator('button[title^="Lock"]').first().click(); await page.waitForTimeout(100);
  check("locking the active object disables Paint", await page.locator('[data-guide="tool-paint"] button').isDisabled());
  await page.locator('button[title="Unlock"]').first().click(); await page.waitForTimeout(100);
  check("unlocking re-enables Paint", !(await page.locator('[data-guide="tool-paint"] button').isDisabled()));

  // B5 Fill = outline fill: on an empty slice it floods the whole slice
  await page.locator('[data-guide="tool-fill"]').click();
  await page.mouse.click(cx, cy); await page.waitForTimeout(300);
  const filledFrac = await ax.evaluate((c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[i + 1]) > 15 || Math.abs(d[i + 1] - d[i + 2]) > 15) n++; return n / (c.width * c.height); });
  check("Fill floods the unpainted region (whole empty slice), like the real viewer", filledFrac > 0.8, filledFrac);
  await page.keyboard.press("Control+z"); await page.waitForTimeout(150);

  // B7 paint a blob, then double-click the object row -> panes jump to it
  await page.locator('[data-guide="tool-paint"]').click();
  await page.mouse.move(axBox.x + axBox.width * 0.7, axBox.y + axBox.height * 0.3); await page.mouse.down(); await page.mouse.move(axBox.x + axBox.width * 0.72, axBox.y + axBox.height * 0.32, { steps: 3 }); await page.mouse.up(); await page.waitForTimeout(150);
  const axialNow = (await sliders(page))[2];
  await page.locator('[data-guide="objects"] li').first().dblclick(); await page.waitForTimeout(200);
  const jumped = await sliders(page);
  check("double-click on the object row jumps sagittal/coronal to the paint (~x=179, y=77) and keeps its axial slice", Math.abs(jumped[0] - 179) <= 3 && Math.abs(jumped[1] - 77) <= 3 && jumped[2] === axialNow, { jumped, axialNow });

  // B8 Clear hovered slice
  await ax.hover();
  await page.locator("button", { hasText: "Clear hovered slice" }).click(); await page.waitForTimeout(200);
  check("Clear hovered slice wipes the paint (Mark disables again)", await page.locator("header button", { hasText: "Mark as Practice-Annotated" }).isDisabled());

  // B9 review phase: tool reset to cursor -> drag pans after zoom
  await page.locator('[data-guide="tool-paint"]').click();
  await page.mouse.click(cx, cy); await page.waitForTimeout(150);
  await page.locator("header button", { hasText: "Mark as Practice-Annotated" }).click(); await page.waitForTimeout(400);
  await closeTour(page);
  await page.mouse.move(cx, cy); await page.keyboard.down("Control"); await page.mouse.wheel(0, -240); await page.keyboard.up("Control"); await page.waitForTimeout(150);
  const r0 = await transforms(page);
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 40, cy + 30, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(150);
  const r1 = await transforms(page);
  check("review phase: drag pans (tool was reset to Cursor on entering review)", r0[2] !== r1[2], { r0: r0[2], r1: r1[2] });

  // ── Part A: real viewer header (dr-test's real job) ──
  await page.goto(`${VIEWER}/viewer/series/${F.SERIES}?jobId=${F.ANNOT_CARD}&caseId=${F.CASE}`);
  await page.waitForSelector('[data-guide="job-status"]', { timeout: 30000 }).catch(() => null);
  const badge = page.locator('[data-guide="job-status"]');
  check("viewer: job status is a read-only badge, not a <select>", (await badge.count()) === 1 && (await badge.evaluate((el) => el.tagName)) === "SPAN");
  check("viewer: badge shows the computed status", /In progress|Done|To do/.test((await badge.innerText().catch(() => "")) || ""), await badge.innerText().catch(() => null));
  check("viewer: Tutorial button is the amber labeled one", /amber/.test((await page.locator('button[aria-label="Tutorial"]').getAttribute("class").catch(() => "")) || ""));

  // ── Part C: admin-ui as platform-admin (full AdminLayout) ──
  const p2 = await ctx.newPage();
  const errors2 = []; p2.on("pageerror", (e) => errors2.push(e.message));
  await p2.context().clearCookies();
  await login(p2, "platform-admin", "platform-admin", `${UI}/my-jobs`);
  await p2.waitForTimeout(1500);
  await closeTour(p2);
  const sideBtn = p2.locator("aside button", { hasText: "Tutorial" });
  check("admin sidebar shows an amber Tutorial button on My Jobs", (await sideBtn.count()) === 1 && /amber/.test((await sideBtn.getAttribute("class")) || ""));
  await sideBtn.click(); await p2.waitForTimeout(300);
  check("admin sidebar Tutorial button opens the tour", (await p2.locator('[role="dialog"]').count()) === 1);
  await closeTour(p2);
  check("My Jobs tutorial card has the prominent 'Start the tutorial' button", (await p2.locator("text=Start the tutorial").count()) === 1);
  await p2.goto(`${UI}/studies/${F.STUDY}`); await p2.waitForTimeout(2000);
  const row = p2.locator("tr", { hasText: "Annotation" }).first();
  check("study page job row: status is a badge (only the assignee <select> remains)", (await row.locator("select").count()) === 1 && /In progress|Done|To do/.test(await row.innerText()), await row.innerText().catch(() => null));

  check("no page errors (viewer/tutorial)", errors.length === 0, errors);
  check("no page errors (admin-ui)", errors2.length === 0, errors2);
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 400));
})().catch((e) => { console.error("EXC", e.message); for (const r of results) console.log(r.ok ? "ok  " : "FAIL", r.n); process.exit(1); });
