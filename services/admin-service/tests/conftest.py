"""Top-level pytest config for admin-service.

The pure-logic tests in this directory run anywhere. The tests under
integration/ drive the real FastAPI app against a real Postgres and
are only collected when DATABASE_URL points at a database whose name
ends in `_test` -- see integration/conftest.py and scripts/test-integration.sh
at the repo root (which sets that up inside the compose stack).
"""
import os

if not os.environ.get("DATABASE_URL", "").rstrip("/").split("/")[-1].endswith("_test"):
    collect_ignore_glob = ["integration/*"]
