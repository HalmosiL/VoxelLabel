# VoxelLabel clinician shell

A downloadable, installable desktop wrapper around the platform's own
admin-ui, reduced to exactly what a single assignee (typically a
doctor) needs: log in, see your own Annotation/Review jobs, open the
viewer. No Studies/Patients/Configuration surface, no separate browser
tab for ct-annotator, and (once set up) no re-login every launch.

This app has **no UI of its own** beyond a one-time "edit config.json"
screen -- everything you see after that is `admin-ui`'s own React app
running in "clinician mode" (see `admin-ui/src/config.ts`'s
`isClinicianApp` and everything that branches on it).

## One-time server setup (do this before handing out an installer)

**1. Add a Keycloak redirect URI.** This app serves the bundled
admin-ui over `http://127.0.0.1:45678` (a tiny local static server --
see `static-server.js`'s own comment for why it can't just be loaded
via `file://`). In the `ct-platform` realm's `ct-platform` client, add
to **Valid Redirect URIs**:

```
http://127.0.0.1:45678/*
```

and to **Web Origins**:

```
http://127.0.0.1:45678
```

**2. Allow that origin to call the backend services.** Each service
(admin-service, data-service, annotation-service, ingestion-service)
reads `ADMIN_UI_ORIGINS` (comma-separated) for CORS. The default
already includes `http://127.0.0.1:45678` alongside
`http://localhost:5173` -- if your deployment overrides
`ADMIN_UI_ORIGINS` in its own environment, add it there too.

## config.json

Backend URLs are **not** baked into the build -- the same installer
has to work against whatever real deployment a hospital runs, not
`localhost`. On first launch (or if the file is missing/unreadable),
the app writes a template and shows a one-time "edit this file and
restart" screen instead of a blank window. Location:

- Packaged install: inside the app's user data directory (platform-
  specific -- shown on that first-run screen).
- Dev (`npm start` in this directory): `clinician-app/config.json`,
  right next to this README (gitignored -- not shipped, not tracked).

Shape:

```json
{
  "keycloakUrl": "https://your-keycloak.example.org",
  "keycloakRealm": "ct-platform",
  "keycloakClientId": "ct-platform",
  "ingestionApi": "https://your-ingestion-api.example.org",
  "dataApi": "https://your-data-api.example.org",
  "annotationApi": "https://your-annotation-api.example.org",
  "adminApi": "https://your-admin-api.example.org",
  "annotatorUiUrl": "https://your-ct-annotator.example.org"
}
```

There is no in-app settings screen yet -- whoever sets up the machine
hand-edits this file once.

## Running in development

```bash
cd admin-ui && npm run build   # produces admin-ui/dist, which this app serves
cd ../clinician-app
npm install
npm start
```

## Building installers

```bash
npm run dist
```

Produces `nsis` (Windows), `dmg` (macOS), and `AppImage` (Linux)
targets from `package.json`'s `build` config -- but cross-building a
signed macOS installer from Linux isn't reliable, so build each
platform's installer from that platform (or a CI matrix), not all
three from one machine.

**No code-signing certificate is configured.** Windows/macOS will show
an "unknown publisher" warning on install until one is added.

## Known limitation: persisted login on some Linux setups

The "stay logged in between launches" feature stores the Keycloak
session via Electron's `safeStorage`, which is backed by each OS's own
credential store (Keychain on macOS, DPAPI on Windows, the desktop's
Secret Service -- gnome-keyring or KWallet -- on Linux). On a normal
Linux desktop this just works. On a Linux machine with **no** Secret
Service daemon running at all (some minimal/locked-down or headless
setups), `safeStorage.isEncryptionAvailable()` returns false even with
this app's `--password-store=basic` fallback (see `main.js`), and the
app silently falls back to asking for a fresh login every launch
instead of persisting one -- annoying, but not a crash or a data-loss
issue. If this affects a real deployment, installing/enabling
`gnome-keyring` (or KWallet on KDE) on that machine is the fix.
