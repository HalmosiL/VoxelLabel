// Store templates (C-14): inserting one that fails halfway leaves nothing
// behind, and only your own saved templates say "Mine". The template here
// is valid to save but can't be placed: two Datasets both wired into one
// Filter, which takes a single input. Runs on a throwaway study and
// template, both deleted at the end.
const { chromium } = require("playwright");
const { login, seenGuides, token } = require("./helpers");
const ADMIN = "http://localhost:8004", UI = "http://localhost:5173";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

(async () => {
  const t = await token("platform-admin", "platform-admin");
  const H = { Authorization: `Bearer ${t}`, "content-type": "application/json" };
  const post = async (url, body) => (await fetch(url, { method: "POST", headers: H, body: body ? JSON.stringify(body) : undefined })).json();
  const stamp = Date.now();
  const study = await post(`${ADMIN}/admin/studies?name=${encodeURIComponent(`e2e store ${stamp}`)}`);
  const card = (key, type, x) => ({ key, type, title: `${key}-${stamp}`, x, y: 0, width: 200, height: 100, config: {} });
  const title = `e2e half-insert ${stamp}`;
  const template = await post(`${ADMIN}/admin/pipeline-templates`, {
    title,
    cards: [card("a", "dataset", 0), card("b", "dataset", 0), card("f", "filter", 300)],
    edges: [
      { source_key: "a", source_handle: "output", target_key: "f", target_handle: "input" },
      { source_key: "b", source_handle: "output", target_key: "f", target_handle: "input" },
    ],
  });

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    if (seenGuides) await ctx.addInitScript(seenGuides);
    const page = await ctx.newPage();
    await login(page, "platform-admin", "platform-admin", `${UI}/studies/${study.id}/workflow`);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Store", exact: true }).click();
    await page.locator('input[aria-label="Filter templates"]').fill(title);
    const tpl = page.locator("div[draggable]", { hasText: title });
    check("your own saved template says Mine", (await tpl.locator("span", { hasText: /^Mine$/ }).count()) === 1);
    await tpl.getByRole("button", { name: "Insert", exact: true }).click();
    await page.waitForTimeout(3000);
    const board = await (await fetch(`${ADMIN}/admin/studies/${study.id}/workflow`, { headers: H })).json();
    check("a template that fails halfway leaves nothing on the board", board.cards.length === 0, board.cards.map((c) => c.title));
    check("... and says so", (await page.locator("text=nothing was added").count()) >= 1);
    await ctx.close();
  } finally {
    await browser.close();
    await fetch(`${ADMIN}/admin/pipeline-templates/${template.id}`, { method: "DELETE", headers: H });
    await fetch(`${ADMIN}/admin/studies/${study.id}`, { method: "DELETE", headers: H });
  }
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
