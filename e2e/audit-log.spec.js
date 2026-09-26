// Audit log end to end: an admin action lands as a line, the System page
// shows it, a non-admin can't read the log, and the viewer answers 200
// (not 404) for a series with no saved segmentation.
const { chromium } = require("playwright");
const { F } = require("./helpers");
const KC = "http://localhost:8080", ADMIN = "http://localhost:8004", UI = "http://localhost:5173";
const results = [];
const check = (n, ok, extra) => { results.push({ n, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"} ${n}${ok ? "" : " " + JSON.stringify(extra)}`); };
async function token(u, p) {
  const r = await fetch(`${KC}/realms/ct-platform/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username: u, password: p, scope: "openid" }) });
  return (await r.json()).access_token;
}

(async () => {
  const t = await token("platform-admin", "platform-admin");
  const H = { Authorization: `Bearer ${t}` };
  const stamp = Date.now();

  // Create, rename, add a member, remove it, delete -- five audited actions.
  const study = await (await fetch(`${ADMIN}/admin/studies?name=audit-e2e-${stamp}`, { method: "POST", headers: H })).json();
  await fetch(`${ADMIN}/admin/studies/${study.id}?name=audit-e2e-${stamp}-renamed`, { method: "PATCH", headers: H });
  await fetch(`${ADMIN}/admin/studies/${study.id}/members?user_id=${F.ANNOTATOR.subject}&role=annotator`, { method: "POST", headers: H });
  await fetch(`${ADMIN}/admin/studies/${study.id}/members/${F.ANNOTATOR.subject}?role=annotator`, { method: "DELETE", headers: H });
  const del = await fetch(`${ADMIN}/admin/studies/${study.id}`, { method: "DELETE", headers: H });
  check("study create/rename/member add+remove/delete all succeeded", del.status === 204, del.status);

  const log = await (await fetch(`${ADMIN}/admin/audit-log?entity_id=${study.id}`, { headers: H })).json();
  const actions = log.entries.map((e) => e.action);
  check("audit log has all five actions for that study", ["study.create", "study.update", "member.add", "member.remove", "study.delete"].every((a) => actions.includes(a)), actions);
  const rename = log.entries.find((e) => e.action === "study.update");
  check("rename diff records from/to", rename && rename.diff?.name?.to === `audit-e2e-${stamp}-renamed`, rename?.diff);
  check("actor resolved to the person's name", log.entries.every((e) => e.actor === "Platform Admin"), log.entries.map((e) => e.actor));

  const dr = await token("dr-test", "Test1234!");
  const forbidden = await fetch(`${ADMIN}/admin/audit-log`, { headers: { Authorization: `Bearer ${dr}` } });
  check("non-admin gets 403 on the audit log", forbidden.status === 403, forbidden.status);

  // A user PATCH (handler gained a db session for the audit line) still works.
  const me = await (await fetch(`${ADMIN}/admin/me`, { headers: H })).json();
  const patch = await fetch(`${ADMIN}/admin/users/${me.subject}`, { method: "PATCH", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ first_name: "Platform" }) });
  check("PATCH /admin/users still works (audited)", patch.status === 200, await patch.text());

  // Viewer: unsaved-series mask volume is a 200 with null now, not a 404.
  const series = await (await fetch(`http://localhost:8002/data/cases/${F.CASE}/series`, { headers: H })).json();
  const mv = await fetch(`http://localhost:8010/series/${series[0].id}/mask-volume`, { headers: H });
  check("viewer mask-volume answers 200 (saved or not)", mv.status === 200, mv.status);

  // System page shows the card with the entries.
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(() => { try { for (const k of ["workbench","job","case","system"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${UI}/system`, { waitUntil: "networkidle" });
  await page.fill('input[autocomplete="username"]', "platform-admin");
  await page.fill('input[type="password"]', "platform-admin");
  await page.click('[data-testid="signin-submit"]');
  // A real entry row (the action badge), not the "Loading…" placeholder row.
  await page.waitForSelector('[data-testid="audit-log"] tbody tr .badge-blue', { timeout: 15000 });
  const text = await page.locator('[data-testid="audit-log"]').innerText();
  check("System page: Audit log card lists the study.delete line", /study\.delete/.test(text) && /Platform Admin/.test(text));
  await page.locator('[data-guide="tutorial-button"] button').click();
  const dialog = page.locator('[role="dialog"]');
  let titles = [];
  for (let i = 0; i < 12 && (await dialog.count()) > 0; i++) { titles.push(await dialog.getAttribute("aria-label")); const n = dialog.locator("[data-guide-next]"); const l = await n.innerText(); await n.click(); await page.waitForTimeout(120); if (l === "Finish") break; }
  check("System tour includes the Audit log step", titles.some((x) => /Audit log/.test(x || "")), titles);
  check("no page errors", errors.length === 0, errors);
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`\nchecks ${results.length}, fails ${fails.length}`);
  process.exit(fails.length ? 1 : 0);
})();
