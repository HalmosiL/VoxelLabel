import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import {
  CaseFormFields,
  createClinicalDataItem,
  deleteSeries,
  updateCase,
  updateSeries,
} from "../api/adminApi";
import {
  CaseSeries,
  CaseSummary,
  ClinicalDataItem,
  getCase,
  getPixelDataUrl,
  ImagingStudy,
  Instance,
  listCaseSeries,
  listClinicalDataItems,
  listImagingStudies,
  listInstances,
} from "../api/dataApi";
import { uploadDicom } from "../api/ingestionApi";
import { ANNOTATOR_UI_URL } from "../config";
import DocumentModal from "../components/DocumentModal";
import EmptyState from "../components/EmptyState";
import ImagingStudyModal from "../components/ImagingStudyModal";
import Modal from "../components/Modal";
import SectionHeader from "../components/SectionHeader";
import Thumbnail from "../components/Thumbnail";
import { DocumentIcon } from "../components/icons";

/** Appends `&jobId=<id>` when this Case page was reached via a My Jobs
 * link -- lets ct-annotator fetch and enforce that job's Surface-card
 * restriction. Absent (a plain visit) means an unrestricted viewer. */
function viewerUrl(seriesId: string, studyId: string, jobId: string | null): string {
  const url = `${ANNOTATOR_UI_URL}/viewer/series/${seriesId}?studyId=${studyId}`;
  return jobId ? `${url}&jobId=${jobId}` : url;
}

export default function CaseDetailPage() {
  const { caseId } = useParams<{ caseId: string }>();
  const [searchParams] = useSearchParams();
  const jobId = searchParams.get("jobId");
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
      <ImagingStudiesSection caseId={caseId} />
      <SeriesSection caseId={caseId} studyId={caseInfo.study_id} jobId={jobId} />
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

function ImagingStudiesSection({ caseId }: { caseId: string }) {
  const [imagingStudies, setImagingStudies] = useState<ImagingStudy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [openImagingStudy, setOpenImagingStudy] = useState<ImagingStudy | null>(null);

  function refresh() {
    listImagingStudies(caseId).then(setImagingStudies).catch((err) => setError(String(err)));
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
        title="Imaging"
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

      {imagingStudies.length === 0 ? (
        <EmptyState message="No imaging yet -- upload a DICOM file above." />
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {imagingStudies.map((s) => (
            <button key={s.id} onClick={() => setOpenImagingStudy(s)} className="text-left" title={s.study_instance_uid}>
              <Thumbnail url={s.thumbnail_url} label={s.description ?? undefined} />
              <div className="mt-1.5 flex items-center gap-1">
                {s.modality && <span className="badge-blue">{s.modality}</span>}
              </div>
              <p className="mt-1 truncate text-xs text-gray-600">{s.description ?? s.study_instance_uid}</p>
            </button>
          ))}
        </div>
      )}

      {openImagingStudy && (
        <ImagingStudyModal
          imagingStudy={openImagingStudy}
          onClose={() => setOpenImagingStudy(null)}
          onSaved={() => {
            setOpenImagingStudy(null);
            refresh();
          }}
          onDeleted={() => {
            setOpenImagingStudy(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function SeriesSection({ caseId, studyId, jobId }: { caseId: string; studyId: string; jobId: string | null }) {
  const [series, setSeries] = useState<CaseSeries[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openSeriesId, setOpenSeriesId] = useState<string | null>(null);

  function refresh() {
    listCaseSeries(caseId).then(setSeries).catch((err) => setError(String(err)));
  }

  useEffect(refresh, [caseId]);

  return (
    <div className="card">
      <SectionHeader title="Series" />
      {error && <p className="alert-error mt-3">{error}</p>}

      {series.length === 0 ? (
        <EmptyState message="No series yet." />
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {series.map((s) => (
            <div key={s.id}>
              <button onClick={() => setOpenSeriesId(s.id)} className="w-full text-left">
                <Thumbnail url={s.thumbnail_url} label={s.series_description ?? undefined} />
                <p className="mt-1.5 truncate text-xs font-medium text-gray-700">
                  {s.series_description ?? s.series_instance_uid}
                </p>
                <p className="truncate text-xs text-gray-400">{s.imaging_study_description}</p>
              </button>
              <a
                href={viewerUrl(s.id, studyId, jobId)}
                target="_blank"
                rel="noreferrer"
                className="btn-secondary btn-sm mt-1.5 block w-full text-center"
              >
                Open in Viewer
              </a>
            </div>
          ))}
        </div>
      )}

      {openSeriesId && (
        <SeriesInstancesModal
          seriesId={openSeriesId}
          series={series.find((s) => s.id === openSeriesId) ?? null}
          studyId={studyId}
          jobId={jobId}
          onClose={() => setOpenSeriesId(null)}
          onChanged={() => {
            setOpenSeriesId(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function SeriesInstancesModal({
  seriesId,
  series,
  studyId,
  jobId,
  onClose,
  onChanged,
}: {
  seriesId: string;
  series: CaseSeries | null;
  studyId: string;
  jobId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [seriesDescription, setSeriesDescription] = useState(series?.series_description ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listInstances(seriesId).then(setInstances);
  }, [seriesId]);

  async function openPixelData(instanceId: string) {
    const { url } = await getPixelDataUrl(instanceId);
    window.open(url, "_blank");
  }

  async function handleSaveDescription(event: FormEvent) {
    event.preventDefault();
    try {
      await updateSeries(seriesId, { seriesDescription });
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this series and all its images? This cannot be undone.")) return;
    try {
      await deleteSeries(seriesId);
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <Modal title="Series instances" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}

        <form onSubmit={handleSaveDescription} className="flex items-end gap-2">
          <label className="field flex-1">
            <span className="label">Series description</span>
            <input className="input" value={seriesDescription} onChange={(e) => setSeriesDescription(e.target.value)} />
          </label>
          <button type="submit" className="btn-secondary btn-sm">
            Save
          </button>
        </form>

        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
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

        <div className="flex justify-end gap-2 border-t border-gray-100 pt-4">
          <a href={viewerUrl(seriesId, studyId, jobId)} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
            Open in Viewer
          </a>
          <button onClick={handleDelete} className="btn-danger btn-sm">
            Delete series
          </button>
        </div>
      </div>
    </Modal>
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
          onDeleted={() => {
            setOpenItem(null);
            refresh();
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
