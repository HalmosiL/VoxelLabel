# Testing VoxelLabel

Four layers, each runnable on its own. Nothing needs Python or Node on
the host -- everything runs in the compose stack or a pinned container.

| Layer | What it proves | Command | Needs |
|---|---|---|---|
| **Unit (backend)** | pure logic per service: workflow math, job-status rules, notification diff/compose, de-identification, thumbnails, DICOM rendering | `make test` (or `docker compose run --rm --no-deps admin-service python -m pytest -q tests`) | nothing |
| **Unit (frontend)** | admin-ui: sign-in/register form, tour engine, token handoff, error wording; viewer: fill/histogram/plane math | `make test-ui` · `cd ../ct-annotator/frontend && npx vitest run` | Node container |
| **Integration** | the real admin-service against a real Postgres: every endpoint's behaviour, role gates, computed job status, notification cycles, registration, audit trail | `make test-integration` (= `scripts/test-integration.sh`) | compose Postgres |
| **End to end** | a real browser through every surface: sign-in/registration, workbench + admin pages with their tours, board, viewer annotate/review/tutorial, notifications, audit, session handoff | `make test-e2e` (= `e2e/run.sh`) | the whole stack running + seeded data (`e2e/README.md`) |

`make test-all` runs all four. CI (`.github/workflows/ci.yml`) runs the
first three on every push; e2e runs on a developer machine or a test
server against live data.

## Where things live

```
services/<svc>/tests/                 backend unit tests (pytest, no DB)
services/admin-service/tests/integration/   integration tests (pytest + Postgres)
admin-ui/src/**/*.test.tsx            frontend unit tests (Vitest + Testing Library)
../ct-annotator/frontend/src/**/*.test.ts
e2e/*.spec.js                         browser specs (Playwright, plain Node scripts)
```

## Backend unit tests

Pure functions only -- the modules keep their logic separate from the
FastAPI plumbing on purpose (`app/api/workflow/status.py`,
`app/notifications/events.py`, ...), so tests import and call them with
plain data. Run for one service:

```bash
docker compose run --rm --no-deps -v "$PWD/services/admin-service/tests:/app/tests" \
  -v "$PWD/services/admin-service/app:/app/app" admin-service python -m pytest -q tests
```

(The two `-v` mounts test the working tree without rebuilding the image.)

## Integration tests (`services/admin-service/tests/integration`)

`scripts/test-integration.sh` creates a `ctplatform_test` database in
the compose Postgres, then runs pytest inside a throwaway admin-service
container with `DATABASE_URL` pointed at it. The harness
(`integration/conftest.py`):

- creates the schema from the ORM models (`Base.metadata.create_all`)
  and **truncates every table after each test**;
- replaces `get_current_user` with whoever the test says --
  `client.as_admin()`, `client.as_user(SUBJECT, ["roles"])` -- so there
  are no tokens;
- replaces Keycloak with an in-memory directory (`keycloak` fixture,
  with a call log) and SMTP with a recorder (`outbox` fixture);
- refuses to run unless the database name ends in `_test`.

Builders: `make_study`, `add_member`, `make_case`, `make_series` (imaging
rows without pixel data), `make_annotation` (one version with a status,
as the viewer's save writes it). A typical test:

```python
def test_job_status_follows_the_cases(client, db):
    sid, cases, series, ann, rev = _pipeline(client, db)      # study, members, cases, Dataset->Annotation->Review, run
    make_annotation(db, sid, series[0], ANNOTATOR_SUBJECT, "submitted")
    assert _job(client, ANNOTATOR_SUBJECT, ann["id"])["status"] == "in_progress"
```

Coverage by file: `test_studies_members` (RBAC, membership upsert,
delete guard), `test_cases_patients` (pseudonymisation, role gates,
cascade, all-cases dataset), `test_workflow_jobs` (cards/edges/run,
My Jobs, computed status through draft → submitted → rejected →
approved, splits, surface config), `test_registration_users_audit`,
`test_notifications_api`, `test_config_and_versions`.

Options pass through: `scripts/test-integration.sh -k notifications -x`.

## Frontend unit tests

Vitest + Testing Library, jsdom. `npm test` in `admin-ui/` (or
`make test-ui` to run it in a Node container). Mock the two modules
with side effects -- `../keycloak` and `../api/adminApi` -- with
`vi.mock`; render pages with `render(<AuthPage ... />)`; query by
label/role/test id, never by CSS class.

## End-to-end specs

See `e2e/README.md`. Each spec is a standalone Node script against the
running stack; `e2e/run.sh [names]` runs them in the Playwright image
and prints one line per spec. They are the only layer that exercises
the viewer's rendering, the real Keycloak, and the two apps together.

## Adding coverage for a new feature

1. Logic that can be a pure function → a unit test next to it.
2. A new endpoint → an integration test (the harness gives you a real
   DB and a chosen caller for free).
3. A new screen or a change in how screens connect → an e2e spec, with
   `data-testid`/`data-guide` anchors on the elements it needs.
