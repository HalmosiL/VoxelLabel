import { FormEvent, useEffect, useState } from "react";

import { addClinicalDataConsent, addClinicalDataTag, createClinicalDataItem } from "../api/adminApi";
import { ClinicalDataItem, getClinicalDataFileUrl, listClinicalDataItems } from "../api/dataApi";
import EmptyState from "./EmptyState";

export default function ClinicalDataPanel({ caseId }: { caseId: string }) {
  const [items, setItems] = useState<ClinicalDataItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState("");
  const [title, setTitle] = useState("");
  const [itemDate, setItemDate] = useState("");
  const [file, setFile] = useState<File | null>(null);

  function refresh() {
    listClinicalDataItems(caseId)
      .then(setItems)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, [caseId]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    try {
      await createClinicalDataItem(caseId, type, title, itemDate, file);
      setType("");
      setTitle("");
      setItemDate("");
      setFile(null);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="alert-error">{error}</p>}

      {items.length === 0 && <EmptyState message="No clinical data items yet -- add one below." />}
      {items.map((item) => (
        <ItemCard key={item.id} item={item} onChanged={refresh} />
      ))}

      <div className="card">
        <h3 className="section-title mb-4">New clinical data item</h3>
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-4">
          <label className="field w-40">
            <span className="label">Type</span>
            <input className="input" value={type} onChange={(e) => setType(e.target.value)} placeholder="referral_letter" required />
          </label>
          <label className="field flex-1">
            <span className="label">Title</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label className="field w-40">
            <span className="label">Date</span>
            <input className="input" type="date" value={itemDate} onChange={(e) => setItemDate(e.target.value)} />
          </label>
          <label className="field">
            <span className="label">File (optional)</span>
            <input
              className="text-sm"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button type="submit" className="btn-primary">
            Add
          </button>
        </form>
      </div>
    </div>
  );
}

function ItemCard({ item, onChanged }: { item: ClinicalDataItem; onChanged: () => void }) {
  const [tagLabel, setTagLabel] = useState("");
  const [consentType, setConsentType] = useState("");
  const [consentStatus, setConsentStatus] = useState<"granted" | "revoked">("granted");
  const [error, setError] = useState<string | null>(null);

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
    <div className="card">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="badge-blue">{item.type}</span>
            <h3 className="section-title">{item.title}</h3>
          </div>
          {item.date && <p className="hint mt-1">{item.date}</p>}
        </div>
        {item.has_file && (
          <button onClick={openFile} className="btn-secondary btn-sm">
            Download file
          </button>
        )}
      </div>

      {error && <p className="alert-error mb-3">{error}</p>}

      <div className="mb-4 flex flex-wrap gap-1.5">
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

      <div className="flex flex-wrap gap-6">
        <form onSubmit={handleAddTag} className="inline-flex items-end gap-2">
          <label className="field">
            <span className="label">Add tag</span>
            <input className="input w-36" value={tagLabel} onChange={(e) => setTagLabel(e.target.value)} required />
          </label>
          <button type="submit" className="btn-secondary btn-sm">
            Add
          </button>
        </form>

        <form onSubmit={handleAddConsent} className="inline-flex items-end gap-2">
          <label className="field">
            <span className="label">Consent type</span>
            <input className="input w-36" value={consentType} onChange={(e) => setConsentType(e.target.value)} required />
          </label>
          <label className="field">
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
      </div>
    </div>
  );
}
