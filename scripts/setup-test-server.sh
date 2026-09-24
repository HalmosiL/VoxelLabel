#!/usr/bin/env bash
# One-shot first-time setup of the whole platform on a fresh host (a
# test server or a laptop): builds the images with the PUBLIC_* URLs
# from .env baked in, starts everything, provisions the Keycloak realm
# with every browser origin that needs it, applies the DB migrations,
# registers the viewer's annotation types, and pulls the local LLM.
# Safe to re-run: every step is idempotent.
#
#   cp .env.example .env   # edit PUBLIC_* + passwords first!
#   scripts/setup-test-server.sh
#
# Optional env: CT_ANNOTATOR_DIR (path to the ct-annotator checkout --
# looks for a ./ct-annotator subdirectory of this repo first, falling
# back to a sibling ../ct-annotator for the older two-checkout layout)
# -- its setup scripts are run too when found;
# GPU=1 to include docker-compose.gpu.yml; SKIP_OLLAMA=1 to skip the
# model pull (a few GB).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env -- copy .env.example to .env, set PUBLIC_* to this server's hostname and change the passwords, then re-run." >&2
  exit 1
fi
set -a; . ./.env; set +a
for tool in docker curl jq python3; do
  command -v "$tool" >/dev/null || { echo "Missing: $tool (apt install $tool)" >&2; exit 1; }
done
docker compose version >/dev/null || { echo "Docker Compose v2 plugin missing (apt install docker-compose-plugin)" >&2; exit 1; }

COMPOSE=(docker compose -f docker-compose.yml)
[ "${GPU:-0}" = "1" ] && COMPOSE+=(-f docker-compose.gpu.yml)

echo "==> Building images (PUBLIC_KEYCLOAK_URL=${PUBLIC_KEYCLOAK_URL:-http://localhost:8080}, PUBLIC_ADMIN_API=${PUBLIC_ADMIN_API:-http://localhost:8004})"
"${COMPOSE[@]}" build

echo "==> Starting the stack"
"${COMPOSE[@]}" up -d

# The object storage bucket every service's OBJECT_STORAGE_BUCKET env
# var already assumes exists (see e.g. ingestion-service's
# upload_staged_file) -- nothing else in this repo ever creates it.
# On this sandbox it's existed since long before this script did, which
# is exactly why this was never caught here: a genuinely fresh MinIO
# volume (a first-ever install, or one recreated after wiping it to fix
# a stale root password -- see the "password authentication failed"
# class of problem this same script's realm/DB steps below also hit)
# has no buckets at all, and every upload then 500s with a bare
# "NoSuchBucket" -- surfacing in the browser as an opaque "network
# error", nothing about a missing bucket. `mc mb --ignore-existing`
# (MinIO's own client, bundled in its image -- no extra tool needed) is
# idempotent, so this is safe on every rerun.
echo "==> Making sure the object storage bucket exists"
for _ in $(seq 1 30); do
  "${COMPOSE[@]}" exec -T minio curl -sf -o /dev/null http://localhost:9000/minio/health/live && break
  sleep 2
done
"${COMPOSE[@]}" exec -T minio sh -c "mc alias set local http://localhost:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD >/dev/null && mc mb --ignore-existing local/${OBJECT_STORAGE_BUCKET:-ct-pixel-data}"

echo "==> Waiting for Keycloak"
for _ in $(seq 1 90); do
  curl -sf -o /dev/null http://localhost:8080/realms/master && break
  sleep 2
done
curl -sf -o /dev/null http://localhost:8080/realms/master || { echo "Keycloak did not come up on :8080" >&2; exit 1; }

