// Work in the viewer is never lost silently: leaving a case with unsaved
// paint asks first (E-04), and a save made from an older version than the
// one on the server -- another tab, another person -- is refused with a
// clear message instead of burying the newer work (J-11).
const { chromium } = require("playwright");
const { F } = require("./helpers");
const ADMIN = "http://localhost:8004", KC = "http://localhost:8080", VIEWER = "http://localhost:5174", UI = "http://localhost:5173";

async function token(user, pass) {
  const r = await fetch(`${KC}/realms/ct-platform/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: user, password: pass }) });
  return (await r.json()).access_token;
}
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }
const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

async function open(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review", "workbench", "job", "case"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  return { ctx, page };
}

async function paint(page) {
  await page.locator('[data-testid^="object-"]').first().click().catch(() => undefined);
  await page.locator('[data-testid="tool-paint"]').click();
  const box = await page.locator('[data-testid="pane-axial"]').boundingBox();
  const x = box.x + box.width * (0.3 + Math.random() * 0.3), y = box.y + box.height * (0.3 + Math.random() * 0.3);
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + i * 4, y + i * 3);
  await page.mouse.up(); await page.waitForTimeout(200);
}
const saveButton = (page) => page.locator("header button", { hasText: /^Save$/ });

(async () => {
  const t = await token("dr-test", "Test1234!");
  const jobs = await api(t, `${ADMIN}/admin/my-jobs`);
  const job = jobs.find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases.find((c) => c.status !== "done") || job.cases[0];
  const seriesId = (await api(t, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const returnUrl = `${UI}/studies/${F.STUDY}/cases/${kase.id}?jobId=${F.ANNOT_CARD}`;
  const url = `${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}&returnUrl=${encodeURIComponent(returnUrl)}`;
  const browser = await chromium.launch();

  // ---- E-04: leaving with unsaved paint asks first ----
  {
    const { ctx, page } = await open(browser, url);
    const dialogs = [];
    page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
    const back = page.locator('[data-guide="back"]');
    await back.click(); await page.waitForTimeout(800);
    check("with nothing changed, Back just leaves", dialogs.length === 0 && page.url().startsWith(UI), page.url());
    await page.goBack(); await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 }); await page.waitForTimeout(2000);
    await paint(page);
    const before = page.url();
    await page.locator('[data-guide="back"]').click(); await page.waitForTimeout(800);
    check("with unsaved paint, Back asks and staying keeps the work", dialogs.length === 1 && /unsaved changes/.test(dialogs[0]) && page.url() === before, { dialogs, url: page.url() });
    await saveButton(page).click();
    await page.waitForTimeout(1500);
    await page.locator('[data-guide="back"]').click(); await page.waitForTimeout(800);
    check("after Save, Back leaves without asking", dialogs.length === 1 && page.url().startsWith(UI), { dialogs, url: page.url() });
    await ctx.close();
  }

  // ---- J-11: a save based on an older version is refused, with a clear message ----
  {
    const a = await open(browser, url);
    const b = await open(browser, url);
    await paint(a.page);
    await saveButton(a.page).click(); await a.page.waitForTimeout(1500);
    check("the first tab saves", (await a.page.locator("text=Someone else saved").count()) === 0);
    await paint(b.page);
    await saveButton(b.page).click(); await b.page.waitForTimeout(1500);
    check("the second tab, still on the old version, is refused with a clear message", (await b.page.locator("text=Someone else saved a newer version").count()) === 1);
    await b.page.reload(); await b.page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 }); await b.page.waitForTimeout(2500);
    await paint(b.page);
    await saveButton(b.page).click(); await b.page.waitForTimeout(1500);
    check("after a reload it saves on top of the newer version", (await b.page.locator("text=Someone else saved").count()) === 0);
    await a.ctx.close(); await b.ctx.close();
  }

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
