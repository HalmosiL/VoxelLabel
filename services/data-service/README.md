# data-service

Read-focused API for browsing cases, ingested imaging studies/series/
instances, and clinical data items, plus fetching their files. Files are
never proxied through this service -- callers get a short-lived presigned
object storage URL and fetch directly. Writing/creating this data (cases,
clinical data items, tags, consents) lives in admin-service, not here.

## Endpoints

- `GET /data/studies/{study_id}/cases` -- list cases in a study (with date/type/title/comment and rolled-up tags)
- `GET /data/cases/{case_id}` -- get one case
- `GET /data/cases/{case_id}/imaging-studies` -- list imaging studies in a case, each with a representative `thumbnail_url`
- `GET /data/cases/{case_id}/series` -- every series across every imaging study in the case, flattened, each with `thumbnail_url` and its parent imaging study reference
- `GET /data/imaging-studies/{imaging_study_id}/series` -- list series within one imaging study, with `thumbnail_url`
- `GET /data/series/{series_id}/instances` -- list instances within a series, with `thumbnail_url`
- `GET /data/instances/{instance_id}/pixel-data-url` -- presigned URL to the raw DICOM file
- `GET /data/cases/{case_id}/clinical-data-items` -- list clinical data items in a case (with tags/consents)
- `GET /data/clinical-data-items/{item_id}/file-url` -- presigned URL to the item's attached file (404 if it has none)
- `GET /data/patients` -- list all patients, across every study (global `admin` role only -- see below)
- `GET /data/patients/{patient_id}/cases` -- a patient's cases across every study, each with its imaging studies (with `thumbnail_url`), full clinical data items, and flattened tags (global `admin` role only) -- enough to edit/delete a patient's images and documents without opening each case
- `GET /health` -- liveness/readiness probe

The two `/data/patients*` endpoints require the global Keycloak `admin`
realm role rather than a study-scoped one: a patient's cases can span
multiple studies, so there is no single study to check a role against.

All endpoints require a study role in `["viewer", "annotator", "reviewer", "data_manager", "admin"]`, checked via `shared_auth.require_study_role`.

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

`tests/test_health.py` needs no live DB, object storage, or Keycloak.
