// K2: one misplaced click deleted a whole study with its cases -- the trash
// icon sits next to Duplicate, and the only guard was two browser
// confirm() pop-ups. Deleting a study now puts it in the trash (the app's
// own dialog, an Undo right after, Restore from Trash); only "Delete
// forever" in the Trash removes it, after its name is typed. Deleting
// several board cards at once asks first too. No browser pop-up anywhere.
const { chromium } = require("playwright");
const { token } = require("./helpers");
const ADMIN = "http://localhost:8004", UI = "http://localhost:5173";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function call(tok, method, path, body) {
  const r = await fetch(`${ADMIN}${path}`, { method, headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  const t = await token("platform-admin", "platform-admin");
  const name = `QA-K2-delete-${Date.now() % 100000}`;
  const study = (await call(t, "POST", `/admin/studies?name=${encodeURIComponent(name)}`)).body;
  await call(t, "POST", `/admin/studies/${study.id}/cases?external_patient_id=QA-K2-P1`);
  const cards = [];
  for (let i = 0; i < 3; i++) cards.push((await call(t, "POST", `/admin/studies/${study.id}/workflow/cards`, { type: "note", title: `Note ${i}`, position_x: i * 260, position_y: 0, config: {} })).body);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["studies", "study", "board"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  const nativeDialogs = [];
  page.on("dialog", (d) => { nativeDialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await page.goto(`${UI}/studies`);
  await page.waitForSelector('[data-testid="signin-submit"]', { timeout: 30000 });
  await page.fill('input[autocomplete="username"]', "platform-admin"); await page.fill('input[type="password"]', "platform-admin");
  await page.click('[data-testid="signin-submit"]');
  await page.waitForSelector(`text=${name}`, { timeout: 30000 });
  check("'New study' is at the top of the page", (await page.locator('[data-testid="new-study-top"]').count()) === 1);
  const card = page.locator('[data-testid="study-card"]', { hasText: name });
  check("the study card says how many cases it has", /1 case\b/.test(await card.innerText()), await card.innerText());

  // Delete on the card: into the trash, said plainly, with an Undo
  await card.hover();
  await card.getByRole("button", { name: "Delete study" }).click();
  const trashDlg = page.locator('[data-testid="trash-study-modal"]');
  await trashDlg.waitFor({ timeout: 5000 });
  check("deleting opens the app's own dialog, no browser pop-up", nativeDialogs.length === 0);
  check("... which says the case goes to the trash and can be restored", /1 case/.test(await trashDlg.innerText()) && /restore/i.test(await trashDlg.innerText()), await trashDlg.innerText());
  await trashDlg.getByRole("button", { name: "Cancel" }).click();
  check("Cancel keeps the study", (await call(t, "GET", `/admin/studies/${study.id}`)).status === 200);
  await card.hover(); await card.getByRole("button", { name: "Delete study" }).click();
  await page.locator('[data-testid="trash-confirm"]').click(); await page.waitForTimeout(1200);
  check("Move to trash hides the study", (await page.locator('[data-testid="study-card"]', { hasText: name }).count()) === 0);
  check("... and closes it", (await call(t, "GET", `/admin/studies/${study.id}`)).status === 404);
  const dataCases = await fetch(`http://localhost:8002/data/studies/${study.id}/cases`, { headers: { Authorization: `Bearer ${t}` } });
  check("... in every service (the viewer's data too)", dataCases.status === 404, dataCases.status);
  await page.locator('[data-testid="trash-undo"]').click(); await page.waitForTimeout(1200);
  check("Undo brings it back, with its case", (await call(t, "GET", `/admin/studies/${study.id}`)).status === 200 && /1 case\b/.test(await card.innerText().catch(() => "")));

  // board: several cards at once asks first
  await page.goto(`${UI}/studies/${study.id}/workflow`);
  await page.waitForSelector(".react-flow__node", { timeout: 30000 }); await page.waitForTimeout(800);
  const nodes = page.locator(".react-flow__node");
  await nodes.nth(0).click(); await nodes.nth(1).click({ modifiers: ["Control"] }); await nodes.nth(2).click({ modifiers: ["Control"] });
  await page.keyboard.press("Delete"); await page.waitForTimeout(500);
  const boardDlg = page.locator('[data-testid="delete-cards-modal"]');
  check("deleting 3 board cards asks first", (await boardDlg.count()) === 1 && /3 cards/.test(await boardDlg.innerText()));
  await boardDlg.getByRole("button", { name: "Cancel" }).click(); await page.waitForTimeout(500);
  check("... Cancel keeps all 3", (await page.locator(".react-flow__node").count()) === 3);

  // into the trash again; restore from the Trash; then delete it for good
  await page.goto(`${UI}/studies`); await page.waitForSelector(`text=${name}`, { timeout: 30000 });
  await card.hover(); await card.getByRole("button", { name: "Delete study" }).click();
  await page.locator('[data-testid="trash-confirm"]').click(); await page.waitForTimeout(1200);
  check("the Trash button counts it", /Trash \(\d+\)/.test(await page.locator('[data-testid="trash-open"]').innerText()));
  await page.locator('[data-testid="trash-open"]').click();
  const row = page.locator('[data-testid="trash-row"]', { hasText: name });
  check("the Trash lists it, with its case and who deleted it", /1 case/.test(await row.innerText()) && /Platform Admin/.test(await row.innerText()), await row.innerText().catch(() => ""));
  await row.locator('[data-testid="trash-restore"]').click(); await page.waitForTimeout(1200);
  check("Restore from the Trash brings it back", (await call(t, "GET", `/admin/studies/${study.id}`)).status === 200);
  await card.hover(); await card.getByRole("button", { name: "Delete study" }).click();
  await page.locator('[data-testid="trash-confirm"]').click(); await page.waitForTimeout(1200);
  await page.locator('[data-testid="trash-open"]').click();
  await page.locator('[data-testid="trash-row"]', { hasText: name }).locator('[data-testid="trash-purge"]').click();
  const dlg = page.locator('[data-testid="delete-study-modal"]');
  await dlg.waitFor({ timeout: 5000 });
  check("Delete forever says the case goes with it", /1 case/.test(await dlg.innerText()), await dlg.innerText());
  const confirmBtn = dlg.getByRole("button", { name: /Delete study/ });
  check("... it is off until the name is typed", await confirmBtn.isDisabled());
  await dlg.locator("input").fill(name.slice(0, -1));
  check("... a near-miss name keeps it off", await confirmBtn.isDisabled());
  await dlg.locator("input").fill(name);
  await confirmBtn.click(); await page.waitForTimeout(1500);
  check("typing the name and confirming deletes it for good", (await call(t, "POST", `/admin/studies/${study.id}/restore`)).status === 404);
  check("no browser pop-up was ever used", nativeDialogs.length === 0, nativeDialogs);
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
