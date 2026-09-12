const { chromium } = require("playwright");
const { F } = require("./helpers");
const VIEWER = "http://localhost:5174";
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });
async function login(page, user, pass, url) {
  await page.goto(url); await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", user); await page.fill("#password", pass); await page.click("#kc-login");
  await page.waitForURL((u) => !u.href.includes("localhost:8080"), { timeout: 30000 });
}
async function closeTour(page) {
  const dialog = page.locator('[role="dialog"]');
  for (let i = 0; i < 25 && (await dialog.count()) > 0; i++) {
    const next = dialog.locator("[data-guide-next]");
    const txt = await next.innerText();
    await next.click(); await page.waitForTimeout(150);
    if (txt === "Finish") break;
  }
}
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await login(page, "dr-test", "Test1234!", `${VIEWER}/tutorial`);
  await page.waitForSelector("canvas", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await closeTour(page);

  const canvases = page.locator('[data-guide="panes"] canvas'); // sagittal, coronal, axial

  // --- Alt+click while PAINT tool is active (not cursor) ---
  await page.locator('[data-guide="tool-paint"]').click();
  const axBox = await canvases.nth(2).boundingBox();
  await page.keyboard.down("Alt");
  await page.mouse.click(axBox.x + axBox.width * 0.5, axBox.y + axBox.height * 0.5);
  await page.keyboard.up("Alt");
  await page.waitForTimeout(200);
  let readout = await page.locator("text=/HU$/").innerText().catch(() => null);
  check("Alt+click works while Paint tool is active", readout !== null && /HU$/.test(readout || ""), readout);
  check("Alt+click did NOT paint (mask unaffected)", await page.locator("header button", { hasText: "Mark as Practice-Annotated" }).isDisabled());
  await page.waitForTimeout(3200); // let the readout auto-clear

  // --- Alt+click while HISTOGRAM tool is active ---
  await page.locator('[data-guide="tool-histogram"]').click();
  await page.keyboard.down("Alt");
  await page.mouse.click(axBox.x + axBox.width * 0.4, axBox.y + axBox.height * 0.4);
  await page.keyboard.up("Alt");
  await page.waitForTimeout(200);
  readout = await page.locator("text=/HU$/").innerText().catch(() => null);
  check("Alt+click works while Histogram tool is active", readout !== null && /HU$/.test(readout || ""), readout);
  check("Alt+click did NOT open the histogram popup", !(await page.locator("text=Brightness in the box").isVisible().catch(() => false)));
  await page.waitForTimeout(3200);

  // --- Alt+click on SAGITTAL pane ---
  const sagBox = await canvases.nth(0).boundingBox();
  await page.keyboard.down("Alt");
  await page.mouse.click(sagBox.x + sagBox.width * 0.5, sagBox.y + sagBox.height * 0.5);
  await page.keyboard.up("Alt");
  await page.waitForTimeout(200);
  readout = await page.locator("text=/HU$/").innerText().catch(() => null);
  check("Alt+click works on SAGITTAL pane", readout !== null && /HU$/.test(readout || ""), readout);
  const readoutNum = readout ? parseInt(readout) : NaN;
  check("Alt+click HU value is a real number, not NaN", !Number.isNaN(readoutNum), readout);
  await page.waitForTimeout(3200);

  // --- Alt+click on CORONAL pane ---
  const corBox = await canvases.nth(1).boundingBox();
  await page.keyboard.down("Alt");
  await page.mouse.click(corBox.x + corBox.width * 0.5, corBox.y + corBox.height * 0.5);
  await page.keyboard.up("Alt");
  await page.waitForTimeout(200);
  readout = await page.locator("text=/HU$/").innerText().catch(() => null);
  check("Alt+click works on CORONAL pane", readout !== null && /HU$/.test(readout || ""), readout);
  await page.waitForTimeout(3200);

  // --- Histogram tool: drag box on all 3 panes, verify real stats ---
  for (const [idx, name] of [[0, "sagittal"], [1, "coronal"], [2, "axial"]]) {
    const box = await canvases.nth(idx).boundingBox();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const popupVisible = await page.locator("text=Brightness in the box").isVisible().catch(() => false);
    check(`Histogram popup appears after drag on ${name}`, popupVisible);
    if (popupVisible) {
      const statsText = await page.locator("text=/min .* mean .* max .* HU/").innerText().catch(() => "");
      check(`Histogram stats on ${name} look like real numbers`, /min -?\d+ · mean -?\d+ · max -?\d+ HU/.test(statsText), statsText);
      await page.locator("button:has(svg)", { hasText: "" }).first(); // no-op, just ensure locator chain doesn't throw
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
  }

  // --- Alt+click during REVIEW phase ---
  const t2 = await ctx.newPage(); const t2err = []; t2.on("pageerror", e => t2err.push(e.message));
  await t2.goto(`${VIEWER}/tutorial?mode=review`);
  await t2.waitForSelector("canvas", { timeout: 15000 });
  await t2.waitForTimeout(1200);
  await closeTour(t2);
  const t2canvases = t2.locator('[data-guide="panes"] canvas');
  const t2axBox = await t2canvases.nth(2).boundingBox();
  await t2.keyboard.down("Alt");
  await t2.mouse.click(t2axBox.x + t2axBox.width * 0.5, t2axBox.y + t2axBox.height * 0.5);
  await t2.keyboard.up("Alt");
  await t2.waitForTimeout(200);
  const t2readout = await t2.locator("text=/HU$/").innerText().catch(() => null);
  check("Alt+click works during REVIEW phase too", t2readout !== null && /HU$/.test(t2readout || ""), t2readout);

  check("no page errors (annotate tab)", errors.length === 0, errors);
  check("no page errors (review tab)", t2err.length === 0, t2err);

  await browser.close();
  const fails = results.filter(r => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 300));
})().catch(e => { console.error("EXC", e.message, e.stack); for (const r of results) console.log(r.ok ? "ok  " : "FAIL", r.n); process.exit(1); });
