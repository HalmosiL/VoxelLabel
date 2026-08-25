import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getStudy, Study, updateStudy } from "../api/adminApi";
import CasesPanel from "../components/CasesPanel";
import DatasetsPanel from "../components/DatasetsPanel";
import { DocumentIcon, PencilIcon } from "../components/icons";
import MembersPanel from "../components/MembersPanel";
import Modal from "../components/Modal";
import PageHeader from "../components/PageHeader";
import TaskCardsPanel from "../components/TaskCardsPanel";
import WorkflowSummaryPanel from "../components/WorkflowSummaryPanel";

export default function StudyDetailPage() {
  const { studyId } = useParams<{ studyId: string }>();
  const [study, setStudy] = useState<Study | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  function refresh() {
    if (!studyId) return;
    getStudy(studyId)
      .then(setStudy)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, [studyId]);

  if (!studyId) return null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={study?.name ?? "Study"}
        subtitle={study?.description ?? undefined}
        action={
          <div className="flex items-center gap-2">
            <Link to={`/studies/${studyId}/workflow`} className="btn-secondary btn-sm">
              Workflow board
            </Link>
            <button onClick={() => setEditOpen(true)} className="btn-secondary btn-sm">
              Edit
            </button>
          </div>
        }
      />
      {error && <p className="alert-error">{error}</p>}

      <MembersPanel studyId={studyId} />
      <CasesPanel studyId={studyId} />
      <TaskCardsPanel
        studyId={studyId}
        cardType="annotation"
        title="Annotations"
        icon={<PencilIcon className="h-4 w-4" />}
        progressLabel="annotated"
      />
      <TaskCardsPanel
        studyId={studyId}
        cardType="review"
        title="Reviews"
        icon={<DocumentIcon className="h-4 w-4" />}
        progressLabel="reviewed"
      />
      <WorkflowSummaryPanel studyId={studyId} />
      <DatasetsPanel studyId={studyId} />

      {editOpen && study && (
        <EditStudyModal
          study={study}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function EditStudyModal({ study, onClose, onSaved }: { study: Study; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(study.name);
  const [description, setDescription] = useState(study.description ?? "");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      await updateStudy(study.id, name, description);
      onSaved();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <Modal title="Edit study" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}
        <label className="field">
          <span className="label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          <span className="label">Description</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" className="btn-primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
