#!/usr/bin/env bash
# Starts the whole system (this platform + the sibling ct-annotator
# viewer) behind a single ngrok tunnel: admin-ui, its login (Keycloak),
# its four backend APIs, the images it shows (MinIO), and the "Open in
# Viewer" / "Start the tutorial" links into ct-annotator all work from
# one public URL. A small nginx edge proxy puts everything behind that
# one origin, using each service's own existing path prefix (/admin,
# /data, /annotations, /ingestion, /public, /realms+/resources+/js for
# Keycloak, /ct-pixel-data for MinIO's bucket) plus two new ones this
# script adds for the viewer (/viewer, /viewer-api). Both apps are then
# rebuilt so their JavaScript calls that public URL instead of
# localhost.
#
# Run it, wait for the printed URL, share it. Ctrl+C stops the tunnel
# and the edge proxy (both apps keep running locally after that, just
# no longer reachable from outside).
#
# Expects ct-annotator checked out as a sibling of this repo (../ct-annotator).
# One-time setup this script assumes is already done:
#   ~/.local/bin/ngrok installed, `ngrok config add-authtoken <token>` run once.
set -euo pipefail
cd "$(dirname "$0")/.."
CT_ANNOTATOR_DIR="$(cd "$(pwd)/../ct-annotator" 2>/dev/null && pwd || true)"

PROXY_PORT="${PROXY_PORT:-8090}"
EDGE_NAME="ctplatform-ngrok-edge"
NGROK_BIN="$HOME/.local/bin/ngrok"
[ -x "$NGROK_BIN" ] || NGROK_BIN="$(command -v ngrok || true)"

if [ -z "$NGROK_BIN" ]; then
  # `tar -C` needs its target directory to already exist (it won't
  # create it), and a fresh box -- especially logged in as root, whose
  # shell profile never adds ~/.local/bin to PATH the way a normal
  # user's does -- often doesn't have ~/.local/bin yet. `mkdir -p` first
  # and the config step's full path (matching $NGROK_BIN above, which
  # this script checks before ever falling back to PATH) keep every
  # line here copy-pasteable as-is, with no separate "now put it on
  # PATH" step required.
  echo "ngrok isn't installed. Install it first:" >&2
  echo "  mkdir -p ~/.local/bin" >&2
  echo "  curl -sSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz -o /tmp/ngrok.tgz" >&2
  echo "  tar -xzf /tmp/ngrok.tgz -C ~/.local/bin/" >&2
  echo "  ~/.local/bin/ngrok config add-authtoken <your token from dashboard.ngrok.com>" >&2
  exit 1
fi
if [ ! -f "$HOME/.config/ngrok/ngrok.yml" ]; then
  echo "No ngrok authtoken configured -- run: ngrok config add-authtoken <token>" >&2
  exit 1
fi
if [ -z "$CT_ANNOTATOR_DIR" ]; then
  echo "NOTE: ../ct-annotator not found next to this repo -- the viewer" >&2
  echo "won't be exposed, only admin-ui and its own APIs." >&2
fi

echo "==> Making sure the platform is up (with Keycloak trusting the proxy)..."
# docker-compose.proxy.yml makes Keycloak build its issuer/redirect URLs
# from X-Forwarded-* headers instead of its own container hostname --
# required so tokens are issued with the public https:// URL, or every
# API call 401s with "Invalid token" (issuer mismatch) even though
# login itself succeeded. Safe for plain localhost use too: it only
# changes behavior when those headers are actually present.
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.proxy.yml"
$COMPOSE up -d >/dev/null
if [ -n "$CT_ANNOTATOR_DIR" ]; then
  ( cd "$CT_ANNOTATOR_DIR" && docker compose up -d >/dev/null )
fi

NETWORK="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$(docker compose ps -q keycloak)")"
echo "==> Using docker network: $NETWORK"

echo "==> Writing the edge proxy config..."
CONF_DIR="$(mktemp -d)"
cat > "$CONF_DIR/edge.conf" <<'NGINX'
# 127.0.0.11 is Docker's embedded DNS. A plain `proxy_pass http://name:port`
# resolves once at nginx startup and then NEVER AGAIN -- if a backend
# container is later recreated (e.g. this script recreating them a few
# lines down, to pick up the public Keycloak issuer) it gets a new IP,
# and this proxy would keep sending traffic to whatever container now
# happens to hold the stale IP, producing confusing wrong-service
# responses instead of a clean connection error. Routing through a
# variable forces a fresh lookup (valid=10s) on every request instead.
resolver 127.0.0.11 valid=10s;

