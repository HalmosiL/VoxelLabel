import { FormEvent, useState } from "react";

import { addClinicalDataConsent, addClinicalDataTag, deleteClinicalDataItem, updateClinicalDataItem } from "../api/adminApi";
import { ClinicalDataItem, getClinicalDataFileUrl } from "../api/dataApi";
import Modal from "./Modal";

export default function DocumentModal({
  item,
  onClose,
  onChanged,
  onDeleted,
}: {
  item: ClinicalDataItem;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [type, setType] = useState(item.type);
  const [title, setTitle] = useState(item.title);
  const [itemDate, setItemDate] = useState(item.date ?? "");
  const [tagLabel, setTagLabel] = useState("");
  const [consentType, setConsentType] = useState("");
  const [consentStatus, setConsentStatus] = useState<"granted" | "revoked">("granted");
  const [error, setError] = useState<string | null>(null);

  async function handleSaveEdit(event: FormEvent) {
    event.preventDefault();
    try {
      await updateClinicalDataItem(item.id, { type, title, itemDate });
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${item.title}"? This removes its file, tags, and consents. This cannot be undone.`))
      return;
    try {
      await deleteClinicalDataItem(item.id);
      onDeleted();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleAddTag(event: FormEvent) {
    event.preventDefault();
    try {
      await addClinicalDataTag(item.id, tagLabel);
      setTagLabel("");
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleAddConsent(event: FormEvent) {
    event.preventDefault();
    try {
      await addClinicalDataConsent(item.id, consentType, consentStatus);
      setConsentType("");
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  }

  async function openFile() {
    const { url } = await getClinicalDataFileUrl(item.id);
    window.open(url, "_blank");
  }

  return (
    <Modal title="Edit document" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}

        <form onSubmit={handleSaveEdit} className="flex flex-col gap-4">
          <label className="field">
            <span className="label">Title</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label className="field">
            <span className="label">Type</span>
            <input className="input" value={type} onChange={(e) => setType(e.target.value)} required />
          </label>
          <label className="field">
            <span className="label">Date</span>
            <input className="input" type="date" value={itemDate} onChange={(e) => setItemDate(e.target.value)} />
          </label>
          <button type="submit" className="btn-secondary btn-sm self-start">
            Save changes
          </button>
        </form>

        {item.has_file && (
          <button onClick={openFile} className="btn-secondary btn-sm self-start">
            Download file
          </button>
        )}

        <div className="flex flex-wrap gap-1.5">
          {item.tags.map((label) => (
            <span key={label} className="badge-gray">
              {label}
            </span>
          ))}
          {item.consents.map((c, i) => (
            <span key={i} className={c.status === "granted" ? "badge-green" : "badge-red"}>
              <span className={`badge-dot ${c.status === "granted" ? "bg-emerald-500" : "bg-red-500"}`} />
              {c.consent_type}: {c.status}
            </span>
          ))}
        </div>

        <form onSubmit={handleAddTag} className="flex items-end gap-2">
          <label className="field flex-1">
            <span className="label">Add tag</span>
            <input className="input" value={tagLabel} onChange={(e) => setTagLabel(e.target.value)} required />
          </label>
          <button type="submit" className="btn-secondary btn-sm">
            Add
          </button>
        </form>

        <form onSubmit={handleAddConsent} className="flex items-end gap-2">
          <label className="field flex-1">
            <span className="label">Consent type</span>
            <input className="input" value={consentType} onChange={(e) => setConsentType(e.target.value)} required />
          </label>
          <label className="field w-32">
            <span className="label">Status</span>
            <select className="input" value={consentStatus} onChange={(e) => setConsentStatus(e.target.value as "granted" | "revoked")}>
              <option value="granted">granted</option>
              <option value="revoked">revoked</option>
            </select>
          </label>
          <button type="submit" className="btn-secondary btn-sm">
            Add
          </button>
        </form>

        <div className="flex justify-end border-t border-gray-100 pt-4">
          <button onClick={handleDelete} className="btn-danger btn-sm">
            Delete document
          </button>
        </div>
      </div>
    </Modal>
  );
}
