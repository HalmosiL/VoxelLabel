// Serves the bundled admin-ui build over a real http://127.0.0.1 origin
// instead of loading it via file://. This isn't just cosmetic: Keycloak
// itself throws server-side ("empty host name", inside
// OIDCRedirectUriBuilder) trying to build the final redirect URL when
// redirect_uri has no host component, which every file:// URI does by
// definition -- the login flow can never complete against a
// file://-loaded page, no matter how permissively the client's Valid
// Redirect URIs are configured. A tiny local static server (Node's
// built-in http/fs, no extra dependency) sidesteps that entirely: from
// Keycloak's perspective this is just an ordinary http://localhost app,
// exactly like admin-ui's normal browser deployment.
const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function startStaticServer(rootDir, port) {
  const indexPath = path.join(rootDir, "index.html");

  const server = http.createServer((req, res) => {
    const reqPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const resolved = path.normalize(path.join(rootDir, reqPath === "/" ? "index.html" : reqPath));

    // Path-traversal guard, then the same SPA fallback admin-ui's own
    // nginx.conf already uses (try_files $uri /index.html) -- a deep
    // link like /my-jobs has no matching file on disk; React Router
    // takes over once index.html itself has loaded.
    const filePath = resolved.startsWith(rootDir) ? resolved : indexPath;

    fs.readFile(filePath, (err, data) => {
      if (!err) {
        res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
        return;
      }
      fs.readFile(indexPath, (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(data2);
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

module.exports = { startStaticServer };
