// Shared bits for the specs. Every spec is a plain Node script (no test
// runner): it prints PASS/FAIL lines and exits non-zero on any failure,
// so run.sh can aggregate them.
const F = require("./fixtures");

/** All guided tours, pre-marked "seen" -- their auto-opening overlay
 * would otherwise block the first click on a fresh browser profile.
 * Pass to context.addInitScript(). */
const seenGuides = () => {
  try {
    for (const k of ["workbench", "job", "case", "annotate", "review", "studies", "study", "patients", "patient", "annotation-types", "deidentification", "users", "notifications", "system", "board"])
      localStorage.setItem(`vl.guide.${k}.seen`, "1");
  } catch {}
};

/** Signs in on whichever surface shows up: admin-ui's own AuthPage
 * (:5173) or Keycloak's hosted form (ct-annotator opened directly). */
async function login(page, user, pass, url) {
  await page.goto(url);
  await Promise.race([
    page.waitForSelector("#username", { timeout: 30000 }),
    page.waitForSelector('[data-testid="signin-submit"]', { timeout: 30000 }),
  ]);
  if (await page.locator('[data-testid="signin-submit"]').isVisible().catch(() => false)) {
    await page.fill('input[autocomplete="username"]', user);
    await page.fill('input[type="password"]', pass);
    await page.click('[data-testid="signin-submit"]');
  } else {
    await page.fill("#username", user);
    await page.fill("#password", pass);
    await page.click("#kc-login");
  }
  await page.waitForURL((u) => !u.href.includes("localhost:8080"), { timeout: 30000 });
}

/** A password-grant access token for API calls from the spec itself. */
async function token(username, password) {
  const r = await fetch(`${F.KC}/realms/ct-platform/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "ct-platform", username, password, scope: "openid" }),
  });
  return (await r.json()).access_token;
}

/** Walks an open GuideTour to Finish; returns the step titles seen. */
async function walkTour(page) {
  const dialog = page.locator('[role="dialog"]');
  const titles = [];
  for (let i = 0; i < 40 && (await dialog.count()) > 0; i++) {
    titles.push((await dialog.getAttribute("aria-label")) || "");
    const next = dialog.locator("[data-guide-next]");
    const label = await next.innerText();
    await next.click();
    await page.waitForTimeout(150);
    if (label === "Finish") break;
  }
  return titles;
}

/** Saves a series' current segmentation again as `status` ("submitted" =
 * the annotator handing the case in), through the viewer backend, as the
 * token's user. Lets a spec make a case reviewable without drawing. */
async function saveMaskAs(tok, seriesId, studyId, status, extra = {}) {
  const headers = { Authorization: `Bearer ${tok}`, "content-type": "application/json" };
  const m = await (await fetch(`http://localhost:8010/series/${seriesId}/mask-volume`, { headers })).json();
  const empty = "H4sIAAAAAAAAAwMAAAAAAAAAAAA="; // gzip of zero bytes
  const r = await fetch(`http://localhost:8010/series/${seriesId}/mask-volume`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      study_id: studyId, mask_gzip_base64: m.mask_gzip_base64 || empty, labels: m.labels || [], objects: m.objects || [],
      status, base_version_id: m.version_id || "", ...extra,
    }),
  });
  return { status: r.status, body: await r.json().catch(() => null), before: m };
}

module.exports = { F, seenGuides, login, token, walkTour, saveMaskAs };
