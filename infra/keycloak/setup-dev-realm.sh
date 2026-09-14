#!/usr/bin/env bash
# Provisions the ct-platform Keycloak realm for local development: the
# realm itself, an OIDC client (with an audience mapper so access tokens
# validate against KEYCLOAK_AUDIENCE), the global "admin" realm role, and
# one test user holding that role.
#
# Per-study roles (data_manager/annotator/reviewer/viewer) are NOT
# created here -- those live in the study_memberships table (see
# shared_models.models.StudyMembership), not in Keycloak. Only the
# global "admin" role is a Keycloak realm role; see ARCHITECTURE.md
# ("Access control: study-scoped RBAC").
#
# Safe to re-run: if the realm already exists, only its mutable settings
# (sslRequired, the client's redirectUris/webOrigins) are reconciled
# against the current ADMIN_UI_ORIGIN/EXTRA_ORIGINS -- the realm, roles,
# test user and service account are created once and never touched
# again (re-creating them would just 409).
#
# Usage: KEYCLOAK_URL=http://localhost:8080 ./setup-dev-realm.sh
set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
REALM="${REALM:-ct-platform}"
CLIENT_ID="${CLIENT_ID:-ct-platform}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
TEST_USERNAME="${TEST_USERNAME:-platform-admin}"
TEST_PASSWORD="${TEST_PASSWORD:-platform-admin}"
ADMIN_UI_ORIGIN="${ADMIN_UI_ORIGIN:-http://localhost:5173}"
# Comma-separated extra browser origins to allow on the same client: the
# ct-annotator viewer and the clinician desktop app's local server.
EXTRA_ORIGINS="${EXTRA_ORIGINS:-http://localhost:5174,http://127.0.0.1:45678}"
SERVICE_ACCOUNT_CLIENT_ID="${SERVICE_ACCOUNT_CLIENT_ID:-admin-service-account}"
SERVICE_ACCOUNT_CLIENT_SECRET="${SERVICE_ACCOUNT_CLIENT_SECRET:-admin-service-account-secret}"

echo "Waiting for Keycloak at $KEYCLOAK_URL ..."
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "$KEYCLOAK_URL/realms/master" && break
  sleep 2
done

admin_token() {
  curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=$ADMIN_USER" -d "password=$ADMIN_PASSWORD" \
    -d "grant_type=password" -d "client_id=admin-cli" | jq -r .access_token
}

TOKEN=$(admin_token)

# Every realm (master included) defaults to sslRequired "external" --
# plain HTTP is accepted from what Keycloak considers a local address
# (localhost, RFC1918 private ranges) but refused with a bare "HTTPS
# required" page from anywhere else, including a real public IP with no
# TLS in front of it -- exactly the shape of INSTALL.md's own "plain
# ports, no reverse proxy" fast path. A minimal PUT (Keycloak's realm/
# client update endpoints only touch the fields actually present in the
# body, so this can't clobber anything else already configured) turns
# it off; run every time, including against an already-existing realm,
# since that's precisely the realm a public-IP deployment hits this on.
echo "Turning off Keycloak's HTTPS requirement (master + $REALM; this platform terminates TLS at a reverse proxy if it wants HTTPS, not here) ..."
curl -sf -X PUT "$KEYCLOAK_URL/admin/realms/master" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sslRequired": "none"}' >/dev/null

realm_status=$(curl -s -o /dev/null -w "%{http_code}" "$KEYCLOAK_URL/admin/realms/$REALM" \
  -H "Authorization: Bearer $TOKEN")
realm_existed="false"
if [ "$realm_status" = "200" ]; then
  realm_existed="true"
  echo "Realm '$REALM' already exists -- reconciling its mutable settings, skipping the rest."
  curl -sf -X PUT "$KEYCLOAK_URL/admin/realms/$REALM" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"sslRequired": "none"}' >/dev/null
else
  echo "Creating realm '$REALM' ..."
  curl -sf -X POST "$KEYCLOAK_URL/admin/realms" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"realm\": \"$REALM\", \"enabled\": true, \"displayName\": \"CT Annotation Platform\", \"sslRequired\": \"none\"}" >/dev/null
