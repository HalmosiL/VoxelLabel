// The Duplicate card on the board: added from the library, its copies set
// in the side panel (how many, their names), Run makes one Dataset card
// per copy with every case, drawn wired to the Duplicate. Works on the
// fixture study's board and removes everything it added.
const { chromium } = require("playwright");
const { F, login, seenGuides, token } = require("./helpers");

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

async function call(tok, method, url, body) {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  const admin = await token("platform-admin", "platform-admin");
  const boardNow = async () => (await call(admin, "GET", `${F.ADMIN}/admin/studies/${F.STUDY}/workflow`)).body;
  const before = new Set((await boardNow()).cards.map((c) => c.id));
  const kase = (await call(admin, "GET", `${F.DATA}/data/studies/${F.STUDY}/cases`)).body[0];
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    await ctx.addInitScript(seenGuides);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "platform-admin", "platform-admin", `${F.UI}/studies/${F.STUDY}/workflow`);
    await page.waitForSelector(".react-flow__node", { timeout: 30000 });
    await page.waitForTimeout(1500);

    await page.getByRole("button", { name: "Add Duplicate card" }).click();
    await page.waitForTimeout(1500);
    const added = (await boardNow()).cards.filter((c) => !before.has(c.id));
    const dup = added.find((c) => c.type === "duplicate");
    check("the library adds a Duplicate card", dup && dup.config.copies === 2, added.map((c) => c.type));
    const node = page.locator(`.react-flow__node[data-id="${dup?.id}"]`);
    check("... drawn with two copies and what to do next", (await node.locator('[data-testid^="duplicate-copy-"]').count()) === 2 && (await node.locator('[data-testid="duplicate-run-hint"]').count()) === 1);

    // three copies, the first one named, in the side panel
    await node.click();
    await page.locator('[data-testid="duplicate-copies"]').selectOption("3");
    await page.waitForTimeout(600);
    await page.locator('[data-testid="duplicate-name-0"]').fill("Anna");
    await page.locator('[data-testid="duplicate-name-0"]').blur();
    await page.waitForTimeout(800);
    const cfg = (await boardNow()).cards.find((c) => c.id === dup.id).config;
    check("the panel sets how many copies and their names", cfg.copies === 3 && cfg.names?.[0] === "Anna", cfg);

    // feed it one case and Run it from the panel
    const ds = await call(admin, "POST", `${F.ADMIN}/admin/studies/${F.STUDY}/workflow/cards`, { type: "dataset", title: "e2e duplicate input", position_x: dup.position_x - 300, position_y: dup.position_y, config: { mode: "manual", case_ids: [kase.id] } });
    await call(admin, "POST", `${F.ADMIN}/admin/studies/${F.STUDY}/workflow/edges`, { source_card_id: ds.body.id, source_handle: "output", target_card_id: dup.id, target_handle: "input" });
    await page.reload();
    await page.waitForSelector(`.react-flow__node[data-id="${dup.id}"]`, { timeout: 30000 });
    await page.locator(`.react-flow__node[data-id="${dup.id}"]`).click();
    await page.getByRole("button", { name: "Run duplicate" }).click();
    await page.waitForTimeout(2500);
    const after = await boardNow();
    const kids = after.cards.find((c) => c.id === dup.id).materialized_card_ids || {};
    const titles = Object.keys(kids).sort().map((h) => after.cards.find((c) => c.id === kids[h])?.title);
    check("Run makes a card per copy, named", titles.join("|") === "Anna|Copy B|Copy C", titles);
    check("... each with every case", Object.values(kids).every((id) => (after.cards.find((c) => c.id === id).config.case_ids || []).join() === kase.id));
    const drawn = await page.locator(`.react-flow__node[data-id="${dup.id}"] [data-testid^="duplicate-copy-"]`).allInnerTexts();
    check("the card says how many cases each copy got", drawn.length === 3 && drawn.every((t) => /1 cases/.test(t)), drawn);
    check("the copies are drawn wired to it", (await page.locator(`.react-flow__edge[data-id^="materialize-${dup.id}"], [data-testid^="rf__edge-materialize-${dup.id}"]`).count()) === 3);
    check("no page errors", errors.length === 0, errors.slice(0, 3));
  } finally {
    await browser.close();
    const extra = (await boardNow()).cards.filter((c) => !before.has(c.id));
    for (const c of extra) await call(admin, "DELETE", `${F.ADMIN}/admin/workflow-cards/${c.id}`);
  }
  const left = (await boardNow()).cards.filter((c) => !before.has(c.id)).length;
  check("the board is left as it was", left === 0, left);

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
