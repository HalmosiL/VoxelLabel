// The case page's previews (study and series thumbnails, the series'
// instance thumbnails) load through the data API's signed links -- even
// when the browser can't reach MinIO at all, which is how a server behind
// a firewall or a proxy looks. MinIO's port is blocked for the whole run.
const { chromium } = require("playwright");
const { F } = require("./helpers");
const results = []; const check = (n, ok, extra) => results.push({ n, ok: Boolean(ok), extra });

async function token(u, p) {
  const r = await fetch(`${F.KC}/realms/ct-platform/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: u, password: p }) });
  return (await r.json()).access_token;
}
async function api(t, url) { const r = await fetch(url, { headers: { Authorization: `Bearer ${t}` } }); return r.ok ? r.json() : null; }

(async () => {
  const t = await token("platform-admin", "platform-admin");
  // a case whose imaging study has a thumbnail
  let target = null;
  const studies = (await api(t, `${F.ADMIN}/admin/studies`)) || [];
  for (const study of Array.isArray(studies) ? studies : studies.items || []) {
    const cases = (await api(t, `${F.DATA}/data/studies/${study.id}/cases`)) || [];
    for (const c of Array.isArray(cases) ? cases : cases.items || []) {
      const imaging = (await api(t, `${F.DATA}/data/cases/${c.id}/imaging-studies`)) || [];
      if (imaging.some((s) => s.thumbnail_url)) { target = { study: study.id, kase: c.id, thumb: imaging.find((s) => s.thumbnail_url).thumbnail_url }; break; }
    }
    if (target) break;
  }
  check("found a case with a thumbnail", target !== null);
  check("the API hands out a signed link to itself, not a MinIO URL", target && target.thumb.startsWith("/data/objects?") && !/:9000/.test(target.thumb), target && target.thumb);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(() => { try { for (const k of ["workbench", "job", "case", "studies", "study"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const blocked = [];
  await ctx.route(/:9000\//, (route) => { blocked.push(route.request().url()); route.abort(); });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${F.UI}/studies/${target.study}/cases/${target.kase}`);
  await Promise.race([page.waitForSelector("#username", { timeout: 30000 }), page.waitForSelector('[data-testid="signin-submit"]', { timeout: 30000 })]);
  if (await page.locator('[data-testid="signin-submit"]').isVisible().catch(() => false)) {
    await page.fill('input[autocomplete="username"]', "platform-admin"); await page.fill('input[type="password"]', "platform-admin"); await page.click('[data-testid="signin-submit"]');
  } else {
    await page.fill("#username", "platform-admin"); await page.fill("#password", "platform-admin"); await page.click("#kc-login");
  }
  await page.waitForFunction(() => Array.from(document.images).some((i) => i.src.includes("/data/objects?")), null, { timeout: 30000 });
  await page.waitForFunction(() => Array.from(document.images).filter((i) => i.src.includes("/data/objects?")).every((i) => i.complete), null, { timeout: 30000 });
  const imgs = await page.evaluate(() => Array.from(document.images).filter((i) => i.src.includes("/data/objects?")).map((i) => ({ w: i.naturalWidth, src: i.src.slice(0, 60) })));
  check("the study and series previews load with MinIO unreachable", imgs.length >= 2 && imgs.every((i) => i.w > 0), imgs);
  check("nothing on the page tried to reach MinIO directly", blocked.length === 0, blocked.slice(0, 3));

  // the series' instance thumbnails, in its modal
  const series = page.locator("button", { hasText: /^Images$|^View images$|^Instances$/ }).first();
  if (await series.count()) {
    await series.click();
    await page.waitForTimeout(1500);
    const inModal = await page.locator('[role="dialog"] img').evaluateAll((els) => els.map((i) => i.naturalWidth));
    check("the series' instance thumbnails load too", inModal.length > 0 && inModal.every((w) => w > 0), inModal.slice(0, 5));
  }
  check("no page errors", errors.length === 0, errors);
  await page.screenshot({ path: "case-previews.png" });
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.n, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
