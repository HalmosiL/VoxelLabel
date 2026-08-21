import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { listPatients, PatientSummary } from "../api/dataApi";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";

export default function PatientsPage() {
  const [patients, setPatients] = useState<PatientSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listPatients()
      .then(setPatients)
      .catch((err) => setError(String(err)));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Patients"
        subtitle="Every patient across all studies. Click one to see their cases, images, and tags."
      />
      {error && <p className="alert-error">{error}</p>}

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
            {patients.length === 0 && (
              <tr>
                <td colSpan={3}>
                  <EmptyState message="No patients yet -- create a case to add one." />
                </td>
              </tr>
            )}
            {patients.map((p) => (
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
