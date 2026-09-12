#!/usr/bin/env bash
# Runs admin-service's integration tests (tests/integration) against the
# compose stack's Postgres, in a throwaway admin-service container --
# real app, real database, faked Keycloak and SMTP. Creates the
# `ctplatform_test` database on first use. Extra args go to pytest.
#
#   scripts/test-integration.sh
#   scripts/test-integration.sh -k workflow -x
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
PGUSER="${POSTGRES_USER:-ctplatform}"; PGPASS="${POSTGRES_PASSWORD:-ctplatform}"; PGDB="${POSTGRES_DB:-ctplatform}"
docker compose up -d postgres >/dev/null
docker compose exec -T postgres sh -c "until pg_isready -U $PGUSER >/dev/null 2>&1; do sleep 1; done"
docker compose exec -T postgres sh -c "psql -U $PGUSER -d $PGDB -tc \"SELECT 1 FROM pg_database WHERE datname='${PGDB}_test'\" | grep -q 1 || psql -U $PGUSER -d $PGDB -c 'CREATE DATABASE ${PGDB}_test'" >/dev/null
docker compose run --rm --no-deps \
  -e DATABASE_URL="postgresql+psycopg://$PGUSER:$PGPASS@postgres:5432/${PGDB}_test" \
  -e NOTIFICATIONS_POLLER_ENABLED=0 \
  -v "$PWD/services/admin-service/tests:/app/tests" \
  -v "$PWD/services/admin-service/app:/app/app" \
  -v "$PWD/libs/shared-models/shared_models:/usr/local/lib/python3.11/site-packages/shared_models" \
  admin-service python -m pytest -q tests/integration "$@"
