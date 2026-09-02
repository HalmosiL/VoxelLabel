// VoxelLabel clinician shell -- a single-purpose Electron wrapper
// around admin-ui's own "My Jobs" + viewer flow (see
// admin-ui/src/config.ts's isClinicianApp and everything that branches
// on it). No new UI of its own beyond a first-run "edit config.json"
// safety screen; the bundled admin-ui/dist is the real app.
const path = require("path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");

const { loadConfig } = require("./config");
const sessionStore = require("./session-store");
const { startStaticServer } = require("./static-server");

// Some Linux desktops have no Secret Service daemon (gnome-keyring/
// KWallet) running -- safeStorage needs one for real OS-backed
// encryption, and without this fallback isEncryptionAvailable() simply
// returns false, silently disabling the persisted-login feature on
// those machines. "basic" trades some of that OS-level protection for
// actually working reliably everywhere; must be set before app is
// ready. Windows (DPAPI) and macOS (Keychain) never need this -- both
// always have a working OS-level store, so this is a no-op there.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("password-store", "basic");
}

const userDataDir = app.getPath("userData");

// Fixed, not dynamically chosen: Keycloak's Valid Redirect URIs
// allowlist needs an exact host:port match (its own wildcard support is
// suffix-only, on the path -- see this app's own README for the
// redirect URI Keycloak needs added). 127.0.0.1, not localhost, so this
// never collides with anything a developer might also have running on
// "localhost" under a different resolver behavior.
const STATIC_SERVER_PORT = 45678;

function adminUiDistDir() {
  // Packaged: extraResources copied admin-ui's dist next to the app
  // under resources/admin-ui (see package.json's build.extraResources).
  // Unpackaged (npm start, local dev): serve the sibling repo's dist
  // directly, so there's no separate copy/build step just to try the
  // shell out.
  return app.isPackaged ? path.join(process.resourcesPath, "admin-ui") : path.join(__dirname, "..", "admin-ui", "dist");
}

async function createWindow() {
  const { config, filePath } = loadConfig(userDataDir, app.isPackaged);

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Preload can't receive arbitrary data over IPC before the page
      // has even loaded (nothing's listening yet) -- passing the config
      // as a launch argument is what lets it inject
      // window.clinicianConfig synchronously, before admin-ui's own
      // bundle runs. Absent entirely when there's no config yet (first
      // run); preload treats that the same as "not present".
      additionalArguments: config ? [`--clinician-config=${JSON.stringify(config)}`] : [],
    },
  });

  // Anything admin-ui opens as a new window (e.g. CaseDetailPage's
  // "Open in Viewer" links, target="_blank" to ct-annotator) is
  // rendered as a real native window instead of Electron's default of
  // silently swallowing window.open -- no admin-ui code change needed
  // for this, it's purely this one hook.
  win.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: { width: 1400, height: 900 },
  }));

  if (config) {
    // Real http://127.0.0.1 origin, not file:// -- Keycloak's own
    // server-side redirect-URL builder throws ("empty host name") on a
    // file:// redirect_uri, so the login flow can never complete
    // against a file://-loaded page no matter how it's configured on
    // the client side. See static-server.js's own comment.
    await startStaticServer(adminUiDistDir(), STATIC_SERVER_PORT);
    win.loadURL(`http://127.0.0.1:${STATIC_SERVER_PORT}/`);
  } else {
    win.loadFile(path.join(__dirname, "no-config.html"), { query: { path: filePath } });
  }

  return win;
}

app.whenReady().then(() => {
  ipcMain.handle("clinician:getSession", () => sessionStore.getSession(userDataDir));
  ipcMain.handle("clinician:saveSession", (_event, session) => sessionStore.saveSession(userDataDir, session));
  ipcMain.handle("clinician:clearSession", () => sessionStore.clearSession(userDataDir));
  ipcMain.handle("clinician:openConfigFolder", () => shell.showItemInFolder(loadConfig(userDataDir, app.isPackaged).filePath));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
