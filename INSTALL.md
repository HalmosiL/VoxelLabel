# Installing VoxelLabel on a test server

This walks through a from-scratch install on one Linux host (tested
against Ubuntu 22.04/24.04) with Docker. Everything runs in containers;
the host needs Docker, `git`, `curl`, `jq` and `python3` (for two small
setup scripts) and nothing else.

The platform is one checkout, with the viewer nested inside it:

```
~/voxellabel/
  Annotator-Pipline/          the platform: Keycloak, Postgres, MinIO, the four APIs, admin-ui, mail sandbox, backups, local LLM
    ct-annotator/              the viewer (annotation/review surface) + its thin backend
```

(An older layout, with `ct-annotator/` cloned separately as a sibling
of `Annotator-Pipline/` instead of nested inside it, still works --
every script here looks in `./ct-annotator` first and falls back to
`../ct-annotator`.)

Ports the **browser** must be able to reach on the server (open them in
the firewall / security group): `5173` (admin UI), `5174` (viewer),
`8080` (Keycloak), `8001`-`8004` (the four APIs), `8010` (viewer
backend), `9000` (MinIO -- images/documents are fetched from it
directly). Everything else (Postgres, Redis, MinIO console, Ollama,
Mailpit) is bound to `127.0.0.1` on the server only.

> **Why so many ports?** admin-ui and the viewer are static browser apps
> that call the APIs and Keycloak *directly from the browser*, so every
> one of them needs a browser-reachable address. Putting them behind one
> reverse proxy / one hostname is described at the end; for a test
> server, the plain ports are the fastest path.

## 1. Host prerequisites

```bash
sudo apt update && sudo apt install -y git curl jq python3 ca-certificates
# Docker Engine + the compose plugin (official repo; the distro's
# docker.io package is often too old for `docker compose`):
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && newgrp docker
docker compose version   # must print v2.x
```

Sizing: 8 GB RAM and ~20 GB free disk is comfortable for a test server
(Postgres, MinIO with real DICOM data, and the ~1.5 GB local model all
live on disk under Docker volumes). An NVIDIA GPU is optional -- only
the Clinical Trial Assistant card uses the local model, and it runs on
CPU without one (slower).

## 2. Get the code

```bash
mkdir -p ~/voxellabel && cd ~/voxellabel
git clone https://github.com/HalmosiL/VoxelLabel.git Annotator-Pipline
```

`ct-annotator/` is already inside this checkout -- nothing separate to
clone. (No GitHub access from the server? Copy the checkout over with
`rsync`/`scp` from a machine that has it instead.)

## 3. Configure `.env` -- the one step that needs thought

```bash
cd ~/voxellabel/Annotator-Pipline
cp .env.example .env
nano .env
```

Replace `localhost` with the server's hostname or IP in **every**
`PUBLIC_*` line and in `ADMIN_UI_ORIGINS`, and change every password:

```
PUBLIC_KEYCLOAK_URL=http://ct-test.example.org:8080
PUBLIC_ADMIN_UI_URL=http://ct-test.example.org:5173
PUBLIC_ANNOTATOR_UI_URL=http://ct-test.example.org:5174
PUBLIC_INGESTION_API=http://ct-test.example.org:8001
PUBLIC_DATA_API=http://ct-test.example.org:8002
PUBLIC_ANNOTATION_API=http://ct-test.example.org:8003
PUBLIC_ADMIN_API=http://ct-test.example.org:8004
PUBLIC_MINIO_URL=http://ct-test.example.org:9000
ADMIN_UI_ORIGINS=http://ct-test.example.org:5173,http://ct-test.example.org:5174,http://127.0.0.1:45678

POSTGRES_PASSWORD=<long random>
MINIO_ROOT_PASSWORD=<long random>
KEYCLOAK_ADMIN_PASSWORD=<long random>
KEYCLOAK_ADMIN_CLIENT_SECRET=<long random>
OBJECT_LINK_SECRET=<long random>   # optional: signs image/document links; defaults to one derived from MINIO_ROOT_PASSWORD
```

Rules that will bite if ignored:

- Use the **same** hostname form everywhere (all IP, or all DNS name).
  `PUBLIC_KEYCLOAK_URL` becomes the issuer inside every token, and the
  APIs reject a token whose issuer doesn't match it exactly.
- These URLs are **baked into the browser apps at build time**. Change
  one later → `docker compose build admin-ui` (and the viewer) again.
- Keep `http://127.0.0.1:45678` in `ADMIN_UI_ORIGINS`: it's the
  clinician desktop app's local server.