echo "==> Provisioning the Keycloak realm (idempotent)"
# The realm script talks to Keycloak on this host's own :8080 (always
# reachable from here); the ORIGINS it registers are the browser-facing
# ones from .env.
KEYCLOAK_URL=http://localhost:8080 \
ADMIN_USER="${KEYCLOAK_ADMIN:-admin}" ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-admin}" \
ADMIN_UI_ORIGIN="${PUBLIC_ADMIN_UI_URL:-http://localhost:5173}" \
EXTRA_ORIGINS="${PUBLIC_ANNOTATOR_UI_URL:-http://localhost:5174},http://127.0.0.1:45678" \
SERVICE_ACCOUNT_CLIENT_SECRET="${KEYCLOAK_ADMIN_CLIENT_SECRET:-admin-service-account-secret}" \
  ./infra/keycloak/setup-dev-realm.sh

echo "==> Applying database migrations"
scripts/migrate.sh

if [ -z "${CT_ANNOTATOR_DIR:-}" ]; then
  if [ -d "./ct-annotator/scripts" ]; then CT_ANNOTATOR_DIR="./ct-annotator"
  elif [ -d "../ct-annotator/scripts" ]; then CT_ANNOTATOR_DIR="../ct-annotator"
  else CT_ANNOTATOR_DIR="./ct-annotator"
  fi
fi
if [ -d "$CT_ANNOTATOR_DIR/scripts" ]; then
  echo "==> Registering the viewer's annotation types + its origin on the Keycloak client ($CT_ANNOTATOR_DIR)"
  # --keycloak-url here must be PUBLIC_KEYCLOAK_URL, not localhost, even
  # though this all runs server-side: Keycloak has no fixed hostname
  # config (KC_HOSTNAME is never set), so the `iss` claim it stamps into
  # a token is whatever host/port the token REQUEST itself came in on --
  # a token minted via localhost:8080 carries iss=.../localhost:8080,
  # but admin-service's shared_auth checks it against its own
  # KEYCLOAK_ISSUER (baked from PUBLIC_KEYCLOAK_URL, since that's what
  # every *browser* token's issuer actually is) and 401s "Invalid token"
  # on the mismatch -- confirmed live on a real deployment, not a
  # theoretical concern. admin-service-url stays on localhost: nothing
  # there validates what host was used to reach IT, only what's inside
  # the token this call sends it.
  python3 "$CT_ANNOTATOR_DIR/scripts/register_annotation_type.py" \
    --username "${TEST_USERNAME:-platform-admin}" --password "${TEST_PASSWORD:-platform-admin}" \
    --keycloak-url "${PUBLIC_KEYCLOAK_URL:-http://localhost:8080}" --admin-service-url http://localhost:8004 || true
  python3 "$CT_ANNOTATOR_DIR/scripts/patch_keycloak_client.py" \
    --keycloak-url http://localhost:8080 --admin-username "${KEYCLOAK_ADMIN:-admin}" --admin-password "${KEYCLOAK_ADMIN_PASSWORD:-admin}" \
    --frontend-origin "${PUBLIC_ANNOTATOR_UI_URL:-http://localhost:5174}" || true
else
  echo "    (ct-annotator checkout not found at $CT_ANNOTATOR_DIR -- run its scripts/ yourself, see INSTALL.md)"
fi

echo "==> Putting back any missing image previews (thumbnails) -- idempotent"
"${COMPOSE[@]}" exec -T ingestion-service python -m app.thumbnail_backfill || echo "    (thumbnail backfill failed -- previews may stay blank; rerun: docker compose exec ingestion-service python -m app.thumbnail_backfill)"

if [ "${SKIP_OLLAMA:-0}" != "1" ]; then
  echo "==> Pulling the local model ${OLLAMA_MODEL:-qwen3:1.7b} (skip with SKIP_OLLAMA=1)"
  "${COMPOSE[@]}" exec -T ollama ollama pull "${OLLAMA_MODEL:-qwen3:1.7b}" || echo "    (model pull failed -- the Clinical Trial Assistant card won't work until it's pulled)"
fi

cat <<EOF

Done.
  Admin UI:      ${PUBLIC_ADMIN_UI_URL:-http://localhost:5173}   (sign in: platform-admin / platform-admin -- change it under Users)
  Viewer:        ${PUBLIC_ANNOTATOR_UI_URL:-http://localhost:5174}   (start it from the ct-annotator checkout: docker compose up -d --build)
  Keycloak:      ${PUBLIC_KEYCLOAK_URL:-http://localhost:8080}   (admin console: ${KEYCLOAK_ADMIN:-admin})
  Mail sandbox:  http://localhost:8025 on this host  (real SMTP: Admin UI -> Notifications)
EOF
