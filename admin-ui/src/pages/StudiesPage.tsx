import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  createStudy,
  deleteStudy,
  duplicateStudy,
  listStudies,
  Study,
  updateStudy,
  uploadStudyCoverImage,
} from "../api/adminApi";
import { ApiError, describeApiError } from "../api/client";
import { roleLabel, useMe } from "../auth/MeContext";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";
import { STUDIES_STEPS } from "../guide/adminSteps";
import { useRegisterGuide } from "../guide/GuideContext";

type ModalState = { mode: "create" } | { mode: "edit"; study: Study } | null;

export default function StudiesPage() {
  const { isAdmin } = useMe();
  const [studies, setStudies] = useState<Study[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  function refresh() {
    listStudies()
      .then((list) => {
        setStudies(list);
        setLoaded(true);
      })
      .catch((err) => setError(describeApiError(err)));
  }

  useEffect(refresh, []);
  useRegisterGuide("studies", STUDIES_STEPS, loaded, false);

  async function handleDelete(study: Study) {
    if (!window.confirm(`Delete "${study.name}"? This cannot be undone.`)) return;
    try {
      await deleteStudy(study.id);
      refresh();
      return;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) {
        setError(describeApiError(err));
        return;
      }
      // Study still has cases -- deleteStudy's own 409 message already
      // says how many. Force-deleting is a second, explicit confirm (on
      // top of the one above) since it's no longer just the study
      // container being removed -- every case's real imaging data and
      // documents go with it.
      let detail = err.body;
      try {
        detail = JSON.parse(err.body).detail ?? detail;
      } catch {
        // Not JSON -- show the raw body as-is.
      }
      if (!window.confirm(`${detail}\n\nDelete the study AND all its cases (imaging data, documents, everything)? This cannot be undone.`)) {
        return;
      }
      try {
        await deleteStudy(study.id, true);
        refresh();
      } catch (err2) {
        setError(describeApiError(err2));
      }
    }
  }

  const [duplicating, setDuplicating] = useState<string | null>(null);

  async function handleDuplicate(study: Study) {
    if (!window.confirm(`Duplicate "${study.name}"? This creates a fully independent copy -- every case, image and document is really re-uploaded under its own new identity, not shared with the original.`)) {
      return;
    }
    setDuplicating(study.id);
    try {
      await duplicateStudy(study.id);
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setDuplicating(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="page-title">Studies</h1>
        {!isAdmin && <p className="page-subtitle">The studies you are a member of, with your role in each.</p>}
      </div>
      {error && <p className="alert-error">{error}</p>}

      {loaded && studies.length === 0 && !isAdmin && (
        <EmptyState message="You're not a member of any study yet -- ask a study admin to add you." />
      )}

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {studies.map((s, i) => (
          <StudyCard
            key={s.id}
            guide={i === 0 ? "study-card" : undefined}
            study={s}
            // Editing/deleting/cover images: a global admin, or a member
            // holding the study-scoped admin role (mirrors the backend).
            canAdminister={isAdmin || s.my_role === "admin"}
            canDelete={isAdmin}
            canDuplicate={isAdmin}
            duplicating={duplicating === s.id}
            showRole={!isAdmin}
            onImageUploaded={refresh}
            onEdit={() => setModal({ mode: "edit", study: s })}
            onDelete={() => handleDelete(s)}
            onDuplicate={() => handleDuplicate(s)}
          />
        ))}
        {isAdmin && <NewStudyTile onClick={() => setModal({ mode: "create" })} />}
      </div>

      {modal && (
        <StudyFormModal
          state={modal}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            refresh();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function NewStudyTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      data-guide="new-study"
      className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-gray-200 text-gray-400 transition-colors hover:border-brand-300 hover:bg-brand-50/50 hover:text-brand-600"
    >
      <PlusIcon className="h-8 w-8" />
      <span className="text-sm font-medium">New study</span>
    </button>
  );
}

function StudyFormModal({
  state,
  onClose,
  onSaved,
  onError,
}: {
  state: { mode: "create" } | { mode: "edit"; study: Study };
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const editing = state.mode === "edit" ? state.study : null;
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      if (editing) {
        await updateStudy(editing.id, name, description);
      } else {
        await createStudy(name, description);
      }
      onSaved();
    } catch (err) {
      onError(describeApiError(err));
    }
  }

  return (
    <Modal title={editing ? "Edit study" : "New study"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
            {editing ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function StudyCard({
  study,
  canAdminister,
  canDelete,
  canDuplicate,
  duplicating,
  showRole,
  onImageUploaded,
  onEdit,
  onDelete,
  onDuplicate,
  guide,
}: {
  study: Study;
  /** data-guide anchor for the page tour (the first card carries it). */
  guide?: string;
  canAdminister: boolean;
  canDelete: boolean;
  canDuplicate: boolean;
  duplicating: boolean;
  showRole: boolean;
  onImageUploaded: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await uploadStudyCoverImage(study.id, file);
      onImageUploaded();
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-gray-100 bg-white/90 shadow-sm transition-shadow hover:shadow-md" data-guide={guide}>
      <Link to={`/studies/${study.id}`} className="block">
        <div className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-gradient-to-br from-brand-100 to-brand-50">
          {study.cover_image_url ? (
            <img src={study.cover_image_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <FolderIcon className="h-12 w-12 text-brand-300" />
          )}
        </div>
        <div className="p-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-semibold text-gray-900">{study.name}</h3>
            {showRole && <span className="badge-blue flex-shrink-0">{roleLabel(study.my_role ?? null)}</span>}
          </div>
          {study.description && <p className="mt-1 text-sm text-gray-500">{study.description}</p>}
        </div>
      </Link>

      {canAdminister && (
      <div className="absolute right-3 top-3 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <label
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-white/90 text-gray-600 shadow-sm hover:bg-white"
          title="Set cover image"
        >
          {uploading ? <Spinner className="h-4 w-4" /> : <CameraIcon className="h-4 w-4" />}
          <input type="file" accept="image/*" className="hidden" onChange={handleImageChange} />
        </label>
        <button
          onClick={onEdit}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-gray-600 shadow-sm hover:bg-white"
          title="Edit study"
        >
          <PencilIcon className="h-4 w-4" />
        </button>
        {canDuplicate && (
          <button
            onClick={onDuplicate}
            disabled={duplicating}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-gray-600 shadow-sm hover:bg-white disabled:opacity-50"
            title="Duplicate study (a fully independent copy)"
          >
            {duplicating ? <Spinner className="h-4 w-4" /> : <DuplicateIcon className="h-4 w-4" />}
          </button>
        )}
        {canDelete && (
          <button
            onClick={onDelete}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-red-600 shadow-sm hover:bg-white"
            title="Delete study"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      )}
    </div>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M2 4a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V4z" />
    </svg>
  );
}

function CameraIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M4 5a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-1.586a1 1 0 01-.707-.293l-1.121-1.121A2 2 0 0011.172 3H8.828a2 2 0 00-1.414.586L6.293 4.707A1 1 0 015.586 5H4z" />
      <path fillRule="evenodd" d="M10 8a3 3 0 100 6 3 3 0 000-6zm-5 3a5 5 0 1110 0 5 5 0 01-10 0z" clipRule="evenodd" />
    </svg>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
    </svg>
  );
}

function DuplicateIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M7 3a2 2 0 00-2 2v8a2 2 0 002 2h6a2 2 0 002-2V8.414a2 2 0 00-.586-1.414l-3.414-3.414A2 2 0 009.586 3H7z" />
      <path d="M4 7a1 1 0 00-1 1v8a2 2 0 002 2h6a1 1 0 100-2H5V8a1 1 0 00-1-1z" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482 41.03 41.03 0 00-2.365-.298V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
    </svg>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
