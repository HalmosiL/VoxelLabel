# admin-service

Platform administration: projects, project memberships (per-project
roles), de-identification profiles/rules, cases (patient identity
resolution), and clinical data items (generic files attached to a case,
plus their tags/consents). Project/profile/annotation-type management
requires the global Keycloak `admin` realm role; case and clinical-data
writes require a project-scoped role instead (see `shared_auth`).

## Endpoints

- `GET /admin/projects` -- list projects (each with a presigned `cover_image_url` if one is set)
- `POST /admin/projects` -- create a project
- `PATCH /admin/projects/{project_id}` -- update a project's name/description
- `DELETE /admin/projects/{project_id}` -- delete a project (409 if it still has cases -- remove them first)
- `POST /admin/projects/{project_id}/cover-image` -- attach/replace a project's cover image
- `GET /admin/projects/{project_id}/members` -- list a project's members
- `POST /admin/projects/{project_id}/members` -- grant a user a role on a project
- `GET /admin/keycloak-users` -- list realm users (id/username/email), for the project-member picker in admin-ui
- `POST /admin/projects/{project_id}/cases` -- create a case, resolving/creating its patient from a real-world identifier, with optional date/type/title/comment
- `PATCH /admin/cases/{case_id}` -- update a case's accession number, date, type, title, or comment
- `POST /admin/cases/{case_id}/clinical-data-items` -- attach a clinical data item to a case, with an optional file
- `POST /admin/clinical-data-items/{item_id}/tags` -- add a tag to an item
- `POST /admin/clinical-data-items/{item_id}/consents` -- add a consent record to an item
- `GET /admin/deidentification-profiles` -- list de-identification profiles (with their rules)
- `POST /admin/deidentification-profiles` -- create a de-identification profile
- `POST /admin/deidentification-profiles/{profile_id}/rules` -- add a per-tag rule (keep/remove/replace_fixed/hash)
- `POST /admin/annotation-types` -- register a new annotation type with its JSON Schema
- `GET /admin/annotation-types` -- list registered annotation types
- `GET /health` -- liveness/readiness probe

Reading/listing cases and clinical data items lives in `data-service`, not
here -- this service only covers the write/creation side. See
ARCHITECTURE.md, "Case-centric data model".

## Module layout

| File | Responsibility |
|---|---|
| `app/main.py` | FastAPI app, route registration |
| `app/api/projects.py` | Project + membership management |
| `app/api/cases.py` | Case creation + patient identity resolution (pseudonymization) |
| `app/api/clinical_data.py` | Clinical data item / tag / consent creation, incl. file upload |
| `app/api/deidentification.py` | De-identification profile/rule management |
| `app/api/annotation_types.py` | Annotation type registration (the JSON Schema that `annotation-service` validates payloads against) |
| `app/api/users.py` | Keycloak realm user lookup (project-member picker) |
| `app/keycloak_admin.py` | Keycloak Admin API client (client-credentials token + user listing), using a narrowly-scoped service account -- not master-realm admin credentials |
| `app/storage.py` | Object storage upload for clinical data files (internal hostname -- real uploads, unlike data-service) |

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

`tests/test_health.py` needs no live DB or Keycloak.
