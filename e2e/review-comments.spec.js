// Review rounds in the viewer (F-02, F-04, F-06): the reviewer's comment
// box starts empty and the annotator's note is shown apart from it, the
// last round's verdict is visible to the reviewer, and the annotator sees
// in the object list which objects were rejected and why. The states are
// set up through the API; the checks are what each person sees.
const { chromium } = require("playwright");
const { F, token, saveMaskAs } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174", A8010 = "http://localhost:8010";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

async function open(browser, user, seriesId, caseId, jobId) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review", "workbench", "job", "case"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${caseId}&jobId=${jobId}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", user); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  return { ctx, page };
}

(async () => {
  const at = await token("dr-test", "Test1234!");
  const rt = await token("dr-review", "Test1234!");
  const job = (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases.find((c) => c.status !== "done") ?? job.cases[job.cases.length - 1];
  const seriesId = (await api(at, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const current = await api(at, `${A8010}/series/${seriesId}/mask-volume`);
  if (!current.objects || current.objects.length === 0) { console.log("checks 0, fails 1\nFAIL the fixture case has no objects"); process.exit(1); }
  const [first, ...rest] = current.objects;
  const browser = await chromium.launch();

  // ---- the annotator hands in with a note and a verdict from last round ----
  const handedIn = [
    { ...first, comment: "annotator note: unsure about margin", previous_review: { status: "rejected", reject_reason: "boundary", review_comment: "too wide" }, review_status: undefined, reject_reason: undefined, review_comment: undefined },
    ...rest.map((o) => ({ ...o, review_status: undefined, reject_reason: undefined, review_comment: undefined })),
  ];
  const sub = await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: handedIn });
  check("the hand-in is accepted by the server schema", sub.status === 201, sub.body);
  {
    const { ctx, page } = await open(browser, "dr-review", seriesId, kase.id, F.REVIEW_CARD);
    await page.locator("aside li", { hasText: `${first.instance_number}` }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    check("the reviewer's comment box starts empty (F-02)", (await page.locator('[data-testid="review-comment"]').inputValue()) === "");
    check("the annotator's note is shown apart from it", /unsure about margin/.test(await page.locator('[data-testid="annotator-note"]').innerText().catch(() => "")));
    check("last round's verdict is shown to the reviewer (F-06)", /rejected \(boundary off\): too wide/.test(await page.locator('[data-testid="previous-review"]').innerText().catch(() => "")));
    await ctx.close();
  }

  // ---- the reviewer rejects the first object; the annotator sees it (F-04) ----
  const reviewed = handedIn.map((o, i) => ({ ...o, review_status: i === 0 ? "rejected" : "accepted", ...(i === 0 ? { reject_reason: "missed", review_comment: "look again at the apex" } : {}) }));
  const draft = await saveMaskAs(rt, seriesId, F.STUDY, "draft", { objects: reviewed, review_of: sub.body.id });
  await fetch(`${A8010}/annotations/${draft.body.id}/review`, { method: "POST", headers: { Authorization: `Bearer ${rt}`, "content-type": "application/json" }, body: JSON.stringify({ decision: "reject", comment: "Nodule: look again" }) });
  {
    const { ctx, page } = await open(browser, "dr-test", seriesId, kase.id, F.ANNOT_CARD);
    const badge = await page.locator(`[data-testid="rejected-${first.id}"]`).innerText().catch(() => "");
    check("the annotator sees which object was rejected, and why (F-04)", /missed finding/.test(badge), badge);
    await ctx.close();
  }
  // hand the case in again, so the fixture is reviewable for the next specs
  await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: handedIn });

  await browser.close();
  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
