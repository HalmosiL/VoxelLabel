"""Keycloak JWT verification and study-scoped role checks, shared by every service.

Identity always comes from a validated Keycloak access token; there is no
local password/session store. Authorization is two-tiered:

- a global Keycloak realm role "admin" grants access to everything
- everyone else is checked against the `study_memberships` table for a
  role scoped to the specific study being accessed

This module queries `study_memberships` with raw SQL rather than the
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

# The `iss` claim in a token reflects whatever hostname the *caller* used to
# reach Keycloak -- a browser goes through the published port (e.g.
# localhost:8080), while a backend-to-backend caller inside the docker/k8s
# network uses the internal service hostname (e.g. keycloak:8080). Those can
# differ, so JWKS fetching (this service reaching Keycloak) is configured
# separately from issuer validation (matching what's actually in the token).
# Defaults to KEYCLOAK_ISSUER for the common case where they're the same.
KEYCLOAK_JWKS_URL = os.environ.get("KEYCLOAK_JWKS_URL", f"{KEYCLOAK_ISSUER}/protocol/openid-connect/certs")

_bearer_scheme = HTTPBearer()
_jwks_client = jwt.PyJWKClient(KEYCLOAK_JWKS_URL)


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


def require_study_role(db: Session, study_id: str, user: CurrentUser, allowed_roles: list[str]) -> None:
    """Raise 403 unless `user` is a global admin or holds one of
    `allowed_roles` on `study_id`.

    Usage in a route:

        @router.get("/studies/{study_id}/cases")
        def list_cases(
            study_id: str,
            db: Session = Depends(get_db),
            user: CurrentUser = Depends(get_current_user),
        ):
            require_study_role(db, study_id, user, allowed_roles=["viewer", "annotator", "admin"])
            ...
    """
    if "admin" in user.realm_roles:
        return

    # A user can hold more than one role in the same study (role is part
    # of study_memberships' primary key -- see StudyMembership's own
    # docstring), so this checks whether *any* of their rows for this
    # study matches, not a single row's one role.
    rows = db.execute(
        text("SELECT role FROM study_memberships WHERE study_id = :sid AND user_id = :uid"),
        {"sid": study_id, "uid": user.subject},
    ).fetchall()

    # The Postgres enum backing this column stores StudyRole's member
    # NAMES ("ADMIN", "DATA_MANAGER", ...), not its lowercase .value
    # ("admin", "data_manager", ...) that `allowed_roles` lists always use
    # -- a plain raw-SQL string read gets the former, so it's compared
    # case-insensitively here rather than assuming either casing.
    if not any(row[0].lower() in allowed_roles for row in rows):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient study role")


def require_any_study_role(db: Session, user: CurrentUser, allowed_roles: list[str] | None = None) -> None:
    """Raise 403 unless `user` is a global admin or holds a role in at
    least one study -- one of `allowed_roles` if given, any role if not.
    For platform-wide configuration that study work needs but an account
    belonging to no study has no business reading (A-09)."""
    if "admin" in user.realm_roles:
        return
    rows = db.execute(text("SELECT role FROM study_memberships WHERE user_id = :uid"), {"uid": user.subject}).fetchall()
    # stored as enum member NAMES -- compared case-insensitively, as above
    if not any(allowed_roles is None or row[0].lower() in allowed_roles for row in rows):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient study role")
