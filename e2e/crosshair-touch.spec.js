// Moving the crosshair on a tablet: with the Cursor tool a tap puts it
// where the finger was (a double-tap still only resets the zoom), and its
// middle can be grabbed and dragged -- by a finger, or the mouse on a
// desktop; in the viewer and in the tutorial's practice viewer alike. Before, a two-finger tap was the only way, and a hard one to aim.
// Real touch events (CDP Input.dispatchTouchEvent).
const { chromium } = require("playwright");
const { F, token } = require("./helpers");

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

/** The crosshair's middle on screen (x, y), and in the pane's own display
 * square (dx, dy: what moving it changes -- a pan or a zoom reset moves the
 * image, and it with it), from the axial pane's SVG lines. */
async function crosshair(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-testid="crosshair-axial"]');
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const k = r.width / Number(svg.getAttribute("width"));
    const v = svg.querySelector("line"); // the vertical line's first half
    const h = svg.querySelectorAll("line")[2]; // the horizontal line's first half
    const dx = Number(v.getAttribute("x1")), dy = Number(h.getAttribute("y1"));
    return { x: r.left + dx * k, y: r.top + dy * k, dx, dy };
  });
}

async function openViewer(browser, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(() => {
    try {
      for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1");
      localStorage.removeItem("vl.view.layout");
      localStorage.removeItem("vl.viewer.crosshair");
      sessionStorage.setItem("ct.fullscreenDeclined", "1");
    } catch {}
  });
  const page = await ctx.newPage();
  const at = await token("dr-test", "Test1234!");
  const job = (await api(at, `${F.ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const seriesId = (await api(at, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  await page.goto(`${F.VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForSelector('[data-testid="crosshair-axial"]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch();

  // ── a tablet ──
  const { ctx, page } = await openViewer(browser, { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const tap = async (x, y) => { await touch("touchStart", [[x, y]]); await touch("touchEnd", []); };
  // the crosshair lands on a voxel's centre: within one voxel on screen
  // (the fixture's series is small -- a voxel is several pixels)
  const near = (a, b, tol = 10) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
  const same = (a, b) => Math.abs(a.dx - b.dx) < 0.01 && Math.abs(a.dy - b.dy) < 0.01;

  check("the crosshair's middle has a handle to grab on a touch screen", (await page.locator('[data-testid="crosshair-handle-axial"]').count()) === 1);
  const c0 = await crosshair(page);
  const target = { x: c0.x + 70, y: c0.y + 45 };
  await tap(target.x, target.y);
  await page.waitForTimeout(700);
  const c1 = await crosshair(page);
  check("a tap with the Cursor tool puts the crosshair there", near(c1, target), { c0, c1, target });

  // a double-tap resets the zoom and leaves the crosshair alone
  await tap(c1.x - 90, c1.y - 60); await page.waitForTimeout(80); await tap(c1.x - 90, c1.y - 60);
  await page.waitForTimeout(700);
  const afterDouble = await crosshair(page);
  check("... a double-tap doesn't move it (only resets the zoom)", same(afterDouble, c1), { before: c1, after: afterDouble });

  // grab the middle and drag it
  const g = afterDouble; // where it is on screen now
  const to = { x: g.x - 100, y: g.y - 30 };
  await touch("touchStart", [[g.x + 6, g.y + 6]]); // not dead-centre: a finger is a blob
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[g.x + 6 + ((to.x - g.x) * i) / 10, g.y + 6 + ((to.y - g.y) * i) / 10]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(500);
  const c2 = await crosshair(page);
  check("dragging its middle moves it along with the finger", near(c2, { x: to.x + 6, y: to.y + 6 }), { g, c2, to });

  // a drag that doesn't start on it stays a pan (zoom in first so a pan shows)
  await page.locator('[data-testid="pane-axial"]').dispatchEvent("wheel", { deltaY: -400, ctrlKey: true, clientX: c2.x, clientY: c2.y });
  await page.waitForTimeout(500);
  const c3 = await crosshair(page);
  const far = { x: c3.x + 120, y: c3.y + 90 };
  await touch("touchStart", [[far.x, far.y]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[far.x + i * 10, far.y]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(700);
  const c4 = await crosshair(page);
  check("... a drag elsewhere still pans (the crosshair moves with the image, not to the finger)", Math.abs(c4.x - c3.x - 80) <= 6 && Math.abs(c4.y - c3.y) <= 6, { c3, c4 });
  check("no page errors (tablet)", errors.length === 0, errors.slice(0, 3));
  await ctx.close();

  // ── the tutorial's practice viewer: the same on a tablet ──
  {
    const tctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    await tctx.addInitScript(() => { try { sessionStorage.setItem("ct.fullscreenDeclined", "1"); localStorage.removeItem("vl.viewer.crosshair"); } catch {} });
    const tp = await tctx.newPage();
    const terr = []; tp.on("pageerror", (e) => terr.push(e.message));
    await tp.goto(`${F.VIEWER}/tutorial`);
    await tp.waitForSelector("#username", { timeout: 30000 });
    await tp.fill("#username", "dr-test"); await tp.fill("#password", "Test1234!"); await tp.click("#kc-login");
    await tp.waitForSelector('[data-testid="crosshair-axial"]', { timeout: 60000 });
    await tp.waitForTimeout(1000);
    const dialog = tp.locator('[role="dialog"]'); // the tour opens itself the first time
    for (let i = 0; i < 30 && (await dialog.count()) > 0; i++) {
      const next = dialog.locator("[data-guide-next]");
      const txt = await next.innerText().catch(() => "Finish");
      await next.click().catch(() => {}); await tp.waitForTimeout(150);
      if (txt === "Finish") break;
    }
    await tp.waitForTimeout(500);
    const tcdp = await tctx.newCDPSession(tp);
    const ttouch = (type, points) => tcdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    check("tutorial: the crosshair has its handle", (await tp.locator('[data-testid="crosshair-handle-axial"]').count()) === 1);
    const t0 = await crosshair(tp);
    const tt = { x: t0.x + 60, y: t0.y - 40 };
    await ttouch("touchStart", [[tt.x, tt.y]]); await ttouch("touchEnd", []);
    await tp.waitForTimeout(700);
    const t1 = await crosshair(tp);
    check("tutorial: a tap puts it there", near(t1, tt, 14), { t0, t1, tt });
    const tto = { x: t1.x - 80, y: t1.y + 50 };
    await ttouch("touchStart", [[t1.x + 5, t1.y + 5]]);
    for (let i = 1; i <= 10; i++) await ttouch("touchMove", [[t1.x + 5 + ((tto.x - t1.x) * i) / 10, t1.y + 5 + ((tto.y - t1.y) * i) / 10]]);
    await ttouch("touchEnd", []);
    await tp.waitForTimeout(500);
    const t2 = await crosshair(tp);
    check("tutorial: dragging its middle moves it", near(t2, { x: tto.x + 5, y: tto.y + 5 }, 14), { t1, t2, tto });
    check("no page errors (tutorial)", terr.length === 0, terr.slice(0, 3));
    await tctx.close();
  }

  // ── a desktop: the mouse grabs it too ──
  const desk = await openViewer(browser, { viewport: { width: 1400, height: 900 } });
  const d0 = await crosshair(desk.page);
  check("no handle drawn for a mouse", (await desk.page.locator('[data-testid="crosshair-handle-axial"]').count()) === 0);
  await desk.page.mouse.move(d0.x + 3, d0.y + 3);
  await desk.page.mouse.down();
  await desk.page.mouse.move(d0.x + 83, d0.y + 43, { steps: 8 });
  await desk.page.mouse.up();
  await desk.page.waitForTimeout(400);
  const d1 = await crosshair(desk.page);
  check("the mouse drags the crosshair's middle", near(d1, { x: d0.x + 83, y: d0.y + 43 }), { d0, d1 });
  await desk.page.mouse.click(d1.x - 150, d1.y - 100);
  await desk.page.waitForTimeout(500);
  check("... and a plain click still doesn't move it (Ctrl+click does)", same(await crosshair(desk.page), d1));
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
