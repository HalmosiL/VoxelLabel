# ct-annotator backend

Thin backend for the standalone CT annotation-drawing viewer. It does
**not** duplicate the main platform's data — no database, no
`annotations`/`study_memberships` tables of its own. It adds exactly two
capabilities the main platform (`~/Desktop/Annotator-Pipline`) doesn't
have, and proxies everything else straight through to it:

- **`GET /instances/{instance_id}/metadata`** and
  **`GET /instances/{instance_id}/render.png?wc=&ww=`** — the main
  platform has no endpoint that renders DICOM pixel data (only a
  presigned URL to the *raw* `.dcm` file, and a fixed-size min-max
  thumbnail with no real windowing). This service fetches that raw file
  via the main platform's own `data-service`, decodes it with `pydicom`,
  and renders a real windowed PNG (falling back to the file's own
  `WindowCenter`/`WindowWidth`, then min-max normalization if neither is
  available). A short-lived in-process cache (`RENDER_CACHE_TTL_SECONDS`)
  avoids re-downloading+re-decoding the same instance on every
  window/level tweak.
- **`POST /annotations`** (freehand pixel-mask) — uploads the mask PNG to
  the same shared MinIO bucket the main platform already uses
  (`ct-pixel-data`, under a new `annotation-masks/` prefix that can't
  collide with the platform's own key conventions), then calls the main
  platform's existing `annotation-service` to record an `Annotation` row
  whose `payload` references that mask by key — matching the
  `Annotation.payload` model's own documented convention ("large binary
  data... stored in object storage with just a pointer in payload").
  Requires the `freehand_mask` `AnnotationType` to already be registered
  on the main platform (see `scripts/`).
- **`GET /annotations?target_type=&target_id=`** — proxies the main
  platform's own annotation listing, additionally resolving each result's
  `mask_storage_key` into a presigned GET URL so the frontend never needs
  MinIO credentials of its own.

Auth (`app/auth.py`) is a vendored, trimmed copy of the main platform's
`libs/shared-auth` JWT validation (same Keycloak issuer/audience/JWKS,
so tokens from the main platform's realm work here unmodified) — see
that file's docstring for why there is deliberately no
`require_study_role` reimplementation: every study-scoped route forwards
the caller's own bearer token to the main platform's services, which
already enforce that RBAC.

## Configuration

All of `app/config.py`'s defaults assume the main platform's
docker-compose stack is running with its usual published ports
(`localhost:8080` Keycloak, `:8002` data-service, `:8003`
annotation-service, `:9000` MinIO) — override via env vars (see that
file) if it's deployed differently.

## Running

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8010
```

or via Docker:

```bash
docker build -t ct-annotator-backend .
docker run --rm -p 8010:8000 --network host ct-annotator-backend
```

(`--network host` so this container can reach the main platform's
services and Keycloak at `localhost:*` exactly like a plain `uvicorn`
process would — Linux only.)

## Testing

```bash
pytest
```

`tests/test_dicom_render.py` covers the pure decode/render/windowing
logic against small synthetic in-memory DICOM datasets — no live file
server, no network access, no dependency on the main platform being up.
The proxying/upload endpoints in `app/main.py` are exercised via curl
against a live stack instead (see the repo root README).
