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
function paneSliderValues(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('[data-guide="pane-sliders"] input[type=range]')).map(i => i.value));
}
function paneTransforms(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('[data-guide="panes"] canvas')).map(c => getComputedStyle(c.parentElement).transform));
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
  const before = await paneSliderValues(page);
  check("initial slider values captured", before.length === 3, before);

  // Hover axial (3rd canvas) and press ArrowRight -> axial slice +1
  await canvases.nth(2).hover();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);
  let after = await paneSliderValues(page);
  check("ArrowRight on hovered axial steps ONLY axial slice", Number(after[2]) === Number(before[2]) + 1 && after[0] === before[0] && after[1] === before[1], { before, after });

  // Hover sagittal (1st canvas) and press ArrowLeft -> sagittal index -1
  await canvases.nth(0).hover();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(150);
  const after2 = await paneSliderValues(page);
  check("ArrowLeft on hovered sagittal steps ONLY sagittal index", Number(after2[0]) === Number(after[0]) - 1 && after2[1] === after[1] && after2[2] === after[2], { after, after2 });

  // Hover axial, ArrowUp -> zoom in (scale > 1), transform changes
  await canvases.nth(2).hover();
  const t0 = await paneTransforms(page);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(150);
  const t1 = await paneTransforms(page);
  check("ArrowUp on hovered axial zooms it (transform changes)", t1[2] !== t0[2], { t0: t0[2], t1: t1[2] });
  check("ArrowUp on axial doesn't affect sagittal/coronal transform", t1[0] === t0[0] && t1[1] === t0[1]);

  // WASD pan now that axial is zoomed
  const t2 = await paneTransforms(page);
  await page.keyboard.press("d");
  await page.waitForTimeout(150);
  const t3 = await paneTransforms(page);
  check("D pans the zoomed, hovered axial pane (transform changes)", t3[2] !== t2[2], { t2: t2[2], t3: t3[2] });

  // Reset axial zoom via double-click, then hover coronal, ArrowUp zooms coronal only
  await canvases.nth(2).dblclick();
  await page.waitForTimeout(150);
  await canvases.nth(1).hover();
  const t4 = await paneTransforms(page);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(150);
  const t5 = await paneTransforms(page);
  check("ArrowUp on hovered coronal zooms ONLY coronal", t5[1] !== t4[1] && t5[0] === t4[0] && t5[2] === t4[2], { t4, t5 });

  // Wheel-zoom on sagittal
  await canvases.nth(0).hover();
  const t6 = await paneTransforms(page);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(200);
  const t7 = await paneTransforms(page);
  check("wheel zooms hovered sagittal pane", t7[0] !== t6[0], { t6: t6[0], t7: t7[0] });

  // Undo/redo keyboard shortcuts: paint something (an instance is
  // pre-seeded and active by default), Ctrl+Z should undo (Mark button disables)
  await page.locator('[data-guide="tool-paint"]').click();
  const axialBox = await canvases.nth(2).boundingBox();
  await page.mouse.move(axialBox.x + axialBox.width * 0.5, axialBox.y + axialBox.height * 0.5);
  await page.mouse.down(); await page.mouse.move(axialBox.x + axialBox.width * 0.55, axialBox.y + axialBox.height * 0.55); await page.mouse.up();
  await page.waitForTimeout(150);
  check("paint enabled Mark button", !(await page.locator("header button", { hasText: "Mark as Practice-Annotated" }).isDisabled()));
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  check("Ctrl+Z undoes the paint stroke (Mark disables again)", await page.locator("header button", { hasText: "Mark as Practice-Annotated" }).isDisabled());
  await page.keyboard.press("Control+Shift+Z");
  await page.waitForTimeout(150);
  check("Ctrl+Shift+Z redoes (Mark enables again)", !(await page.locator("header button", { hasText: "Mark as Practice-Annotated" }).isDisabled()));

  // N shortcut: new instance
  const objCountBefore = await page.locator('[data-guide="objects"] li').count();
  await page.keyboard.press("n");
  await page.waitForTimeout(150);
  const objCountAfter = await page.locator('[data-guide="objects"] li').count();
  check("N creates a new instance", objCountAfter === objCountBefore + 1, { objCountBefore, objCountAfter });

  check("no page errors", errors.length === 0, errors);
  await browser.close();
  const fails = results.filter(r => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra).slice(0, 300));
})().catch(e => { console.error("EXC", e.message); for (const r of results) console.log(r.ok ? "ok  " : "FAIL", r.n); process.exit(1); });
