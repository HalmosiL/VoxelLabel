import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { createCase } from "../api/adminApi";
import { CaseSummary, listCases, listPatients, PatientSummary } from "../api/dataApi";
import EmptyState from "./EmptyState";
import Modal from "./Modal";
import SectionHeader from "./SectionHeader";

export default function CasesPanel({ studyId }: { studyId: string }) {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  function refresh() {
    listCases(studyId)
      .then(setCases)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, [studyId]);

  return (
    <div className="card">
      <SectionHeader
        title="Cases"
        action={
          <button onClick={() => setCreateOpen(true)} className="btn-secondary btn-sm">
            New case
          </button>
        }
      />
      {error && <p className="alert-error mt-3">{error}</p>}

      <div className="table-wrap mt-4">
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
            {cases.length === 0 && (
              <tr>
                <td colSpan={4}>
                  <EmptyState message="No cases yet -- create one above." />
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
                <td className="text-right text-gray-300">
                  <Link to={`/studies/${studyId}/cases/${c.id}`}>
                    <ChevronRight />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
    </div>
  );
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
      setError(String(err));
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
                required
              />
            </label>
            <p className="hint">Hashed and never stored directly -- only a pseudonym is kept.</p>
          </div>
        ) : (
          <label className="field">
            <span className="label">Patient</span>
            <select
              className="input"
              value={existingPatientId}
              onChange={(e) => setExistingPatientId(e.target.value)}
              required
            >
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
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Accession number</span>
          <input className="input" value={accessionNumber} onChange={(e) => setAccessionNumber(e.target.value)} />
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
