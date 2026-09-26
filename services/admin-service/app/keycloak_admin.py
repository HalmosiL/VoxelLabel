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
    return [_serialize_user(u, u["id"] in admin_ids) for u in response.json()]


def _serialize_user(u: dict, is_admin: bool) -> dict:
    created = u.get("createdTimestamp")
    return {
        "id": u["id"],
        "username": u.get("username"),
        "email": u.get("email"),
        "first_name": u.get("firstName"),
        "last_name": u.get("lastName"),
        "enabled": bool(u.get("enabled", True)),
        "email_verified": bool(u.get("emailVerified", False)),
        "required_actions": u.get("requiredActions") or [],
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created / 1000)) if created else None,
        "is_admin": is_admin,
    }


def _headers() -> dict:
    return {"Authorization": f"Bearer {_service_account_token()}"}


def _users_url(user_id: str = "") -> str:
    base = f"{settings.keycloak_internal_url}/admin/realms/{settings.keycloak_realm}/users"
    return f"{base}/{user_id}" if user_id else base


def get_user(user_id: str) -> dict:
    response = httpx.get(_users_url(user_id), headers=_headers())
    response.raise_for_status()
    return _serialize_user(response.json(), user_id in _admin_role_user_ids())


def update_user(user_id: str, **fields) -> dict:
    """Edits profile fields (first_name/last_name/email/enabled) -- Keycloak's
    PUT replaces the representation, so the current one is fetched and
    merged first, never overwritten blind."""
    current = httpx.get(_users_url(user_id), headers=_headers())
    current.raise_for_status()
    representation = current.json()
    mapping = {"first_name": "firstName", "last_name": "lastName", "email": "email", "enabled": "enabled"}
    for key, value in fields.items():
        if value is not None and key in mapping:
            representation[mapping[key]] = value
    response = httpx.put(_users_url(user_id), headers=_headers(), json=representation)
    response.raise_for_status()
    return get_user(user_id)


def set_admin_role(user_id: str, is_admin: bool) -> None:
    currently_admin = user_id in _admin_role_user_ids()
    if is_admin and not currently_admin:
        _grant_admin_role(user_id)
    elif not is_admin and currently_admin:
        role = httpx.get(f"{settings.keycloak_internal_url}/admin/realms/{settings.keycloak_realm}/roles/admin", headers=_headers())
        role.raise_for_status()
        response = httpx.request(
            "DELETE", f"{_users_url(user_id)}/role-mappings/realm", headers=_headers(), json=[role.json()]
        )
        response.raise_for_status()


def reset_password(user_id: str, password: str, temporary: bool = True) -> None:
    """Sets a new password; `temporary` makes Keycloak ask the person to
    choose their own at the next login (the "handed over by an admin"
    case), False sets it outright."""
    response = httpx.put(
        f"{_users_url(user_id)}/reset-password",
        headers=_headers(),
        json={"type": "password", "value": password, "temporary": temporary},
    )
    response.raise_for_status()


def password_status(username: str, password: str) -> str:
    """Checks a sign-in the way the sign-in page does (Keycloak's direct
    grant): "ok", "setup_required" -- the password is right but an action
    such as "update password" is still pending, which Keycloak refuses as
    "Account is not fully set up" -- or "invalid"."""
    response = httpx.post(
        f"{settings.keycloak_internal_url}/realms/{settings.keycloak_realm}/protocol/openid-connect/token",
        data={"grant_type": "password", "client_id": settings.keycloak_login_client_id, "username": username, "password": password},
        timeout=10,
    )
    if response.status_code == 200:
        return "ok"
    description = (response.json() if response.headers.get("content-type", "").startswith("application/json") else {}).get("error_description", "")
    return "setup_required" if "not fully set up" in description.lower() else "invalid"


def find_user_by_username(username: str) -> dict | None:
    response = httpx.get(_users_url(), headers=_headers(), params={"username": username, "exact": "true"})
    response.raise_for_status()
    match = next((u for u in response.json() if u.get("username") == username), None)
    return _serialize_user(match, match["id"] in _admin_role_user_ids()) if match else None


def finish_first_password(user_id: str, new_password: str) -> None:
    """Sets the person's own password and clears the pending "update
    password" action, so they can sign in on the admin-ui's own page."""
    reset_password(user_id, new_password, temporary=False)
    current = httpx.get(_users_url(user_id), headers=_headers())
    current.raise_for_status()
    representation = current.json()
    representation["requiredActions"] = [a for a in representation.get("requiredActions") or [] if a != "UPDATE_PASSWORD"]
    response = httpx.put(_users_url(user_id), headers=_headers(), json=representation)
    response.raise_for_status()


def delete_user(user_id: str) -> None:
    response = httpx.delete(_users_url(user_id), headers=_headers())
    response.raise_for_status()


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
