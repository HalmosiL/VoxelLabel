// Runs before admin-ui's own bundle executes, in a privileged context
// separate from the page it exposes things into (contextIsolation:
// true) -- this is the *only* surface the actual React app can reach
// into Electron through. See admin-ui/src/clinician.d.ts for the
// shapes this promises to match.
const { contextBridge, ipcRenderer } = require("electron");

const CONFIG_PREFIX = "--clinician-config=";
const configArg = process.argv.find((arg) => arg.startsWith(CONFIG_PREFIX));

if (configArg) {
  const config = JSON.parse(configArg.slice(CONFIG_PREFIX.length));
  // A plain object, not a function -- admin-ui/src/config.ts reads this
  // synchronously at module scope, before any async IPC round-trip
  // could resolve, so it has to already be here by the time that
  // module's own top-level code runs.
  contextBridge.exposeInMainWorld("clinicianConfig", config);
}

// safeStorage (what actually encrypts the session at rest) only runs in
// the main process, so these all proxy over IPC rather than doing the
// encryption here.
contextBridge.exposeInMainWorld("clinicianSession", {
  getSession: () => ipcRenderer.invoke("clinician:getSession"),
  saveSession: (session) => ipcRenderer.invoke("clinician:saveSession", session),
  clearSession: () => ipcRenderer.invoke("clinician:clearSession"),
});
