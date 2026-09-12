// The seeded dev data every spec assumes exists. Change here, not in the
// specs. See README.md for how to (re)create it.
module.exports = {
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
