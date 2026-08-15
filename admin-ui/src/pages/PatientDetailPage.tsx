import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { listPatientCases, PatientCase } from "../api/dataApi";
import DocumentModal from "../components/DocumentModal";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import StudyModal from "../components/StudyModal";
import Thumbnail from "../components/Thumbnail";
import { DocumentIcon } from "../components/icons";

export default function PatientDetailPage() {
  const { patientId } = useParams<{ patientId: string }>();
  const [cases, setCases] = useState<PatientCase[]>([]);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    if (!patientId) return;
    listPatientCases(patientId)
      .then(setCases)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, [patientId]);

  if (!patientId) return null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Patient ${patientId.slice(0, 8)}…`}
        subtitle="Every case for this patient, across every project. Click a study or document to edit or delete it."
      />
      {error && <p className="alert-error">{error}</p>}

      {cases.length === 0 && <EmptyState message="This patient has no cases." />}
      {cases.map((c) => (
        <PatientCaseCard key={c.id} patientCase={c} onChanged={refresh} />
      ))}
    </div>
  );
}

function PatientCaseCard({ patientCase, onChanged }: { patientCase: PatientCase; onChanged: () => void }) {
  const [openStudyId, setOpenStudyId] = useState<string | null>(null);
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null);

  const openStudy = patientCase.studies.find((s) => s.id === openStudyId) ?? null;
  const openDocument = patientCase.documents.find((d) => d.id === openDocumentId) ?? null;

  return (
    <div className="card">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="badge-blue">{patientCase.project_name}</span>
          {patientCase.accession_number && <span className="hint font-mono">{patientCase.accession_number}</span>}
        </div>
        <Link to={`/projects/${patientCase.project_id}/cases/${patientCase.id}`} className="btn-secondary btn-sm">
          Open case
        </Link>
      </div>

      {patientCase.tags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {patientCase.tags.map((tag) => (
            <span key={tag} className="badge-gray">
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="mb-4">
        <h3 className="mb-2 text-sm font-medium text-gray-700">Studies</h3>
        {patientCase.studies.length === 0 ? (
          <p className="hint">No studies in this case yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {patientCase.studies.map((s) => (
              <button key={s.id} onClick={() => setOpenStudyId(s.id)} className="text-left" title={s.study_instance_uid}>
                <Thumbnail url={s.thumbnail_url} label={s.description ?? undefined} />
                <div className="mt-1.5 flex items-center gap-1">
                  {s.modality && <span className="badge-blue">{s.modality}</span>}
                </div>
                <p className="mt-1 truncate text-xs text-gray-600">{s.description ?? s.study_instance_uid}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-gray-700">Documents</h3>
        {patientCase.documents.length === 0 ? (
          <p className="hint">No documents in this case yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {patientCase.documents.map((item) => (
              <button key={item.id} onClick={() => setOpenDocumentId(item.id)} className="text-left">
                <div className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 rounded-lg bg-gray-100 p-2">
                  <DocumentIcon className="h-8 w-8 text-gray-400" />
                  <span className="badge-blue">{item.type}</span>
                </div>
                <p className="mt-1.5 truncate text-xs font-medium text-gray-700">{item.title}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {openStudy && (
        <StudyModal
          study={openStudy}
          onClose={() => setOpenStudyId(null)}
          onSaved={() => {
            setOpenStudyId(null);
            onChanged();
          }}
          onDeleted={() => {
            setOpenStudyId(null);
            onChanged();
          }}
        />
      )}
      {openDocument && (
        <DocumentModal
          item={openDocument}
          onClose={() => setOpenDocumentId(null)}
          onChanged={onChanged}
          onDeleted={() => {
            setOpenDocumentId(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
