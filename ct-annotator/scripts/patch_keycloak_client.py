#!/usr/bin/env python3
"""One-time setup: appends this repo's frontend origin to the main
platform's existing `ct-platform` Keycloak client's `redirectUris`/
`webOrigins`, so this frontend can log in through the *same* client
(and therefore get tokens with the same `aud=ct-platform` the main
platform's services already expect) without touching that platform's
own repo/config files at all.

Purely additive and idempotent: only appends the origin if it isn't
already present; never removes or replaces existing entries, so
re-running this (or running it against a realm the main platform's own
`infra/keycloak/setup-dev-realm.sh` already provisioned) is always safe.

Usage:
    python3 scripts/patch_keycloak_client.py \\
        --keycloak-url http://localhost:8080 \\
        --admin-username admin --admin-password admin \\
        --frontend-origin http://localhost:5174
"""
import argparse
import json
import urllib.parse
import urllib.request

REALM = "ct-platform"
CLIENT_ID = "ct-platform"


def _post_form(url: str, data: dict) -> dict:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def _request(url: str, token: str, method: str = "GET", body: dict | None = None):
    headers = {"Authorization": f"Bearer {token}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def get_master_admin_token(keycloak_url: str, admin_username: str, admin_password: str) -> str:
    token_url = f"{keycloak_url}/realms/master/protocol/openid-connect/token"
    token_response = _post_form(
        token_url,
        {"client_id": "admin-cli", "grant_type": "password", "username": admin_username, "password": admin_password},
    )
    return token_response["access_token"]


def patch_client_origin(keycloak_url: str, token: str, frontend_origin: str) -> None:
    clients = _request(f"{keycloak_url}/admin/realms/{REALM}/clients?clientId={CLIENT_ID}", token)
    if not clients:
        raise RuntimeError(f"Client '{CLIENT_ID}' not found in realm '{REALM}' -- is the main platform provisioned?")
    client = clients[0]
    client_uuid = client["id"]

    redirect_uris = set(client.get("redirectUris", []))
    web_origins = set(client.get("webOrigins", []))
    new_redirect = f"{frontend_origin}/*"

    if new_redirect in redirect_uris and frontend_origin in web_origins:
        print(f"'{frontend_origin}' is already allowed -- nothing to do.")
        return

    redirect_uris.add(new_redirect)
    web_origins.add(frontend_origin)
    client["redirectUris"] = sorted(redirect_uris)
    client["webOrigins"] = sorted(web_origins)

    _request(f"{keycloak_url}/admin/realms/{REALM}/clients/{client_uuid}", token, method="PUT", body=client)
    print(f"Added '{frontend_origin}' to the '{CLIENT_ID}' client's redirectUris/webOrigins.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keycloak-url", default="http://localhost:8080")
    parser.add_argument("--admin-username", default="admin")
    parser.add_argument("--admin-password", default="admin")
    parser.add_argument("--frontend-origin", default="http://localhost:5174")
    args = parser.parse_args()

    token = get_master_admin_token(args.keycloak_url, args.admin_username, args.admin_password)
    patch_client_origin(args.keycloak_url, token, args.frontend_origin)


if __name__ == "__main__":
    main()
