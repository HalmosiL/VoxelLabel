"""Keycloak JWT verification and project-scoped role checks, shared by every service.

Identity always comes from a validated Keycloak access token; there is no
local password/session store. Authorization is two-tiered:

- a global Keycloak realm role "admin" grants access to everything
- everyone else is checked against the `project_memberships` table for a
  role scoped to the specific project being accessed

This module queries `project_memberships` with raw SQL rather than the
`shared_models` ORM models, so it has no hard dependency on that package --
the two libraries stay independently versionable and testable, per the
project's modularity requirement.
"""
import os
from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import text
from sqlalchemy.orm import Session

KEYCLOAK_ISSUER = os.environ.get("KEYCLOAK_ISSUER", "http://keycloak:8080/realms/ct-platform")
KEYCLOAK_AUDIENCE = os.environ.get("KEYCLOAK_AUDIENCE", "ct-platform")

_bearer_scheme = HTTPBearer()
_jwks_client = jwt.PyJWKClient(f"{KEYCLOAK_ISSUER}/protocol/openid-connect/certs")


@dataclass
class CurrentUser:
    """Identity extracted from a validated Keycloak access token."""

    subject: str
    email: str | None
    realm_roles: list[str]


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
) -> CurrentUser:
    """FastAPI dependency: validate the bearer token and extract identity.

    Raises 401 if the token is missing, expired, or fails signature/issuer/
    audience validation against Keycloak's published JWKS.
    """
    token = credentials.credentials
    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=KEYCLOAK_AUDIENCE,
            issuer=KEYCLOAK_ISSUER,
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc

    realm_roles = claims.get("realm_access", {}).get("roles", [])
    return CurrentUser(subject=claims["sub"], email=claims.get("email"), realm_roles=realm_roles)


def require_project_role(db: Session, project_id: str, user: CurrentUser, allowed_roles: list[str]) -> None:
    """Raise 403 unless `user` is a global admin or holds one of
    `allowed_roles` on `project_id`.

    Usage in a route:

        @router.get("/projects/{project_id}/studies")
        def list_studies(
            project_id: str,
            db: Session = Depends(get_db),
            user: CurrentUser = Depends(get_current_user),
        ):
            require_project_role(db, project_id, user, allowed_roles=["viewer", "annotator", "admin"])
            ...
    """
    if "admin" in user.realm_roles:
        return

    row = db.execute(
        text("SELECT role FROM project_memberships WHERE project_id = :pid AND user_id = :uid"),
        {"pid": project_id, "uid": user.subject},
    ).first()

    if row is None or row[0] not in allowed_roles:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient project role")
