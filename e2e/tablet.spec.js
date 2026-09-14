// Tablet: every surface at iPad sizes with touch as the only input.
// Emulates a real touch device (pointer: coarse, hover: none, touch
// events through CDP -- multi-touch included) in both orientations and
// checks the things a mouse never needed: no sideways page scrolling,
// finger-sized targets, the sidebar/side panels as drawers, hover-only
// controls visible, cards added to the board by tap, and on the viewer
// one-finger drawing, pinch zoom, double-tap reset, long-press HU and
// two-finger-tap navigation.
const { chromium } = require("playwright");
const { F, seenGuides } = require("./helpers");
const UI = F.UI, VIEWER = F.VIEWER, ADMIN = F.ADMIN;
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });

async function login(page, user, pass, url) {
  await page.goto(url);
  await Promise.race([page.waitForSelector("#username", { timeout: 30000 }), page.waitForSelector('[data-testid="signin-submit"]', { timeout: 30000 })]);
  if (await page.locator('[data-testid="signin-submit"]').isVisible().catch(() => false)) {
    await page.fill('input[autocomplete="username"]', user); await page.fill('input[type="password"]', pass); await page.click('[data-testid="signin-submit"]');
  } else {
    await page.fill("#username", user); await page.fill("#password", pass); await page.click("#kc-login");
  }
  await page.waitForURL((u) => !u.href.includes("localhost:8080"), { timeout: 30000 });
}
async function token(u, p) {
  const r = await fetch(`${F.KC}/realms/ct-platform/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: u, password: p, scope: "openid" }) });
  return (await r.json()).access_token;
}
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);
const isCoarse = (page) => page.evaluate(() => window.matchMedia("(pointer: coarse)").matches && window.matchMedia("(hover: none)").matches);

// Real touch events via CDP (page.touchscreen only does single taps).
class Touch {
  constructor(page) { this.page = page; }
  async init() { this.cdp = await this.page.context().newCDPSession(this.page); }
  async raw(type, pts) { await this.cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })) }); }
  async drag(from, to, steps = 12, holdMs = 0) {
    await this.raw("touchStart", [from]); if (holdMs) await this.page.waitForTimeout(holdMs);
    for (let i = 1; i <= steps; i++) { await this.raw("touchMove", [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]); await this.page.waitForTimeout(16); }
    await this.raw("touchEnd", []);
  }
  async longPress(p, ms = 700) { await this.raw("touchStart", [p]); await this.page.waitForTimeout(ms); await this.raw("touchEnd", []); }
  async doubleTap(p) { for (let i = 0; i < 2; i++) { await this.raw("touchStart", [p]); await this.page.waitForTimeout(40); await this.raw("touchEnd", []); await this.page.waitForTimeout(90); } }
  async twoFingerTap(c, gap = 60) { const a = { x: c.x - gap, y: c.y, id: 0 }, b = { x: c.x + gap, y: c.y, id: 1 }; await this.raw("touchStart", [a, b]); await this.page.waitForTimeout(80); await this.raw("touchEnd", []); }
  async pinch(c, from, to, steps = 10) {
    const pts = (d) => [{ x: c.x - d, y: c.y, id: 0 }, { x: c.x + d, y: c.y, id: 1 }];
    await this.raw("touchStart", pts(from));
    for (let i = 1; i <= steps; i++) { await this.raw("touchMove", pts(from + ((to - from) * i) / steps)); await this.page.waitForTimeout(16); }
    await this.raw("touchEnd", []);
  }
}
const center = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }; };

async function tabletContext(browser, landscape) {
  const ctx = await browser.newContext({ viewport: landscape ? { width: 1024, height: 768 } : { width: 768, height: 1024 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(seenGuides);
  // The viewer goes fullscreen on the first touch of a touch screen;
  // keep the emulated viewport as it is for deterministic geometry.
  await ctx.addInitScript(() => { try { sessionStorage.setItem("ct.fullscreenDeclined", "1"); } catch {} });
  return ctx;
}

(async () => {
  // These specs drive the local stack directly (localhost ports, a
  // locally issued token). While the ngrok launcher is running, the
  // backends validate tokens against the tunnel's issuer instead and
  // every API call here 401s -- fail with that, not with a confusing
  // `undefined` further down.
  {
    const t = await token(F.ADMIN_USER.username, F.ADMIN_USER.password);
    const probe = await fetch(`${ADMIN}/admin/my-jobs`, { headers: { Authorization: `Bearer ${t}` } });
    if (probe.status === 401) {
      console.log("checks 0, fails 1");
      console.log("FAIL the stack is in ngrok mode (backends expect the tunnel's Keycloak issuer).");
      console.log("     Stop scripts/run-with-ngrok.sh and `docker compose up -d` for localhost mode, then rerun.");
      process.exit(1);
    }
  }
  const browser = await chromium.launch();

  // ── admin-ui, portrait (768): drawer sidebar, tap targets, overflow ──
  {
    const ctx = await tabletContext(browser, false);
    const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await login(page, F.ADMIN_USER.username, F.ADMIN_USER.password, `${UI}/studies`);
    await page.waitForSelector("main", { timeout: 15000 }); await page.waitForTimeout(800);
    check("admin-ui portrait: emulated as a touch device", await isCoarse(page));
    check("admin-ui portrait: sidebar is a closed drawer", (await page.locator('[data-testid="sidebar"]').getAttribute("aria-hidden")) === "true" && (await page.locator('[data-testid="menu-button"]').count()) === 1);
    await page.touchscreen.tap(...Object.values(await center(page.locator('[data-testid="menu-button"]'))).slice(0, 2));
    await page.waitForTimeout(400);
    check("admin-ui portrait: menu opens the drawer", (await page.locator('[data-testid="sidebar"]').getAttribute("aria-hidden")) === "false");
    const patients = await center(page.locator('[data-testid="sidebar"] a[href="/patients"]'));
    await page.touchscreen.tap(patients.x, patients.y); await page.waitForURL(/\/patients/); await page.waitForTimeout(500);
    check("admin-ui portrait: picking a page navigates and closes the drawer", page.url().endsWith("/patients") && (await page.locator('[data-testid="sidebar"]').getAttribute("aria-hidden")) === "true");
    for (const path of ["/studies", "/my-jobs", "/patients", "/users", "/notifications", "/system", "/annotation-types", "/deidentification-profiles", `/studies/${F.STUDY}`, `/studies/${F.STUDY}/cases/${F.CASE}`]) {
      await page.goto(`${UI}${path}`, { waitUntil: "networkidle" }); await page.waitForTimeout(400);
      check(`admin-ui portrait ${path}: no sideways scrolling`, await noSidewaysScroll(page));
    }
    await page.goto(`${UI}/studies`, { waitUntil: "networkidle" }); await page.waitForTimeout(500);
    const btn = page.locator(".btn").first();
    check("admin-ui portrait: buttons are finger-sized (>= 44px)", (await btn.count()) === 0 || (await btn.boundingBox()).height >= 44);
    const hoverOnly = page.locator(".group .group-hover\\:opacity-100").first();
    check("admin-ui portrait: hover-only card actions are visible without hover", (await hoverOnly.count()) === 0 || (await hoverOnly.evaluate((el) => getComputedStyle(el).opacity)) === "1");
    await page.screenshot({ path: "tablet-admin-portrait.png" });

    // "Open on a tablet": a QR code of this very address, in the sidebar drawer.
    const menu = await center(page.locator('[data-testid="menu-button"]')); await page.touchscreen.tap(menu.x, menu.y); await page.waitForTimeout(400);
    const qrBtn = await center(page.locator('[data-testid="share-qr-button"]')); await page.touchscreen.tap(qrBtn.x, qrBtn.y); await page.waitForTimeout(600);
    check("admin-ui portrait: QR modal shows a code + this origin", (await page.locator('[data-testid="share-qr"]').count()) === 1 && (await page.locator('[data-testid="share-url"]').innerText()).startsWith(UI));
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);

    // Workflow board: library drawer, tap-to-add, touch pan, properties overlay.
    await page.goto(`${UI}/studies/${F.STUDY}/workflow`, { waitUntil: "networkidle" });
    await page.waitForSelector(".react-flow__node", { timeout: 20000 }); await page.waitForTimeout(800);
    check("board portrait: no sideways scrolling", await noSidewaysScroll(page));
    check("board portrait: library is closed, header has a Library button", (await page.locator('[data-guide="board-library"]').count()) === 0 && (await page.locator('[data-testid="library-toggle"]').count()) === 1);
    const t = new Touch(page); await t.init();
    const before = (await page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform));
    const canvas = await center(page.locator('[data-guide="board-canvas"]'));
    await t.drag({ x: canvas.x - 40, y: canvas.y + 200 }, { x: canvas.x + 120, y: canvas.y + 260 });
    await page.waitForTimeout(300);
    const after = (await page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform));
    check("board portrait: one-finger drag pans the canvas", before !== after, { before, after });
    const adminTok = await token(F.ADMIN_USER.username, F.ADMIN_USER.password);
    const cardsBefore = (await (await fetch(`${ADMIN}/admin/studies/${F.STUDY}/workflow`, { headers: { Authorization: `Bearer ${adminTok}` } })).json()).cards.map((c) => c.id);
    const lib = await center(page.locator('[data-testid="library-toggle"]')); await page.touchscreen.tap(lib.x, lib.y); await page.waitForTimeout(400);
    check("board portrait: Library button opens the palette as an overlay", (await page.locator('[data-guide="board-library"]').count()) === 1);
    const plus = await center(page.locator('button[aria-label="Add Note card"]')); await page.touchscreen.tap(plus.x, plus.y); await page.waitForTimeout(1200);
    const cardsAfter = (await (await fetch(`${ADMIN}/admin/studies/${F.STUDY}/workflow`, { headers: { Authorization: `Bearer ${adminTok}` } })).json()).cards;
    const created = cardsAfter.filter((c) => !cardsBefore.includes(c.id));
    check("board portrait: tapping + adds a card (no drag needed)", created.length === 1 && created[0].type === "note", created.map((c) => c.type));
    check("board portrait: the new card is selected and the properties panel overlays", (await page.locator('[data-guide="board-library"]').count()) === 0 && (await page.locator("aside.w-80").count()) === 1);
    await page.screenshot({ path: "tablet-board-portrait.png" });
    for (const c of created) await fetch(`${ADMIN}/admin/workflow-cards/${c.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${adminTok}` } });
    check("admin-ui portrait: no page errors", errors.length === 0, errors.slice(0, 3));
    await ctx.close();
  }

  // ── admin-ui, landscape (1024): sidebar stays a column, nothing overflows ──
  {
    const ctx = await tabletContext(browser, true);
    const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await login(page, F.ADMIN_USER.username, F.ADMIN_USER.password, `${UI}/studies`);
    await page.waitForSelector("main", { timeout: 15000 }); await page.waitForTimeout(600);
    check("admin-ui landscape: sidebar is a fixed column (no menu button)", (await page.locator('[data-testid="sidebar"]').getAttribute("aria-hidden")) === "false" && (await page.locator('[data-testid="menu-button"]').count()) === 0);
    for (const path of ["/studies", `/studies/${F.STUDY}`, `/studies/${F.STUDY}/cases/${F.CASE}`, "/users", "/system", `/studies/${F.STUDY}/workflow`]) {
      await page.goto(`${UI}${path}`, { waitUntil: "networkidle" }); await page.waitForTimeout(500);
      check(`admin-ui landscape ${path}: no sideways scrolling`, await noSidewaysScroll(page));
    }
    check("board landscape: library is a column, no toggle", (await page.locator('[data-guide="board-library"]').count()) === 1 && (await page.locator('[data-testid="library-toggle"]').count()) === 0);
    const node = await center(page.locator(".react-flow__node").first()); await page.touchscreen.tap(node.x, node.y); await page.waitForTimeout(500);
    check("board landscape: tapping a card opens its properties panel as a column", (await page.locator("aside.w-80").count()) === 1);
    await page.screenshot({ path: "tablet-board-landscape.png" });
    check("admin-ui landscape: no page errors", errors.length === 0, errors.slice(0, 3));
    await ctx.close();
  }

  // ── viewer tutorial, landscape (1024): touch gestures + panel drawer ──
  for (const landscape of [true, false]) {
    const label = landscape ? "tutorial landscape" : "tutorial portrait";
    const ctx = await tabletContext(browser, landscape);
    const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await login(page, F.ANNOTATOR.username, F.ANNOTATOR.password, `${VIEWER}/tutorial`);
    await page.waitForSelector("canvas", { timeout: 30000 }); await page.waitForTimeout(1500);
    // The guide may auto-open: close it.
    if ((await page.locator('[role="dialog"]').count()) > 0) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
    check(`${label}: touch device`, await isCoarse(page));
    check(`${label}: no sideways scrolling`, await noSidewaysScroll(page));
    check(`${label}: side panel is a closed drawer with a Panel button`, (await page.locator('[data-testid="side-panel"]').count()) === 0 && (await page.locator('[data-testid="panel-toggle"]').count()) === 1);
    const toggle = await center(page.locator('[data-testid="panel-toggle"]')); await page.touchscreen.tap(toggle.x, toggle.y); await page.waitForTimeout(400);
    check(`${label}: Panel opens the side panel over the panes`, (await page.locator('[data-testid="side-panel"]').count()) === 1);
    const closeBtn = await center(page.locator('[data-testid="side-panel"] button').first()); await page.touchscreen.tap(closeBtn.x, closeBtn.y); await page.waitForTimeout(300);
    check(`${label}: ✕ closes it again`, (await page.locator('[data-testid="side-panel"]').count()) === 0);
    // Every pane's own back/forward arrows: one slice per tap, and a
    // hold repeats (a finger can't hit one slice of 256 on the slider).
    const paneCount = await page.locator('[data-guide="panes"] > div').count();
    check(`${label}: every pane has back and forward slice arrows`, (await page.locator('[data-testid="slice-prev"]').count()) === paneCount && (await page.locator('[data-testid="slice-next"]').count()) === paneCount);
    const firstSlider = page.locator('[data-guide="panes"] input[type=range]').first();
    const sliceValue = async () => Number(await firstSlider.inputValue());
    const startSlice = await sliceValue();
    const nextArrow = await center(page.locator('[data-testid="slice-next"]').first());
    await page.touchscreen.tap(nextArrow.x, nextArrow.y); await page.waitForTimeout(250);
    check(`${label}: a tap on the arrow steps exactly one slice`, (await sliceValue()) === startSlice + 1, { startSlice, now: await sliceValue() });
    const prevArrow = await center(page.locator('[data-testid="slice-prev"]').first());
    await page.touchscreen.tap(prevArrow.x, prevArrow.y); await page.waitForTimeout(250);
    check(`${label}: the back arrow steps back one`, (await sliceValue()) === startSlice);
    check(`${label}: the arrows are finger-sized`, nextArrow.h >= 24 && nextArrow.w >= 24, nextArrow);
    await page.mouse.move(nextArrow.x, nextArrow.y); await page.mouse.down(); await page.waitForTimeout(1200); await page.mouse.up(); await page.waitForTimeout(300);
    check(`${label}: holding the arrow repeats`, (await sliceValue()) > startSlice + 3, { startSlice, now: await sliceValue() });

    const toolBtn = page.locator('[data-testid="tool-paint"], [data-guide="tool-paint"] button').first();
    check(`${label}: toolbar buttons are finger-sized`, (await toolBtn.boundingBox()).height >= 40);
    check(`${label}: footer shows touch hints`, /Pinch=Zoom/.test(await page.locator('[data-guide="footer"]').innerText()));

    const t = new Touch(page); await t.init();
    const axial = page.locator('[data-pane="axial"] canvas');
    const a = await center(axial);
    // Paint tool + a one-finger stroke -> something is drawn (Save enables).
    const paintBtn = await center(toolBtn); await page.touchscreen.tap(paintBtn.x, paintBtn.y); await page.waitForTimeout(200);
    const saveBefore = await page.locator("header button", { hasText: /^Save$/ }).isDisabled();
    await t.drag({ x: a.x - 30, y: a.y - 10 }, { x: a.x + 30, y: a.y + 20 });
    await page.waitForTimeout(400);
    check(`${label}: one-finger drag paints`, saveBefore === true && (await page.locator("header button", { hasText: /^Save$/ }).isDisabled()) === false);
    // Pinch out -> zoomed; double-tap -> reset.
    const scaleOf = () => page.evaluate(() => { const m = /scale\(([\d.]+)\)/.exec(document.querySelector('[data-pane="axial"]').style.transform); return m ? Number(m[1]) : 1; });
    await t.pinch(a, 40, 120); await page.waitForTimeout(300);
    const zoomed = await scaleOf();
    check(`${label}: pinch zooms the pane`, zoomed > 1.5, zoomed);
    await t.doubleTap({ x: a.x + 5, y: a.y + 5 }); await page.waitForTimeout(400);
    check(`${label}: double-tap resets the zoom`, (await scaleOf()) === 1);
    // Long-press -> HU readout.
    await t.longPress({ x: a.x, y: a.y }); await page.waitForTimeout(200);
    check(`${label}: long-press shows the HU value`, /HU/.test(await page.evaluate(() => Array.from(document.querySelectorAll("div")).filter((d) => /\bHU\b/.test(d.textContent || "") && d.className.includes("fixed")).length ? "HU" : "")));
    // Two-finger tap -> the other panes jump (their slice indices change).
    const sliders = () => page.locator('[data-guide="pane-sliders"] input[type="range"]').evaluateAll((els) => els.map((e) => e.value));
    const sBefore = await sliders();
    // Fingers 30px either side of a point 40px off-center: well inside
    // even the portrait pane (~237px wide).
    await t.twoFingerTap({ x: a.x + 40, y: a.y - 40 }, 30); await page.waitForTimeout(400);
    const sAfter = await sliders();
    check(`${label}: two-finger tap jumps all planes`, JSON.stringify(sBefore) !== JSON.stringify(sAfter), { sBefore, sAfter });

    // Pane headers carry the real viewer's Maximize/Restore + Hide, and
    // the header's eye strip has the 3D toggle too.
    const tapIt = async (loc) => { const c = await center(loc); await page.touchscreen.tap(c.x, c.y); await page.waitForTimeout(350); };
    const paneCols = () => page.locator('[data-guide="panes"] > div').count();
    check(`${label}: every pane has maximize + hide buttons`, (await page.locator('[data-testid="pane-maximize"]').count()) === paneCount && (await page.locator('[data-testid="pane-hide"]').count()) === paneCount);
    await tapIt(page.locator('[data-testid="pane-maximize"]').nth(2));
    check(`${label}: maximize leaves one pane`, (await paneCols()) === 1);
    await tapIt(page.locator('[data-testid="pane-maximize"]').first());
    check(`${label}: restore brings them back`, (await paneCols()) === paneCount);
    const eyeStrip = page.locator("header div.p-0\\.5 button");
    check(`${label}: header toggles cover 3 MPR panes + 3D`, (await eyeStrip.count()) === 4, await eyeStrip.count());
    await tapIt(eyeStrip.nth(3)); await page.waitForTimeout(600);
    check(`${label}: 3D toggle adds the 3D pane`, (await paneCols()) === paneCount + 1);
    await tapIt(eyeStrip.nth(3));

    // Documents -> the bundled practice report, rendered in-page by
    // PDF.js (not an <iframe>, which shows one page on iPadOS).
    await tapIt(page.locator("header button", { hasText: /^Documents/ }));
    await tapIt(page.locator("header li button").first());
    await page.waitForSelector('[data-testid="pdf-page-counter"]', { timeout: 30000 }); await page.waitForTimeout(1200);
    check(`${label}: the practice report opens as an in-page PDF preview`, /1 \/ 2/.test(await page.locator('[data-testid="pdf-page-counter"]').innerText()));
    const inked = await page.evaluate(() => { const c = document.querySelector("[data-pdf-page='1']"); const d = c.getContext("2d").getImageData(0, 0, c.width, Math.min(c.height, 400)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++; return n; });
    check(`${label}: the PDF page is actually drawn`, inked > 200, inked);
    const docBox = await page.locator('[data-testid="document-panel"]').boundingBox();
    check(`${label}: the document takes about half the screen next to the panes`, docBox.width < (await page.viewportSize()).width * 0.6, docBox);
    await tapIt(page.locator('[data-testid="pdf-controls"] button[aria-label="Next page"]'));
    check(`${label}: › goes to page 2`, /2 \/ 2/.test(await page.locator('[data-testid="pdf-page-counter"]').innerText()));
    check(`${label}: still no sideways scrolling with the document open`, await noSidewaysScroll(page));
    await tapIt(page.locator('[data-testid="document-panel-close"]'));
    check(`${label}: ✕ closes the document`, (await page.locator('[data-testid="document-panel"]').count()) === 0);

    await page.screenshot({ path: landscape ? "tablet-tutorial-landscape.png" : "tablet-tutorial-portrait.png" });
    check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 3));
    await ctx.close();
  }

  // ── tutorial: fullscreen on first touch, and the tour in fullscreen ──
  // Its own context: the others pre-decline fullscreen to keep the
  // emulated viewport geometry fixed.
  {
    const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await login(page, F.ANNOTATOR.username, F.ANNOTATOR.password, `${VIEWER}/tutorial`);
    await page.waitForSelector("canvas", { timeout: 30000 }); await page.waitForTimeout(1500);
    const dialog = page.locator('[role="dialog"]');
    // The tour auto-opens on a first visit -- and on a compact layout it
    // needs the side panel open, since its stops live there.
    check("tutorial: the tour opens the side panel by itself on a tablet", (await dialog.count()) === 1 && (await page.locator('[data-testid="side-panel"]').count()) === 1);
    const fs = () => page.evaluate(() => Boolean(document.fullscreenElement));
    check("tutorial: not fullscreen before the first touch", (await fs()) === false);
    // Walk the tour in fullscreen: the overlay portals into document.body,
    // which is only visible because fullscreen is the whole document.
    let walked = 0, spotlighted = 0, everFullscreen = false;
    for (let i = 0; i < 25 && (await dialog.count()); i++) {
      const next = dialog.locator("[data-guide-next]");
      const label = await next.innerText();
      const box = await next.boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(250);
      if (await fs()) everFullscreen = true;
      walked++;
      if ((await page.locator("[data-guide-overlay] .ring-2").count()) > 0) spotlighted++;
      if (label === "Finish") break;
    }
    check("tutorial: the first touch takes it fullscreen", everFullscreen, { walked });
    check("tutorial: the tour is usable in fullscreen (steps + spotlights)", walked >= 8 && spotlighted >= 5, { walked, spotlighted });
    check("tutorial: finishing the tour closes it", (await dialog.count()) === 0);
    check("tutorial: the side panel goes back to closed after the tour", (await page.locator('[data-testid="side-panel"]').count()) === 0);
    // Leaving fullscreen is remembered, so it doesn't drag you back in.
    await page.evaluate(() => document.exitFullscreen()); await page.waitForTimeout(400);
    const paint = await center(page.locator('[data-guide="tool-paint"] button'));
    await page.touchscreen.tap(paint.x, paint.y); await page.waitForTimeout(500);
    check("tutorial: leaving fullscreen is remembered (no re-entry on the next touch)", (await fs()) === false);
    check("tutorial fullscreen: no page errors", errors.length === 0, errors.slice(0, 3));
    await ctx.close();
  }

  // ── the real viewer, landscape: drawer + pinch on a real series ──
  {
    const ctx = await tabletContext(browser, true);
    const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    // A case + series of the annotator's own job (F.CASE/F.SERIES belong
    // to a different study than F.ANNOT_CARD's -- see viewer.spec.js).
    const annotTok = await token(F.ANNOTATOR.username, F.ANNOTATOR.password);
    const job = (await (await fetch(`${ADMIN}/admin/my-jobs`, { headers: { Authorization: `Bearer ${annotTok}` } })).json()).find((j) => j.card_id === F.ANNOT_CARD);
    const kase = job.cases[0];
    const series = (await (await fetch(`${F.DATA}/data/cases/${kase.id}/series`, { headers: { Authorization: `Bearer ${annotTok}` } })).json())[0].id;
    await login(page, F.ANNOTATOR.username, F.ANNOTATOR.password, `${VIEWER}/viewer/series/${series}?studyId=${job.study_id}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`);
    // A cold volume build for a real series can take a couple of minutes
    // right after the backend was (re)started.
    await page.waitForFunction(() => document.querySelectorAll("canvas").length >= 3, null, { timeout: 240000 }); await page.waitForTimeout(3000);
    if ((await page.locator('[role="dialog"]').count()) > 0) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
    check("viewer landscape: no sideways scrolling", await noSidewaysScroll(page));
    check("viewer landscape: Panel button, panel closed", (await page.locator('[data-testid="panel-toggle"]').count()) === 1 && (await page.locator('[data-testid="side-panel"]').count()) === 0);
    const t = new Touch(page); await t.init();
    const axialColumn = page.locator('[data-guide="panes"] > div', { has: page.locator("span", { hasText: /^Axial$/ }) });
    const a = await center(axialColumn.locator("canvas").first());
    const scaleOf = () => axialColumn.locator("div[style*='transform']").first().evaluate((w) => { const m = /scale\(([\d.]+)\)/.exec(w.style.transform); return m ? Number(m[1]) : 1; });
    await t.pinch(a, 40, 130); await page.waitForTimeout(300);
    const z = await scaleOf();
    check("viewer landscape: pinch zooms the axial pane", z > 1.5, z);
    await t.doubleTap({ x: a.x, y: a.y }); await page.waitForTimeout(400);
    check("viewer landscape: double-tap resets", (await scaleOf()) === 1);
    await page.screenshot({ path: "tablet-viewer-landscape.png" });
    check("viewer landscape: no page errors", errors.length === 0, errors.slice(0, 3));
    await ctx.close();
  }

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => { console.error("EXC", e.message); for (const r of results) console.log(r.ok ? "ok  " : "FAIL", r.n); process.exit(1); });
