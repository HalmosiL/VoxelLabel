// The drawing tools never destroy or resurrect work behind the annotator's
// back: a hidden object is protected like a locked one (E-09), Undo after
// deleting an object doesn't bring its painting back ownerless (E-05), and
// Enter applies exactly the Auto region that is previewed (E-01). Checked
// against the saved mask itself, voxel for voxel per object id.
const zlib = require("zlib");
const { chromium } = require("playwright");
const { F } = require("./helpers");
const ADMIN = "http://localhost:8004", KC = "http://localhost:8080", VIEWER = "http://localhost:5174", API = "http://localhost:8010";

async function token(user, pass) {
  const r = await fetch(`${KC}/realms/ct-platform/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: user, password: pass }) });
  return (await r.json()).access_token;
}
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }
// A fresh case has no labels yet: add one so there is an object to draw into.
async function ensureObject(page) {
  if ((await page.locator('[data-testid^="object-"]').count()) > 0) return;
  await page.locator('input[placeholder="New label…"]').fill("QA structure");
  await page.locator('input[placeholder="New label…"]').press("Enter");
  await page.waitForTimeout(300);
  await page.locator('[data-testid^="add-object-"]').first().click();
  await page.waitForTimeout(300);
}
const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

(async () => {
  const t = await token("dr-test", "Test1234!");
  const job = (await api(t, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases.find((c) => c.status !== "done") || job.cases[0];
  const seriesId = (await api(t, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const counts = async () => {
    const m = await api(await token("dr-test", "Test1234!"), `${API}/series/${seriesId}/mask-volume`);
    const out = {};
    if (!m.mask_gzip_base64) return out;
    for (const v of zlib.gunzipSync(Buffer.from(m.mask_gzip_base64, "base64"))) if (v) out[v] = (out[v] || 0) + 1;
    return { ...out, _objects: m.objects.map((o) => o.id) };
  };

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review", "workbench", "job", "case"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${F.ANNOT_CARD}`);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", "dr-test"); await page.fill("#password", "Test1234!"); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  const box = await page.locator('[data-testid="pane-axial"]').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const stroke = async (from, to) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
    await page.mouse.up(); await page.waitForTimeout(150);
  };
  const save = async () => { await page.locator("header button", { hasText: /^Save$/ }).click(); await page.waitForTimeout(1800); };
  const newObject = async () => {
    await ensureObject(page);
    // "New instance" adds one of the selected object's label: select one first
    if (await page.locator('[data-testid="new-instance-button"]').isDisabled()) {
      await page.locator('[data-testid^="object-"]').filter({ has: page.locator("xpath=self::*[not(contains(@data-testid,'form'))]") }).first().click();
      await page.waitForTimeout(200);
    }
    await page.locator('[data-testid="new-instance-button"]').click(); await page.waitForTimeout(300);
    const ids = await page.locator('[data-testid^="object-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")).filter((x) => /^object-\d+$/.test(x)).map((x) => Number(x.slice(7))));
    return Math.max(...ids);
  };

  // ---- E-09: a hidden object survives the eraser and another object's paint ----
  const a = await newObject();
  await page.locator('[data-testid="tool-paint"]').click();
  await stroke(at(0.40, 0.40), at(0.48, 0.46));
  await save();
  const before = (await counts())[a] || 0;
  await page.locator(`[data-testid="hide-${a}"]`).click();
  await page.locator('[data-testid="tool-erase"]').click();
  await stroke(at(0.40, 0.40), at(0.48, 0.46));
  check("the annotator is told why", (await page.locator("text=locked or hidden object").count()) >= 1);
  const b = await newObject();
  await page.locator('[data-testid="tool-paint"]').click();
  await stroke(at(0.40, 0.40), at(0.48, 0.46));
  await save();
  const after = await counts();
  check("a hidden object keeps every voxel under the eraser and another object's paint", before > 0 && after[a] === before, { before, after: after[a], b: after[b] });
  await page.locator(`[data-testid="hide-${a}"]`).click();

  // ---- E-05: delete + Undo does not resurrect ownerless voxels ----
  const c = await newObject();
  await page.locator('[data-testid="tool-paint"]').click();
  // two strokes: Undo restores the slice as it was before the second one,
  // which still holds the first stroke's voxels of the deleted object
  await stroke(at(0.60, 0.60), at(0.66, 0.66));
  await stroke(at(0.60, 0.66), at(0.66, 0.60));
  dialogs.length = 0;
  await page.locator(`[data-testid="delete-${c}"]`).click(); await page.waitForTimeout(300);
  check("deleting an object asks first", dialogs.length === 1 && /can't be undone/.test(dialogs[0]), dialogs);
  await page.locator('[data-testid="pane-axial"]').hover();
  await page.keyboard.press("Control+z"); await page.waitForTimeout(300);
  await save();
  const afterDelete = await counts();
  check("Undo after a delete leaves no voxels of the deleted object", !afterDelete[c] && !afterDelete._objects.includes(c), afterDelete);
  const d = await newObject();
  check("a new object never reuses the deleted one's id", d > c, { c, d });

  // ---- E-01: Enter applies exactly the previewed Auto region ----
  await page.locator('[data-testid="tool-auto"]').click();
  const p0 = at(0.30, 0.55), p1 = at(0.45, 0.70);
  await page.mouse.move(p0.x, p0.y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(p0.x + ((p1.x - p0.x) * i) / 8, p0.y + ((p1.y - p0.y) * i) / 8);
  await page.mouse.up();
  await page.locator('[data-testid="auto-range"]').waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  const previewed = Number((/(\d+) px selected/.exec(await page.locator("text=px selected").innerText()) || [])[1]);
  await page.keyboard.press("Enter"); await page.waitForTimeout(300);
  await save();
  const applied = (await counts())[d] || 0;
  check("Enter writes exactly the previewed region", previewed > 0 && applied === previewed, { previewed, applied });
  // ---- E-07: "Clear hovered slice" wipes only the active object ----
  const e1 = await newObject();
  await page.locator('[data-testid="tool-paint"]').click();
  await stroke(at(0.20, 0.20), at(0.26, 0.24));
  const e2 = await newObject();
  await page.locator('[data-testid="tool-paint"]').click();
  await stroke(at(0.20, 0.30), at(0.26, 0.34));
  await save();
  const beforeClear = await counts();
  await page.locator('[data-testid="pane-axial"]').hover();
  await page.getByRole("button", { name: "Clear hovered slice" }).click();
  await save();
  const afterClear = await counts();
  check("Clear hovered slice keeps the other object's paint", beforeClear[e1] > 0 && afterClear[e1] === beforeClear[e1] && !afterClear[e2], { before: [beforeClear[e1], beforeClear[e2]], after: [afterClear[e1], afterClear[e2]] });

  // ---- E-12: instance numbers are never reused within a label ----
  // e2 is active, so the new object joins e2's label; deleting the older e1
  // used to hand its count to the next object -- a second "e2" name.
  const nameOf = async (id) => (await page.locator(`[data-testid="object-${id}"]`).innerText()).trim().split("\n")[0];
  await page.locator(`[data-testid="delete-${e1}"]`).click(); await page.waitForTimeout(300);
  await page.locator(`[data-testid="object-${e2}"]`).click();
  const e3 = await newObject();
  check("a new object never takes a name already in use", (await nameOf(e3)) !== (await nameOf(e2)), { e2: await nameOf(e2), e3: await nameOf(e3) });

  check("no page errors", errors.length === 0, errors);

  // Leave the shared fixture case as we found it: the objects made here go
  // (review specs later decide every object on this case, one by one).
  for (const id of [a, b, d, e2, e3]) await page.locator(`[data-testid="delete-${id}"]`).click();
  await save();

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
