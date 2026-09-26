// A real 3D view of the CT: the volume ray-marched on the GPU with the
// annotation inside it, opacity / smoothing / window / MIP live, a camera
// that flies like a game character (W A S D, Space, Shift) and "Only inside
// the lungs" for vessels and nodules. WebGL here is software (SwiftShader).
const { chromium } = require("playwright");
const { F, token } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

(async () => {
  const at = await token("dr-test", "Test1234!");
  const job = (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const seriesId = (await api(at, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;

  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); localStorage.removeItem("vl.view.layout"); } catch {} });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => /shader|WebGL: INVALID/i.test(m.text()) && errors.push(m.text().slice(0, 200)));
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.locator('[data-testid="show-pane-three_d"]').click();
  await page.locator('[data-testid="pane-three_d-maximize"]').click();
  const panel = page.locator('[data-testid="volume-panel"]');
  check("the 3D pane opens on the CT volume", await panel.waitFor({ timeout: 60000 }).then(() => true, () => false) && (await page.locator('[data-testid="three-d-volume"]').getAttribute("aria-pressed")) === "true");
  check("... with its size and real voxel size", /voxels · [\d.]+ × [\d.]+ × [\d.]+ mm/.test(await panel.innerText()));
  await page.locator('[data-testid="volume-panel-toggle"]').click(); // settings out of the picture
  await page.waitForTimeout(3000);
  const view = page.locator('[data-testid="volume-view"]');
  const shot = async () => view.screenshot({ timeout: 60000 });
  const first = await shot();
  check("it draws the CT (not a black box)", first.length > 15000, first.length);
  const box = await view.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("KeyW"); await page.waitForTimeout(1200); await page.keyboard.up("KeyW");
  await page.waitForTimeout(1500);
  const flown = await shot();
  check("W flies the camera forward", !flown.equals(first));
  // the viewer's own keys stay out of it: W didn't pan a 2D pane, Space didn't peek
  await page.keyboard.down("Space"); await page.waitForTimeout(600); await page.keyboard.up("Space"); await page.waitForTimeout(1200);
  check("Space goes up (the view moves)", !(await shot()).equals(flown));
  await page.locator('[data-testid="volume-panel-toggle"]').click();
  await page.locator('[data-testid="volume-reset"]').click();
  await page.locator('[data-testid="volume-preset-Vessels"]').click();
  await page.waitForTimeout(4000);
  check("Lung vessels turns on Only inside the lungs", await page.locator('[data-testid="volume-lung-only"]').isChecked() && !/no lungs found/.test(await panel.innerText()));
  await page.locator('[data-testid="volume-mode-mip"]').click(); await page.waitForTimeout(1500);
  check("MIP is one click", (await page.locator('[data-testid="volume-mode-mip"]').getAttribute("aria-pressed")) === "true");
  check("full screen is there", (await page.locator('[data-testid="volume-fullscreen"]').count()) === 1);
  await page.locator('[data-testid="three-d-surfaces"]').click(); await page.waitForTimeout(800);
  check("the surfaces view is still one click away", (await page.locator('[data-testid="volume-view"]').count()) === 0);
  check("no shader or page errors", errors.length === 0, errors.slice(0, 3));
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
