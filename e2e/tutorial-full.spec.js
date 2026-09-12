const { chromium } = require("playwright");
// login is the shared dual-path helper: admin-ui shows its own sign-in
// form, while the viewer opened directly still shows Keycloak's.
const { F, login } = require("./helpers");
const UI = "http://localhost:5173", VIEWER = "http://localhost:5174";
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });
async function closeTour(page) {
  const dialog = page.locator('[role="dialog"]');
  for (let i = 0; i < 25 && (await dialog.count()) > 0; i++) {
    const next = dialog.locator("[data-guide-next]");
    const txt = await next.innerText();
    await next.click(); await page.waitForTimeout(150);
    if (txt === "Finish") break;
  }
}
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));

  // My Jobs card
  await login(page, "dr-test", "Test1234!", `${UI}/my-jobs`); await page.waitForTimeout(1200);
  const card = page.locator("a", { hasText: "Tutorial job" });
  check("my-jobs: tutorial card present", (await card.count()) === 1);
  const cardClass = await card.getAttribute("class");
  check("my-jobs: tutorial card is amber-themed (distinct color)", /amber/.test(cardClass ?? ""), cardClass);
  check("my-jobs: card opens in new tab (target=_blank)", (await card.getAttribute("target")) === "_blank");
  await page.screenshot({ path: "tutorial-myjobs-card.png" });

  // Open the tutorial (annotate)
  const href = await card.getAttribute("href");
  const t = await ctx.newPage(); const terr = []; t.on("pageerror", (e) => terr.push(e.message));
  await t.goto(href); await t.waitForSelector('canvas', { timeout: 15000 }); await t.waitForTimeout(1200);
  check("tutorial: guide auto-opens on entry", (await t.locator('[role="dialog"]').count()) === 1);
  await closeTour(t);
  check("tutorial: header shows Practice badge", /PRACTICE/.test(await t.locator("header").innerText()));

  // annotate: an instance is pre-seeded and active by default now -- no
  // need to click + before painting.
  check("tutorial: default instance pre-seeded and active", (await t.locator("aside li").count()) === 1 && /Active: Structure 1/.test(await t.locator('[data-guide="footer"]').innerText()));
  // find the nodule: scroll to the middle slice, use Fill
  await t.locator('[data-guide="pane-sliders"] input[type="range"]').last().fill("20"); // the axial slider is last (Sagittal, Coronal, Axial order)
  await t.waitForTimeout(300);
  await t.locator('[data-guide="tool-fill"]').click();
  const canvas = t.locator('[data-guide="panes"] canvas').last(); // axial is last
  const box = await canvas.boundingBox();
  // click near the nodule position (slightly right and up from center, matching NODULE_CX/CY)
  await t.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.46);
  await t.waitForTimeout(400);
  check("tutorial: Mark as Practice-Annotated enabled after painting", !(await t.locator("header button", { hasText: "Mark as Practice-Annotated" }).isDisabled()));
  await t.screenshot({ path: "tutorial-3-painted.png" });

  // window presets change appearance
  await t.locator("aside button", { hasText: "Lung" }).click(); await t.waitForTimeout(200);
  check("tutorial: Lung preset selectable", (await t.locator("aside button.border-amber-500", { hasText: "Lung" }).count()) === 1);

  // undo (the dedicated Undo button inside the undo-redo group, not the "?" Tutorial button) --
  // reverts the fill, so Mark as Practice-Annotated should go back to disabled.
  await t.locator('header [data-guide="undo-redo"] button').first().click();
  await t.waitForTimeout(200);
  check("tutorial: undo actually reverts (button disables again)", await t.locator("header button", { hasText: "Mark as Practice-Annotated" }).isDisabled());
  // repaint so the rest of the walkthrough can proceed
  await t.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.46);
  await t.waitForTimeout(300);

  // hand in -> review phase, guide reopens
  await t.locator("header button", { hasText: "Mark as Practice-Annotated" }).click(); await t.waitForTimeout(500);
  check("tutorial: transitions to Review phase", /Tutorial · Review/.test(await t.locator("header").innerText()));
  check("tutorial: guide auto-reopens for Review phase", (await t.locator('[role="dialog"]').count()) === 1);
  await closeTour(t);
  await t.screenshot({ path: "tutorial-4-review.png" });

  // decide and submit
  const acceptBtns = t.locator("aside button", { hasText: "Accept" });
  let guard = 0;
  while (await t.locator("header button", { hasText: "Submit review" }).isDisabled() && guard++ < 6) {
    await acceptBtns.click(); await t.waitForTimeout(200);
  }
  check("tutorial: submit review enabled once decided", !(await t.locator("header button", { hasText: "Submit review" }).isDisabled()));
  await t.locator("header button", { hasText: "Submit review" }).click(); await t.waitForTimeout(400);
  check("tutorial: completion screen shown", /Tutorial complete/.test(await t.locator("h1").innerText()));
  await t.screenshot({ path: "tutorial-5-done.png" });

  // replay resets and reopens the guide
  await t.locator("button", { hasText: "Replay the tutorial" }).click(); await t.waitForTimeout(500);
  check("tutorial: replay returns to Annotate phase", /Tutorial · Annotate/.test(await t.locator("header").innerText()));
  check("tutorial: replay reopens the guide", (await t.locator('[role="dialog"]').count()) === 1);
  await closeTour(t);

  // direct entry in review mode seeds demo objects
  const t2 = await ctx.newPage(); const t2err = [];
  t2.on("pageerror", (e) => t2err.push(e.message));
  await t2.goto(`${VIEWER}/tutorial?mode=review`); await t2.waitForSelector('canvas', { timeout: 15000 }); await t2.waitForTimeout(1200);
  check("tutorial ?mode=review: lands in Review phase", /Tutorial · Review/.test(await t2.locator("header").innerText()));
  check("tutorial ?mode=review: guide auto-opens", (await t2.locator('[role="dialog"]').count()) === 1);
  await closeTour(t2);
  check("tutorial ?mode=review: 2 demo objects seeded", (await t2.locator("aside", { hasText: "Objects" }).locator("li").count()) === 2);
  await t2.screenshot({ path: "tutorial-6-direct-review.png" });

  check("no console/page errors (my-jobs)", errors.length === 0, errors);
  check("no console/page errors (tutorial annotate tab)", terr.length === 0, terr);
  check("no console/page errors (tutorial review-mode tab)", t2err.length === 0, t2err);

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra).slice(0, 300));
})().catch((e) => { console.error("EXC", e.message); for (const r of results) console.log(r.ok ? "ok  " : "FAIL", r.n); process.exit(1); });
