# Keycloak dev realm setup

`setup-dev-realm.sh` provisions everything the four services need to
validate JWTs locally: the `ct-platform` realm, an OIDC client with an
audience mapper, the global `admin` realm role, and one test user holding
it.

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

**Caveat:** the token's `iss` claim reflects the hostname you requested it
from. A token fetched via `localhost:8080` has `iss=http://localhost:8080/...`,
but the services (running inside the docker-compose network) validate
against `KEYCLOAK_ISSUER=http://keycloak:8080/realms/ct-platform`. For a
token that validates against the services, request it from inside the
same docker network, e.g.:

```bash
docker run --rm --network annotator-pipline_default curlimages/curl:latest \
  curl -s -X POST http://keycloak:8080/realms/ct-platform/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=ct-platform" -d "username=platform-admin" -d "password=platform-admin" -d "grant_type=password"
```

A real frontend would instead use the standard authorization code flow
through a browser redirect to Keycloak's own hostname, which does not have
this mismatch.

## Production

This script and `start-dev` mode are dev-only. Production uses the
Keycloak Operator with its own HA Postgres and a realm provisioned via
the operator's realm-import mechanism or Terraform, not this script --
see `infra/k8s/README.md`.
