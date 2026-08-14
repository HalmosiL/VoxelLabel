# admin-service

Platform administration: projects, project memberships (per-project
roles), and de-identification profiles/rules. Every endpoint requires the
global Keycloak `admin` realm role.

## Endpoints

- `POST /admin/projects` -- create a project
- `POST /admin/projects/{project_id}/members` -- grant a user a role on a project
- `POST /admin/deidentification-profiles` -- create a de-identification profile
- `POST /admin/deidentification-profiles/{profile_id}/rules` -- add a per-tag rule (keep/remove/replace_fixed/hash)
- `POST /admin/annotation-types` -- register a new annotation type with its JSON Schema
- `GET /admin/annotation-types` -- list registered annotation types
- `GET /health` -- liveness/readiness probe

## Module layout

| File | Responsibility |
|---|---|
| `app/main.py` | FastAPI app, route registration |
| `app/api/projects.py` | Project + membership management |
| `app/api/deidentification.py` | De-identification profile/rule management |
| `app/api/annotation_types.py` | Annotation type registration (the JSON Schema that `annotation-service` validates payloads against) |

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

`tests/test_health.py` needs no live DB or Keycloak.
