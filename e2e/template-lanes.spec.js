// K5: a two-lane template saved from a board came back with a second,
// empty Lane A/B wired to the jobs while the real lanes the Split made sat
// unconnected on top of them. The template now holds the Split and the
// jobs, plus "feedback" connections from the Split's parts and the
// Review's rejected branch; inserting it makes the lanes once and wires
// the jobs to them. Throwaway study and template, both deleted at the end.
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
  const study = await post(`${ADMIN}/admin/studies?name=${encodeURIComponent(`e2e lanes ${stamp}`)}`);
  await post(`${ADMIN}/admin/studies/${study.id}/cases?external_patient_id=LANES-1`);
  await post(`${ADMIN}/admin/studies/${study.id}/cases?external_patient_id=LANES-2`);
  const c = (key, type, x, y, config = {}) => ({ key, type, title: key, x, y, width: 200, height: 100, config });
  const title = `e2e two lanes ${stamp}`;
  const template = await post(`${ADMIN}/admin/pipeline-templates`, {
    title,
    cards: [
      c("All", "dataset", 0, 0, { mode: "all_cases" }),
      c("Split", "split", 260, 0, { parts: [{ name: "Lane A", ratio: 1 }, { name: "Lane B", ratio: 1 }] }),
      c("Annotate A", "annotation", 600, 0), c("Annotate B", "annotation", 600, 300),
      c("Review A", "review", 900, 0),
    ],
    edges: [
      { source_key: "All", source_handle: "output", target_key: "Split", target_handle: "input" },
      { source_key: "Annotate A", source_handle: "output", target_key: "Review A", target_handle: "input" },
    ],
    feedback: [
      { source_key: "Split", source_handle: "part_0", target_key: "Annotate A", target_handle: "input" },
      { source_key: "Split", source_handle: "part_1", target_key: "Annotate B", target_handle: "input" },
      { source_key: "Review A", source_handle: "rejected", target_key: "Annotate A", target_handle: "input" },
    ],
  });

  const extraStudies = [];
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    if (seenGuides) await ctx.addInitScript(seenGuides);
    const page = await ctx.newPage();
    await login(page, "platform-admin", "platform-admin", `${UI}/studies/${study.id}/workflow`);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Store", exact: true }).click();
    await page.locator('input[aria-label="Filter templates"]').fill(title);
    await page.locator("div[draggable]", { hasText: title }).getByRole("button", { name: "Insert", exact: true }).click();
    await page.waitForTimeout(6000);
    const board = await (await fetch(`${ADMIN}/admin/studies/${study.id}/workflow`, { headers: H })).json();
    const byTitle = (x) => board.cards.filter((k) => k.title === x);
    check("one Lane A and one Lane B, made by the Split", byTitle("Lane A").length === 1 && byTitle("Lane B").length === 1, board.cards.map((k) => k.title));
    const laneA = byTitle("Lane A")[0], annA = byTitle("Annotate A")[0];
    const into = (id) => board.edges.filter((e) => e.target_card_id === id && e.target_handle === "input").map((e) => e.source_card_id);
    check("Annotate A takes its cases from the real Lane A", laneA && annA && into(annA.id).includes(laneA.id), into(annA?.id));
    const rejected = board.cards.find((k) => k.title.endsWith("(rejected)"));
    check("... and the Review's rejected branch loops back into it", rejected && into(annA.id).includes(rejected.id));
    check("Annotate A got its lane's cases", (annA?.output_count ?? 0) >= 1, annA?.output_count);

    // the built-in "Review with feedback loop" still closes its loop
    const study2 = await post(`${ADMIN}/admin/studies?name=${encodeURIComponent(`e2e builtin ${stamp}`)}`);
    extraStudies.push(study2.id);
    await page.goto(`${UI}/studies/${study2.id}/workflow`); await page.waitForTimeout(2000);
    await page.getByRole("button", { name: "Store", exact: true }).click();
    await page.locator('input[aria-label="Filter templates"]').fill("Review with feedback loop");
    await page.locator("div[draggable]", { hasText: "Review with feedback loop" }).first().getByRole("button", { name: "Insert", exact: true }).click();
    await page.waitForTimeout(5000);
    const b2 = await (await fetch(`${ADMIN}/admin/studies/${study2.id}/workflow`, { headers: H })).json();
    const ann2 = b2.cards.find((k) => k.type === "annotation");
    const rej2 = b2.cards.find((k) => k.title.endsWith("(rejected)"));
    const into2 = b2.edges.filter((e) => e.target_card_id === ann2?.id && e.target_handle === "input").map((e) => e.source_card_id);
    check("the built-in feedback template wires rejected back into Annotation", ann2 && rej2 && into2.includes(rej2.id), b2.cards.map((k) => k.title));
    await ctx.close();
  } finally {
    await browser.close();
    await fetch(`${ADMIN}/admin/pipeline-templates/${template.id}`, { method: "DELETE", headers: H });
    await fetch(`${ADMIN}/admin/studies/${study.id}?force=true`, { method: "DELETE", headers: H });
    for (const id of extraStudies) await fetch(`${ADMIN}/admin/studies/${id}?force=true`, { method: "DELETE", headers: H });
  }
  const fails = results.filter((r) => !r.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
