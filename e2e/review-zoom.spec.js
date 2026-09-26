// UX-rev-2-04 / UX-rev-1-06: opening an object jumped to an extreme,
// pixelated zoom with no lung around it; Maximize kept the zoom and pushed
// the nodule to the edge; double-click didn't reset in review. Now a jump
// zooms at most 4x, the object stays centred through Maximize, and
// double-click resets. Leaves the fixture case handed in.
const { chromium } = require("playwright");
const { F, token, saveMaskAs } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174", A8010 = "http://localhost:8010";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

(async () => {
  const at = await token("dr-test", "Test1234!");
  const job = (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases[0];
  const seriesId = (await api(at, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const current = await api(at, `${A8010}/series/${seriesId}/mask-volume`);
  const plain = current.objects.map((o) => ({ ...o, hidden: false, review_status: undefined, reject_reason: undefined, review_comment: undefined }));
  // a small nodule (5x5 pixels on one slice), first in the review order, for this spec only
  const zlib = require("zlib");
  const instances = await api(at, `${F.DATA}/data/series/${seriesId}/instances`);
  const meta = await api(at, `${A8010}/instances/${instances[0].id}/metadata`);
  const volume = zlib.gunzipSync(Buffer.from(current.mask_gzip_base64, "base64"));
  const rows = meta.rows, cols = meta.columns, slices = volume.length / (rows * cols);
  const smallId = Math.max(...volume, ...plain.map((o) => o.id)) + 1;
  const z = Math.floor(slices / 2), y0 = Math.floor(rows * 0.3), x0 = Math.floor(cols * 0.3);
  const withSmall = Buffer.from(volume);
  for (let y = y0; y < y0 + 5; y++) for (let x = x0; x < x0 + 5; x++) withSmall[z * rows * cols + y * cols + x] = smallId;
  const small = { id: smallId, label_id: plain[0].label_id, instance_number: 0, locked: false, hidden: false };
  await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: [small, ...plain], mask_gzip_base64: zlib.gzipSync(withSmall).toString("base64") });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); localStorage.removeItem("vl.view.layout"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.REVIEW_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-review"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  // the zoom of the axial pane, and how far the painted object's centre is from the pane's centre (in pane widths)
  const view = () => page.evaluate(() => {
    const pane = document.querySelector('[data-testid="pane-axial"]');
    const image = document.querySelector('[data-testid="pane-axial-image"]');
    const overlay = [...pane.querySelectorAll("canvas")].find((c) => c.style.position === "absolute");
    const m = /scale\(([\d.]+)\)/.exec(image.parentElement.style.transform);
    const d = overlay.getContext("2d").getImageData(0, 0, overlay.width, overlay.height).data;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < overlay.height; y++) for (let x = 0; x < overlay.width; x++) if (d[(y * overlay.width + x) * 4 + 3] > 0) { sx += x; sy += y; n++; }
    const r = overlay.getBoundingClientRect(), p = pane.getBoundingClientRect();
    const cx = r.left + ((sx / n) / overlay.width) * r.width, cy = r.top + ((sy / n) / overlay.height) * r.height;
    return { scale: m ? Number(m[1]) : 1, off: n ? Math.hypot(cx - (p.left + p.width / 2), cy - (p.top + p.height / 2)) / p.width : null };
  });
  const opened = await view();
  check("a jump to the object zooms, but at most 4x", opened.scale > 1 && opened.scale <= 4, opened);
  check("... with the object in the middle", opened.off !== null && opened.off < 0.15, opened);
  await page.locator('[data-testid="pane-axial-maximize"]').click(); await page.waitForTimeout(1200);
  const big = await view();
  check("after Maximize the object is still in the middle", big.off !== null && big.off < 0.15, big);
  await page.locator('[data-testid="pane-axial-maximize"]').click(); await page.waitForTimeout(800);
  await page.locator('[data-testid="pane-axial"]').dblclick({ position: { x: 20, y: 20 } }); await page.waitForTimeout(500);
  check("double-click resets the zoom in review", (await view()).scale === 1);
  await browser.close();
  // the fixture as it was
  await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: plain, mask_gzip_base64: current.mask_gzip_base64 });

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