server {
  listen 80;
  client_max_body_size 512m;

  # Keycloak's browser-facing paths (token endpoint, static assets it
  # serves). X-Forwarded-Proto/Host/Port are what KC_PROXY_HEADERS=xforwarded
  # (docker-compose.proxy.yml) reads to build https:// issuer/redirect
  # URLs instead of its own http:// container hostname.
  location ~ ^/(realms|resources|js)/ {
    set $upstream keycloak:8080;
    proxy_pass http://$upstream;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port 443;
  }

  # Each backend keeps its own existing prefix -- no rewriting needed.
  location /admin/  { set $upstream admin-service:8000; proxy_pass http://$upstream; proxy_set_header Host $host; }
  location /public/ { set $upstream admin-service:8000; proxy_pass http://$upstream; proxy_set_header Host $host; }
  location /data/   { set $upstream data-service:8000; proxy_pass http://$upstream; proxy_set_header Host $host; }
  location /annotations/ { set $upstream annotation-service:8000; proxy_pass http://$upstream; proxy_set_header Host $host; }
  location /ingestion/   { set $upstream ingestion-service:8000; proxy_pass http://$upstream; proxy_set_header Host $host; }

  # MinIO, unprefixed and unmodified: a presigned URL's signature covers
  # the exact path boto3 built it with (scheme+host from
  # PUBLIC_MINIO_URL, then /<bucket>/<key>?signature...) -- rewriting
  # anything here would invalidate the signature. ct-pixel-data is the
  # one bucket this platform uses (see docker-compose.yml).
  location /ct-pixel-data/ {
    set $upstream minio:9000;
    proxy_pass http://$upstream;
    proxy_set_header Host $host;
  }

  # The separate ct-annotator app (its own repo/compose project) --
  # network_mode: host there, so it's reached via the docker host's own
  # published ports, not a container DNS name. Prefix stripped on the
  # way in (proxy_pass ends in /) since neither ct-annotator's nginx nor
  # its FastAPI backend know they're mounted under /viewer -- that's
  # exactly what VITE_BASE_PATH (frontend) makes the *browser* agree on.
  location /viewer-api/ {
    proxy_pass http://host.docker.internal:8010/;
    proxy_set_header Host $host;
  }
  location /viewer/ {
    proxy_pass http://host.docker.internal:5174/;
    proxy_set_header Host $host;
  }

  # Everything else: the admin-ui single-page app itself.
  location / {
    set $upstream admin-ui:80;
    proxy_pass http://$upstream;
    proxy_set_header Host $host;
  }
}
NGINX

echo "==> Starting the edge proxy container..."
docker rm -f "$EDGE_NAME" >/dev/null 2>&1 || true
docker run -d --name "$EDGE_NAME" --network "$NETWORK" \
  --add-host=host.docker.internal:host-gateway \
  -p "127.0.0.1:${PROXY_PORT}:80" \
  -v "$CONF_DIR/edge.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.27-alpine >/dev/null

cleanup() {
  echo
  echo "==> Stopping the tunnel and edge proxy (both apps keep running locally)..."
  [ -n "${NGROK_PID:-}" ] && kill "$NGROK_PID" 2>/dev/null || true
  docker rm -f "$EDGE_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "==> Starting ngrok..."
NGROK_LOG="$(mktemp)"
"$NGROK_BIN" http "$PROXY_PORT" --log=stdout --log-format=logfmt > "$NGROK_LOG" 2>&1 &
NGROK_PID=$!

PUBLIC_URL=""
for _ in $(seq 1 30); do
  PUBLIC_URL="$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null \
    | python3 -c 'import sys,json
try:
    t=json.load(sys.stdin)["tunnels"]
    print(next(x["public_url"] for x in t if x["public_url"].startswith("https")))
except Exception:
    pass' 2>/dev/null || true)"
  [ -n "$PUBLIC_URL" ] && break
  sleep 1
done
if [ -z "$PUBLIC_URL" ]; then
  echo "ngrok never reported a public URL -- log:" >&2
  cat "$NGROK_LOG" >&2
  exit 1
fi
echo "==> Public URL: $PUBLIC_URL"

echo "==> Pointing the backends' token validation and image links at that URL..."
# KEYCLOAK_ISSUER and OBJECT_STORAGE_ENDPOINT/OBJECT_STORAGE_PUBLIC_ENDPOINT
# are runtime env (docker-compose.yml) -- no rebuild needed, just a
# recreate so the new values take effect.
PUBLIC_KEYCLOAK_URL="$PUBLIC_URL" \
PUBLIC_MINIO_URL="$PUBLIC_URL" \
  $COMPOSE up -d admin-service data-service annotation-service ingestion-service >/dev/null

echo "==> Rebuilding admin-ui to call that URL instead of localhost..."
PUBLIC_KEYCLOAK_URL="$PUBLIC_URL" \
PUBLIC_INGESTION_API="$PUBLIC_URL" \
PUBLIC_DATA_API="$PUBLIC_URL" \
PUBLIC_ANNOTATION_API="$PUBLIC_URL" \
PUBLIC_ADMIN_API="$PUBLIC_URL" \
PUBLIC_ANNOTATOR_UI_URL="$PUBLIC_URL/viewer" \
  $COMPOSE up -d --build admin-ui >/dev/null

if [ -n "$CT_ANNOTATOR_DIR" ]; then
  echo "==> Rebuilding the viewer to run under $PUBLIC_URL/viewer ..."
  ( cd "$CT_ANNOTATOR_DIR" && \
    PUBLIC_KEYCLOAK_URL="$PUBLIC_URL" \
    PUBLIC_ADMIN_UI_URL="$PUBLIC_URL" \
    PUBLIC_ANNOTATOR_API="$PUBLIC_URL/viewer-api" \
    PUBLIC_ANNOTATOR_UI_URL="$PUBLIC_URL/viewer" \
    PUBLIC_ANNOTATOR_BASE_PATH="/viewer/" \
    docker compose up -d --build >/dev/null )
  VIEWER_LINE=" Viewer links work too -- try My Jobs -> Start the tutorial."
else
  VIEWER_LINE=" Viewer links still point at localhost (../ct-annotator not found)."
fi

echo
echo "================================================================"
echo " VoxelLabel is live at:  $PUBLIC_URL"
echo
echo " Sign in with an existing account, e.g. platform-admin / platform-admin"
echo
echo " SECURITY: this is now reachable by anyone with the link, using"
echo " today's test passwords. Change platform-admin's password (System"
echo " page won't do it yet -- use Users page, or ask me to) before"
echo " sharing this URL beyond a quick look."
echo
echo "$VIEWER_LINE"
echo
echo " Press Ctrl+C to stop the tunnel."
echo "================================================================"

wait "$NGROK_PID"
