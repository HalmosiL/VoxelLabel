#!/usr/bin/env bash
# Runs the browser end-to-end specs against the LOCAL running stack
# (admin-ui :5173, ct-annotator :5174, Keycloak :8080, the APIs) inside
# the pinned Playwright image -- nothing to install on the host.
#
#   e2e/run.sh                 # every spec
#   e2e/run.sh auth-page viewas # just these
#
# Each spec is a plain Node script printing PASS/FAIL lines and exiting
# non-zero on a failure; this prints one summary line per spec.
set -u
cd "$(dirname "$0")"
IMAGE=mcr.microsoft.com/playwright:v1.47.0-jammy
if [ $# -gt 0 ]; then specs=("$@"); else specs=(); for f in *.spec.js; do specs+=("${f%.spec.js}"); done; fi
# The Playwright image ships the browsers but not the npm package on the
# module path of an arbitrary directory -- install it here once (pinned
# to the image's own version in package.json; node_modules is gitignored).
if [ ! -d node_modules/playwright ]; then
  docker run --rm -v "$PWD:/w" -w /w "$IMAGE" sh -c "npm install --no-audit --no-fund >/dev/null 2>&1 && chown -R $(id -u):$(id -g) node_modules package-lock.json" || { echo "npm install of playwright failed" >&2; exit 1; }
fi
fail=0
for s in "${specs[@]}"; do
  printf '%-32s ' "$s"
  # A spec fails on a non-zero exit OR a "checks N, fails M" summary with M > 0
  # (a few older specs print the summary without setting an exit code).
  if out=$(docker run --rm --network host -v "$PWD:/w" -w /w "$IMAGE" sh -c "node $s.spec.js" 2>&1) && ! echo "$out" | grep -qE '^checks [0-9]+, fails [1-9]'; then
    echo "ok   $(echo "$out" | grep -E '^checks|ALL VISIBLE' | tail -1)"
  else
    fail=1; echo "FAIL"; echo "$out" | grep -E '^FAIL|EXC|Error' | head -8 | sed 's/^/    /'
  fi
done
exit $fail
