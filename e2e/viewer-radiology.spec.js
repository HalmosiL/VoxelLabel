// The radiologist's round of viewer feedback, end to end in the real
// viewer: mouse window/level, the slice strip along the pane's edge,
// thick slabs (average/MIP/MinIP), a crosshair that leaves its centre
// open, the wheel paging slices (Ctrl+wheel zooms), the Auto tool's HU
// range, and polygon points that stay small when zoomed.
const { chromium } = require("playwright");
const { F } = require("./helpers");
const ADMIN = "http://localhost:8004", KC = "http://localhost:8080", VIEWER = "http://localhost:5174";

async function token(user, pass) {
  const r = await fetch(`${KC}/realms/ct-platform/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: user, password: pass }) });
  return (await r.json()).access_token;
}
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

(async () => {
  const t = await token("dr-test", "Test1234!");
  const jobs = await api(t, `${ADMIN}/admin/my-jobs`);
  const job = jobs.find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases.find((c) => c.status !== "done") || job.cases[0];
  const seriesId = (await api(t, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review", "workbench", "job", "case"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); localStorage.removeItem("vl.viewer.crosshair"); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const slabResponses = [];
  page.on("response", (r) => { if (r.url().includes("/slab.png")) slabResponses.push(r.status()); });
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="pane-"][data-testid$="-image"]').length >= 3, null, { timeout: 60000 });
  await page.waitForTimeout(3000);

  const axial = page.locator('[data-testid="pane-axial"]');
  const box = await axial.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const sliceOf = (pane) => page.locator(`[data-testid="pane-${pane}"]`).locator("xpath=following-sibling::div[1]").locator("input[type=range]").inputValue().then(Number);
  const scaleOf = (pane) => page.locator(`[data-testid="pane-${pane}"] > div`).first().evaluate((el) => { const m = /scale\(([\d.]+)\)/.exec(el.style.transform); return m ? Number(m[1]) : 1; });
  const windowValues = () => page.locator('[data-guide="window"] input[type=range]').evaluateAll((els) => els.map((e) => Number(e.value)));
  await page.locator('[data-testid="tool-cursor"]').click();

  check("the footer teaches the new mouse", /Scroll=Slice · Ctrl\/Cmd\+Scroll=Zoom · Right\/middle-drag=Window/.test(await page.locator('[data-guide="footer"]').innerText()));

  // 5. the wheel pages slices; Ctrl+wheel zooms
  await page.mouse.move(cx, cy);
  const s0 = await sliceOf("axial"), z0 = await scaleOf("axial");
  await page.mouse.wheel(0, 100); await page.waitForTimeout(250);
  const s1 = await sliceOf("axial"), z1 = await scaleOf("axial");
  check("the plain wheel steps the axial slice by one, no zoom", s1 === s0 + 1 && z1 === z0, { s0, s1, z0, z1 });
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -100); await page.keyboard.up("Control"); await page.waitForTimeout(250);
  const s2 = await sliceOf("axial"), z2 = await scaleOf("axial");
  check("Ctrl+wheel zooms and leaves the slice alone", s2 === s1 && z2 > z1, { s1, s2, z1, z2 });
  await page.mouse.dblclick(cx, cy); await page.waitForTimeout(200);

  // 2. the slice strip stands along the pane's right edge, relative drag
  const strip = page.locator('[data-testid="pane-axial"]').locator("xpath=following-sibling::div[1]");
  const sb = await strip.boundingBox();
  check("the slice strip is a tall column right of the image", sb && sb.x >= box.x + box.width - 2 && sb.height > box.height * 0.8 && sb.width < 50, { sb, box });
  const drag = page.locator('[data-testid="pane-axial"]').locator("xpath=following-sibling::div[1]").locator('[data-testid="slice-drag"]');
  const db = await drag.boundingBox();
  const before = await sliceOf("axial");
  // press near the top, drag 40 px down: relative -- a few slices on from
  // where it was, not a jump to the top
  await page.mouse.move(db.x + db.width / 2, db.y + 10); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(db.x + db.width / 2, db.y + 10 + i * 5);
  await page.mouse.up(); await page.waitForTimeout(250);
  const after = await sliceOf("axial");
  check("dragging the strip pages relative to where the drag began", after > before && after - before <= 14, { before, after });

  // 1. right-drag windows the image (Cursor tool): down = level up, right = wider
  const w0 = await windowValues();
  await page.mouse.move(cx, cy); await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 8, cy + i * 6);
  await page.mouse.up({ button: "right" }); await page.waitForTimeout(300);
  const w1 = await windowValues();
  check("right-drag moves the level (up/down) and the width (left/right)", w1[0] > w0[0] && w1[1] > w0[1], { w0, w1 });
  // the instant preview filter goes once the server's picture for the new window lands
  await page.waitForTimeout(1500);
  check("the preview filter is gone once the new picture arrived", (await page.locator('[data-testid="pane-axial-image"]').evaluate((el) => el.style.filter)) === "");
  // middle button windows with a drawing tool too, and draws nothing
  await page.locator('[data-testid="tool-paint"]').click().catch(() => undefined);
  const wm0 = await windowValues();
  await page.mouse.move(cx, cy); await page.mouse.down({ button: "middle" });
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx - i * 6, cy - i * 5);
  await page.mouse.up({ button: "middle" }); await page.waitForTimeout(300);
  const wm1 = await windowValues();
  check("middle-drag windows with any tool", wm1[0] < wm0[0] && wm1[1] < wm0[1], { wm0, wm1 });
  // Ctrl+click jumps the other planes with a drawing tool too, and paints nothing
  const painted = () => page.locator('[data-testid="pane-axial"] canvas').nth(1).evaluate((c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  const paintBefore = await painted();
  const sag0 = await sliceOf("sagittal"), cor0 = await sliceOf("coronal");
  await page.keyboard.down("Control"); await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.7); await page.keyboard.up("Control");
  await page.waitForTimeout(300);
  const sag1 = await sliceOf("sagittal"), cor1 = await sliceOf("coronal");
  // the overlay redraws for the new crosshair position, not for paint: compare on the same slice
  const paintAfter = await painted();
  check("Ctrl+click with the Paint tool jumps the other planes and draws nothing", sag1 !== sag0 && cor1 !== cor0 && paintAfter === paintBefore, { sag0, sag1, cor0, cor1, paintBefore, paintAfter });
  await page.locator('[data-testid="tool-cursor"]').click();

  // 4. crosshair: on by default, open in the middle, C toggles
  const lines = await page.locator('[data-testid="crosshair-axial"] line').evaluateAll((els) => els.map((l) => ["x1", "y1", "x2", "y2"].map((a) => Number(l.getAttribute(a)))));
  const vertical = lines.filter(([x1, , x2]) => x1 === x2), horizontal = lines.filter(([, y1, , y2]) => y1 === y2);
  const vx = vertical[0] && vertical[0][0], hy = horizontal[0] && horizontal[0][1];
  const coversCentre = lines.some(([x1, y1, x2, y2]) => Math.min(x1, x2) <= vx && Math.max(x1, x2) >= vx && Math.min(y1, y2) <= hy && Math.max(y1, y2) >= hy);
  check("the crosshair draws both other planes, broken around their meeting point", vertical.length === 2 && horizontal.length === 2 && !coversCentre, lines);
  check("every pane has its crosshair", (await page.locator('svg[data-testid^="crosshair-"]').count()) === 3);
  await page.mouse.move(cx, cy); await page.keyboard.press("c"); await page.waitForTimeout(150);
  check("C hides the crosshair", (await page.locator('svg[data-testid^="crosshair-"]').count()) === 0);
  await page.keyboard.press("c"); await page.waitForTimeout(150);

  // 3. slab: MIP of 5 on every pane, from the backend's slab.png
  await page.locator('[data-testid="slab-mode-mip"]').click();
  await page.waitForTimeout(2500);
  check("MIP makes every pane a 5-slice slab and says so", (await page.locator('[data-testid="pane-axial-slab"]').innerText()).trim() === "MIP 5" && (await page.locator('[data-testid$="-slab"]').count()) === 3);
  check("the slabs come from the backend", slabResponses.length >= 3 && slabResponses.every((s) => s === 200), slabResponses);
  await page.locator('[data-testid="slab-thickness-1"]').click(); await page.waitForTimeout(300);
  check("thickness 1 is back to single slices", (await page.locator('[data-testid$="-slab"]').count()) === 0);

  // 7. polygon points keep one small screen size at any zoom
  const hasObject = await page.locator('[data-testid^="object-"]').count();
  if (!hasObject) {
    const firstLabel = page.locator('[data-testid^="add-object-"]').first();
    if (await firstLabel.count()) await firstLabel.click();
  }
  await page.locator('[data-testid^="object-"]').first().click().catch(() => undefined);
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 4; i++) { await page.keyboard.down("Control"); await page.mouse.wheel(0, -100); await page.keyboard.up("Control"); await page.waitForTimeout(80); }
  const zoomed = await scaleOf("axial");
  await page.locator('[data-testid="tool-polygon"]').click();
  await page.mouse.click(cx - 20, cy - 20); await page.mouse.click(cx + 20, cy - 20); await page.mouse.click(cx + 20, cy + 20);
  await page.waitForTimeout(200);
  const radii = await page.locator('[data-testid="polygon-point"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width / 2));
  check("polygon points stay small when zoomed in", zoomed > 1.5 && radii.length === 3 && radii.every((r) => r <= 4), { zoomed, radii });
  await page.keyboard.press("Escape");

  // 6. Auto: a HU range suggested from the box, fill holes on
  await page.locator('[data-testid="tool-auto"]').click();
  await page.mouse.dblclick(cx, cy).catch(() => undefined);
  await page.mouse.move(cx - 30, cy - 30); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(cx - 30 + i * 10, cy - 30 + i * 10);
  await page.mouse.up();
  await page.locator('[data-testid="auto-range"]').waitFor({ timeout: 15000 });
  check("the Auto panel offers a HU range (open at the top) and fill holes", /… max$/.test(await page.locator('[data-testid="auto-range"]').innerText()) && (await page.locator('[data-testid="auto-fill-holes"]').isChecked()), await page.locator('[data-testid="auto-range"]').innerText());
  await page.keyboard.press("Escape");

  check("no page errors", errors.length === 0, errors);
  await page.screenshot({ path: "viewer-radiology.png" });
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 400));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
