#!/usr/bin/env bash
# Restore the platform database from a backup taken by the db-backup
# service. Usage:  scripts/restore-db.sh ctplatform-20260909-080000.dump
# Stops the API services first (open connections would block the
# restore), restores with --clean (drops and recreates objects), then
# starts everything again. Object storage (MinIO) is NOT part of this --
# DICOM/documents/masks live there, keep its volume backed up separately
# (e.g. `mc mirror`).
set -euo pipefail
FILE="${1:?usage: restore-db.sh <backup filename inside the db-backups volume>}"
cd "$(dirname "$0")/.."
echo "Stopping API services..."
docker compose stop ingestion-service ingestion-worker data-service annotation-service admin-service mcp-server
echo "Restoring $FILE ..."
docker compose exec -T db-backup sh -c "pg_restore --clean --if-exists --no-owner --dbname=\$PGDATABASE /backups/$FILE"
echo "Starting services..."
docker compose up -d
echo "Done. Verify with: docker compose exec postgres psql -U ctplatform -d ctplatform -c 'select count(*) from studies;'"
