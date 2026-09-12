.PHONY: up down test test-ingestion test-data test-annotation test-admin test-integration test-ui test-e2e test-all migrate setup

up:
	docker compose up --build

down:
	docker compose down

# Runs each service's test suite in its own venv-less local install.
# Requires: pip install -e libs/shared-models -e libs/shared-auth, plus
# each service's requirements.txt, done once beforehand (see root README).
test: test-ingestion test-data test-annotation test-admin

test-ingestion:
	cd services/ingestion-service && pytest

test-data:
	cd services/data-service && pytest

test-annotation:
	cd services/annotation-service && pytest

test-admin:
	cd services/admin-service && pytest

migrate:
	cd infra/migrations && alembic upgrade head

# First-time (and any-time) setup of the whole stack from .env -- see INSTALL.md.
setup:
	scripts/setup-test-server.sh

# Integration tests: the real admin-service against the compose stack's
# Postgres (a ctplatform_test database), Keycloak/SMTP faked. See TESTING.md.
test-integration:
	scripts/test-integration.sh

# Frontend unit tests (Vitest), run in a Node container so the host needs no npm.
test-ui:
	docker run --rm -v "$(PWD)/admin-ui:/app" -w /app -e HOME=/tmp node:20-slim sh -c "npm ci --no-audit --no-fund >/dev/null && npx vitest run"

# Browser end-to-end specs against the running stack (docker compose up first).
test-e2e:
	e2e/run.sh

test-all: test test-integration test-ui test-e2e
