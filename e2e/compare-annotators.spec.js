// The Compare card: two Duplicate copies' work on the same image, side by
// side. Builds Dataset (one case) -> Duplicate -> a job per copy ->
// Compare on the fixture study's board; hands in two different masks of
// the same series, one on each copy's branch; runs the Compare from its
// panel and reads the node, the report (a pair, an image row, a viewer
// link on each copy's own job) and the CSV. Removes everything it made.
const zlib = require("zlib");
const { chromium } = require("playwright");
const { F, login, seenGuides, token } = require("./helpers");

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

async function call(tok, method, url, body) {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  const admin = await token("platform-admin", "platform-admin");
  const annot = await token("dr-test", "Test1234!");
  const boardNow = async () => (await call(admin, "GET", `${F.ADMIN}/admin/studies/${F.STUDY}/workflow`)).body;
  const existing = (await boardNow()).cards;
  const before = new Set(existing.map((c) => c.id));
  // beside what is already on the board, so the board's opening view shows it
  const X = Math.max(...existing.map((c) => c.position_x)) + 400, Y = Math.min(...existing.map((c) => c.position_y));
  const kase = (await call(admin, "GET", `${F.DATA}/data/studies/${F.STUDY}/cases`)).body[0];
  const seriesId = (await call(admin, "GET", `${F.DATA}/data/cases/${kase.id}/series`)).body[0].id;
  const card = async (type, title, config, x, y) => {
    const r = await call(admin, "POST", `${F.ADMIN}/admin/studies/${F.STUDY}/workflow/cards`, { type, title, position_x: x, position_y: y, config });
    if (r.status !== 201) throw new Error(`card ${type}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const edge = (src, dst) => call(admin, "POST", `${F.ADMIN}/admin/studies/${F.STUDY}/workflow/edges`, { source_card_id: src, source_handle: "output", target_card_id: dst, target_handle: "input" });
  const browser = await chromium.launch();
  const branches = [];
  const errors = [];
  try {
    const ds = await card("dataset", "e2e compare: one case", { mode: "manual", case_ids: [kase.id] }, X, Y);
    const dup = await card("duplicate", "e2e compare readers", { copies: 2, names: ["Reader 1", "Reader 2"] }, X + 300, Y);
    await edge(ds.id, dup.id);
    await call(admin, "POST", `${F.ADMIN}/admin/workflow-cards/${dup.id}/run`);
    const kids = (await boardNow()).cards.find((c) => c.id === dup.id).materialized_card_ids;
    const jobs = [];
    for (const [i, handle] of ["copy_0", "copy_1"].entries()) {
      const job = await card("annotation", `e2e reader ${i + 1}`, { assigned_user_id: F.ANNOTATOR.subject }, X + 600, Y + i * 200);
      await edge(kids[handle], job.id);
      await call(admin, "POST", `${F.ADMIN}/admin/workflow-cards/${job.id}/run`);
      jobs.push(job);
      branches.push((await call(annot, "GET", `${F.ADMIN}/admin/workflow-cards/${job.id}/surface-config`)).body.branch);
    }
    const cmp = await card("compare", "e2e readers compared", { agree_dice: 0.7 }, X + 900, Y);
    for (const job of jobs) await edge(job.id, cmp.id);

    // two different masks of the same series: reader 2's is reader 1's, shifted
    const main = (await call(annot, "GET", `${F.ANNOTATOR_API}/series/${seriesId}/mask-volume`)).body;
    const voxels = main.mask_gzip_base64 ? zlib.gunzipSync(Buffer.from(main.mask_gzip_base64, "base64")) : null;
    if (!voxels || !main.labels?.length || !main.objects?.length) throw new Error("the fixture series has no segmentation to take its size and fields from");
    const one = Buffer.alloc(voxels.length);
    const two = Buffer.alloc(voxels.length);
    const start = Math.floor(voxels.length / 2);
    one.fill(1, start, start + 4000);
    two.fill(1, start + 2000, start + 6000); // half of each overlaps: Dice 0.5
    // the fixture's own label and object as the template: the payload schema asks for every field
    const label = main.labels[0];
    const object = { ...main.objects[0], id: 1, label_id: label.id };
    const payload = (buf) => ({ study_id: F.STUDY, mask_gzip_base64: zlib.gzipSync(buf).toString("base64"), labels: [label], objects: [object], status: "submitted" });
    for (const [i, buf] of [one, two].entries()) {
      const r = await call(annot, "POST", `${F.ANNOTATOR_API}/series/${seriesId}/mask-volume`, { ...payload(buf), base_version_id: "", branch: branches[i] });
      if (r.status !== 201) throw new Error(`hand-in ${i}: ${r.status} ${JSON.stringify(r.body)}`);
    }

    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
    await ctx.addInitScript(seenGuides);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "platform-admin", "platform-admin", `${F.UI}/studies/${F.STUDY}/workflow`);
    const node = page.locator(`.react-flow__node[data-id="${cmp.id}"]`);
    await node.waitFor({ timeout: 30000 });
    check("before a Run the card says what to do", (await node.locator('[data-testid="compare-run-hint"]').count()) === 1);
    await node.click();
    await page.getByRole("button", { name: "Run compare" }).click();
    await node.locator('[data-testid="compare-pair"]').waitFor({ timeout: 60000 });
    const pairText = await node.locator('[data-testid="compare-pair"]').innerText();
    check("the card shows the pair's Dice", /e2e reader 1 vs e2e reader 2/.test(pairText) && /Dice 0\.50/.test(pairText), pairText);
    check("... and that the case disagrees", /1 disagree/.test(await node.locator('[data-testid="compare-counts"]').innerText()));
    const res = (await boardNow()).cards.find((c) => c.id === cmp.id);
    check("the disagreement is a Dataset of its own", (await boardNow()).cards.find((c) => c.id === res.materialized_card_ids.disagree).config.case_ids.join() === kase.id);

    await page.getByTestId("compare-open-report").click();
    const report = page.getByTestId("compare-report");
    await report.waitFor();
    const row = report.locator('[data-testid="compare-image-row"]');
    check("the report lists the image", (await row.count()) === 1 && /0\.50/.test(await row.innerText()), await row.innerText().catch(() => ""));
    const links = await row.locator("a").evaluateAll((as) => as.map((a) => a.href));
    check("... with each reader's work one click away, on their own job", links.length === 2 && links[0].includes(`jobId=${jobs[0].id}`) && links[1].includes(`jobId=${jobs[1].id}`), links);
    const [csv] = await Promise.all([page.waitForEvent("download"), report.getByTestId("compare-report-csv").click()]);
    const text = require("fs").readFileSync(await csv.path(), "utf8");
    check("the CSV has a row per image and pair", /^﻿?case,series_id,a,b,dice/.test(text) && text.trim().split(/\r?\n/).length === 2 && /e2e reader 1,e2e reader 2,0\.5/.test(text), text.slice(0, 200));
    await page.keyboard.press("Escape");
    // raising the bar moves nothing until the next Run -- then the case agrees
    await page.getByTestId("compare-threshold").fill("0.4");
    await page.getByTestId("compare-threshold").blur();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Run compare" }).click();
    await page.waitForTimeout(2500);
    check("with a lower threshold the same case agrees", /1 agree · 0 disagree/.test(await node.locator('[data-testid="compare-counts"]').innerText()));
    check("no page errors", errors.length === 0, errors.slice(0, 3));
  } finally {
    await browser.close();
    const extra = (await boardNow()).cards.filter((c) => !before.has(c.id));
    for (const c of extra) await call(admin, "DELETE", `${F.ADMIN}/admin/workflow-cards/${c.id}`);
    for (const branch of branches.filter(Boolean)) {
      const rows = (await call(admin, "GET", `${F.ANNOTATIONS}/annotations/series/${seriesId}?branch=${encodeURIComponent(branch)}`)).body || [];
      for (const row of rows.reverse()) await call(admin, "DELETE", `${F.ANNOTATIONS}/annotations/${row.id}`);
    }
  }
  check("the board is left as it was", (await boardNow()).cards.filter((c) => !before.has(c.id)).length === 0);

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
