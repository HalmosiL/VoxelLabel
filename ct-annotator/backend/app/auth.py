"""Keycloak JWT verification, vendored from the main platform's
`libs/shared-auth` -- that package is a private local install, not
published anywhere this repo could depend on, so this is the same ~30
lines of validation logic (RS256, same issuer/audience/JWKS) reimplemented
here so tokens issued for the main platform's Keycloak realm work
unmodified against this service too.

Unlike shared-auth, there is no `require_study_role` here and no direct
database access at all: every route that touches study-scoped data
forwards the caller's own bearer token to the main platform's existing
data-service/annotation-service, which already enforce that RBAC against
their own `study_memberships` table. Reimplementing that check here would
just be a second place for it to silently drift out of sync (see the
main platform's own case-sensitivity bug history for why that's a real
risk, not a theoretical one).
"""
from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import KEYCLOAK_AUDIENCE, KEYCLOAK_ISSUER, KEYCLOAK_JWKS_URL

_bearer_scheme = HTTPBearer()
_jwks_client = jwt.PyJWKClient(KEYCLOAK_JWKS_URL)


@dataclass
class CurrentUser:
    subject: str
    token: str  # the raw bearer token, forwarded as-is to upstream services


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme)) -> CurrentUser:
    """FastAPI dependency: validate the bearer token. Raises 401 if it's
    missing, expired, or fails signature/issuer/audience validation
    against Keycloak's published JWKS."""
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

    return CurrentUser(subject=claims["sub"], token=token)
