import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getStudy, Study, updateStudy } from "../api/adminApi";
import { describeApiError } from "../api/client";
import { roleLabel, useMe } from "../auth/MeContext";
import CasesPanel from "../components/CasesPanel";
import DatasetsPanel from "../components/DatasetsPanel";
import { DocumentIcon, PencilIcon } from "../components/icons";
import MembersPanel from "../components/MembersPanel";
import Modal from "../components/Modal";
import PageHeader from "../components/PageHeader";
import TaskCardsPanel from "../components/TaskCardsPanel";
import VersionsPanel from "../components/VersionsPanel";
import WorkflowSummaryPanel from "../components/WorkflowSummaryPanel";
import { STUDY_DETAIL_STEPS } from "../guide/adminSteps";
import { useRegisterGuide } from "../guide/GuideContext";

export default function StudyDetailPage() {
  const { studyId } = useParams<{ studyId: string }>();
  const { canAdminister, canManage, roleFor, isAdmin } = useMe();
  const [study, setStudy] = useState<Study | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  function refresh() {
    if (!studyId) return;
    getStudy(studyId)
      .then(setStudy)
      .catch((err) => setError(describeApiError(err)));
  }

  useEffect(refresh, [studyId]);
  useRegisterGuide("study", STUDY_DETAIL_STEPS, study !== null, false);

  if (!studyId) return null;

  return (
    <div className="flex flex-col gap-6">
      <div data-guide="study-header">
      <PageHeader
        title={study?.name ?? "Study"}
        subtitle={study?.description ?? undefined}
        action={
          <div className="flex items-center gap-2">
            {!isAdmin && <span className="badge-blue">Your role: {roleLabel(roleFor(studyId))}</span>}
            <Link to={`/studies/${studyId}/workflow`} className="btn-secondary btn-sm">
              Workflow board
            </Link>
            {canManage(studyId) && (
              <Link to={`/studies/${studyId}/analytics`} className="btn-secondary btn-sm" data-testid="study-analytics-link" data-guide="study-analytics-link">
                Analytics
              </Link>
            )}
            {canAdminister(studyId) && (
              <button onClick={() => setEditOpen(true)} className="btn-secondary btn-sm">
                Edit
              </button>
            )}
          </div>
        }
      />
      </div>
      {error && <p className="alert-error">{error}</p>}

      {/* Plain wrappers so the page tour can spotlight each panel without
          reaching into the panel components. */}
      <div data-guide="members"><MembersPanel studyId={studyId} canAdminister={canAdminister(studyId)} /></div>
      <div data-guide="cases"><CasesPanel studyId={studyId} canManage={canManage(studyId)} /></div>
      <div data-guide="annotations">
      <TaskCardsPanel
        studyId={studyId}
        cardType="annotation"
        title="Annotations"
        icon={<PencilIcon className="h-4 w-4" />}
        progressLabel="annotated"
      />
      </div>
      <div data-guide="reviews">
      <TaskCardsPanel
        studyId={studyId}
        cardType="review"
        title="Reviews"
        icon={<DocumentIcon className="h-4 w-4" />}
        progressLabel="reviewed"
      />
      </div>
      <div data-guide="workflow-summary"><WorkflowSummaryPanel studyId={studyId} /></div>
      <div data-guide="datasets"><DatasetsPanel studyId={studyId} /></div>
      <div data-guide="versions">
      <VersionsPanel
        studyId={studyId}
        canManage={canManage(studyId)}
        canAdminister={canAdminister(studyId)}
        // A restore may have renamed the study and reshaped every panel
        // above -- the simplest correct thing is a full page reload.
        onRestored={() => window.location.reload()}
      />
      </div>

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
      setError(describeApiError(err));
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
