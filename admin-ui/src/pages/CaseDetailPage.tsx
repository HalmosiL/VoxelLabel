import { ChangeEvent, FormEvent, ReactNode, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import {
  addClinicalDataConsent,
  addClinicalDataTag,
  CaseFormFields,
  createClinicalDataItem,
  updateCase,
} from "../api/adminApi";
import {
  CaseSeries,
  CaseSummary,
  ClinicalDataItem,
  getCase,
  getClinicalDataFileUrl,
  getPixelDataUrl,
  Instance,
  listCaseSeries,
  listClinicalDataItems,
  listInstances,
  listStudies,
  Study,
} from "../api/dataApi";
import { uploadDicom } from "../api/ingestionApi";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";

export default function CaseDetailPage() {
  const { caseId } = useParams<{ caseId: string }>();
  const [caseInfo, setCaseInfo] = useState<CaseSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);

  function refreshCase() {
    if (caseId) getCase(caseId).then(setCaseInfo).catch((err) => setError(String(err)));
  }

  useEffect(refreshCase, [caseId]);

  if (!caseId || !caseInfo) return null;

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="alert-error">{error}</p>}

      <CaseInfoCard caseInfo={caseInfo} onEdit={() => setEditModalOpen(true)} />
      <CommentBox caseId={caseId} initialComment={caseInfo.comment} onSaved={refreshCase} />
      <StudiesSection caseId={caseId} />
      <SeriesSection caseId={caseId} />
      <DocumentsSection caseId={caseId} />

      {editModalOpen && (
        <EditCaseModal
          caseInfo={caseInfo}
          onClose={() => setEditModalOpen(false)}
          onSaved={() => {
            setEditModalOpen(false);
            refreshCase();
          }}
        />
      )}
    </div>
  );
}

