import { FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { createCase, deleteCase } from "../api/adminApi";
import { describeApiError } from "../api/client";
import { CaseSummary, listPatients, PatientSummary, searchCases } from "../api/dataApi";
import { getQuickImport, QuickImportStatus } from "../api/ingestionApi";
import EmptyState from "./EmptyState";
import { TrashIcon } from "./icons";
import Modal from "./Modal";
import QuickImportModal from "./QuickImportModal";
import SectionHeader from "./SectionHeader";

const PAGE_SIZE = 25;
const IMPORT_POLL_MS = 2500;

/** The study's case list: server-side search + paging (a study can hold
 * thousands of cases), and the create/import/delete actions only for a
 * member who may actually manage data -- an annotator gets a plain list. */
export default function CasesPanel({ studyId, canManage }: { studyId: string; canManage: boolean }) {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // A quick import that was started from the modal keeps being tracked
  // here even after the modal is closed, so its outcome (cases created /
  // matched, files that failed) is still shown as a banner on this panel.
  const [activeImport, setActiveImport] = useState<{ id: string; status: QuickImportStatus | null } | null>(null);
  const importPollRef = useRef<number | null>(null);

  function refresh() {
    setLoading(true);
    searchCases(studyId, { q: query.trim() || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then(({ items, total: count }) => {
        setCases(items);
        setTotal(count);
      })
      .catch((err) => setError(describeApiError(err)))
      .finally(() => setLoading(false));
  }

  // Debounced: typing in the search box re-queries after a short pause,
  // not on every keystroke.
  useEffect(() => {
    const handle = window.setTimeout(refresh, query ? 300 : 0);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyId, query, page]);

  useEffect(() => {
    setPage(0);
  }, [query, studyId]);

  useEffect(() => {
    if (!activeImport || (activeImport.status && ["completed", "failed"].includes(activeImport.status.status))) return;
    const poll = () => {
      getQuickImport(activeImport.id)
        .then((status) => {
          setActiveImport({ id: activeImport.id, status });
          if (status.status === "completed") refresh();
          else if (status.status !== "failed") importPollRef.current = window.setTimeout(poll, IMPORT_POLL_MS);
        })
        .catch(() => {
          importPollRef.current = window.setTimeout(poll, IMPORT_POLL_MS);
        });
    };
    importPollRef.current = window.setTimeout(poll, IMPORT_POLL_MS);
    return () => {
      if (importPollRef.current !== null) window.clearTimeout(importPollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeImport?.id, activeImport?.status?.status]);

  async function handleDelete(c: CaseSummary) {
    const label = c.title || `Patient ${c.patient_pseudonym_id.slice(0, 8)}…`;
    if (!window.confirm(`Delete "${label}"? This removes all its imaging and clinical data too, and cannot be undone.`)) {
      return;
    }
    try {
      await deleteCase(c.id);
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstIndex = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastIndex = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <div className="card">
      <SectionHeader
        title="Cases"
        action={
          canManage ? (
            <div className="flex items-center gap-2">
              <button onClick={() => setImportOpen(true)} className="btn-secondary btn-sm">
                Quick import
              </button>
              <button onClick={() => setCreateOpen(true)} className="btn-secondary btn-sm">
                New case
              </button>
            </div>
          ) : undefined
        }
      />
      {error && <p className="alert-error mt-3">{error}</p>}
      {activeImport && <ImportBanner status={activeImport.status} onDismiss={() => setActiveImport(null)} />}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <input
          className="input max-w-sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title, accession number or type…"
          aria-label="Search cases"
        />
        <p className="hint">
          {total === 0 ? "No cases" : `${firstIndex}–${lastIndex} of ${total} case${total === 1 ? "" : "s"}`}
          {loading && " · loading…"}
        </p>
      </div>

      <div className="table-wrap mt-3">
        <table>
          <thead>
            <tr>
              <th>Case</th>
              <th>Accession number</th>
              <th>Tags</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {cases.length === 0 && !loading && (
              <tr>
                <td colSpan={4}>
                  <EmptyState
                    message={
                      query
                        ? "No cases match your search."
                        : canManage
                          ? "No cases yet -- create one or use Quick import above."
                          : "No cases yet."
                    }
                  />
                </td>
              </tr>
            )}
            {cases.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/studies/${studyId}/cases/${c.id}`} className="font-medium text-brand-600 hover:text-brand-700">
                    {c.title || `Patient ${c.patient_pseudonym_id.slice(0, 8)}…`}
                  </Link>
                </td>
                <td className="font-mono text-xs">{c.accession_number ?? "—"}</td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {c.tags.map((tag) => (
                      <span key={tag} className="badge-gray">
                        {tag}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    {canManage && (
                      <button onClick={() => handleDelete(c)} className="text-gray-400 hover:text-red-600" title="Delete case">
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    )}
                    <Link to={`/studies/${studyId}/cases/${c.id}`} className="text-gray-300">
                      <ChevronRight />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="btn-secondary btn-sm">
            ← Previous
          </button>
          <span className="text-xs text-gray-500">
            Page {page + 1} of {pageCount}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={page >= pageCount - 1}
            className="btn-secondary btn-sm"
          >
            Next →
          </button>
        </div>
      )}

      {createOpen && (
        <NewCaseModal
          studyId={studyId}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            refresh();
          }}
        />
      )}
      {importOpen && (
        <QuickImportModal
          studyId={studyId}
          onClose={() => setImportOpen(false)}
          onImported={refresh}
          onStarted={(importId) => setActiveImport({ id: importId, status: null })}
        />
      )}
    </div>
  );
}

/** The outcome of the most recent quick import, persisted on the panel
 * even once the modal is gone: still running (with N of M progress), or
 * a summary of what landed and what didn't. */
function ImportBanner({ status, onDismiss }: { status: QuickImportStatus | null; onDismiss: () => void }) {
  if (!status || status.status === "pending" || status.status === "started" || status.status === "retry") {
    return (
      <div className="mt-3 flex items-center justify-between rounded-lg border border-blue-100 bg-blue-50 px-3.5 py-2.5 text-sm text-blue-700">
        <span>Quick import queued -- waiting for the worker to pick it up…</span>
      </div>
    );
  }
  if (status.status === "progress") {
    return (
      <div className="mt-3 flex items-center justify-between rounded-lg border border-blue-100 bg-blue-50 px-3.5 py-2.5 text-sm text-blue-700">
        <span>
          Importing {status.current} of {status.total} files… ({status.filename.split("/").pop()})
        </span>
      </div>
    );
  }
  if (status.status === "failed") {
    return (
      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
        <span>Quick import failed: {status.error}</span>
        <button onClick={onDismiss} className="text-xs font-medium underline">
          Dismiss
        </button>
      </div>
    );
  }
  if (status.status === "completed") {
    const created = status.cases.filter((c) => c.created).length;
    const matched = status.cases.length - created;
    const instances = status.cases.reduce((sum, c) => sum + c.instance_count, 0);
    const failed = status.errors.length;
    return (
      <div
        className={`mt-3 flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-sm ${
          failed > 0 ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"
        }`}
      >
        <div>
          <p className="font-medium">
            Quick import finished: {instances} image{instances === 1 ? "" : "s"} into {status.cases.length} case
            {status.cases.length === 1 ? "" : "s"} ({created} new, {matched} matched)
            {failed > 0 && ` -- ${failed} file${failed === 1 ? "" : "s"} skipped`}
          </p>
          {failed > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {status.errors.slice(0, 5).map((e, i) => (
                <li key={i}>
                  {e.file.split("/").pop()}: {e.error}
                </li>
              ))}
              {failed > 5 && <li>…and {failed - 5} more</li>}
            </ul>
          )}
        </div>
        <button onClick={onDismiss} className="text-xs font-medium underline">
          Dismiss
        </button>
      </div>
    );
  }
  return null;
}

function NewCaseModal({ studyId, onClose, onSaved }: { studyId: string; onClose: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [externalPatientId, setExternalPatientId] = useState("");
  const [existingPatientId, setExistingPatientId] = useState("");
  const [patients, setPatients] = useState<PatientSummary[]>([]);
  const [patientPickerAvailable, setPatientPickerAvailable] = useState(false);
  const [accessionNumber, setAccessionNumber] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Browsing existing patients requires the global admin role (patient
    // identity can span studies -- see data-service). Non-global-admin
    // users just don't get this option; the "new patient" flow below
    // always works for anyone with a study role.
    listPatients()
      .then((p) => {
        setPatients(p);
        setPatientPickerAvailable(true);
      })
      .catch(() => setPatientPickerAvailable(false));
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      const patientRef = mode === "existing" ? { patientId: existingPatientId } : { externalPatientId };
      await createCase(studyId, patientRef, { accessionNumber, title });
      onSaved();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <Modal title="New case" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}

        {patientPickerAvailable && (
          <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
            <button
              type="button"
              onClick={() => setMode("new")}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
                mode === "new" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
              }`}
            >
              New patient
            </button>
            <button
              type="button"
              onClick={() => setMode("existing")}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
                mode === "existing" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
              }`}
            >
              Existing patient
            </button>
          </div>
        )}

        {mode === "new" ? (
          <div className="flex flex-col gap-1.5">
            <label className="field">
              <span className="label">Patient identifier (e.g. MRN)</span>
              <input
                className="input"
                value={externalPatientId}
                onChange={(e) => setExternalPatientId(e.target.value)}
                placeholder="The real-world identifier -- hashed, never stored"
                required
              />
            </label>
            <p className="hint">Hashed and never stored directly -- only a pseudonym is kept.</p>
          </div>
        ) : (
          <label className="field">
            <span className="label">Patient</span>
            <select className="input" value={existingPatientId} onChange={(e) => setExistingPatientId(e.target.value)} required>
              <option value="" disabled>
                Select a patient…
              </option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.pseudonym_id.slice(0, 8)}… ({p.case_count} case{p.case_count === 1 ? "" : "s"})
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          <span className="label">Title</span>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Chest CT follow-up, 2026-03"
          />
        </label>
        <label className="field">
          <span className="label">Accession number</span>
          <input
            className="input"
            value={accessionNumber}
            onChange={(e) => setAccessionNumber(e.target.value)}
            placeholder="Optional -- the RIS/PACS accession number"
          />
        </label>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" className="btn-primary">
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ChevronRight() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="ml-auto h-4 w-4">
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
        clipRule="evenodd"
      />
    </svg>
  );
}
