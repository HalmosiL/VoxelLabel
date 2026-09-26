// UX: the Usage page opened on every study on the platform -- the QA and
// test studies included -- and its "Act now" was about work the viewer
// can't change. It now opens on "My studies" (the studies the viewer is a
// member of or created) and remembers the last choice. platform-admin is
// a member of the fixture studies (created-but-not-joined is covered by
// admin-service's test_me_names_the_studies_i_created).
const { chromium } = require("playwright");
const { login, seenGuides } = require("./helpers");
const UI = "http://localhost:5173";

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: Boolean(ok), extra });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  if (seenGuides) await ctx.addInitScript(seenGuides);
  const page = await ctx.newPage();
  await login(page, "platform-admin", "platform-admin", `${UI}/usage`);
  const filter = page.locator('[data-testid="usage-study-filter"]');
  await filter.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="usage-study-filter"]')?.value === "mine", null, { timeout: 15000 }).catch(() => {});
  const label = await filter.locator('option[value="mine"]').innerText().catch(() => "");
  check("the page opens on My studies", (await filter.inputValue()) === "mine", await filter.inputValue());
  check("... counted in the option", /My studies \((\d+)\)/.test(label) && Number(label.match(/\((\d+)\)/)[1]) >= 2, label);
  await page.waitForSelector('[data-testid="usage-basis"]', { timeout: 30000 }).catch(() => {});
  check("... and says so above the figures", /my \d+ studies|my study/.test(await page.locator('[data-testid="usage-range-label"]').innerText()));
  await filter.selectOption("");
  await page.waitForTimeout(1500);
  await page.reload();
  await filter.waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  check("the last choice is remembered", (await filter.inputValue()) === "", await filter.inputValue());
  check("... and said: all studies", /all studies/.test(await page.locator('[data-testid="usage-range-label"]').innerText()));
  await browser.close();

  const fails = results.filter((x) => !x.ok);
  console.log(`checks ${results.length}, fails ${fails.length}`);
  for (const f of fails) console.log("FAIL", f.name, JSON.stringify(f.extra ?? null).slice(0, 300));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("EXC", e); process.exit(1); });
