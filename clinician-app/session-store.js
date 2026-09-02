// Persists the Keycloak token set (access + refresh + id token) across
// launches, so the app can restore a session without a fresh login.
// Encrypted at rest via Electron's safeStorage, which is backed by each
// OS's own keychain (Keychain on macOS, DPAPI on Windows, libsecret on
// Linux) -- the ciphertext on disk is useless without that OS-level
// key, unlike storing the refresh token as plain JSON.
const fs = require("fs");
const path = require("path");
const { safeStorage } = require("electron");

function sessionFilePath(userDataDir) {
  return path.join(userDataDir, "session.enc");
}

function getSession(userDataDir) {
  const filePath = sessionFilePath(userDataDir);
  if (!fs.existsSync(filePath)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = fs.readFileSync(filePath);
    return JSON.parse(safeStorage.decryptString(encrypted));
  } catch {
    // Corrupt file, or encrypted under a since-changed OS key (e.g. the
    // user's OS login keychain was reset) -- treat as "no session"
    // rather than crashing the app; main.tsx falls back to a real login.
    return null;
  }
}

function saveSession(userDataDir, session) {
  if (!safeStorage.isEncryptionAvailable()) return;
  const encrypted = safeStorage.encryptString(JSON.stringify(session));
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(sessionFilePath(userDataDir), encrypted);
}

function clearSession(userDataDir) {
  const filePath = sessionFilePath(userDataDir);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { getSession, saveSession, clearSession };
