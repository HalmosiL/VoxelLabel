# data-service

Read-focused API for browsing cases, ingested studies/series/instances,
and clinical data items, plus fetching their files. Files are never
proxied through this service -- callers get a short-lived presigned
object storage URL and fetch directly. Writing/creating this data (cases,
clinical data items, tags, consents) lives in admin-service, not here.

## Endpoints

- `GET /data/projects/{project_id}/cases` -- list cases in a project
- `GET /data/cases/{case_id}` -- get one case
- `GET /data/cases/{case_id}/studies` -- list studies in a case
- `GET /data/studies/{study_id}/series` -- list series within a study
- `GET /data/series/{series_id}/instances` -- list instances within a series
- `GET /data/instances/{instance_id}/pixel-data-url` -- presigned URL to the raw DICOM file
- `GET /data/cases/{case_id}/clinical-data-items` -- list clinical data items in a case (with tags/consents)
- `GET /data/clinical-data-items/{item_id}/file-url` -- presigned URL to the item's attached file (404 if it has none)
- `GET /health` -- liveness/readiness probe

All endpoints require a project role in `["viewer", "annotator", "reviewer", "data_manager", "admin"]`, checked via `shared_auth.require_project_role`.

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
