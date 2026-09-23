// Drives the ct-annotator viewer as an annotator (dr-test) and a reviewer
// (dr-review) against the running stack, checking every tool/button the
// doctors use, and saving cropped screenshots for the in-app guide.
const { chromium } = require("playwright");
const { F } = require("./helpers");
const fs = require("fs");
const ADMIN = "http://localhost:8004", KC = "http://localhost:8080", VIEWER = "http://localhost:5174", UI = "http://localhost:5173";
const ANNOT_CARD = F.ANNOT_CARD, REVIEW_CARD = F.REVIEW_CARD;
const STUDY = F.STUDY;
const SUPPRESS_TOUR = process.env.SUPPRESS_TOUR !== "0";

async function token(user, pass) {
  const r = await fetch(`${KC}/realms/ct-platform/protocol/openid-connect/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: user, password: pass }),
  });
  return (await r.json()).access_token;
}
async function api(tok, url) { const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } }); return r.json(); }

async function login(page, user, pass, url) {
  await page.goto(url);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", user); await page.fill("#password", pass); await page.click("#kc-login");
  await page.waitForURL((u) => !u.href.includes("localhost:8080"), { timeout: 30000 });
}
async function suppressTour(ctx) {
  if (!SUPPRESS_TOUR) return;
  await ctx.addInitScript(() => { try { for (const k of ["vl.guide.annotate.seen","vl.guide.review.seen","vl.guide.workbench.seen","vl.guide.job.seen","vl.guide.case.seen"]) localStorage.setItem(k, "1"); } catch {} });
}
async function shot(loc, name) { try { await loc.screenshot({ path: `guide/${name}.png` }); } catch (e) { console.log("shot failed", name, e.message); } }

async function dragOn(page, pane, from, to, button = "left") {
  const box = await pane.boundingBox();
  const sx = box.x + box.width * from[0], sy = box.y + box.height * from[1];
  const ex = box.x + box.width * to[0], ey = box.y + box.height * to[1];
  await page.mouse.move(sx, sy); await page.mouse.down({ button });
  for (let i = 1; i <= 8; i++) await page.mouse.move(sx + (ex - sx) * i / 8, sy + (ey - sy) * i / 8);
  await page.mouse.up({ button });
}

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

(async () => {
  const t = await token("dr-test", "Test1234!");
  const jobs = await api(t, `${ADMIN}/admin/my-jobs`);
  const job = jobs.find((j) => j.card_id === ANNOT_CARD);
  const pendingCase = job.cases.find((c) => c.status !== "done");
  const series = await api(t, `http://localhost:8002/data/cases/${pendingCase.id}/series`);
  const seriesId = series[0].id;
  console.log("case", pendingCase.title, "series", seriesId);
  const returnUrl = `${UI}/studies/${STUDY}/cases/${pendingCase.id}?jobId=${ANNOT_CARD}`;

  const browser = await chromium.launch();
  // ---------------- annotator ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    await suppressTour(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|401|403|404/.test(m.text())) errors.push(m.text()); });
    await login(page, "dr-test", "Test1234!", `${VIEWER}/viewer/series/${seriesId}?studyId=${STUDY}&caseId=${pendingCase.id}&jobId=${ANNOT_CARD}&returnUrl=${encodeURIComponent(returnUrl)}`);
    await page.waitForSelector("canvas", { timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll("canvas").length >= 3, null, { timeout: 60000 });
    await page.waitForTimeout(4000);
    check("viewer loaded (Viewer title)", (await page.locator("header h1").innerText()) === "Viewer");
    // Status is computed server-side and shown as a read-only badge (no select since round 27).
    check("job status badge present", await page.locator('header [data-guide="job-status"]').count() === 1);
    check("case navigation present", /Case \d+ of \d+/.test(await page.locator("header").innerText()));
    // tools
    const tools = ["cursor","paint","erase","fill","polygon","auto","histogram"];
    const present = {};
    for (const tl of tools) present[tl] = await page.locator(`[data-testid="tool-${tl}"]`).count();
    check("toolbar tools present", Object.values(present).every((n) => n === 1), present);
    // Only meaningful on a case with no objects yet -- a rerun against
    // the same shared fixture case (this spec creates a real object
    // every time it runs) legitimately already has one, so paint is
    // already enabled; skip the "without object" assertion then rather
    // than fail on stale-state, mirroring the labelCount idempotency
    // just below.
    const preExistingObjects = await page.locator('[data-testid^="object-"]').count();
    if (preExistingObjects === 0) {
      check("paint disabled without object", await page.locator('[data-testid="tool-paint"]').isDisabled());
    }
    // add label + object
    const labelCount = await page.locator('[data-testid^="label-"]').count();
    if (labelCount === 0) {
      await page.fill('input[placeholder="New label…"]', "Nodule");
      // The "Add label" button's title lives in a Tip hover tooltip, not
      // a native `title` attribute (Tip.tsx replaces those app-wide) --
      // target the label form's submit button directly instead.
      await page.locator('form:has(input[placeholder="New label…"]) button[type="submit"]').click();
    }
    const firstLabel = page.locator('[data-testid^="label-"]').first();
    const labelId = (await firstLabel.getAttribute("data-testid")).replace("label-", "");
    await page.locator(`[data-testid="add-object-${labelId}"]`).click();
    await page.waitForTimeout(300);
    check("object created", await page.locator('[data-testid^="object-"]').count() >= 1);
    check("paint enabled with object", !(await page.locator('[data-testid="tool-paint"]').isDisabled()));
    // paint on axial pane
    const paneNames = await page.locator("span.uppercase.tracking-wider").allInnerTexts();
    check("panes visible", paneNames.length >= 1, paneNames);
    const axialPane = page.locator('div.flex-shrink-0.flex-col.bg-black:has(span:text-is("Axial")) div.relative.overflow-hidden').first();
    if (!(await axialPane.count())) throw new Error("no axial pane; panes=" + paneNames.join(","));
    await page.locator('[data-testid="tool-paint"]').click();
    await dragOn(page, axialPane, [0.45, 0.45], [0.55, 0.55]);
    await page.waitForTimeout(300);
    const footer = await page.locator("div.bg-black\\/60").innerText();
    check("paint hint in footer", /Paint/.test(footer), footer);
    // undo / redo
    // IconButton exposes its title as aria-label; the shortcut lives in the tooltip.
    await page.locator('button[aria-label="Undo"]').click();
    await page.locator('button[aria-label="Redo"]').click();
    check("undo/redo clickable", true);
    // erase
    await page.locator('[data-testid="tool-erase"]').click();
    await dragOn(page, axialPane, [0.5, 0.5], [0.52, 0.52]);
    // polygon: 3 clicks + close
    await page.locator('[data-testid="tool-polygon"]').click();
    const box = await axialPane.boundingBox();
    const pts = [[0.4,0.4],[0.5,0.38],[0.5,0.5],[0.4,0.5]];
    for (const p of pts) await page.mouse.click(box.x + box.width*p[0], box.y + box.height*p[1]);
    await page.mouse.click(box.x + box.width*0.4, box.y + box.height*0.4);
    await page.waitForTimeout(300);
    check("polygon hint", /Polygon/.test(await page.locator("div.bg-black\\/60").innerText()));
    // auto contour
    await page.locator('[data-testid="tool-auto"]').click();
    await dragOn(page, axialPane, [0.3, 0.3], [0.6, 0.6]);
    await page.waitForTimeout(1500);
    const autoPanel = await page.getByText(/tolerance/i).count();
    check("auto contour panel opens", autoPanel > 0, autoPanel);
    await page.keyboard.press("Escape");
    // histogram
    await page.locator('[data-testid="tool-histogram"]').click();
    await dragOn(page, axialPane, [0.3, 0.3], [0.6, 0.6]);
    await page.waitForTimeout(1500);
    check("histogram panel opens", (await page.getByText(/HU/).count()) > 0);
    await page.keyboard.press("Escape");
    // window presets
    const presets = page.locator("aside button", { hasText: /Lung|Bone|Soft|Brain/ });
    check("window presets", (await presets.count()) >= 2, await presets.allInnerTexts());
    await presets.first().click();
    // new instance via header button
    await page.locator('[data-testid="new-instance-button"]').click();
    check("new instance via header", (await page.locator('[data-testid^="object-"]').count()) >= 2);
    // Many nodules scroll inside a fixed-height list instead of stretching
    // the sidebar -- the screen keeps one layout whatever the case holds.
    const listBox = await page.locator('[data-testid="objects-scroll"]').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { overflowY: cs.overflowY, maxHeight: cs.maxHeight };
    });
    check("the object list has a fixed height and scrolls", listBox.overflowY === "auto" && /^\d+(\.\d+)?px$/.test(listBox.maxHeight), listBox);
    // comment via right-click on the painted voxel (view tool)
    await page.locator('[data-testid="tool-cursor"]').click();
    await page.locator('[data-testid^="object-"]').first().click();
    // hide/lock toggles
    const obj = (await page.locator('[data-testid^="object-"]').first().getAttribute("data-testid")).replace("object-", "");
    await page.locator(`[data-testid="hide-${obj}"]`).click(); await page.locator(`[data-testid="hide-${obj}"]`).click();
    await page.locator(`[data-testid="lock-${obj}"]`).click(); await page.locator(`[data-testid="lock-${obj}"]`).click();
    check("hide/lock toggles", true);
    // documents dropdown
    await page.locator('header button', { hasText: /^Documents/ }).click();
    await page.waitForTimeout(800);
    check("documents dropdown", (await page.locator("header ul li, header p").count()) > 0);
    await page.locator('header button', { hasText: /^Documents/ }).click();
    // screenshots for the guide (annotator)
    await page.locator('[data-testid="tool-paint"]').click();
    await page.waitForTimeout(300);
    await shot(page, "viewer-annotate");
    await shot(page.locator("header"), "viewer-header");
    await shot(page.locator("div.w-12.flex-shrink-0"), "viewer-toolbar");
    await shot(page.locator("aside > div").first(), "viewer-objects");
    await shot(page.locator("aside"), "viewer-sidebar");
    await shot(page.locator("div.bg-black\\/60"), "viewer-footer");
    await shot(page.locator("header > div").last(), "viewer-header-actions");
    // save draft
    await page.locator("header button", { hasText: /^Save$/ }).click();
    await page.waitForTimeout(2500);
    const hdr = await page.locator("header").innerText();
    check("save draft feedback", /Saved|saved/.test(hdr), hdr.slice(-80));
    // Mark as Annotated (submits for review)
    await page.locator("header button", { hasText: "Mark as Annotated" }).click();
    await page.waitForTimeout(3000);
    check("mark as annotated feedback", /Saved|saved|Annotated/.test(await page.locator("header").innerText()));
    // back link
    check("back link points to case page", (await page.locator("header a").first().getAttribute("href")).includes("/cases/"));
    check("annotator: no console errors", errors.length === 0, errors.slice(0, 5));
    await ctx.close();
  }
  // ---------------- reviewer ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    await suppressTour(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|401|403|404/.test(m.text())) errors.push(m.text()); });
    const rt = await token("dr-review", "Test1234!");
    const rjobs = await api(rt, `${ADMIN}/admin/my-jobs`);
    const rjob = rjobs.find((j) => j.card_id === REVIEW_CARD);
    const awaiting = rjob.cases.find((c) => c.pending_annotation_id);
    check("reviewer sees the submitted case awaiting review", Boolean(awaiting), rjob.cases.map((c) => [c.title, c.status, c.pending_annotation_id]));
    const rReturn = `${UI}/studies/${STUDY}/cases/${pendingCase.id}?jobId=${REVIEW_CARD}`;
    await login(page, "dr-review", "Test1234!", `${VIEWER}/viewer/series/${seriesId}?studyId=${STUDY}&caseId=${pendingCase.id}&jobId=${REVIEW_CARD}&returnUrl=${encodeURIComponent(rReturn)}`);
    await page.waitForFunction(() => document.querySelectorAll("canvas").length >= 3, null, { timeout: 60000 });
    await page.waitForTimeout(4000);
    check("review mode title", (await page.locator("header h1").innerText()) === "Review");
    check("no toolbar in review", (await page.locator('[data-testid="tool-paint"]').count()) === 0);
    const revObjects = await page.locator("aside li").count();
    check("review objects listed", revObjects >= 1, revObjects);
    check("submit disabled until decided", await page.locator("header button", { hasText: "Submit review" }).isDisabled());
    await shot(page, "viewer-review");
    await shot(page.locator("aside > div").first(), "viewer-review-card");
    await shot(page.locator("aside > div").nth(1), "viewer-review-objects");
    // comment + reject first, accept the rest
    await page.fill('textarea[placeholder="Comment for the annotator…"]', "Boundary too generous on the medial side.");
    await page.locator("aside button", { hasText: "Reject" }).click();
    await page.waitForTimeout(300);
    // tag why -- the reason travels with the saved objects (the annotation
    // type's schema must allow it) and into the annotator's comment
    await page.locator('[data-testid="reject-reason-boundary"]').click();
    await page.waitForTimeout(200);
    // See viewas-viewer.spec.js's comment: bound generously and check
    // the count first, since a real job can have many objects to decide.
    let guard = 0;
    while (await page.locator("header button", { hasText: "Submit review" }).isDisabled() && guard++ < 60) {
      if ((await page.locator("aside button", { hasText: "Accept" }).count()) === 0) break;
      await page.locator("aside button", { hasText: "Accept" }).first().click();
      await page.waitForTimeout(300);
    }
    check("all objects decided", !(await page.locator("header button", { hasText: "Submit review" }).isDisabled()));
    await page.locator("header button", { hasText: "Submit review" }).click();
    await page.waitForTimeout(3000);
    const after = await api(await token("dr-test", "Test1234!"), `${ADMIN}/admin/my-jobs`);
    const c2 = after.find((j) => j.card_id === ANNOT_CARD).cases.find((c) => c.id === pendingCase.id);
    check("case bounced back to annotator as rejected with comment", c2.status === "rejected" && /medial/.test(c2.latest_review_comment || ""), c2);
    check("the tagged reason is in the comment the annotator reads", /\(boundary off\)/.test(c2.latest_review_comment || ""), c2.latest_review_comment);
    check("reviewer: no console errors", errors.length === 0, errors.slice(0, 5));
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync("viewer-results.json", JSON.stringify(results, null, 1));
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra));
})().catch((e) => { console.error("EXC", e); process.exit(1); });
