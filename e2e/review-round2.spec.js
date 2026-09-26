// UX-rev-1-16 / UX-rev-2-24: in round 2 nothing showed what the rework
// changed -- the reviewer found a new rectangular block only thanks to
// their own round-1 screenshots. Now the review card says, per object,
// what changed since the last round, the objects deleted since are listed,
// and G draws the last round's outline as a ghost. Restores the fixture.
const { chromium } = require("playwright");
const zlib = require("zlib");
const { F, token, saveMaskAs } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174", A8010 = "http://localhost:8010";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

(async () => {
  const at = await token("dr-test", "Test1234!");
  const rt = await token("dr-review", "Test1234!");
  const job = (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const seriesId = (await api(at, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const current = await api(at, `${A8010}/series/${seriesId}/mask-volume`);
  if ((current.objects || []).length < 2) { console.log("checks 0, fails 1\nFAIL the fixture case needs two objects"); process.exit(1); }
  const plain = current.objects.map((o) => ({ ...o, hidden: false, review_status: undefined, reject_reason: undefined, review_comment: undefined, previous_review: undefined }));
  const original = current.mask_gzip_base64;
  const mask = zlib.gunzipSync(Buffer.from(original, "base64"));

  // round 1: handed in, rejected
  const sub = await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: plain, mask_gzip_base64: original });
  const verdicts = plain.map((o, i) => ({ ...o, review_status: i === 0 ? "rejected" : "accepted", ...(i === 0 ? { reject_reason: "boundary", review_comment: "add the upper part" } : {}) }));
  const draft = await saveMaskAs(rt, seriesId, F.STUDY, "draft", { objects: verdicts, review_of: sub.body.id, mask_gzip_base64: original });
  await fetch(`${A8010}/annotations/${draft.body.id}/review`, { method: "POST", headers: { Authorization: `Bearer ${rt}`, "content-type": "application/json" }, body: JSON.stringify({ decision: "reject", comment: "see Nodule 1" }) });

  // the rework: Nodule 1 gets 25 more voxels, the last object goes
  const first = plain[0], last = plain[plain.length - 1];
  const rework = Buffer.from(mask);
  let grown = 0;
  for (let i = 0; i < rework.length && grown < 25; i++) if (rework[i] === 0) { rework[i] = first.id; grown++; }
  for (let i = 0; i < rework.length; i++) if (rework[i] === last.id) rework[i] = 0;
  const reworked = verdicts.filter((o) => o.id !== last.id);
  await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: reworked, mask_gzip_base64: zlib.gzipSync(rework).toString("base64") });

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
    const page = await ctx.newPage();
    await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.REVIEW_CARD}`);
    await page.waitForSelector("#username", { timeout: 30000 });
    await page.fill("#username", "dr-review"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
    await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
    const change = page.locator('[data-testid="round-change"]');
    await change.waitFor({ timeout: 20000 }).catch(() => {});
    const said = await change.innerText().catch(() => "");
    check("the card says what the rework changed on this object", /Changed since the last round: \+25 \/ −0 voxels/.test(said), said);
    check("the objects deleted since are listed", /Deleted since the last round/.test(await page.locator('[data-testid="round-deleted"]').innerText().catch(() => "")));
    // an object left as it was says so
    await page.locator('[data-testid^="review-dot-"]').nth(1).click(); await page.waitForTimeout(400);
    const unchangedText = await change.innerText().catch(() => "");
    check("... and one left alone says it is unchanged", /Unchanged since the last round/.test(unchangedText), { name: await page.locator('[data-testid="review-object-name"]').innerText(), unchangedText });
    const white = () => page.evaluate(() => {
      const overlay = [...document.querySelectorAll('[data-testid="pane-axial"] canvas')].find((c) => c.style.position === "absolute");
      const d = overlay.getContext("2d").getImageData(0, 0, overlay.width, overlay.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255 && d[i + 3] > 0) n++;
      return n;
    });
    const before = await white();
    await page.locator('[data-testid="pane-axial"]').hover();
    await page.keyboard.press("g"); await page.waitForTimeout(500);
    check("G draws the last round's outline", (await white()) > before && (await page.locator('[data-testid="last-round-toggle"]').isChecked()), { before });
  } finally {
    await browser.close();
    await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: plain, mask_gzip_base64: original });
  }
  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
