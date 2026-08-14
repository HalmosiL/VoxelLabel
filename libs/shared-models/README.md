# shared-models

Shared SQLAlchemy ORM models and DB session utilities for the CT annotation
platform. This is the single source of truth for the database schema --
every service (`ingestion`, `data`, `annotation`, `admin`) and the Alembic
migrations in `infra/migrations` import from here rather than redefining
tables.

## Contents

- `shared_models/models.py` -- all ORM models (patients, studies, series,
  instances, annotations, projects, de-identification profiles, dataset
  snapshots, audit log). See the module docstrings for the reasoning behind
  each table.
- `shared_models/database.py` -- SQLAlchemy engine/session factory and the
  `get_db()` FastAPI dependency, configured via the `DATABASE_URL` env var.

## Installing (local dev)

```bash
pip install -e .
```

Each service's `Dockerfile` installs this package in editable mode at build
time; see `services/*/Dockerfile`.

## Testing standalone

This library has no tests of its own beyond what Alembic's
`--autogenerate` diffing implicitly verifies (schema matches the models).
Model behavior is exercised indirectly by each service's test suite.
