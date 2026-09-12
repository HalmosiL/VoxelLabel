// Admin walks the viewer via "View as": the mode travels admin-ui -> viewer
// (URL) and back (Back link). Reviewer is a strict subset of Annotator,
// so only Reviewer forces its chrome regardless of the job's real card
// type; Annotator never overrides a real Review job (see ViewerPage.tsx's
// own comment on `reviewMode`). Non-admins never see the tabs.
const { chromium } = require("playwright");
const { F } = require("./helpers");
const ADMIN = "http://localhost:8004", KC = "http://localhost:8080", VIEWER = "http://localhost:5174", UI = "http://localhost:5173";
const ANNOT_CARD = F.ANNOT_CARD, REVIEW_CARD = F.REVIEW_CARD, STUDY = F.STUDY;
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });
async function token(u, p) { const r = await fetch(`${KC}/realms/ct-platform/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: u, password: p }) }); return (await r.json()).access_token; }
async function api(t, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${t}` } })).json(); }
// admin-ui (:5173) shows its own AuthPage now instead of redirecting to
// Keycloak's hosted login (see main.tsx) -- ct-annotator (:5174) still
// does, unchanged. Wait for whichever one actually shows up.
async function login(page, user, pass, url) {
  await page.goto(url);
  await Promise.race([
    page.waitForSelector("#username", { timeout: 30000 }),
    page.waitForSelector('[data-testid="signin-submit"]', { timeout: 30000 }),
  ]);
  if (await page.locator('[data-testid="signin-submit"]').isVisible().catch(() => false)) {
    await page.fill('input[autocomplete="username"]', user);
    await page.fill('input[type="password"]', pass);
    await page.click('[data-testid="signin-submit"]');
  } else {
    await page.fill("#username", user);
    await page.fill("#password", pass);
    await page.click("#kc-login");
  }
  await page.waitForURL((u) => !u.href.includes("localhost:8080"), { timeout: 30000 });
}
// Only the guide "seen" flags are pre-set here -- vl.viewAs is left alone
// so the choice made mid-test actually survives a hard reload (a real
// bug this exposed: an earlier version of this script cleared it on
// every navigation, which looked exactly like the product not persisting).
const seenGuides = () => { try { for (const k of ["workbench","job","case","annotate","review","studies","study","patients","patient","annotation-types","deidentification","users","notifications","system","board"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} };
const waitViewer = async (p) => { await p.waitForFunction(() => document.querySelectorAll("canvas").length >= 1, null, { timeout: 60000 }); await p.waitForTimeout(3000); };
(async () => {
  const t = await token("dr-test", "Test1234!");
  const annotJob = (await api(t, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === ANNOT_CARD);
  const kase = annotJob.cases.find((c) => c.status !== "done");
  const series = (await api(t, `http://localhost:8002/data/cases/${kase.id}/series`))[0].id;
  const rt = await token("dr-review", "Test1234!");
  const revJob = (await api(rt, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === REVIEW_CARD);
  const revCase = revJob.cases.find((c) => c.pending_annotation_id) ?? revJob.cases[0];
  const revSeries = (await api(rt, `http://localhost:8002/data/cases/${revCase.id}/series`))[0].id;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  // addInitScript reruns on every navigation in this context, so a
  // "clear vl.viewAs" placed there would also fire on every later
  // page.goto and erase the very choice this test is checking survives
  // a reload -- clear it exactly once instead, right after first login.
  await ctx.addInitScript(seenGuides);
  const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));

  // admin-ui: choose Annotator, open an Annotation job's case, read the viewer link
  await login(page, "platform-admin", "platform-admin", `${UI}/studies`); await page.waitForTimeout(1000);
  await page.evaluate(() => { try { localStorage.removeItem("vl.viewAs"); } catch {} });
  await page.reload(); await page.waitForTimeout(1000);
  await page.locator('[data-testid="view-as"] [role="tab"]', { hasText: "Annotator" }).click(); await page.waitForTimeout(800);
  await page.goto(`${UI}/studies/${STUDY}/cases/${kase.id}?jobId=${ANNOT_CARD}`); await page.waitForTimeout(2500);
  const href = await page.locator('[data-guide="open-viewer"]').getAttribute("href");
  check("admin-ui: viewer link carries viewAs=annotator", /viewAs=annotator/.test(href), href);

  const v = await ctx.newPage(); const verr = []; v.on("pageerror", (e) => verr.push(e.message));
  await v.goto(href); await waitViewer(v);
  const tabs = v.locator('header [data-testid="view-as"]');
  check("viewer: tabs shown for admin", (await tabs.count()) === 1);
  { const all = await tabs.locator('[role="tab"]').evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute("aria-selected")]));
    check("viewer: Annotator selected from URL", all.find((x) => x[1] === "true")?.[0] === "Annotator", all); }
  check("viewer: annotation card + Annotator = annotate surface", (await v.locator("header h1").innerText()) === "Viewer" && (await v.locator('[data-testid="tool-paint"]').count()) === 1);

  // Override the other way on the SAME (Annotation) card: force Reviewer.
  await tabs.locator('[role="tab"]', { hasText: "Reviewer" }).click(); await v.waitForTimeout(600);
  check("viewer: annotation card + Reviewer override = review chrome", (await v.locator("header h1").innerText()) === "Review" && (await v.locator('[data-testid="tool-paint"]').count()) === 0);
  await v.screenshot({ path: "viewas-viewer-forced-review.png" });

  // Back to Annotator, draw a stroke to prove the toolbar actually works, not just renders.
  await tabs.locator('[role="tab"]', { hasText: "Annotator" }).click(); await v.waitForTimeout(600);
  const labelCount = await v.locator('[data-testid^="label-"]').count();
  if (labelCount === 0) { await v.fill('input[placeholder="New label…"]', "Nodule"); await v.locator('form button[type="submit"]').first().click(); }
  const labelId = (await v.locator('[data-testid^="label-"]').first().getAttribute("data-testid")).replace("label-", "");
  await v.locator(`[data-testid="add-object-${labelId}"]`).click();
  await v.locator('[data-testid="tool-paint"]').click();
  const pane = v.locator('div.flex-shrink-0.flex-col.bg-black:has(span:text-is("Axial")) div.relative.overflow-hidden').first();
  const b = await pane.boundingBox();
  await v.mouse.move(b.x + b.width * 0.45, b.y + b.height * 0.45); await v.mouse.down(); await v.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5, { steps: 6 }); await v.mouse.up();
  await v.locator("header button", { hasText: /^Save$/ }).click(); await v.waitForTimeout(2000);
  check("viewer: draft save works under the override", /Saved|saved/.test(await v.locator("header").innerText()));

  // Back link carries the mode; admin-ui picks it up on a fresh load.
  const back = await v.locator('[data-guide="back"]').getAttribute("href");
  check("viewer: Back link carries viewAs", /viewAs=annotator/.test(back), back);
  await v.reload(); await waitViewer(v);
  check("viewer: mode survives reload (own storage)", (await v.locator('header [data-testid="view-as"] [aria-selected="true"]').innerText()) === "Annotator");
  await page.goto(back); await page.waitForTimeout(1500);
  check("admin-ui: mode taken from the returned URL", (await page.locator("aside").count()) === 0 && (await page.locator('[data-testid="view-as"] [aria-selected="true"]').innerText()) === "Annotator");

  // Now the REAL review job, opened normally as Reviewer -- the actual round trip.
  await page.locator('[data-testid="view-as"] [role="tab"]', { hasText: "Admin" }).click(); await page.waitForTimeout(600);
  await page.locator('[data-testid="view-as"] [role="tab"]', { hasText: "Reviewer" }).click(); await page.waitForTimeout(600);
  check("admin-ui: Reviewer -> workbench, /my-jobs", page.url().endsWith("/my-jobs"));
  await v.goto(`${VIEWER}/viewer/series/${revSeries}?studyId=${STUDY}&caseId=${revCase.id}&jobId=${REVIEW_CARD}&viewAs=reviewer`); await waitViewer(v);
  check("viewer: real review job + Reviewer = review chrome", (await v.locator("header h1").innerText()) === "Review");
  const hasObjects = (await v.locator("aside button", { hasText: "Accept" }).count()) === 1;
  check("viewer: review card renders with the pending annotation's objects", hasObjects);
  if (hasObjects) {
    let guard = 0;
    while (await v.locator("header button", { hasText: "Submit review" }).isDisabled() && guard++ < 10) {
      await v.locator("aside button", { hasText: "Accept" }).click(); await v.waitForTimeout(250);
    }
    check("viewer: submit review enabled once every object is decided", !(await v.locator("header button", { hasText: "Submit review" }).isDisabled()));
    await v.locator("header button", { hasText: "Submit review" }).click(); await v.waitForTimeout(2500);
    const after = (await api(rt, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === REVIEW_CARD).cases.find((c) => c.id === revCase.id);
    check("viewer: review actually recorded (case no longer pending)", after.status !== "pending" || !after.pending_annotation_id, after);
  }
  await v.screenshot({ path: "viewas-viewer-review.png" });

  // Reviewer is a strict subset of Annotator: switching to Annotator on
  // a REAL review job must NOT force the annotate surface on top of it
  // (that would misrepresent what a real annotator sees when one of
  // their own review assignments opens) -- the job's real type still
  // decides, so this stays on the review chrome.
  await v.locator('header [data-testid="view-as"] [role="tab"]', { hasText: "Annotator" }).click(); await v.waitForTimeout(600);
  check("viewer: review card + Annotator = still review chrome (no forced override)", (await v.locator("header h1").innerText()) === "Review" && (await v.locator('[data-testid="tool-paint"]').count()) === 0);

  // Picker shows tabs for admin.
  await v.goto(`${VIEWER}/`); await v.waitForTimeout(1500);
  check("picker: tabs for admin", (await v.locator('[data-testid="view-as"]').count()) === 1);
  check("admin: no page errors", errors.length === 0 && verr.length === 0, [...errors, ...verr]);
  await ctx.close();

  // Non-admin: no tabs anywhere, and a viewAs in the URL is simply ignored.
  const c2 = await browser.newContext({ viewport: { width: 1600, height: 950 } }); await c2.addInitScript(seenGuides);
  const p2 = await c2.newPage();
  await login(p2, "dr-test", "Test1234!", `${VIEWER}/viewer/series/${series}?studyId=${STUDY}&caseId=${kase.id}&jobId=${ANNOT_CARD}&viewAs=reviewer`); await waitViewer(p2);
  check("dr-test: no tabs, viewAs=reviewer ignored (still Viewer)", (await p2.locator('[data-testid="view-as"]').count()) === 0 && (await p2.locator("header h1").innerText()) === "Viewer");
  await c2.close(); await browser.close();

  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra).slice(0, 300));
})().catch((e) => { console.error("EXC", e.message.split("\n")[0]); for (const r of results) console.log(r.ok ? "ok  " : "FAIL", r.n); process.exit(1); });