function CaseInfoCard({ caseInfo, onEdit }: { caseInfo: CaseSummary; onEdit: () => void }) {
  return (
    <div className="card">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="page-title">{caseInfo.title || `Patient ${caseInfo.patient_pseudonym_id.slice(0, 8)}…`}</h1>
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm text-gray-600">
            <dt className="text-gray-400">Patient ID</dt>
            <dd className="font-mono text-xs">{caseInfo.patient_pseudonym_id}</dd>
            <dt className="text-gray-400">Accession number</dt>
            <dd>{caseInfo.accession_number || "—"}</dd>
            <dt className="text-gray-400">Date</dt>
            <dd>{caseInfo.date || "—"}</dd>
            <dt className="text-gray-400">Type</dt>
            <dd>{caseInfo.type || "—"}</dd>
          </dl>
        </div>

        <div className="flex flex-col items-end gap-3">
          <button onClick={onEdit} className="btn-secondary btn-sm">
            Edit
          </button>
          {caseInfo.tags.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {caseInfo.tags.map((tag) => (
                <span key={tag} className="badge-gray">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EditCaseModal({
  caseInfo,
  onClose,
  onSaved,
}: {
  caseInfo: CaseSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fields, setFields] = useState<CaseFormFields>({
    accessionNumber: caseInfo.accession_number ?? "",
    date: caseInfo.date ?? "",
    type: caseInfo.type ?? "",
    title: caseInfo.title ?? "",
  });
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      await updateCase(caseInfo.id, fields);
      onSaved();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <Modal title="Edit case" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}
        <label className="field">
          <span className="label">Title</span>
          <input className="input" value={fields.title} onChange={(e) => setFields({ ...fields, title: e.target.value })} />
        </label>
        <label className="field">
          <span className="label">Accession number</span>
          <input
            className="input"
            value={fields.accessionNumber}
            onChange={(e) => setFields({ ...fields, accessionNumber: e.target.value })}
          />
        </label>
        <label className="field">
          <span className="label">Date</span>
          <input
            className="input"
            type="date"
            value={fields.date}
            onChange={(e) => setFields({ ...fields, date: e.target.value })}
          />
        </label>
        <label className="field">
          <span className="label">Type</span>
          <input className="input" value={fields.type} onChange={(e) => setFields({ ...fields, type: e.target.value })} />
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

function CommentBox({ caseId, initialComment, onSaved }: { caseId: string; initialComment: string | null; onSaved: () => void }) {
  const [comment, setComment] = useState(initialComment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setComment(initialComment ?? ""), [initialComment]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await updateCase(caseId, { comment });
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2 className="section-title mb-3">Comment</h2>
      {error && <p className="alert-error mb-3">{error}</p>}
      <textarea
        className="input"
        rows={4}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Notes about this case…"
      />
      <button onClick={handleSave} disabled={saving} className="btn-secondary btn-sm mt-3">
        {saving ? "Saving…" : "Save comment"}
      </button>
    </div>
  );
}

function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="section-title">{title}</h2>
      {action}
    </div>
  );
}

function Thumbnail({ url, label }: { url: string | null; label?: string }) {
  return (
    <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg bg-gray-100">
      {url ? (
        <img src={url} alt={label ?? ""} className="h-full w-full object-cover" />
      ) : (
        <ImageIcon className="h-8 w-8 text-gray-300" />
      )}
    </div>
  );
}

function StudiesSection({ caseId }: { caseId: string }) {
  const [studies, setStudies] = useState<Study[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  function refresh() {
    listStudies(caseId).then(setStudies).catch((err) => setError(String(err)));
  }

  useEffect(refresh, [caseId]);

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadStatus("Uploading…");
    try {
      const result = await uploadDicom(caseId, file);
      setUploadStatus(`Queued as job ${result.job_id}. Refresh in a moment to see it.`);
    } catch (err) {
      setUploadStatus(null);
      setError(String(err));
    }
    event.target.value = "";
  }

  return (
    <div className="card">
      <SectionHeader
        title="Studies"
        action={
          <div className="flex items-center gap-2">
            <label className="btn-secondary btn-sm cursor-pointer">
              Upload DICOM
              <input type="file" accept=".dcm" className="hidden" onChange={handleUpload} />
            </label>
            <button onClick={refresh} className="btn-secondary btn-sm">
              Refresh
            </button>
          </div>
        }
      />
      {error && <p className="alert-error mt-3">{error}</p>}
      {uploadStatus && <p className="hint mt-2">{uploadStatus}</p>}

      {studies.length === 0 ? (
        <EmptyState message="No studies yet -- upload a DICOM file above." />
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {studies.map((s) => (
            <div key={s.id} title={s.study_instance_uid}>
              <Thumbnail url={s.thumbnail_url} label={s.description ?? undefined} />
              <div className="mt-1.5 flex items-center gap-1">
                {s.modality && <span className="badge-blue">{s.modality}</span>}
              </div>
              <p className="mt-1 truncate text-xs text-gray-600">{s.description ?? s.study_instance_uid}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SeriesSection({ caseId }: { caseId: string }) {
  const [series, setSeries] = useState<CaseSeries[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openSeriesId, setOpenSeriesId] = useState<string | null>(null);

  useEffect(() => {
    listCaseSeries(caseId).then(setSeries).catch((err) => setError(String(err)));
  }, [caseId]);

  return (
    <div className="card">
      <SectionHeader title="Series" />
      {error && <p className="alert-error mt-3">{error}</p>}

      {series.length === 0 ? (
        <EmptyState message="No series yet." />
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {series.map((s) => (
            <button key={s.id} onClick={() => setOpenSeriesId(s.id)} className="text-left">
              <Thumbnail url={s.thumbnail_url} label={s.series_description ?? undefined} />
              <p className="mt-1.5 truncate text-xs font-medium text-gray-700">
                {s.series_description ?? s.series_instance_uid}
              </p>
              <p className="truncate text-xs text-gray-400">{s.study_description}</p>
            </button>
          ))}
        </div>
      )}

      {openSeriesId && <SeriesInstancesModal seriesId={openSeriesId} onClose={() => setOpenSeriesId(null)} />}
    </div>
  );
}

function SeriesInstancesModal({ seriesId, onClose }: { seriesId: string; onClose: () => void }) {
  const [instances, setInstances] = useState<Instance[]>([]);

  useEffect(() => {
    listInstances(seriesId).then(setInstances);
  }, [seriesId]);

  async function openPixelData(instanceId: string) {
    const { url } = await getPixelDataUrl(instanceId);
    window.open(url, "_blank");
  }

  return (
    <Modal title="Series instances" onClose={onClose}>
      <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
        {instances.length === 0 && <p className="hint">No instances.</p>}
        {instances.map((i) => (
          <div key={i.id} className="flex items-center gap-3 rounded-lg border border-gray-100 p-2">
            <div className="h-12 w-12 flex-shrink-0">
              <Thumbnail url={i.thumbnail_url} />
            </div>
            <div className="flex-1 truncate text-xs text-gray-600">
              #{i.instance_number ?? "?"} {i.sop_instance_uid}
            </div>
            <button onClick={() => openPixelData(i.id)} className="btn-secondary btn-sm flex-shrink-0">
              Download
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function DocumentsSection({ caseId }: { caseId: string }) {
  const [items, setItems] = useState<ClinicalDataItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<ClinicalDataItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  function refresh() {
    listClinicalDataItems(caseId).then(setItems).catch((err) => setError(String(err)));
  }

  useEffect(refresh, [caseId]);

  return (
    <div className="card">
      <SectionHeader
        title="Documents"
        action={
          <button onClick={() => setCreateOpen(true)} className="btn-secondary btn-sm">
            Add document
          </button>
        }
      />
      {error && <p className="alert-error mt-3">{error}</p>}

      {items.length === 0 ? (
        <EmptyState message="No documents yet." />
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {items.map((item) => (
            <button key={item.id} onClick={() => setOpenItem(item)} className="text-left">
              <div className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 rounded-lg bg-gray-100 p-2">
                <DocumentIcon className="h-8 w-8 text-gray-400" />
                <span className="badge-blue">{item.type}</span>
              </div>
              <p className="mt-1.5 truncate text-xs font-medium text-gray-700">{item.title}</p>
            </button>
          ))}
        </div>
      )}

      {createOpen && (
        <NewDocumentModal
          caseId={caseId}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            refresh();
          }}
        />
      )}
      {openItem && (
        <DocumentModal
          item={openItem}
          onClose={() => setOpenItem(null)}
          onChanged={() => {
            refresh();
            listClinicalDataItems(caseId).then((updated) => {
              setOpenItem(updated.find((i) => i.id === openItem.id) ?? null);
            });
          }}
        />
      )}
    </div>
  );
}

function NewDocumentModal({ caseId, onClose, onSaved }: { caseId: string; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState("");
  const [title, setTitle] = useState("");
  const [itemDate, setItemDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      await createClinicalDataItem(caseId, type, title, itemDate, file);
      onSaved();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <Modal title="New document" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}
        <label className="field">
          <span className="label">Type</span>
          <input className="input" value={type} onChange={(e) => setType(e.target.value)} placeholder="referral_letter" required />
        </label>
        <label className="field">
          <span className="label">Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label className="field">
          <span className="label">Date</span>
          <input className="input" type="date" value={itemDate} onChange={(e) => setItemDate(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">File (optional)</span>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" className="btn-primary">
            Add
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DocumentModal({ item, onClose, onChanged }: { item: ClinicalDataItem; onClose: () => void; onChanged: () => void }) {
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
    <Modal title={item.title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}
        <div className="flex items-center gap-2">
          <span className="badge-blue">{item.type}</span>
          {item.date && <span className="hint">{item.date}</span>}
        </div>

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
      </div>
    </Modal>
  );
}
