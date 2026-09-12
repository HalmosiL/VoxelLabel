#!/usr/bin/env bash
# Apply every pending Alembic migration to the running compose stack's
# Postgres -- from inside a throwaway admin-service container, so the
# host needs nothing but Docker (no local Python/alembic). Idempotent.
#
#   scripts/migrate.sh            # upgrade head
#   scripts/migrate.sh current    # any other alembic subcommand
set -euo pipefail
cd "$(dirname "$0")/.."
CMD="${*:-upgrade head}"
docker compose run --rm --no-deps \
  -v "$PWD/infra/migrations:/migrations" \
  -v "$PWD/libs/shared-models:/tmp/shared-models" \
  admin-service sh -c "pip install -q alembic -e /tmp/shared-models >/dev/null 2>&1 && cd /migrations && alembic $CMD"
