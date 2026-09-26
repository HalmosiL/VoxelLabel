// The review surface (F-12, F-13, F-14): a case handed in with no objects
// can be approved as "no findings"; an admin switching View as to Reviewer
// can no longer draw; and a job whose settings don't load stays read-only
// instead of opening the full editor, and neither does one whose saved mask
// doesn't load (I-07). Restores the fixture case's objects.
const { chromium } = require("playwright");
const { F, token, saveMaskAs } = require("./helpers");
const ADMIN = "http://localhost:8004", VIEWER = "http://localhost:5174", A8010 = "http://localhost:8010";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });
async function api(tok, url) { return (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json(); }

async function open(browser, user, pass, url, beforeLogin) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => { try { for (const k of ["annotate", "review", "workbench", "job", "case"]) localStorage.setItem(`vl.guide.${k}.seen`, "1"); } catch {} });
  const page = await ctx.newPage();
  if (beforeLogin) await beforeLogin(page);
  await page.goto(url);
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.fill("#username", user); await page.fill("#password", pass); await page.click("#kc-login");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid$="-image"]').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  return { ctx, page };
}

(async () => {
  const at = await token("dr-test", "Test1234!");
  const rt = await token("dr-review", "Test1234!");
  const job = (await api(at, `${ADMIN}/admin/my-jobs`)).find((j) => j.card_id === F.ANNOT_CARD);
  const kase = job.cases.find((c) => c.status !== "done") ?? job.cases[job.cases.length - 1];
  const seriesId = (await api(at, `${F.DATA}/data/cases/${kase.id}/series`))[0].id;
  const original = await api(at, `${A8010}/series/${seriesId}/mask-volume`);
  const viewerUrl = (jobId, extra = "") => `${VIEWER}/viewer/series/${seriesId}?studyId=${F.STUDY}&caseId=${kase.id}&jobId=${jobId}${extra}`;
  const browser = await chromium.launch();

  try {
    // ---- F-12: handed in with no objects -> "Approve: no findings" ----
    await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: [], labels: original.labels || [] });
    {
      const { ctx, page } = await open(browser, "dr-review", "Test1234!", viewerUrl(F.REVIEW_CARD));
      const empty = page.locator('[data-testid="empty-review"]');
      check("a case with no objects offers a decision", (await empty.count()) === 1);
      await empty.getByRole("button", { name: "Approve: no findings" }).click();
      // D-09: the header's counter follows the decision (before the viewer moves on to the next case)
      const counter = await page.waitForFunction(() => /decided/.test(document.querySelector('[data-testid="case-counter"]')?.textContent || ""), null, { timeout: 1300 }).then(() => true, () => false);
      check("the case counter says the case is decided", counter);
      const title = await page.locator('[data-testid="viewer-case-title"]').innerText().catch(() => "");
      check("the header names the case that's open", title.includes(kase.title), title);
      check("... and the counter gives its real position", /^Case \d+ of \d+/.test(await page.locator('[data-testid="case-counter"]').innerText()));
      await page.waitForTimeout(2000);
      const latest = await api(rt, `${A8010}/series/${seriesId}/mask-volume`);
      check("... and approving it works", latest.version_status === "approved", latest.version_status);
      await ctx.close();
    }
    await saveMaskAs(at, seriesId, F.STUDY, "submitted", { objects: original.objects || [], labels: original.labels || [] });

    // ---- F-14: the job's settings fail to load -> read-only ----
    {
      const { ctx, page } = await open(browser, "dr-review", "Test1234!", viewerUrl(F.REVIEW_CARD), (p) =>
        p.route("**/jobs/*/surface-config", (route) => route.fulfill({ status: 503, body: "down" }))
      );
      check("a job whose settings don't load says so", (await page.locator('[data-testid="job-settings-failed"]').count()) === 1);
      const tools = await page.locator('[data-testid^="tool-"]').evaluateAll((els) => els.filter((e) => !e.disabled).map((e) => e.dataset.testid));
      check("... offers no drawing tool", tools.every((t) => t === "tool-cursor"), tools);
      check("... and can't save", await page.locator("header button", { hasText: /^Save$/ }).isDisabled());
      await ctx.close();
    }

    // ---- I-07: the saved mask doesn't load -> read-only, not an empty canvas ----
    {
      const { ctx, page } = await open(browser, "dr-test", "Test1234!", viewerUrl(F.ANNOT_CARD), (p) =>
        p.route("**/series/*/mask-volume", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 500, body: "Internal Server Error" }) : route.continue()))
      );
      check("a mask that doesn't load says so", (await page.locator('[data-testid="mask-load-failed"]').count()) === 1);
      const tools = await page.locator('[data-testid^="tool-"]').evaluateAll((els) => els.filter((e) => !e.disabled).map((e) => e.dataset.testid));
      check("... offers no drawing tool", tools.every((t) => t === "tool-cursor"), tools);
      check("... and can't save over it", await page.locator("header button", { hasText: /^Save$/ }).isDisabled());
      await ctx.close();
    }

    // ---- F-13: View as Reviewer switches the tool back to the cursor ----
    {
      const { ctx, page } = await open(browser, "platform-admin", "platform-admin", viewerUrl(F.ANNOT_CARD, "&viewAs=annotator"));
      await page.locator('[data-testid^="object-"]').first().click().catch(() => {});
      await page.locator('[data-testid="tool-paint"]').click().catch(() => {});
      const footerBefore = await page.locator('[data-guide="footer"]').innerText();
      await page.locator('header [data-testid="view-as"] [role="tab"]', { hasText: "Reviewer" }).click(); await page.waitForTimeout(800);
      const footer = await page.locator('[data-guide="footer"]').innerText();
      check("as Annotator the paint tool was on", /Drag=Draw/.test(footerBefore), footerBefore.slice(0, 120));
      check("as Reviewer the paint tool is gone (cursor only)", footer.length > 0 && !/Drag=Draw|Right-click drag=Erase/.test(footer), footer.slice(0, 120));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
