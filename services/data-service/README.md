# data-service

Read-focused API for browsing ingested studies/series/instances and
fetching pixel data. Pixel data is never proxied through this service --
callers get a short-lived presigned object storage URL and fetch directly.

## Endpoints

- `GET /data/projects/{project_id}/studies` -- list studies in a project
- `GET /data/studies/{study_id}/series` -- list series within a study
- `GET /data/series/{series_id}/instances` -- list instances within a series
- `GET /data/instances/{instance_id}/pixel-data-url` -- presigned URL to the raw DICOM file
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