fi

# The client's redirectUris/webOrigins are reconciled against the
# CURRENT $ADMIN_UI_ORIGIN/$EXTRA_ORIGINS whether the realm (and this
# client with it) is brand new or already existed -- otherwise a
# deployment that changes its PUBLIC_* hostname/IP after the first
# provisioning run stays stuck on the old ones forever (this script
# would previously exit at the realm-exists check above and never
# touch the client again).
if [ "$realm_existed" = "true" ]; then
  echo "Updating client '$CLIENT_ID' origins (now: $ADMIN_UI_ORIGIN, $EXTRA_ORIGINS) ..."
  CLIENT_UUID=$(curl -s "$KEYCLOAK_URL/admin/realms/$REALM/clients?clientId=$CLIENT_ID" \
    -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')
  curl -sf -X PUT "$KEYCLOAK_URL/admin/realms/$REALM/clients/$CLIENT_UUID" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$(jq -n --arg origins "$ADMIN_UI_ORIGIN,$EXTRA_ORIGINS" '
          ($origins | split(",") | map(select(length > 0))) as $o |
          {redirectUris: ($o | map(. + "/*")), webOrigins: $o}')" >/dev/null
  exit 0
fi

echo "Creating client '$CLIENT_ID' (origins: $ADMIN_UI_ORIGIN, $EXTRA_ORIGINS) ..."
# redirectUris/webOrigins allow the admin-ui (a browser app, standard
# Authorization Code + PKCE flow) to log in via this client. directAccessGrants
# stays enabled too, for the password-grant testing shown in this repo's docs.
curl -sf -X POST "$KEYCLOAK_URL/admin/realms/$REALM/clients" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -n --arg id "$CLIENT_ID" --arg origins "$ADMIN_UI_ORIGIN,$EXTRA_ORIGINS" '
        ($origins | split(",") | map(select(length > 0))) as $o |
        {clientId: $id, enabled: true, publicClient: true, directAccessGrantsEnabled: true, standardFlowEnabled: true,
         protocol: "openid-connect", redirectUris: ($o | map(. + "/*")), webOrigins: $o}')" >/dev/null

CLIENT_UUID=$(curl -s "$KEYCLOAK_URL/admin/realms/$REALM/clients?clientId=$CLIENT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

# Keycloak does not include the client id in the access token's `aud` claim
# by default -- shared_auth.get_current_user validates against
# KEYCLOAK_AUDIENCE, so without this mapper every token would fail
# audience validation in every service.
echo "Adding audience mapper (KEYCLOAK_AUDIENCE=$CLIENT_ID) ..."
curl -sf -X POST "$KEYCLOAK_URL/admin/realms/$REALM/clients/$CLIENT_UUID/protocol-mappers/models" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\": \"$CLIENT_ID-audience\", \"protocol\": \"openid-connect\", \"protocolMapper\": \"oidc-audience-mapper\", \"config\": {\"included.client.audience\": \"$CLIENT_ID\", \"id.token.claim\": \"false\", \"access.token.claim\": \"true\"}}" >/dev/null

echo "Creating global 'admin' realm role ..."
curl -sf -X POST "$KEYCLOAK_URL/admin/realms/$REALM/roles" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "admin", "description": "Global superuser role -- bypasses per-study role checks (see shared_auth.require_study_role)"}' >/dev/null

# firstName/lastName are required here: Keycloak's default Declarative User
# Profile silently attaches a VERIFY_PROFILE required action to accounts
# missing them, which breaks the password grant with the confusing error
# "Account is not fully set up".
echo "Creating test user '$TEST_USERNAME' ..."
curl -sf -X POST "$KEYCLOAK_URL/admin/realms/$REALM/users" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"username\": \"$TEST_USERNAME\", \"enabled\": true, \"email\": \"$TEST_USERNAME@ct-platform.local\", \"emailVerified\": true, \"firstName\": \"Platform\", \"lastName\": \"Admin\", \"credentials\": [{\"type\": \"password\", \"value\": \"$TEST_PASSWORD\", \"temporary\": false}]}" >/dev/null

USER_ID=$(curl -s "$KEYCLOAK_URL/admin/realms/$REALM/users?username=$TEST_USERNAME" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')
ROLE_JSON=$(curl -s "$KEYCLOAK_URL/admin/realms/$REALM/roles/admin" -H "Authorization: Bearer $TOKEN")

echo "Granting 'admin' role to '$TEST_USERNAME' ..."
curl -sf -X POST "$KEYCLOAK_URL/admin/realms/$REALM/users/$USER_ID/role-mappings/realm" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "[$ROLE_JSON]" >/dev/null

echo "Creating service-account client '$SERVICE_ACCOUNT_CLIENT_ID' (admin-service -> Keycloak user lookups/creation) ..."
# Confidential, client-credentials-only client -- no browser flow, no
# direct-access-grants. Scoped to this realm's users (view-users +
# manage-users, below) rather than using master-realm admin credentials,
# so a leak of this secret can't reach anything outside this realm.
curl -sf -X POST "$KEYCLOAK_URL/admin/realms/$REALM/clients" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"clientId\": \"$SERVICE_ACCOUNT_CLIENT_ID\", \"enabled\": true, \"publicClient\": false, \"secret\": \"$SERVICE_ACCOUNT_CLIENT_SECRET\", \"serviceAccountsEnabled\": true, \"standardFlowEnabled\": false, \"directAccessGrantsEnabled\": false, \"protocol\": \"openid-connect\"}" >/dev/null

SERVICE_ACCOUNT_CLIENT_UUID=$(curl -s "$KEYCLOAK_URL/admin/realms/$REALM/clients?clientId=$SERVICE_ACCOUNT_CLIENT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')
SERVICE_ACCOUNT_USER_ID=$(curl -s "$KEYCLOAK_URL/admin/realms/$REALM/clients/$SERVICE_ACCOUNT_CLIENT_UUID/service-account-user" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.id')

REALM_MGMT_CLIENT_UUID=$(curl -s "$KEYCLOAK_URL/admin/realms/$REALM/clients?clientId=realm-management" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')
VIEW_USERS_ROLE=$(curl -s "$KEYCLOAK_URL/admin/realms/$REALM/clients/$REALM_MGMT_CLIENT_UUID/roles/view-users" \
  -H "Authorization: Bearer $TOKEN")
# manage-users lets the service account create realm users and assign
# them the "admin" realm role -- backs admin-ui's "New user" panel.
MANAGE_USERS_ROLE=$(curl -s "$KEYCLOAK_URL/admin/realms/$REALM/clients/$REALM_MGMT_CLIENT_UUID/roles/manage-users" \
  -H "Authorization: Bearer $TOKEN")
# query-users + view-realm are needed on top of view-users specifically
# for the roles/{role}/users lookup (list_realm_users' is_admin
# cross-reference) -- Keycloak treats "who holds this role" as a realm-
# level read, not a plain user read.
QUERY_USERS_ROLE=$(curl -s "$KEYCLOAK_URL/admin/realms/$REALM/clients/$REALM_MGMT_CLIENT_UUID/roles/query-users" \
  -H "Authorization: Bearer $TOKEN")
VIEW_REALM_ROLE=$(curl -s "$KEYCLOAK_URL/admin/realms/$REALM/clients/$REALM_MGMT_CLIENT_UUID/roles/view-realm" \
  -H "Authorization: Bearer $TOKEN")

echo "Granting 'view-users' + 'manage-users' + 'query-users' + 'view-realm' (realm-management) to the service account ..."
curl -sf -X POST "$KEYCLOAK_URL/admin/realms/$REALM/users/$SERVICE_ACCOUNT_USER_ID/role-mappings/clients/$REALM_MGMT_CLIENT_UUID" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "[$VIEW_USERS_ROLE, $MANAGE_USERS_ROLE, $QUERY_USERS_ROLE, $VIEW_REALM_ROLE]" >/dev/null

echo "Done. Test user: $TEST_USERNAME / $TEST_PASSWORD (realm role: admin)"
