// UX-rev-1-04 / UX-rev-2-05: the only way to see the scan under a mask was
// dragging the opacity to 0 and back. Now: Outline (O) draws only each
// object's edge, holding Space hides the painting while held, and in
// review an object can be hidden on screen (not saved). Counts the painted
// pixels of the axial overlay. Leaves the fixture case handed in.
const { chromium } = require("playwright");
const { F, token, saveMaskAs } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174", A8010 = "http://localhost:8010";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

(async () => {
  const at = await token("dr-test", "Test1234!");
  const job = (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const seriesId = (await api(at, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const current = await api(at, `${A8010}/series/${seriesId}/mask-volume`);
  const plain = current.objects.map((o) => ({ ...o, hidden: false, review_status: undefined, reject_reason: undefined, review_comment: undefined }));
  await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: plain });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.REVIEW_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-review"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  const painted = () => page.evaluate(() => {
    const canvases = document.querySelectorAll('[data-testid="pane-axial"] canvas');
    const overlay = [...canvases].find((c) => c.style.position === "absolute");
    if (!overlay || !overlay.width) return -1;
    const d = overlay.getContext("2d").getImageData(0, 0, overlay.width, overlay.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  await page.locator('[data-testid="pane-axial"]').hover();
  const filled = await painted();
  check("the object under review is painted", filled > 0, filled);
  await page.keyboard.press("o"); await page.waitForTimeout(400);
  const outline = await painted();
  check("O draws only the outline", outline > 0 && outline < filled, { filled, outline });
  check("... and the switch says so", (await page.locator('[data-testid="overlay-style-outline"]').getAttribute("aria-pressed")) === "true");
  await page.keyboard.down("Space"); await page.waitForTimeout(300);
  const peek = await painted();
  await page.keyboard.up("Space"); await page.waitForTimeout(300);
  check("holding Space hides the painting", peek === 0, peek);
  check("... releasing brings it back", (await painted()) === outline);
  await page.keyboard.press("o"); await page.waitForTimeout(300);
  await page.locator('[data-testid="review-object-eye"]').click(); await page.waitForTimeout(400);
  const hidden = await painted();
  check("the eye hides the object under review", hidden < filled, { filled, hidden });
  await page.locator('[data-testid="review-object-eye"]').click(); await page.waitForTimeout(400);
  check("... on screen only: nothing to save", /Nothing to save yet|Saved/.test(await page.locator('[data-testid="review-autosave"]').innerText()));
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
