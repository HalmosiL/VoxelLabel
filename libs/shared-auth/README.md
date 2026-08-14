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

- `KEYCLOAK_ISSUER` -- must exactly match the `iss` claim callers' tokens will
  have, which depends on the hostname *they* used to reach Keycloak (e.g.
  `http://localhost:8080/realms/ct-platform` for browser clients going
  through a published port).
- `KEYCLOAK_JWKS_URL` -- where *this service* fetches Keycloak's public keys
  from, which may need a different, internally-reachable hostname (e.g.
  `http://keycloak:8080/realms/ct-platform/protocol/openid-connect/certs`
  inside docker-compose/Kubernetes). Defaults to `{KEYCLOAK_ISSUER}/protocol/openid-connect/certs`
  when unset, which is correct only if issuer and JWKS are reachable at the
  same hostname.
- `KEYCLOAK_AUDIENCE` -- the client id configured for this platform in Keycloak

## Installing (local dev)

```bash
pip install -e .
```

## Testing standalone

`pytest` -- no live Keycloak or DB is required; tests should mock
`jwt.PyJWKClient` and pass an in-memory/mock `Session` for the
`require_project_role` checks.
