# Keycloak dev realm setup

`setup-dev-realm.sh` provisions everything the four services need to
validate JWTs locally: the `ct-platform` realm, an OIDC client with an
audience mapper, the global `admin` realm role, one test user holding it,
and a narrowly-scoped `admin-service-account` service-account client
(client-credentials, `view-users` role only) that admin-service uses to
list realm users for the project-member picker in admin-ui -- see
`services/admin-service/app/keycloak_admin.py`.

## Why this exists as a script, not manual clicking

The realm configuration is exactly reproducible, reviewable, and re-runnable
-- required for this codebase (see `ARCHITECTURE.md`, "Code organization
and review requirements"). It has been run end-to-end against a clean
Keycloak and verified to work in one pass (token issued, validated by
`admin-service`, project written to Postgres) without manual fixes.

## What it does NOT create

Per-project roles (`data_manager`, `annotator`, `reviewer`, `viewer`) --
those are rows in the `project_memberships` table (see
`shared_models.models.ProjectMembership`), granted via the admin-service
API (`POST /admin/projects/{project_id}/members`), not Keycloak roles. Only
the global `admin` realm role lives in Keycloak; see
`libs/shared-auth/shared_auth/auth.py`.

## Usage

```bash
docker compose up -d keycloak
./infra/keycloak/setup-dev-realm.sh
```

Safe to re-run -- it checks whether the realm already exists and exits
immediately if so, rather than erroring or duplicating resources.

Keycloak's data is persisted in the `keycloak-data` docker volume (see
`docker-compose.yml`), so this only needs to run once per environment
lifetime, unless that volume is removed (`docker compose down -v`).

## Getting a token to test against a running service

```bash
curl -s -X POST http://localhost:8080/realms/ct-platform/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=ct-platform" -d "username=platform-admin" -d "password=platform-admin" -d "grant_type=password" \
  | jq -r .access_token
```

This works against the services out of the box: `KEYCLOAK_ISSUER` for all
four services is set to `http://localhost:8080/realms/ct-platform` in
`docker-compose.yml`, matching the hostname a token was actually issued
from -- whether that's this curl command or the `admin-ui` browser login.

**Why there's also a `KEYCLOAK_JWKS_URL`:** the services run inside the
docker-compose network and can't reach Keycloak via `localhost:8080`
themselves (that resolves to the container, not the Keycloak container) --
they fetch the public signing keys via the internal hostname
`http://keycloak:8080/...` instead, set separately via `KEYCLOAK_JWKS_URL`.
Issuer *validation* (matching the token's `iss` claim) and key *fetching*
are deliberately decoupled in `shared_auth` for exactly this asymmetry --
see `libs/shared-auth/README.md`.

## Production

This script and `start-dev` mode are dev-only. Production uses the
Keycloak Operator with its own HA Postgres and a realm provisioned via
the operator's realm-import mechanism or Terraform, not this script --
see `infra/k8s/README.md`.
