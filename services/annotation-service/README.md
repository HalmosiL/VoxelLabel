# annotation-service

Owns annotation create/list/review. Annotation types (bbox, segmentation
mask, label, ...) are registered as data (`AnnotationType.json_schema` in
`shared-models`), not hardcoded here -- this service stays unchanged when a
new annotation type is added.

## Endpoints

- `POST /annotations/projects/{project_id}` -- create a draft annotation (role: `annotator`/`admin`). Payload is validated against the type's JSON Schema.
- `GET /annotations/{target_type}/{target_id}` -- list annotations for a target (role: `viewer`/`annotator`/`reviewer`/`admin`)
- `POST /annotations/{annotation_id}/review` -- approve/reject (role: `reviewer`/`admin`)
- `GET /health` -- liveness/readiness probe

## Module layout

| File | Responsibility |
|---|---|
| `app/main.py` | FastAPI app, route registration |
| `app/api/routes.py` | HTTP layer: request/response, auth checks |
| `app/validation.py` | JSON Schema payload validation -- pure, no DB/FastAPI dependency |

## Running standalone

```bash
pip install -e ../../libs/shared-models -e ../../libs/shared-auth
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Requires `DATABASE_URL` and `KEYCLOAK_ISSUER`/`KEYCLOAK_AUDIENCE` env vars
-- see `.env.example` at the repo root, or run `docker compose up` from the
repo root for a fully wired local environment.

## Testing standalone

```bash
pytest
```

`tests/test_health.py` and `tests/test_validation.py` need no live DB or
Keycloak.
