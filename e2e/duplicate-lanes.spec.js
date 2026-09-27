// A Duplicate card: the same case down two lanes, each annotated apart.
// Builds Dataset (one case) -> Duplicate -> an Annotation job per copy on
// the fixture study's board, paints and saves in copy A's job in the real
// viewer, and checks copy B's job opens that same image empty -- its own
// branch -- while A reopens with its work; the main chain is untouched.
// Everything it adds (cards, the branch versions) is removed at the end.
const { chromium } = require("playwright");
const { F, token } = require("./helpers");

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
const ANNOTATOR_API = F.ANNOTATOR_API;

async function call(tok, method, url, body) {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function openJob(browser, seriesId, caseId, jobId) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); localStorage.removeItem("vl.view.layout"); } catch {} });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.goto(`${F.VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${caseId}&jobId=${jobId}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  return { ctx, page };
}

(async () => {
  const admin = await token("platform-admin", "platform-admin");
  const annot = await token("dr-test", "Test1234!");
  const cases = (await call(admin, "GET", `${F.DATA}/data/studies/${F.STUDY}/cases`)).body;
  const kase = cases[0];
  const seriesId = (await call(admin, "GET", `${F.DATA}/data/cases/${kase.id}/series`)).body[0].id;
  const made = [];
  const card = async (type, title, config, x, y) => {
    const r = await call(admin, "POST", `${F.ADMIN}/admin/studies/${F.STUDY}/workflow/cards`, { type, title, position_x: x, position_y: y, config });
    if (r.status !== 201) throw new Error(`card ${type}: ${r.status} ${JSON.stringify(r.body)}`);
    made.push(r.body.id);
    return r.body;
  };
  const edge = (src, dst) => call(admin, "POST", `${F.ADMIN}/admin/studies/${F.STUDY}/workflow/edges`, { source_card_id: src, source_handle: "output", target_card_id: dst, target_handle: "input" });
  const browser = await chromium.launch();
  let branchA = null, branchB = null;
  try {
    const ds = await card("dataset", "e2e dup: one case", { mode: "manual", case_ids: [kase.id] }, 4000, 4000);
    const dup = await card("duplicate", "e2e dup", { copies: 2 }, 4300, 4000);
    await edge(ds.id, dup.id);
    check("the Duplicate runs", (await call(admin, "POST", `${F.ADMIN}/admin/workflow-cards/${dup.id}/run`)).status === 200);
    const board = (await call(admin, "GET", `${F.ADMIN}/admin/studies/${F.STUDY}/workflow`)).body;
    const kids = board.cards.find((c) => c.id === dup.id).materialized_card_ids || {};
    made.push(...Object.values(kids));
    check("... into two copies, each with the case", Object.keys(kids).sort().join() === "copy_0,copy_1" && Object.values(kids).every((id) => (board.cards.find((c) => c.id === id).config.case_ids || []).includes(kase.id)), kids);
    const jobs = [];
    for (const [i, handle] of ["copy_0", "copy_1"].entries()) {
      const job = await card("annotation", `e2e dup job ${"AB"[i]}`, { assigned_user_id: F.ANNOTATOR.subject, labels: ["Nodule"] }, 4600, 4000 + i * 200);
      await edge(kids[handle], job.id);
      await call(admin, "POST", `${F.ADMIN}/admin/workflow-cards/${job.id}/run`);
      jobs.push(job);
    }
    branchA = (await call(annot, "GET", `${F.ADMIN}/admin/workflow-cards/${jobs[0].id}/surface-config`)).body.branch;
    branchB = (await call(annot, "GET", `${F.ADMIN}/admin/workflow-cards/${jobs[1].id}/surface-config`)).body.branch;
    check("each copy's job has its own branch", branchA && branchB && branchA !== branchB, { branchA, branchB });
    const mainBefore = (await call(annot, "GET", `${ANNOTATOR_API}/series/${seriesId}/mask-volume`)).body.version_id;

    // copy A: add an object, paint, save -- in the real viewer
    {
      const { ctx, page } = await openJob(browser, seriesId, kase.id, jobs[0].id);
      const label = page.locator('[data-testid^="label-"]').first();
      if (!(await label.count())) {
        await page.fill('input[placeholder="New label…"]', "Nodule");
        await page.locator('form:has(input[placeholder="New label…"]) button[type="submit"]').click();
      }
      const labelId = (await page.locator('[data-testid^="label-"]').first().getAttribute("data-testid")).replace("label-", "");
      await page.locator(`[data-testid="add-object-${labelId}"]`).click();
      await page.locator('[data-testid="tool-paint"]').click();
      const pane = page.locator('[data-testid="pane-axial"]');
      const box = await pane.boundingBox();
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45); await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * (0.45 + i * 0.01), box.y + box.height * (0.45 + i * 0.01));
      await page.mouse.up();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForTimeout(2500);
      await ctx.close();
    }
    const onA = (await call(annot, "GET", `${ANNOTATOR_API}/series/${seriesId}/mask-volume?branch=${encodeURIComponent(branchA)}`)).body;
    check("copy A's save is on copy A's branch", onA.version_id && onA.objects.length >= 1, { version: onA.version_id, objects: onA.objects?.length });
    const onB = (await call(annot, "GET", `${ANNOTATOR_API}/series/${seriesId}/mask-volume?branch=${encodeURIComponent(branchB)}`)).body;
    check("... not on copy B's", onB.version_id === null, onB.version_id);
    const main = (await call(annot, "GET", `${ANNOTATOR_API}/series/${seriesId}/mask-volume`)).body;
    check("... nor on the main chain", main.version_id === mainBefore, { mainBefore, now: main.version_id });

    // copy B's job opens the same image with nothing on it
    {
      const { ctx, page } = await openJob(browser, seriesId, kase.id, jobs[1].id);
      check("copy B's job opens the image empty -- its own branch", (await page.locator('[data-testid^="object-"]').count()) === 0);
      await ctx.close();
    }
    // copy A's job reopens with its object
    {
      const { ctx, page } = await openJob(browser, seriesId, kase.id, jobs[0].id);
      check("copy A's job reopens with its work", (await page.locator('[data-testid^="object-"]').count()) >= 1);
      await ctx.close();
    }
  } finally {
    await browser.close();
    // leave the fixture board and the image as they were
    for (const id of made.reverse()) await call(admin, "DELETE", `${F.ADMIN}/admin/workflow-cards/${id}`);
    for (const branch of [branchA, branchB].filter(Boolean)) {
      const rows = (await call(admin, "GET", `${F.ANNOTATIONS}/annotations/series/${seriesId}?branch=${encodeURIComponent(branch)}`)).body || [];
      for (const row of rows.reverse()) await call(admin, "DELETE", `${F.ANNOTATIONS}/annotations/${row.id}`);
    }
  }

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
