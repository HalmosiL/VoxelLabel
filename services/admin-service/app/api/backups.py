"""Database backups: list what the db-backup compose service has taken,
start one on demand, download or delete one. Global admin only. The
files themselves are written by the separate `db-backup` container
(scripts/db-backup-loop.sh); this service only sees the shared volume.
"""
import json
import os
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from shared_auth import CurrentUser, get_current_user

from app.core.config import settings

router = APIRouter(prefix="/admin/backups", tags=["admin:backups"])

_DUMP_NAME = re.compile(r"^ctplatform-\d{8}-\d{6}\.dump$")


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


def _safe_path(filename: str) -> str:
    if not _DUMP_NAME.match(filename):
        raise HTTPException(status_code=404, detail="Backup not found")
    path = os.path.join(settings.backups_dir, filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Backup not found")
    return path


@router.get("")
def list_backups(user: CurrentUser = Depends(get_current_user)) -> dict:
    """Every dump in the backups volume (newest first) plus the backup
    service's last status and whether an on-demand backup is queued."""
    _require_global_admin(user)
    directory = settings.backups_dir
    if not os.path.isdir(directory):
        return {"available": False, "backups": [], "status": None, "queued": False, "directory": directory}
    backups = []
    for name in os.listdir(directory):
        if not _DUMP_NAME.match(name):
            continue
        stat = os.stat(os.path.join(directory, name))
        checksum_path = os.path.join(directory, name + ".sha256")
        backups.append(
            {
                "filename": name,
                "size_bytes": stat.st_size,
                "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "sha256": open(checksum_path).read().strip() if os.path.exists(checksum_path) else None,
            }
        )
    backups.sort(key=lambda b: b["filename"], reverse=True)
    status = None
    status_path = os.path.join(directory, "status.json")
    if os.path.exists(status_path):
        try:
            status = json.load(open(status_path))
        except (OSError, ValueError):
            status = None
    return {
        "available": True,
        "backups": backups,
        "status": status,
        "queued": os.path.exists(os.path.join(directory, ".trigger")),
        "directory": directory,
    }


@router.post("", status_code=202)
def request_backup(user: CurrentUser = Depends(get_current_user)) -> dict:
    """Ask the backup service for a backup now (it polls for the trigger
    every 30 s)."""
    _require_global_admin(user)
    if not os.path.isdir(settings.backups_dir):
        raise HTTPException(status_code=503, detail="The backups volume isn't mounted -- is the db-backup service configured?")
    with open(os.path.join(settings.backups_dir, ".trigger"), "w") as handle:
        handle.write(datetime.now(timezone.utc).isoformat())
    return {"status": "queued"}


@router.get("/{filename}")
def download_backup(filename: str, user: CurrentUser = Depends(get_current_user)) -> FileResponse:
    """The dump itself, for an off-site copy. It contains the full
    (pseudonymized) metadata database -- admin only, and treat it as
    sensitive."""
    _require_global_admin(user)
    return FileResponse(_safe_path(filename), media_type="application/octet-stream", filename=filename)


@router.delete("/{filename}", status_code=204)
def delete_backup(filename: str, user: CurrentUser = Depends(get_current_user)) -> None:
    _require_global_admin(user)
    path = _safe_path(filename)
    os.remove(path)
    checksum = path + ".sha256"
    if os.path.exists(checksum):
        os.remove(checksum)
