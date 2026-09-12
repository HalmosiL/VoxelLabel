.PHONY: up down test test-ingestion test-data test-annotation test-admin migrate setup

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
