// UX-annot-1-08 / UX-annot-2-10: every load reset to slice 1 and three
// panes. The viewer now opens a case where it was left (per case, in this
// browser), a first visit on the first object, and keeps the layout -- a
// maximized pane stays maximized.
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
  const current = await api(at, `${A8010()}/series/${seriesId}/mask-volume`);
  const url = `${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.goto(url);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  const ready = async () => { await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 }); await page.waitForTimeout(2500); };
  await ready();
  const axial = async () => Number(await page.locator('[data-testid="slice-number-axial"]').innerText());
  const where = async () => Promise.all(["axial", "coronal", "sagittal"].map(async (p) => Number(await page.locator(`[data-testid="slice-number-${p}"]`).innerText())));
  const opened = await where();
  // the first object's own place: where a click on it in the list goes
  await page.locator("text=Nodule 1").first().click(); await page.waitForTimeout(600);
  const firstObject = await where();
  check("a first visit opens on the first object", (current.objects || []).length > 0 && JSON.stringify(opened) === JSON.stringify(firstObject), { opened, firstObject });

  await page.locator('[data-testid="pane-axial"]').hover();
  for (let i = 0; i < 3; i++) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(80); }
  const moved = await axial();
  await page.waitForTimeout(1200);
  await page.reload(); await ready();
  check("coming back, the case opens where it was left", (await axial()) === moved, { moved, now: await axial() });

  await page.locator('[data-testid="pane-axial-maximize"]').click(); await page.waitForTimeout(600);
  await page.reload(); await ready();
  const images = await page.locator('[data-testid$="-image"]:visible').count();
  check("a maximized pane stays maximized", images === 1 && (await page.locator('[data-testid="pane-axial-image"]').isVisible()), images);
  await page.locator('[data-testid="pane-axial-maximize"]').click(); await page.waitForTimeout(600); // back to three panes for other specs' sake (same browser only)
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
function A8010() { return "http://localhost:8010"; }
