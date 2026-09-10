#!/usr/bin/env bash
# Runs inside the `db-backup` compose service (postgres:16 image, so
# pg_dump matches the server). Takes a compressed logical backup of the
# platform database on a fixed interval AND whenever /backups/.trigger
# appears (admin-service's "Back up now" creates it), prunes backups
# older than the retention window, and writes /backups/status.json so
# the admin-ui can show what happened last.
#
# Restore: see scripts/restore-db.sh.
set -u
BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"

status() {  # $1=state $2=file $3=message
  printf '{"state":"%s","file":"%s","message":"%s","at":"%s"}\n' "$1" "$2" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$BACKUP_DIR/status.json"
}

run_backup() {
  local stamp file tmp
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  file="$BACKUP_DIR/ctplatform-$stamp.dump"
  tmp="$file.partial"
  status "running" "$(basename "$file")" "backup in progress"
  if pg_dump --format=custom --compress=6 --file="$tmp" "$PGDATABASE"; then
    mv "$tmp" "$file"
    sha256sum "$file" | awk '{print $1}' > "$file.sha256"
    status "ok" "$(basename "$file")" "backup completed ($(du -h "$file" | cut -f1))"
    find "$BACKUP_DIR" -name 'ctplatform-*.dump' -mtime +"$RETENTION_DAYS" -print -delete | sed 's/^/pruned: /'
    find "$BACKUP_DIR" -name 'ctplatform-*.dump.sha256' -mtime +"$RETENTION_DAYS" -delete
  else
    rm -f "$tmp"
    status "failed" "$(basename "$file")" "pg_dump failed -- see the db-backup container logs"
  fi
  date +%s > "$BACKUP_DIR/.last-run"
}

# Wait for Postgres, then take a first backup so a fresh install has one.
until pg_isready -q; do sleep 5; done
[ -f "$BACKUP_DIR/.last-run" ] || run_backup

while true; do
  now=$(date +%s)
  last=$(cat "$BACKUP_DIR/.last-run" 2>/dev/null || echo 0)
  if [ -f "$BACKUP_DIR/.trigger" ]; then
    rm -f "$BACKUP_DIR/.trigger"
    run_backup
  elif [ $((now - last)) -ge "$INTERVAL" ]; then
    run_backup
  fi
  sleep 30
done
