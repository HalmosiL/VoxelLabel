// UX-rev-1-03/-17, UX-rev-2-06: a reviewer had no numbers -- no volume, no
// diameter, no mean HU, no slice list -- and walked every slice, guessing
// "18 mm vs 8 mm". The review card now measures the object under review
// and lists its slices, each one click away. Leaves the fixture case
// handed in, undecided.
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
  const plain = current.objects.map((o) => ({ ...o, review_status: undefined, reject_reason: undefined, review_comment: undefined }));
  await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: plain });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.REVIEW_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-review"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  const text = page.locator('[data-testid="object-measurement-text"]');
  const measured = await text.waitFor({ timeout: 30000 }).then(() => true, () => false);
  const said = measured ? await text.innerText() : "";
  check("the review card measures the object", measured && /slices? \d+/.test(said), said);
  check("... volume, long axis and HU", /mL/.test(said) && /long axis [\d.]+ mm/.test(said) && /mean -?\d+ HU/.test(said), said);
  const chips = page.locator('[data-testid="object-slice-list"] button');
  check("... and lists the slices it is on", (await chips.count()) >= 1);
  const last = chips.last();
  const target = Number(await last.innerText());
  await last.click(); await page.waitForTimeout(500);
  check("a slice in the list is one click away", Number(await page.locator('[data-testid="slice-number-axial"]').innerText()) === target, target);
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
