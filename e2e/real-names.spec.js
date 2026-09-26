// People are shown by the name set on the Users page (UX: "the names set
// on Users show nowhere, the avatar says UX"): the study's members, the
// board's assignee, the Jobs list, the study analytics and the sidebar.
// dr-test is "Anna Annotator", platform-admin "Platform Admin" locally.
const { chromium } = require("playwright");
const { F, login, seenGuides } = require("./helpers");
const UI = "http://localhost:5173";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  if (seenGuides) await ctx.addInitScript(seenGuides);
  const page = await ctx.newPage();
  await login(page, "platform-admin", "platform-admin", `${UI}/studies/${F.STUDY}`);
  await page.waitForSelector('[data-guide="members"] table', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const members = await page.locator('[data-guide="members"]').innerText();
  check("members are listed by name", /Anna Annotator/.test(members) && /Rita Reviewer/.test(members), members.slice(0, 300));
  check("... with the username beside it", /@dr-test/.test(members));
  const avatar = await page.locator('[data-guide="members"] .avatar').first().innerText();
  check("... and name initials on the avatar", /^[A-ZÁÉÍÓÖŐÚÜŰ]{2}$/.test(avatar) && avatar !== "00", avatar);
  check("the sidebar shows the signed-in person's name", /Platform Admin/.test(await page.locator('[data-guide="account"]').innerText()));

  await page.goto(`${UI}/jobs`);
  await page.waitForSelector("table", { timeout: 30000 });
  await page.waitForTimeout(1500);
  check("the Jobs list names the assignee", /Anna Annotator/.test(await page.locator("table").innerText()));

  await page.goto(`${UI}/studies/${F.STUDY}/workflow`);
  await page.waitForSelector(".react-flow__node", { timeout: 30000 });
  await page.waitForTimeout(2000);
  check("the board card names its assignee", /Anna Annotator/.test(await page.locator(".react-flow").innerText()));

  await page.goto(`${UI}/studies/${F.STUDY}/analytics`);
  await page.waitForTimeout(5000);
  const analytics = await page.locator("main").innerText();
  check("study analytics name the people", /Anna Annotator|Rita Reviewer/.test(analytics) && !/\bdr-test\b/.test(analytics));
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
