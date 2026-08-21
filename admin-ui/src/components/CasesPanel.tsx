import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { createCase } from "../api/adminApi";
import { CaseSummary, listCases } from "../api/dataApi";
import EmptyState from "./EmptyState";

export default function CasesPanel({ studyId }: { studyId: string }) {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [externalPatientId, setExternalPatientId] = useState("");
  const [accessionNumber, setAccessionNumber] = useState("");
  const [title, setTitle] = useState("");

  function refresh() {
    listCases(studyId)
      .then(setCases)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, [studyId]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    try {
      await createCase(studyId, externalPatientId, { accessionNumber, title });
      setExternalPatientId("");
      setAccessionNumber("");
      setTitle("");
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="alert-error">{error}</p>}

      <div className="table-wrap">
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
                  <EmptyState message="No cases yet -- create one below." />
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

      <div className="card">
        <h3 className="section-title mb-4">New case</h3>
        <p className="hint mb-4">
          The patient identifier is hashed and never stored directly -- only a pseudonym is kept. Date, type, and
          comment can be added afterwards from the case page.
        </p>
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-4">
          <label className="field flex-1">
            <span className="label">Patient identifier (e.g. MRN)</span>
            <input
              className="input"
              value={externalPatientId}
              onChange={(e) => setExternalPatientId(e.target.value)}
              required
            />
          </label>
          <label className="field w-56">
            <span className="label">Title</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field w-56">
            <span className="label">Accession number</span>
            <input className="input" value={accessionNumber} onChange={(e) => setAccessionNumber(e.target.value)} />
          </label>
          <button type="submit" className="btn-primary">
            Create case
          </button>
        </form>
      </div>
    </div>
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
