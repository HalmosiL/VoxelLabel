// The 3D view on a tablet: an on-screen stick flies (as far as it is
// pushed), ▲ ▼ rise and sink, a finger dragged on the view looks around --
// and the two at once, a thumb on each, the way the tour's touch text says.
// Real touch events (CDP Input.dispatchTouchEvent), not mouse ones.
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
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); localStorage.removeItem("vl.view.layout"); } catch {} });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  // a tablet opens on one big pane, the others one tap away
  const switchTo3D = page.locator('[data-testid="pane-switch-three_d"]').first();
  if (await switchTo3D.isVisible()) await switchTo3D.tap();
  else { await page.locator('[data-testid="show-pane-three_d"]').tap(); await page.locator('[data-testid="pane-three_d-maximize"]').tap(); }
  const stick = page.locator('[data-testid="volume-stick"]');
  check("a touch screen gets the on-screen stick and ▲ ▼", await stick.waitFor({ timeout: 60000 }).then(() => true, () => false) && (await page.locator('[data-testid="volume-rise"]').count()) === 1);
  check("... and a hint for fingers", /Drag to look · the stick flies/.test(await page.locator('[data-testid="volume-hint"]').innerText()));
  if (await page.locator('[data-testid="volume-panel"]').isVisible()) await page.locator('[data-testid="volume-panel-toggle"]').tap();
  await page.waitForTimeout(3000);
  const view = page.locator('[data-testid="volume-view"]');
  // the stick and the buttons are part of the pane: shoot the canvas alone
  const canvas = page.locator('[data-testid="volume-canvas"]');
  const shot = async () => canvas.screenshot({ timeout: 60000 });
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });

  const sb = await stick.boundingBox();
  const sx = sb.x + sb.width / 2, sy = sb.y + sb.height / 2;
  const first = await shot();
  await touch("touchStart", [[sx, sy]]);
  await touch("touchMove", [[sx, sy - 30]]); // pushed most of the way forward
  const knob = await page.locator('[data-testid="volume-stick-knob"]').boundingBox();
  check("the knob follows the thumb", knob && knob.y + knob.height / 2 < sy - 15, { knobY: knob && knob.y, sy });
  await page.waitForTimeout(1200);
  await touch("touchEnd", []);
  await page.waitForTimeout(1500);
  const flown = await shot();
  check("pushing the stick flies the camera", !flown.equals(first));
  const back = await page.locator('[data-testid="volume-stick-knob"]').boundingBox();
  check("... and letting go stops it (the knob back in the middle)", Math.abs(back.y + back.height / 2 - sy) < 3);
  await page.waitForTimeout(800);
  check("... the view stays put once let go", (await shot()).equals(await shot()));

  const rb = await page.locator('[data-testid="volume-rise"]').boundingBox();
  await touch("touchStart", [[rb.x + rb.width / 2, rb.y + rb.height / 2]]);
  await page.waitForTimeout(700);
  await touch("touchEnd", []);
  await page.waitForTimeout(1200);
  const risen = await shot();
  check("holding ▲ rises", !risen.equals(flown));

  // a finger dragged on the view looks around
  const vb = await view.boundingBox();
  const lx = vb.x + vb.width * 0.6, ly = vb.y + vb.height * 0.4;
  await touch("touchStart", [[lx, ly]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[lx + i * 12, ly]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(1500);
  const looked = await shot();
  check("dragging a finger on the view looks around", !looked.equals(risen));

  // both at once: the thumb on the stick doesn't turn the view, the other finger does
  await touch("touchStart", [[sx, sy], [lx, ly]]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [[sx, sy - 30], [lx - i * 10, ly]]);
  await page.waitForTimeout(800);
  const knob2 = await page.locator('[data-testid="volume-stick-knob"]').boundingBox();
  await touch("touchEnd", []);
  await page.waitForTimeout(1500);
  check("a thumb on each: fly and look at once", knob2.y + knob2.height / 2 < sy - 15 && !(await shot()).equals(looked));
  check("no page errors", errors.length === 0, errors.slice(0, 3));
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
