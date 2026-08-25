"""Keycloak Admin API client for looking up and creating realm users --
backs the study-member "add user" picker and the global Users page in
admin-ui.

Uses a dedicated service account client (granted `view-users` and
`manage-users`, see infra/keycloak/setup-dev-realm.sh) instead of
master-realm admin credentials, so a leak of this secret is scoped to
this realm's users rather than the whole Keycloak instance.
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


def _admin_role_user_ids() -> set[str]:
    response = httpx.get(
        f"{settings.keycloak_internal_url}/admin/realms/{settings.keycloak_realm}/roles/admin/users",
        headers={"Authorization": f"Bearer {_service_account_token()}"},
        params={"max": 500},
    )
    response.raise_for_status()
    return {u["id"] for u in response.json()}


def list_realm_users() -> list[dict]:
    """Every user in the realm -- id (the Keycloak "sub" used everywhere
    else in this platform as the user identifier), username, email, and
    whether they hold the global "admin" realm role."""
    response = httpx.get(
        f"{settings.keycloak_internal_url}/admin/realms/{settings.keycloak_realm}/users",
        headers={"Authorization": f"Bearer {_service_account_token()}"},
        params={"max": 500},
    )
    response.raise_for_status()
    admin_ids = _admin_role_user_ids()
    return [
        {"id": u["id"], "username": u.get("username"), "email": u.get("email"), "is_admin": u["id"] in admin_ids}
        for u in response.json()
    ]


def create_user(username: str, email: str, first_name: str, last_name: str, password: str, is_admin: bool) -> dict:
    """Creates a realm user with a password credential (marked temporary,
    so Keycloak prompts them to set their own password at first login).
    firstName/lastName are required -- an account missing them gets a
    silent VERIFY_PROFILE required action that breaks login with a
    confusing "Account is not fully set up" error (see setup-dev-realm.sh)."""
    response = httpx.post(
        f"{settings.keycloak_internal_url}/admin/realms/{settings.keycloak_realm}/users",
        headers={"Authorization": f"Bearer {_service_account_token()}"},
        json={
            "username": username,
            "enabled": True,
            "email": email,
            "emailVerified": True,
            "firstName": first_name,
            "lastName": last_name,
            "credentials": [{"type": "password", "value": password, "temporary": True}],
        },
    )
    response.raise_for_status()
    user_id = response.headers["Location"].rsplit("/", 1)[-1]

    if is_admin:
        _grant_admin_role(user_id)

    return {"id": user_id, "username": username, "email": email, "is_admin": is_admin}


def _grant_admin_role(user_id: str) -> None:
    role = httpx.get(
        f"{settings.keycloak_internal_url}/admin/realms/{settings.keycloak_realm}/roles/admin",
        headers={"Authorization": f"Bearer {_service_account_token()}"},
    )
    role.raise_for_status()
    response = httpx.post(
        f"{settings.keycloak_internal_url}/admin/realms/{settings.keycloak_realm}/users/{user_id}/role-mappings/realm",
        headers={"Authorization": f"Bearer {_service_account_token()}"},
        json=[role.json()],
    )
    response.raise_for_status()
