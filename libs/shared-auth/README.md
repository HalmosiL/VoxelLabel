# shared-auth

Keycloak JWT validation and project-scoped role checks, shared by every
service in the platform.

## Exports

- `get_current_user` -- FastAPI dependency that validates the bearer token
  against Keycloak's JWKS endpoint and returns a `CurrentUser`.
- `require_project_role(db, project_id, user, allowed_roles)` -- raises 403
  unless the user is a global Keycloak realm admin or holds one of
  `allowed_roles` on that project (checked against the `project_memberships`
  table via a raw SQL query, so this library does not depend on
  `shared-models`).

## Usage

```python
from fastapi import Depends
from sqlalchemy.orm import Session
from shared_auth import CurrentUser, get_current_user, require_project_role
from shared_models.database import get_db

@router.get("/projects/{project_id}/studies")
def list_studies(
    project_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    require_project_role(db, project_id, user, allowed_roles=["viewer", "annotator", "reviewer", "admin"])
    ...
```

## Env vars

- `KEYCLOAK_ISSUER` -- e.g. `http://keycloak:8080/realms/ct-platform`
- `KEYCLOAK_AUDIENCE` -- the client id configured for this platform in Keycloak

## Installing (local dev)

```bash
pip install -e .
```

## Testing standalone

`pytest` -- no live Keycloak or DB is required; tests should mock
`jwt.PyJWKClient` and pass an in-memory/mock `Session` for the
`require_project_role` checks.
