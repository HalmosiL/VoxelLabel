// Reads (and, on first run, writes a template for) config.json -- the
// backend URLs this specific install talks to. Not baked into the app
// at build time: the same installer has to work against whatever real
// deployment a hospital actually runs, not the "localhost" defaults
// admin-ui's own browser build uses for local dev. v1 has no in-app
// settings screen -- whoever sets up the machine hand-edits this file
// once.
const fs = require("fs");
const path = require("path");

const TEMPLATE = {
  keycloakUrl: "http://localhost:8080",
  keycloakRealm: "ct-platform",
  keycloakClientId: "ct-platform",
  ingestionApi: "http://localhost:8001",
  dataApi: "http://localhost:8002",
  annotationApi: "http://localhost:8003",
  adminApi: "http://localhost:8004",
  annotatorUiUrl: "http://localhost:5174",
};

/** Packaged: alongside the user's other app data (survives updates,
 * writable without admin rights on any of the three target OSes).
 * Dev (unpackaged): right next to this file, so `npm start` in this
 * directory picks up whatever the developer already has running
 * locally without any setup step. */
function configPath(userDataDir, isPackaged) {
  return isPackaged ? path.join(userDataDir, "config.json") : path.join(__dirname, "config.json");
}

/** Returns the parsed config, or null if it doesn't exist yet (first
 * run) or fails to parse -- either way, a template is written so the
 * next thing the person sees is "here's the file, go edit it", not a
 * silent crash or a mysteriously blank window. */
function loadConfig(userDataDir, isPackaged) {
  const filePath = configPath(userDataDir, isPackaged);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return { config: JSON.parse(raw), filePath };
  } catch {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(TEMPLATE, null, 2) + "\n", "utf-8");
    return { config: null, filePath };
  }
}

module.exports = { loadConfig, configPath };
