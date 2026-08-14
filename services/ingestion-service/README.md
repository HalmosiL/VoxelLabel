# ingestion-service

Accepts DICOM CT uploads, de-identifies them per an admin-configured
project profile, stores pixel data in object storage, and writes
patient/study/series/instance metadata to Postgres. Processing is
asynchronous: the HTTP API only stages the file and enqueues a job.

## Endpoints

- `POST /ingestion/projects/{project_id}/upload` -- upload a single DICOM
  file (requires `data_manager` or `admin` role on the project). Returns a
  `job_id` immediately; the file is processed by the Celery worker.
- `GET /health` -- liveness/readiness probe.

## Module layout

| File | Responsibility |
|---|---|
| `app/main.py` | FastAPI app, route registration |
| `app/api/routes.py` | HTTP layer: request/response, auth checks |
| `app/tasks.py` | Celery task wrapper (retries, error classification) |
| `app/pipeline.py` | Core ingestion logic: parse, validate, dedupe, persist -- no Celery/FastAPI dependency, directly unit-testable |
| `app/deidentify.py` | Applies a project's `DeidentificationProfile` to a pydicom dataset |
| `app/storage.py` | Object storage (MinIO/S3) upload |
| `app/worker.py` | Celery worker process entrypoint |

## Running standalone

```bash
pip install -e ../../libs/shared-models -e ../../libs/shared-auth
pip install -r requirements.txt

# API
uvicorn app.main:app --reload

# Worker (separate process, needs Redis running)
celery -A app.worker worker --loglevel=info
```

Requires `DATABASE_URL`, `REDIS_URL`, `OBJECT_STORAGE_*` and
`KEYCLOAK_ISSUER`/`KEYCLOAK_AUDIENCE` env vars -- see `.env.example` at the
repo root. Easiest local setup is `docker compose up` from the repo root,
which wires all of these together.

## Testing standalone

```bash
pytest
```

`tests/test_health.py` and `tests/test_deidentify.py` need no live DB,
Redis, or Keycloak -- they exercise the FastAPI app and the pure tag-
resolution helper directly. Testing `app/pipeline.py` end to end requires a
running Postgres and object storage (integration-level, not included yet).