Then the viewer's own `.env`, with the *same* values:

```bash
cd ~/voxellabel/Annotator-Pipline/ct-annotator
cp .env.example .env
nano .env    # PUBLIC_KEYCLOAK_URL, PUBLIC_ADMIN_UI_URL, PUBLIC_ANNOTATOR_UI_URL,
             # PUBLIC_ANNOTATOR_API=http://ct-test.example.org:8010, MINIO_ROOT_USER/PASSWORD
```

## 4. Build, start and provision the platform (one command)

```bash
cd ~/voxellabel/Annotator-Pipline
scripts/setup-test-server.sh
```

What it does, in order (all idempotent -- re-run it any time):

1. `docker compose build` with your `.env` baked in.
2. `docker compose up -d` -- Postgres, Redis, MinIO, Keycloak, the four
   APIs + ingestion worker, admin-ui, Mailpit, the backup service,
   Ollama and the MCP server.
3. Creates the MinIO bucket every service stores DICOM/document/mask
   data in (`mc mb --ignore-existing` -- MinIO never creates this on
   its own, and nothing else in this repo did either before this step
   existed, so skipping it is the difference between a working upload
   and every one of them failing deep inside the ingestion service with
   no clue in the browser why).
4. Waits for Keycloak, then `infra/keycloak/setup-dev-realm.sh`:
   creates the `ct-platform` realm (HTTPS not required, since this
   guide's own "plain ports" setup never puts TLS in front of it), its
   OIDC client with **all three browser origins** (admin UI, viewer,
   clinician app), the `admin` role, the `platform-admin` user and the
   service account admin-service uses -- and, on every rerun (not just
   the first), reconciles the client's origins against the current
   `.env` even if the realm already existed, so changing a `PUBLIC_*`
   URL later and rerunning this script is enough on its own.
5. `scripts/migrate.sh` -- applies every database migration from inside
   a container (no Python needed on the host).
6. If `ct-annotator/` (or `../ct-annotator`) exists: registers the
   viewer's annotation types and adds its origin to the Keycloak client.
7. Pulls the local model (`qwen3:1.7b`, ~1.4 GB). `SKIP_OLLAMA=1` to skip;
   `GPU=1` to also apply `docker-compose.gpu.yml`.

Postgres and Keycloak each fix their root/admin credentials from
`POSTGRES_PASSWORD`/`KEYCLOAK_ADMIN_PASSWORD` **once**, the first time
they boot with an empty volume -- changing `.env` afterward and
rerunning this script does not change either password retroactively.
If a rerun's migration step fails with "password authentication
failed" (or the realm step fails silently right after "Creating
realm..."), the fix is to drop that one service's volume and let it
reinitialize:
```bash
docker compose stop postgres   # or: keycloak
docker compose rm -f postgres
docker volume rm voxellabel_postgres-data   # matches your compose project's name
scripts/setup-test-server.sh
```
(MinIO doesn't have this problem -- its root credentials are read fresh
from `.env` on every boot.)

Takes ~10 minutes the first time (image builds + model pull).

## 5. Start the viewer

```bash
cd ~/voxellabel/Annotator-Pipline/ct-annotator
docker compose up -d --build
```

## 6. First sign-in and the things to change immediately

Open `http://<server>:5173`. Sign in as `platform-admin` /
`platform-admin`.

1. **Users → platform-admin → Reset password.** Then **Users → New
   user** for yourself (tick Platform admin) rather than sharing the
   seeded account.
2. **Notifications → Email delivery.** Out of the box, every email goes
   to the Mailpit sandbox (`http://127.0.0.1:8025` *on the server* --
   `ssh -L 8025:127.0.0.1:8025 server` to view it from your laptop)
   and nothing leaves the machine. To send real mail, enter your SMTP
   server (host, port, STARTTLS/SSL, user, password, sender), Save,
   then *Send test email*. Gmail needs a 16-character App Password
   (2-step verification on), not the account password.
3. **Keycloak admin console** (`http://<server>:8080`, user `admin`,
   password from `.env`): nothing to change for a test server, but
   this is where you'd tighten password policy or session lifetimes.

Tell people who need an account to open `http://<server>:5173` and use
**Create account** -- requests land on your Users page for approval,
and the approval email carries their one-time password.

## 7. Day-two operations

| Task | How |
|---|---|
| See what's running / logs | `docker compose ps` · `docker compose logs -f admin-service` |
| Update to a new version | `git pull` (one checkout, brings both apps), then `scripts/setup-test-server.sh` (rebuilds, restarts, migrates) and `docker compose up -d --build` in `ct-annotator/` |
| Database backups | Automatic daily, 14 kept, plus **System → Back up now** in the admin UI; files in the `db-backups` volume, downloadable from that page |
| Restore a backup | `scripts/restore-db.sh <file>` (stops the APIs, restores, restarts) -- for one study's mistake use its **Version history** instead |
| Object storage backup | MinIO's `minio-data` volume holds every DICOM/document/mask -- back it up separately (e.g. `mc mirror` or a volume snapshot) |
| Audit trail | **System → Audit log** (who changed what) and **Notifications → Delivery log** (every email) |
| Stop everything | `docker compose down` in both checkouts (data stays in the volumes; `down -v` deletes it) |

## 8. Optional: one hostname + HTTPS behind a reverse proxy

For a test server the plain ports above are fine. If it must be
reachable from outside a trusted network, put nginx/Caddy/Traefik with
TLS in front and give each piece its own subdomain or path, e.g.
`https://ct.example.org` → admin-ui, `https://ct.example.org/auth` →
Keycloak, `https://api.ct.example.org/admin` → admin-service, and so on.
Then in `.env` set every `PUBLIC_*` to the proxied `https://` URL, start
with `docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d`
(it tells Keycloak to trust the proxy's `X-Forwarded-*` headers so it
generates the right issuer), rebuild, and re-run the setup script (it only adds
origins to the Keycloak client that aren't there yet). Thumbnails,
documents, DICOM downloads and study cover images are served through the
data/admin APIs themselves (signed links), so they need nothing extra;
only the PyTorch export's download links still point at MinIO, so for
those `PUBLIC_MINIO_URL` must be proxied too (path-style:
`https://files.ct.example.org` → `minio:9000`).

## 9. Optional: the clinician desktop app

`clinician-app/` packages admin-ui into an installable Electron app for
a doctor who only annotates/reviews. `clinician-app/README.md` covers
building it; the installer reads a `config.json` with the same
`PUBLIC_*` URLs as above. The Linux AppImage is built and tested;
Windows/macOS installers are configured but need to be built on those
platforms.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Sign-in form says *Incorrect username or password* for a known-good login | Keycloak isn't reachable at `PUBLIC_KEYCLOAK_URL` from the browser (firewall/port 8080), or the realm wasn't provisioned -- re-run `scripts/setup-test-server.sh` |
| Signed in, but every page shows *permission* / 401 errors | Token issuer mismatch: `PUBLIC_KEYCLOAK_URL` in `.env` differs from the URL in the browser's address bar (IP vs hostname, port). Fix `.env`, `docker compose build admin-ui && docker compose up -d` |
| Browser console: *blocked by CORS policy* | The browser origin isn't in `ADMIN_UI_ORIGINS` (platform) / `CORS_ALLOWED_ORIGINS` (viewer). Add it, `docker compose up -d` |
| A case's previews (thumbnails) stay blank | The thumbnail files are missing from storage, or were never made (a DICOM that couldn't be decoded at import): `docker compose exec ingestion-service python -m app.thumbnail_backfill` regenerates them (the setup script runs it on every deploy). Previews come through the data API, not MinIO -- if they fail with an error, check that `PUBLIC_DATA_API` is reachable |
| PyTorch export links don't download | `PUBLIC_MINIO_URL` isn't reachable from where the export is read (port 9000) |
| "Open in Viewer" shows Keycloak's own login page | The viewer's origin isn't on the Keycloak client -- re-run the setup script; or the viewer's `.env` `PUBLIC_KEYCLOAK_URL` differs from the platform's |
| A page still shows an old bug after an update | Both UIs send `Cache-Control: no-store` on `index.html`, so a normal reload picks up a rebuild; if a tab was open across the update, reload it once (Ctrl+Shift+R) |
| Emails "sent" but never arrive | They went to the Mailpit sandbox -- configure real SMTP under Notifications and use *Send test email* |
| Clinical Trial Assistant card errors | The model isn't pulled: `docker compose exec ollama ollama pull qwen3:1.7b` |
| Keycloak keeps restarting right after start | `docker compose logs keycloak` -- an invalid option (e.g. a `KC_*` env var with a value it doesn't accept); Keycloak 24 exits instead of ignoring it |
| `docker compose up` fails mentioning `nvidia` | You included `docker-compose.gpu.yml` on a host without the NVIDIA toolkit -- drop the `-f docker-compose.gpu.yml` |
