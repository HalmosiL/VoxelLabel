// UX "keyboard map": the viewer's shortcuts were only in a truncated footer
// line and in tooltips. "?" (or the header's keyboard button) now lists
// every key and gesture of the screen; review leaves the drawing keys out.
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

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review", "tutorial"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  const help = page.locator('[data-testid="keyboard-help"]');
  check("the footer points to the full list", /\?=All keys/.test(await page.locator('[data-guide="footer"]').innerText()));
  await page.keyboard.press("Shift+Slash");
  check("? opens the list of keys and gestures", await help.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false));
  const text = await help.innerText().catch(() => "");
  check("... with the drawing keys while annotating", /Ctrl\+Z/.test(text) && /New object/.test(text) && /Alt\+click/.test(text), text.slice(0, 200));
  check("... and the 3D view's flying keys", /3D view/i.test(text) && /Fly up \/ down/.test(text), text.slice(-300));
  await page.keyboard.press("Escape");
  check("Esc closes it", await help.waitFor({ state: "hidden", timeout: 3000 }).then(() => true, () => false));
  await page.locator('[data-testid="keyboard-help-open"]').click();
  check("the header's keyboard button opens it too", await help.isVisible());
  await page.keyboard.press("Shift+Slash");
  check("... and ? closes it again", await help.waitFor({ state: "hidden", timeout: 3000 }).then(() => true, () => false));

  // review: no drawing keys
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.REVIEW_CARD}&viewAs=reviewer`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.keyboard.press("Shift+Slash");
  await help.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  const reviewText = await help.innerText().catch(() => "");
  check("in review the list leaves the drawing keys out", /Alt\+click/.test(reviewText) && !/New object/.test(reviewText), reviewText.slice(0, 200));
  await page.keyboard.press("Escape");

  // the tutorial has the same list
  await page.goto(`${VIEWER}/tutorial`);
  await page.waitForSelector('[data-guide="footer"]', { timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.keyboard.press("Escape"); // a tour step, if one is up
  await page.keyboard.press("Shift+Slash");
  check("the tutorial answers ? the same way", await help.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false));
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
