// Two admins on one board (C-13): a tab that wasn't reloaded used to send
// its whole stale copy of a card's settings with every edit, silently
// undoing what the other tab had just changed. Here tab A unassigns the
// job, then tab B (still showing the old assignee) changes another
// setting -- the job must stay unassigned. Runs on a throwaway study,
// deleted at the end.
const { chromium } = require("playwright");
const { F, login, seenGuides, token } = require("./helpers");
const ADMIN = "http://localhost:8004", UI = "http://localhost:5173";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

(async () => {
  const t = await token("platform-admin", "platform-admin");
  const H = { Authorization: `Bearer ${t}`, "content-type": "application/json" };
  const post = async (url, body) => (await fetch(url, { method: "POST", headers: H, body: body ? JSON.stringify(body) : undefined })).json();
  const study = await post(`${ADMIN}/admin/studies?name=${encodeURIComponent(`e2e two tabs ${Date.now()}`)}`);
  await post(`${ADMIN}/admin/studies/${study.id}/members?user_id=${F.ANNOTATOR.subject}&role=annotator`);
  const card = await post(`${ADMIN}/admin/studies/${study.id}/workflow/cards`, {
    type: "annotation", title: "Two-tab job", position_x: 100, position_y: 100,
    config: { assigned_user_id: F.ANNOTATOR.subject, materialize_dataset: true },
  });

  const browser = await chromium.launch();
  const openTab = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    if (seenGuides) await ctx.addInitScript(seenGuides);
    const page = await ctx.newPage();
    await login(page, "platform-admin", "platform-admin", `${UI}/studies/${study.id}/workflow`);
    await page.locator(".react-flow__node", { hasText: "Two-tab job" }).click();
    await page.waitForTimeout(600);
    return { ctx, page };
  };
  try {
    const a = await openTab();
    const b = await openTab();
    const assignee = a.page.locator("label.field", { hasText: "Assignee" }).locator("select");
    await assignee.selectOption("");
    await a.page.waitForTimeout(800);
    await b.page.locator("label", { hasText: "Also create/update a Dataset card" }).locator('input[type="checkbox"]').click(); // controlled: flips once the PATCH answers
    await b.page.waitForTimeout(800);

    const board = await (await fetch(`${ADMIN}/admin/studies/${study.id}/workflow`, { headers: H })).json();
    const config = board.cards.find((c) => c.id === card.id).config;
    check("tab A's unassign survives tab B's edit", !config.assigned_user_id, config);
    check("tab B's own edit is saved", config.materialize_dataset === false, config);
    await a.ctx.close(); await b.ctx.close();
  } finally {
    await browser.close();
    await fetch(`${ADMIN}/admin/studies/${study.id}`, { method: "DELETE", headers: H });
  }
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
