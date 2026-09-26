// UX-rev-1-03: no measuring tool -- a reviewer couldn't check "18 mm vs
// 8 mm". M turns the ruler on; a drag on a pane shows its length in mm
// (the series' own spacing); the painting is untouched; Esc clears it.
const { chromium } = require("playwright");
const { F, token } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174", A8010 = "http://localhost:8010";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

(async () => {
  const at = await token("dr-test", "Test1234!");
  const job = (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const seriesId = (await api(at, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const { spacing_mm: spacing } = await api(at, `${A8010}/series/${seriesId}/spacing`);
  const instances = await api(at, `${F.DATA}/data/series/${seriesId}/instances`);
  const meta = await api(at, `${A8010}/instances/${instances[0].id}/metadata`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  const painted = () => page.evaluate(() => {
    const overlay = [...document.querySelectorAll('[data-testid="pane-axial"] canvas')].find((c) => c.style.position === "absolute");
    const d = overlay.getContext("2d").getImageData(0, 0, overlay.width, overlay.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  const before = await painted();
  await page.locator('[data-testid="pane-axial"]').hover();
  await page.keyboard.press("m");
  check("M turns the ruler on", (await page.locator('[data-testid="ruler-toggle"]').getAttribute("aria-pressed")) === "true");
  const rect = await page.locator('[data-testid="pane-axial-image"]').boundingBox();
  const x0 = rect.x + rect.width * 0.3, y0 = rect.y + rect.height * 0.5, dragPx = rect.width * 0.4;
  await page.mouse.move(x0, y0); await page.mouse.down();
  await page.mouse.move(x0 + dragPx / 2, y0, { steps: 4 }); await page.mouse.move(x0 + dragPx, y0, { steps: 4 });
  await page.mouse.up(); await page.waitForTimeout(600);
  const label = await page.locator('[data-testid="ruler-label-axial"]').innerText().catch(() => "");
  const expected = spacing ? (dragPx / rect.width) * meta.columns * spacing[2] : null;
  const shown = Number((label.match(/([\d.]+) mm/) || [])[1]);
  check("a drag shows its length in mm", expected !== null && Math.abs(shown - expected) / expected < 0.05, { label, expected });
  check("... and draws nothing into the annotation", (await painted()) === before, { before });
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  check("Esc clears the line", (await page.locator('[data-testid="ruler-label-axial"]').count()) === 0);
  await page.keyboard.press("m");
  check("M again turns it off", (await page.locator('[data-testid="ruler-toggle"]').getAttribute("aria-pressed")) !== "true" && (await page.locator('[data-testid="ruler-surface-axial"]').count()) === 0);
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
