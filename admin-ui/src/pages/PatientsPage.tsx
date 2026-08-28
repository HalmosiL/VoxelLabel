import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { createPatient } from "../api/adminApi";
import { listPatients, PatientSummary } from "../api/dataApi";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";
import PageHeader from "../components/PageHeader";

export default function PatientsPage() {
  const [patients, setPatients] = useState<PatientSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showNewPatient, setShowNewPatient] = useState(false);

  function refresh() {
    listPatients()
      .then(setPatients)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, []);

  const filtered = patients.filter((p) => p.pseudonym_id.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Patients"
        subtitle="Every patient across all studies. Click one to see their cases, images, and tags."
      />
      {error && <p className="alert-error">{error}</p>}

      <div className="flex items-end justify-between gap-4">
        <label className="field w-80">
          <span className="label">Search by patient ID</span>
          <input
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Paste or type a patient pseudonym ID…"
          />
        </label>
        <button onClick={() => setShowNewPatient(true)} className="btn-primary self-end">
          New patient
        </button>
      </div>

      {showNewPatient && (
        <NewPatientModal
          onClose={() => setShowNewPatient(false)}
          onCreated={() => {
            setShowNewPatient(false);
            refresh();
          }}
          onError={setError}
        />
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Patient</th>
              <th>Cases</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={3}>
                  <EmptyState
                    message={
                      patients.length === 0
                        ? "No patients yet -- create one directly, or add a case to register one."
                        : "No patients match your search."
                    }
                  />
                </td>
              </tr>
            )}
            {filtered.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/patients/${p.id}`} className="font-medium text-brand-600 hover:text-brand-700">
                    Patient {p.pseudonym_id.slice(0, 8)}…
                  </Link>
                </td>
                <td>
                  <span className="badge-gray">{p.case_count}</span>
                </td>
                <td className="text-right text-gray-300">
                  <Link to={`/patients/${p.id}`}>
                    <ChevronRight />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NewPatientModal({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void;
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const [externalPatientId, setExternalPatientId] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await createPatient(externalPatientId.trim());
      onCreated();
    } catch (err) {
      onError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="New patient" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="hint">
          Register a patient before they have any case or imaging data yet. Their real identifier is pseudonymized
          immediately and never stored in the clear -- the same identifier used later when creating a case for them
          resolves back to this same patient, not a duplicate.
        </p>
        <label className="field">
          <span className="label">Patient identifier (e.g. MRN)</span>
          <input
            className="input"
            value={externalPatientId}
            onChange={(e) => setExternalPatientId(e.target.value)}
            autoFocus
            required
          />
        </label>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={saving || !externalPatientId.trim()}>
            {saving ? "Creating…" : "Create"}
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
