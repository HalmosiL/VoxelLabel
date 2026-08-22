# admin-service

Platform administration: studies (the top-level, admin-created RBAC
container -- e.g. a research study or clinical protocol), study
memberships (per-study roles), de-identification profiles/rules, cases
(patient identity resolution), and clinical data items (generic files
attached to a case, plus their tags/consents), plus editing/deleting
imaging studies/series ingested under a case. Study/profile/
annotation-type management requires the global Keycloak `admin` realm
role; case, clinical-data, and imaging writes require a study-scoped
role instead (see `shared_auth`).

## Endpoints

- `GET /admin/studies` -- list studies (each with a presigned `cover_image_url` if one is set)
- `GET /admin/studies/{study_id}` -- get one study
- `POST /admin/studies` -- create a study
- `PATCH /admin/studies/{study_id}` -- update a study's name/description
- `DELETE /admin/studies/{study_id}` -- delete a study (409 if it still has cases -- remove them first)
- `POST /admin/studies/{study_id}/cover-image` -- attach/replace a study's cover image
- `GET /admin/studies/{study_id}/members` -- list a study's members
- `POST /admin/studies/{study_id}/members` -- grant a user a role on a study
- `GET /admin/keycloak-users` -- list realm users (id/username/email), for the study-member picker in admin-ui
- `POST /admin/studies/{study_id}/cases` -- create a case for either a new patient (`external_patient_id`, resolved/created from a real-world identifier) or an already-known one (`patient_id`, e.g. picked from the existing patients list) -- exactly one of the two is required; with optional date/type/title/comment
- `PATCH /admin/cases/{case_id}` -- update a case's accession number, date, type, title, or comment
- `POST /admin/cases/{case_id}/clinical-data-items` -- attach a clinical data item to a case, with an optional file
- `PATCH /admin/clinical-data-items/{item_id}` -- update an item's type/title/date
- `DELETE /admin/clinical-data-items/{item_id}` -- delete an item, its tags/consents, and its attached file
- `POST /admin/clinical-data-items/{item_id}/tags` -- add a tag to an item
- `POST /admin/clinical-data-items/{item_id}/consents` -- add a consent record to an item
- `PATCH /admin/imaging-studies/{imaging_study_id}` -- update an imaging study's description/modality
- `DELETE /admin/imaging-studies/{imaging_study_id}` -- delete an imaging study, cascading to its series/instances and their object storage files (pixel data + thumbnails)
- `PATCH /admin/series/{series_id}` -- update a series' description/body part
- `DELETE /admin/series/{series_id}` -- delete a series, cascading to its instances and their object storage files
- `GET /admin/deidentification-profiles` -- list de-identification profiles (with their rules)
- `POST /admin/deidentification-profiles` -- create a de-identification profile
- `POST /admin/deidentification-profiles/{profile_id}/rules` -- add a per-tag rule (keep/remove/replace_fixed/hash)
- `POST /admin/annotation-types` -- register a new annotation type with its JSON Schema
- `GET /admin/annotation-types` -- list registered annotation types
- `GET /admin/studies/{study_id}/workflow` -- get a study's workflow board (cards + edges), each card with a computed `output_count`/`stale` flag, and annotation/review cards additionally with a live `annotation_progress` cross-check against the real `Annotation` table
- `POST /admin/studies/{study_id}/workflow/cards` -- add a card (dataset/split/filter/annotation/review/union/note/milestone) to the board
- `PATCH /admin/workflow-cards/{card_id}` -- update a card's title/position/size/config; a plain annotator/reviewer (not data_manager/admin) may only flip the `status` of their own assigned annotation/review card, nothing else
- `DELETE /admin/workflow-cards/{card_id}` -- delete a card, cascading to any edge touching it (board scratch space, no "still has data" guard like Study/case deletes)
- `POST /admin/studies/{study_id}/workflow/edges` -- connect two cards (validates same-study, no self-loop, source/target handle compatibility per card type)
- `DELETE /admin/workflow-edges/{edge_id}` -- remove a connection
- `POST /admin/workflow-cards/{card_id}/run` -- execute a dataset/split/filter/union/annotation/review card: a Dataset with one incoming edge snapshots that upstream result as its own manual case list (a user-placed, general version of the auto-materialize below); Split partitions its input into N named parts, deterministically by a per-case-id hash (stable across re-runs as the input set grows), and materializes each part as a real Dataset card (created on first Run, updated in place -- keyed by `materialized_source_card_id`/`materialized_source_handle` -- on every re-run, never duplicated); Filter keeps cases matching a tag; Union dedupes N inputs; Annotation/Review pass their input through unchanged (the real "work" is the assignee/status in `config`, edited via PATCH) and, when `config.materialize_dataset` is set, also materialize a single "annotated dataset" card the same way -- containing only the subset of their assigned cases with a real `Annotation` record (approved/rejected for Review), not every assigned case
- `GET /health` -- liveness/readiness probe

Reading/listing cases and clinical data items lives in `data-service`, not
here -- this service only covers the write/creation side. See
ARCHITECTURE.md, "Case-centric data model".

## Module layout

| File | Responsibility |
|---|---|
| `app/main.py` | FastAPI app, route registration |
| `app/api/studies.py` | Study + membership management (the top-level RBAC container) |
| `app/api/cases.py` | Case creation + patient identity resolution (pseudonymization) |
| `app/api/clinical_data.py` | Clinical data item create/update/delete, tag/consent creation, incl. file upload |
| `app/api/imaging.py` | ImagingStudy/Series metadata edit and cascading delete (series/instances + their object storage files) |
| `app/api/deidentification.py` | De-identification profile/rule management |
| `app/api/annotation_types.py` | Annotation type registration (the JSON Schema that `annotation-service` validates payloads against) |
| `app/api/users.py` | Keycloak realm user lookup (study-member picker) |
| `app/api/workflow.py` | Per-study workflow board: card/edge CRUD and the Run execution logic (Split/Filter/Union/Annotation/Review) |
| `app/keycloak_admin.py` | Keycloak Admin API client (client-credentials token + user listing), using a narrowly-scoped service account -- not master-realm admin credentials |
| `app/storage.py` | Object storage upload/delete for clinical data files, study cover images, and (via `delete_object`) pixel data/thumbnails written by ingestion-service -- all services share one bucket |

## Running standalone

```bash
pip install -e ../../libs/shared-models -e ../../libs/shared-auth
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Requires `DATABASE_URL`, `OBJECT_STORAGE_*` and
`KEYCLOAK_ISSUER`/`KEYCLOAK_AUDIENCE` env vars -- see `.env.example` at the
repo root, or run `docker compose up` from the repo root for a fully wired
local environment.

## Testing standalone

```bash
pytest
```

`tests/test_health.py` and `tests/test_workflow.py` need no live DB or
Keycloak -- the latter covers the workflow board's pure logic (split
hashing, filter matching, union dedup, staleness); the Run/edge-validation/
cascade-delete behavior itself is exercised via curl against a live stack
instead.
