// The 3D view fills the room it is given: beside the 2D panes (each image
// keeps its square) it takes the rest of the row's width and all of its
// height -- no black bars above and below a square 3D -- and on its own
// it takes the whole row.
const { chromium } = require("playwright");
const { F, token } = require("./helpers");

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

(async () => {
  const at = await token("dr-test", "Test1234!");
  const job = (await api(at, `${F.ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const seriesId = (await api(at, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); localStorage.removeItem("vl.view.layout"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(`${F.VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.locator('[data-testid="show-pane-three_d"]').click();
  await page.locator('[data-testid="volume-view"]').waitFor({ timeout: 60000 });
  await page.waitForTimeout(1000);

  const row = await page.locator('[data-guide="panes"]').boundingBox();
  // all four side by side: the 3D pane still reaches from top to bottom
  const four = await page.locator('[data-testid="volume-view"]').boundingBox();
  check("with all four panes the 3D view still takes the row's full height", four.height >= row.height - 40, { row: row.height, four: four.height });
  // just the axial beside it
  for (const p of ["sagittal", "coronal"]) await page.locator(`[data-testid="show-pane-${p}"]`).click();
  await page.waitForTimeout(800);
  const axial = await page.locator('[data-testid="pane-axial"]').boundingBox();
  const three = await page.locator('[data-testid="volume-view"]').boundingBox();
  // the 3D pane's own header row sits above the view: allow for it
  check("beside a 2D pane the 3D view takes the row's full height", three.height >= row.height - 40, { row: row.height, three: three.height });
  check("... and the rest of its width", Math.abs(three.x + three.width - (row.x + row.width)) <= 2 && three.width > axial.width * 0.8, { row, three, axial });
  check("... while the 2D image stays square", Math.abs(axial.width - axial.height) <= 2, axial);

  // on its own: the whole row
  await page.locator('[data-testid="show-pane-axial"]').click();
  await page.waitForTimeout(800);
  const alone = await page.locator('[data-testid="volume-view"]').boundingBox();
  check("alone it takes the whole row", Math.abs(alone.width - row.width) <= 2 && alone.height >= row.height - 40, { row, alone });
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
