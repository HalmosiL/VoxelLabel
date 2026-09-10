import { FormEvent, useState } from "react";

import { deleteImagingStudy, updateImagingStudy } from "../api/adminApi";
import Modal from "./Modal";
import Thumbnail from "./Thumbnail";
import { describeApiError } from "../api/client";

interface ImagingStudyLike {
  id: string;
  description: string | null;
  modality: string | null;
  thumbnail_url: string | null;
}

export default function ImagingStudyModal({
  imagingStudy,
  onClose,
  onSaved,
  onDeleted,
}: {
  imagingStudy: ImagingStudyLike;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [description, setDescription] = useState(imagingStudy.description ?? "");
  const [modality, setModality] = useState(imagingStudy.modality ?? "");
  const [error, setError] = useState<string | null>(null);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    try {
      await updateImagingStudy(imagingStudy.id, { description, modality });
      onSaved();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this imaging study, all its series, and all its images? This cannot be undone.")) return;
    try {
      await deleteImagingStudy(imagingStudy.id);
      onDeleted();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <Modal title="Edit imaging study" onClose={onClose}>
      <form onSubmit={handleSave} className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}
        <div className="w-24">
          <Thumbnail url={imagingStudy.thumbnail_url} />
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
            Delete imaging study
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
