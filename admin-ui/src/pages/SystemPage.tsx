import { useEffect, useState } from "react";

import { BackupsOverview, deleteBackup, downloadBackup, listBackups, requestBackup } from "../api/adminApi";
import { describeApiError } from "../api/client";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import { TrashIcon } from "../components/icons";
import { SYSTEM_STEPS } from "../guide/adminSteps";
import { useRegisterGuide } from "../guide/GuideContext";

const POLL_MS = 5000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Platform admin's operations page: database backups (taken by the
 * db-backup service on a schedule and on demand here), with download
 * and restore guidance. */
export default function SystemPage() {
  const [overview, setOverview] = useState<BackupsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useRegisterGuide("system", SYSTEM_STEPS, overview !== null, false);

  function refresh() {
    listBackups()
      .then(setOverview)
      .catch((err) => setError(describeApiError(err)));
  }

  useEffect(() => {
    refresh();
    const handle = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(handle);
  }, []);

  async function handleBackupNow() {
    setBusy(true);
    setError(null);
    try {
      await requestBackup();
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(filename: string) {
    if (!window.confirm(`Delete backup ${filename}? This cannot be undone.`)) return;
    try {
      await deleteBackup(filename);
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  async function handleDownload(filename: string) {
    try {
      await downloadBackup(filename);
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  const status = overview?.status ?? null;
  const running = status?.state === "running" || overview?.queued;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="System"
        subtitle="Database backups and maintenance. Object storage (images, documents, masks) is backed up separately -- see the README."
        action={
          <button onClick={handleBackupNow} className="btn-primary btn-sm" disabled={busy || Boolean(running) || !overview?.available} data-guide="backup-now">
            {running ? "Backup running…" : "Back up now"}
          </button>
        }
      />
      {error && <p className="alert-error">{error}</p>}

      {overview && !overview.available && (
        <p className="alert-error">
          The backups volume isn't mounted into admin-service ({overview.directory}) -- start the stack with the
          db-backup service (docker compose up -d) to enable backups.
        </p>
      )}

      {status && (
        <div
          data-guide="backup-status"
          className={`rounded-lg border px-3.5 py-2.5 text-sm ${
            status.state === "failed"
              ? "border-red-200 bg-red-50 text-red-700"
              : status.state === "running" || overview?.queued
                ? "border-blue-100 bg-blue-50 text-blue-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          <span className="font-medium">Last backup run:</span> {status.message} ({new Date(status.at).toLocaleString()})
          {overview?.queued && " · a new backup is queued and starts within 30 seconds"}
        </div>
      )}

      <div className="card" data-guide="backups">
        <h2 className="section-title mb-1">Backups</h2>
        <p className="hint mb-4">
          Taken automatically once a day and kept for 14 days (see the db-backup service in docker-compose.yml). Each
          file is a compressed pg_dump of the whole metadata database; download one for an off-site copy.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Taken</th>
                <th>Size</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(overview?.backups ?? []).length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <EmptyState message="No backups yet -- the first one is taken shortly after the backup service starts." />
                  </td>
                </tr>
              )}
              {(overview?.backups ?? []).map((b) => (
                <tr key={b.filename}>
                  <td className="font-mono text-xs">
                    {b.filename}
                    {b.sha256 && <span className="ml-2 text-gray-400" title={`sha256 ${b.sha256}`}>✓ checksum</span>}
                  </td>
                  <td className="text-sm text-gray-500">{new Date(b.created_at).toLocaleString()}</td>
                  <td className="text-sm text-gray-500">{formatBytes(b.size_bytes)}</td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => handleDownload(b.filename)} className="btn-secondary btn-sm">
                        Download
                      </button>
                      <button onClick={() => handleDelete(b.filename)} className="text-gray-400 hover:text-red-600" title="Delete backup">
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" data-guide="restoring">
        <h2 className="section-title mb-1">Restoring</h2>
        <p className="hint">
          Restoring replaces the whole database with the chosen backup. From the platform's checkout, on the host:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-gray-900 px-4 py-3 text-xs text-gray-100">
          scripts/restore-db.sh ctplatform-YYYYMMDD-HHMMSS.dump
        </pre>
        <p className="hint mt-2">
          The script stops the API services, restores with pg_restore --clean, and starts everything again. Study-level
          mistakes rarely need this -- every study keeps its own version history (Study page → Version history) that can
          be restored without touching the rest of the platform.
        </p>
      </div>
    </div>
  );
}
