// The seeded dev data every spec assumes exists. Change here, not in the
// specs. See README.md for how to (re)create it.
const fixtures = {
  UI: "http://localhost:5173",
  VIEWER: "http://localhost:5174",
  KC: "http://localhost:8080",
  ADMIN: "http://localhost:8004",
  DATA: "http://localhost:8002",
  ANNOTATOR_API: "http://localhost:8010",
  // Study "LIDC-IDRI Real CT Sample" with its annotation + review job cards.
  STUDY: "4c6bfb9a-e10c-4000-9695-9952b28d891b",
  ANNOT_CARD: "4e12ad81-6738-4c43-9fb1-e210ea341780",
  REVIEW_CARD: "6a0488f5-9d03-47c9-9d35-c04e91f59737",
  // A case + series of that study with real pixel data (viewer tests).
  CASE: "aff78f3e-5371-4d8d-b660-426eec9a2b9e",
  SERIES: "a024cdbb-c95e-46f4-a344-aed0f20d3263",
  // Accounts created by infra/keycloak/setup-dev-realm.sh + the test users.
  ADMIN_USER: { username: "platform-admin", password: "platform-admin", subject: "17fd9f74-f180-4d21-a502-409f1082fc48" },
  ANNOTATOR: { username: "dr-test", password: "Test1234!", subject: "2d103fc8-09ea-48f6-ad0a-a753d847790b" },
  REVIEWER: { username: "dr-review", password: "Test1234!", subject: "e62a5f35-15ec-464b-a955-76a286e49ac0" },
};

// In CI, `e2e/seed.py` provisions a fresh stack from scratch and writes the
// real ids it created here -- overlaid over the hardcoded local-dev
// defaults above (only the fields a generated run actually produces:
// STUDY/ANNOT_CARD/REVIEW_CARD/CASE/SERIES as plain strings, and each
// account's `subject`, since seed.py reuses the same usernames/passwords
// above rather than generating new ones). Local devs running against their
// own long-lived sandbox never have this file, so nothing changes for them.
try {
  const generated = require("./fixtures.generated.json");
  for (const [key, value] of Object.entries(generated)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(fixtures[key], value);
    } else {
      fixtures[key] = value;
    }
  }
} catch (err) {
  if (err.code !== "MODULE_NOT_FOUND") throw err;
}

module.exports = fixtures;
