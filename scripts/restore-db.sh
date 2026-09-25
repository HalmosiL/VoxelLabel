#!/usr/bin/env bash
# Restore the platform database from a backup taken by the db-backup
# service. Usage:
#   scripts/restore-db.sh ctplatform-20260909-080000.dump
#   scripts/restore-db.sh ctplatform-20260909-080000.dump --check-only   # verify the file, restore nothing
#   scripts/restore-db.sh old-backup.dump --unverified                    # a backup without a .sha256 file
# First checks the file against the checksum the backup service stored
# next to it (<file>.sha256) -- a damaged or partial dump is refused before
# anything is stopped. Then stops the API services (open connections
# would block the restore), restores with --clean (drops and recreates
# objects), and starts everything again. Object storage (MinIO) is NOT
# part of this -- DICOM/documents/masks live there, keep its volume backed
# up separately (e.g. `mc mirror`).
set -euo pipefail
FILE="${1:?usage: restore-db.sh <backup filename inside the db-backups volume> [--check-only|--unverified]}"
MODE="${2:-}"
cd "$(dirname "$0")/.."

echo "Checking $FILE ..."
docker compose exec -T -e FILE="$FILE" -e MODE="$MODE" db-backup sh -c '
  cd /backups
  [ -f "$FILE" ] || { echo "No backup named $FILE in the db-backups volume." >&2; exit 1; }
  if [ ! -f "$FILE.sha256" ]; then
    [ "$MODE" = "--unverified" ] || { echo "$FILE has no checksum file ($FILE.sha256); pass --unverified to restore it anyway." >&2; exit 1; }
    echo "No checksum file -- restoring unverified, as asked."
    exit 0
  fi
  expected=$(cut -d" " -f1 "$FILE.sha256")
  actual=$(sha256sum "$FILE" | cut -d" " -f1)
  [ "$expected" = "$actual" ] || { echo "$FILE does not match its checksum -- damaged or incomplete; nothing was changed." >&2; exit 1; }
  echo "Checksum OK."
'
if [ "$MODE" = "--check-only" ]; then
  exit 0
fi

echo "Stopping API services..."
docker compose stop ingestion-service ingestion-worker data-service annotation-service admin-service mcp-server
echo "Restoring $FILE ..."
docker compose exec -T -e FILE="$FILE" db-backup sh -c 'pg_restore --clean --if-exists --no-owner --dbname=$PGDATABASE "/backups/$FILE"'
echo "Starting services..."
docker compose up -d
echo "Done. Verify with: docker compose exec postgres psql -U ctplatform -d ctplatform -c 'select count(*) from studies;'"
