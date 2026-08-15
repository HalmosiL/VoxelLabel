import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { listPatientCases, PatientCase } from "../api/dataApi";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";

export default function PatientDetailPage() {
  const { patientId } = useParams<{ patientId: string }>();
  const [cases, setCases] = useState<PatientCase[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!patientId) return;
    listPatientCases(patientId)
      .then(setCases)
      .catch((err) => setError(String(err)));
  }, [patientId]);

  if (!patientId) return null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={`Patient ${patientId.slice(0, 8)}…`} subtitle="All cases for this patient, across every project." />
      {error && <p className="alert-error">{error}</p>}

      {cases.length === 0 && <EmptyState message="This patient has no cases." />}
      {cases.map((c) => (
        <div key={c.id} className="card">
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="badge-blue">{c.project_name}</span>
                {c.accession_number && <span className="hint font-mono">{c.accession_number}</span>}
              </div>
            </div>
            <Link to={`/projects/${c.project_id}/cases/${c.id}`} className="btn-secondary btn-sm">
              View case
            </Link>
          </div>

          {c.tags.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {c.tags.map((tag) => (
                <span key={tag} className="badge-gray">
                  {tag}
                </span>
              ))}
            </div>
          )}

          <div className="text-sm font-medium text-gray-700 mb-2">Studies</div>
          {c.studies.length === 0 ? (
            <p className="hint">No studies in this case yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {c.studies.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-sm text-gray-600">
                  {s.modality && <span className="badge-gray">{s.modality}</span>}
                  <span>{s.description ?? s.study_instance_uid}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
