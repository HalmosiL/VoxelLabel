"""Keycloak Admin API client for looking up realm users -- backs the
study-member "add user" picker in admin-ui.

Uses a dedicated, narrowly-scoped service account client (granted only the
`view-users` role, see infra/keycloak/setup-dev-realm.sh) instead of
master-realm admin credentials, so a leak of this secret can't do more
than read this realm's user list.
"""
import time

import httpx

from app.core.config import settings

_cached_token: str | None = None
_cached_token_expiry: float = 0.0


def _service_account_token() -> str:
    global _cached_token, _cached_token_expiry
    if _cached_token and time.time() < _cached_token_expiry:
        return _cached_token

    response = httpx.post(
        f"{settings.keycloak_internal_url}/realms/{settings.keycloak_realm}/protocol/openid-connect/token",
        data={
            "client_id": settings.keycloak_admin_client_id,
            "client_secret": settings.keycloak_admin_client_secret,
            "grant_type": "client_credentials",
        },
    )
    response.raise_for_status()
    payload = response.json()

    _cached_token = payload["access_token"]
    _cached_token_expiry = time.time() + payload["expires_in"] - 10  # refresh a bit early
    return _cached_token


def list_realm_users() -> list[dict]:
    """Every user in the realm -- id (the Keycloak "sub" used everywhere
    else in this platform as the user identifier), username, email."""
    response = httpx.get(
        f"{settings.keycloak_internal_url}/admin/realms/{settings.keycloak_realm}/users",
        headers={"Authorization": f"Bearer {_service_account_token()}"},
        params={"max": 500},
    )
    response.raise_for_status()
    return [{"id": u["id"], "username": u.get("username"), "email": u.get("email")} for u in response.json()]
