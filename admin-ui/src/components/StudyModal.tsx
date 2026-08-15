import { FormEvent, useState } from "react";

import { deleteStudy, updateStudy } from "../api/adminApi";
import Modal from "./Modal";
import Thumbnail from "./Thumbnail";

interface StudyLike {
  id: string;
  description: string | null;
  modality: string | null;
  thumbnail_url: string | null;
}

export default function StudyModal({
  study,
  onClose,
  onSaved,
  onDeleted,
}: {
  study: StudyLike;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [description, setDescription] = useState(study.description ?? "");
  const [modality, setModality] = useState(study.modality ?? "");
  const [error, setError] = useState<string | null>(null);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    try {
      await updateStudy(study.id, { description, modality });
      onSaved();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this study, all its series, and all its images? This cannot be undone.")) return;
    try {
      await deleteStudy(study.id);
      onDeleted();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <Modal title="Edit study" onClose={onClose}>
      <form onSubmit={handleSave} className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}
        <div className="w-24">
          <Thumbnail url={study.thumbnail_url} />
        </div>
        <label className="field">
          <span className="label">Description</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Modality</span>
          <input className="input" value={modality} onChange={(e) => setModality(e.target.value)} />
        </label>
        <div className="mt-2 flex items-center justify-between gap-2">
          <button type="button" onClick={handleDelete} className="btn-danger btn-sm">
            Delete study
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              Save
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
