# ct-annotator

A standalone CT annotation-drawing viewer -- a custom-built (not
Cornerstone3D/OHIF) `<canvas>` renderer with a freehand/pen pixel-mask
annotation tool, server-side DICOM->PNG rendering, and real window/level
control.

This is a **separate repository with its own separate API**, deliberately
not folded into the main platform (`~/Desktop/Annotator-Pipline`). It
adds no database of its own and duplicates none of that platform's data
-- see `backend/README.md` for exactly what it adds versus what it
proxies through to the main platform's existing services.

## Prerequisites

The main platform's docker-compose stack must already be running
(Keycloak, Postgres, MinIO, admin-service, data-service,
annotation-service) at its usual published ports.

## One-time setup

```bash
python3 scripts/register_annotation_type.py --username platform-admin --password platform-admin
python3 scripts/patch_keycloak_client.py --frontend-origin http://localhost:5174
```

Re-run it after every upgrade: an already registered type gets its
schema brought up to the current version (e.g. `segmentation_volume`
gained per-label `fields` and per-object `attributes`); new saves fail
with a 422 "Additional properties are not allowed" until then.


The first registers the `freehand_mask` annotation type on the main
platform (needs a user with the global Keycloak `admin` realm role); the
second appends this frontend's origin to the main platform's existing
`ct-platform` Keycloak client so logins here get tokens that already
work against that platform's services. Both are idempotent -- safe to
re-run.

## Deploying (Docker)

```bash
cp .env.example .env   # PUBLIC_* = this server's hostname, same values as the main platform's .env
docker compose up -d --build
```

The frontend bakes `PUBLIC_KEYCLOAK_URL` / `PUBLIC_ADMIN_UI_URL` /
`PUBLIC_ANNOTATOR_API` in at build time (Vite), so a changed `.env`
needs `docker compose build`. The main platform's `INSTALL.md` walks
through the whole server setup, this repo included.

## Running (development)

```bash
# Backend (port 8010)
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8010

# Frontend (port 5174), in another terminal
cd frontend
cp .env.example .env
npm install
npm run dev
```

Then open http://localhost:5174, log in with the same Keycloak account
used for the main platform's admin-ui, pick a Study/Case/ImagingStudy/
Series/Instance, and open the viewer.

## Layout

- `backend/` -- FastAPI thin backend (DICOM rendering, mask-annotation
  storage, and a picker-read proxy). See `backend/README.md`.
- `frontend/` -- Vite/React/TypeScript viewer, mirroring the main
  platform's `admin-ui` conventions (Tailwind design system, Keycloak
  login pattern, `config.ts`/`.env` structure).
- `scripts/` -- one-time setup scripts (see above).
