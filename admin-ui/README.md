# admin-ui

The browser-based management interface for the platform: studies,
study memberships, cases (patient + accession number), imaging studies/
series/instances browsing, DICOM upload, clinical data items (files, tags,
consents), a cross-study patient profile view, annotation review,
de-identification profiles, and annotation type registration. Talks
directly to the four backend APIs from the browser (ingestion/data/
annotation/admin) and to Keycloak for login -- there is no server-side
component of its own beyond the static file server.

Navigation: Studies -> Study detail (Cases / Annotation review /
Members) -> Case detail (Imaging / Series / Documents, single unified
page). Patients is a separate, cross-study entry point: Patients ->
Patient detail lists every case for that patient across all studies, each
with its imaging and tags, with a link into the corresponding Case detail
page.

## Stack

React + TypeScript + Vite, `react-router-dom` for client-side routing,
`keycloak-js` for the login flow (Authorization Code + PKCE, standard
OIDC browser flow -- not the password grant used elsewhere in this repo's
docs for scripted testing).

## Module layout

| Path | Responsibility |
|---|---|
| `src/keycloak.ts` | Keycloak client instance |
| `src/main.tsx` | Keycloak init (redirects to login if unauthenticated), then mounts the app |
| `src/api/client.ts` | Shared fetch wrapper: attaches the bearer token, normalizes errors |
| `src/api/*Api.ts` | One thin client module per backend service |
| `src/pages/*.tsx` | Top-level routed pages |
| `src/components/*.tsx` | Shared/nested UI (layout, imaging thumbnails, review queue) |

## Running standalone (dev server)

```bash
cp .env.example .env   # adjust backend URLs if not using the default docker-compose ports
npm install
npm run dev
```

Opens on http://localhost:5173. Requires Keycloak and the four backend
services to be running (`docker compose up` from the repo root) and the
`ct-platform` Keycloak client to have `http://localhost:5173/*` in its
redirect URIs (already set by `infra/keycloak/setup-dev-realm.sh`).

## Type-checking

```bash
npm run lint
```

Runs `tsc --noEmit` -- there is no automated test suite for this app yet
(no component tests), only the type checker as a correctness gate.

## Building for production

```bash
npm run build
```

Also done automatically by `Dockerfile` (multi-stage: Node build ->
nginx serving the static bundle). Vite inlines `VITE_*` env vars into the
bundle at **build time**, not runtime -- see `src/config.ts`. The
defaults point at `localhost:800{1-4}` and `localhost:8080`, which work
for the docker-compose setup because the browser (not a server) is what
calls those services, and docker-compose already publishes all of those
ports to the host.

## Known limitations

- Study listing/creation, de-identification/annotation-type management,
  and the Patients cross-study view all require the global Keycloak
  `admin` realm role -- there is no reduced-permission admin view yet.
- No pagination anywhere; fine at the target scale (10k-100k imaging
  studies), but the plain list views will need it if used against very
  large single studies.
