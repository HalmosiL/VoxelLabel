import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  CaseFormFields,
  createClinicalDataItem,
  deleteSeries,
  updateCase,
  updateSeries,
} from "../api/adminApi";
import { describeApiError } from "../api/client";
import {
  CaseSeries,
  CaseSummary,
  ClinicalDataItem,
  getCase,
  getClinicalDataFileUrl,
  getPixelDataUrl,
  ImagingStudy,
  Instance,
  listCaseSeries,
  listClinicalDataItems,
  listImagingStudies,
  listInstances,
} from "../api/dataApi";
import { alreadyImportedMessage, getIngestionJob, uploadDicom } from "../api/ingestionApi";
import { useMe } from "../auth/MeContext";
import { useRegisterGuide } from "../guide/GuideContext";
import { CASE_STEPS } from "../guide/workbenchSteps";
import DocumentModal from "../components/DocumentModal";
import EmptyState from "../components/EmptyState";
import ImagingStudyModal from "../components/ImagingStudyModal";
import Modal from "../components/Modal";
import SectionHeader from "../components/SectionHeader";
import Thumbnail from "../components/Thumbnail";
import { DocumentIcon, PencilIcon } from "../components/icons";
import { refreshViewerHandoffOnClick, withViewerHandoff } from "../auth/viewerHandoff";
import { ANNOTATOR_UI_URL } from "../config";

/** Appends `&jobId=<id>` when this Case page was reached via a My Jobs
 * link -- lets ct-annotator fetch and enforce that job's Surface-card
 * restriction. Absent (a plain visit) means an unrestricted viewer.
 * Also passes `caseId` (this case's own id -- lets the viewer's Prev/
 * Next case arrows find their place in the job's case list) and this
 * Case page's own URL as `returnUrl`, so the viewer's "Back" arrow
 * (opened in a new tab, so there's no browser history to go back to)
 * can return here instead of to ct-annotator's own picker. Also hands
 * ct-annotator this session's tokens so opening the viewer doesn't
 * mean signing in twice -- see auth/viewerHandoff.ts. */
function viewerUrl(seriesId: string, studyId: string, caseId: string, jobId: string | null, viewAs: string): string {
  const url = `${ANNOTATOR_UI_URL}/viewer/series/${seriesId}?studyId=${studyId}&caseId=${caseId}`;
  const withJob = jobId ? `${url}&jobId=${jobId}` : url;
  // An admin's "View as" choice travels along (the viewer is another
  // origin, so it can't read this app's storage); nothing for plain admin.
  const withRole = viewAs === "admin" ? withJob : `${withJob}&viewAs=${viewAs}`;
  return withViewerHandoff(`${withRole}&returnUrl=${encodeURIComponent(window.location.href)}`);
}

/** One case, top to bottom: who/what it is (with the free-text notes
 * right next to it), then its imaging grouped the way DICOM actually
 * nests it (imaging study → series → images, each series openable in
 * the viewer), then the non-imaging documents as a table. Editing
 * controls only appear for a member who may manage data; a job link
 * (`?jobId=`) travels into every "Open in Viewer" so the viewer applies
 * that job's surface restrictions. */
export default function CaseDetailPage() {
  const { caseId } = useParams<{ caseId: string }>();
  const [searchParams] = useSearchParams();
  const jobId = searchParams.get("jobId");
  const { canManage, jobsOnly } = useMe();
  const [caseInfo, setCaseInfo] = useState<CaseSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);

  function refreshCase() {
    if (caseId) getCase(caseId).then(setCaseInfo).catch((err) => setError(describeApiError(err)));
  }

  useEffect(refreshCase, [caseId]);
  useRegisterGuide("case", CASE_STEPS, caseInfo !== null);

  if (!caseId || !caseInfo) return error ? <p className="alert-error">{error}</p> : null;
  const editable = canManage(caseInfo.study_id);

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="alert-error">{error}</p>}

      <nav className="flex items-center gap-1.5 text-xs text-gray-400">
        {jobId ? (
          <Link to={`/my-jobs/${jobId}`} className="link-action font-medium text-brand-600 hover:text-brand-700" data-guide="back-to-job">
            ← Back to the job
          </Link>
        ) : (
          !jobsOnly && (
            <Link to={`/studies/${caseInfo.study_id}`} className="link-action font-medium text-brand-600 hover:text-brand-700">
              ← Back to the study
            </Link>
          )
        )}
      </nav>

      <CaseHeader caseInfo={caseInfo} editable={editable} onEdit={() => setEditModalOpen(true)} onSaved={refreshCase} />
      <ImagingSection caseId={caseId} studyId={caseInfo.study_id} jobId={jobId} editable={editable} />
      <DocumentsSection caseId={caseId} editable={editable} />

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

// ---------------------------------------------------------------- header

function CaseHeader({
  caseInfo,
  editable,
  onEdit,
  onSaved,
}: {
  caseInfo: CaseSummary;
  editable: boolean;
  onEdit: () => void;
  onSaved: () => void;
}) {
  const [comment, setComment] = useState(caseInfo.comment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = comment !== (caseInfo.comment ?? "");

  useEffect(() => {
    setComment(caseInfo.comment ?? "");
  }, [caseInfo.comment]);

  async function handleSaveComment() {
    setSaving(true);
    setError(null);
    try {
      await updateCase(caseInfo.id, { comment });
      onSaved();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" data-guide="case-header">
      {error && <p className="alert-error mb-3">{error}</p>}
      <div className="grid gap-6 lg:grid-cols-[1fr,minmax(280px,1fr)]">
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="page-title">{caseInfo.title || `Patient ${caseInfo.patient_pseudonym_id.slice(0, 8)}…`}</h1>
              {caseInfo.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {caseInfo.tags.map((tag) => (
                    <span key={tag} className="badge-gray">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {editable && (
              <button onClick={onEdit} className="btn-secondary btn-sm flex-shrink-0">
                Edit details
              </button>
            )}
          </div>
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-gray-400">Patient ID</dt>
            <dd className="font-mono text-xs text-gray-700">{caseInfo.patient_pseudonym_id}</dd>
            <dt className="text-gray-400">Accession number</dt>
            <dd className="text-gray-700">{caseInfo.accession_number || "—"}</dd>
            <dt className="text-gray-400">Date</dt>
            <dd className="text-gray-700">{caseInfo.date || "—"}</dd>
            <dt className="text-gray-400">Type</dt>
            <dd className="text-gray-700">{caseInfo.type || "—"}</dd>
          </dl>
        </div>

        <div className="flex flex-col gap-2 rounded-xl bg-gray-50/80 p-4">
          <div className="flex items-center justify-between">
            <span className="label">Notes</span>
            {editable && dirty && (
              <button onClick={handleSaveComment} disabled={saving} className="btn-primary btn-sm">
                {saving ? "Saving…" : "Save notes"}
              </button>
            )}
          </div>
          <textarea
            className="input min-h-[7rem] flex-1 resize-y bg-white"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            readOnly={!editable}
            placeholder={editable ? "Clinical context, what to look for, anything the annotator should know…" : "No notes."}
          />
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
      setError(describeApiError(err));
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
          <input className="input" type="date" value={fields.date} onChange={(e) => setFields({ ...fields, date: e.target.value })} />
        </label>
        <label className="field">
          <span className="label">Type</span>
          <input className="input" value={fields.type} onChange={(e) => setFields({ ...fields, type: e.target.value })} placeholder="e.g. radiology, oncology" />
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

// ---------------------------------------------------------------- imaging

function ImagingSection({
  caseId,
  studyId,
  jobId,
  editable,
}: {
  caseId: string;
  studyId: string;
  jobId: string | null;
  editable: boolean;
}) {
  const { viewAs } = useMe();
  const [imagingStudies, setImagingStudies] = useState<ImagingStudy[]>([]);
  const [series, setSeries] = useState<CaseSeries[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [openImagingStudy, setOpenImagingStudy] = useState<ImagingStudy | null>(null);
  const [openSeriesId, setOpenSeriesId] = useState<string | null>(null);

  function refresh() {
    Promise.all([listImagingStudies(caseId), listCaseSeries(caseId)])
      .then(([studies, allSeries]) => {
        setImagingStudies(studies);
        setSeries(allSeries);
        setLoaded(true);
      })
      .catch((err) => setError(describeApiError(err)));
  }

  useEffect(refresh, [caseId]);

  const seriesByStudy = useMemo(() => {
    const groups = new Map<string, CaseSeries[]>();
    for (const s of series) {
      const list = groups.get(s.imaging_study_id) ?? [];
      list.push(s);
      groups.set(s.imaging_study_id, list);
    }
    return groups;
  }, [series]);
  const totalImages = series.reduce((sum, s) => sum + s.instance_count, 0);

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadStatus(`Uploading ${file.name}…`);
    setError(null);
    try {
      const result = await uploadDicom(caseId, file);
      setUploadStatus("Processing in the ingestion worker…");
      // Poll the job (the worker runs asynchronously) so the page
      // actually learns whether the file landed, was already known, or
      // failed -- instead of refreshing on a guessed delay.
      const startedAt = Date.now();
      const poll = async () => {
        const job = await getIngestionJob(result.job_id);
        if (job.status === "completed" || job.status === "duplicate") {
          setUploadStatus(job.status === "duplicate" ? alreadyImportedMessage(file.name, "where" in job ? job.where : undefined) : `✓ ${file.name} imported.`);
          refresh();
          window.setTimeout(() => setUploadStatus(null), 4000);
        } else if (job.status === "failed") {
          setUploadStatus(null);
          setError(`Upload of ${file.name} failed: ${(job as { error?: string }).error ?? "unknown error"}`);
        } else if (Date.now() - startedAt > 120000) {
          setUploadStatus(`Still processing ${file.name} -- use Refresh to check later.`);
        } else {
          window.setTimeout(poll, 1500);
        }
      };
      await poll();
    } catch (err) {
      setUploadStatus(null);
      setError(describeApiError(err));
    }
    event.target.value = "";
  }

  return (
    <div className="card" data-guide="imaging">
      <SectionHeader
        title="Imaging"
        action={
          <div className="flex items-center gap-2">
            {loaded && imagingStudies.length > 0 && (
              <span className="hint">
                {imagingStudies.length} stud{imagingStudies.length === 1 ? "y" : "ies"} · {series.length} series · {totalImages} image
                {totalImages === 1 ? "" : "s"}
              </span>
            )}
            {editable && (
              <label className="btn-secondary btn-sm cursor-pointer">
                Upload DICOM
                <input type="file" accept=".dcm,application/dicom" className="hidden" onChange={handleUpload} />
              </label>
            )}
            <button onClick={refresh} className="btn-secondary btn-sm">
              Refresh
            </button>
          </div>
        }
      />
      {error && <p className="alert-error mt-3">{error}</p>}
      {uploadStatus && <p className="hint mt-2">{uploadStatus}</p>}

      {loaded && imagingStudies.length === 0 && (
        <EmptyState
          message={
            editable
              ? "No imaging yet -- upload a DICOM file above, or use Quick import on the study page for a whole folder."
              : "No imaging yet."
          }
        />
      )}

      <div className="mt-4 flex flex-col gap-4">
        {imagingStudies.map((study) => {
          const studySeries = seriesByStudy.get(study.id) ?? [];
          const imageCount = studySeries.reduce((sum, s) => sum + s.instance_count, 0);
          return (
            <div key={study.id} className="rounded-xl border border-gray-100">
              <div className="flex items-center gap-4 px-4 py-3">
                <div className="w-14 flex-shrink-0">
                  <Thumbnail url={study.thumbnail_url} label={study.description ?? undefined} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {study.modality && <span className="badge-blue">{study.modality}</span>}
                    <p className="truncate text-sm font-semibold text-gray-900" title={study.study_instance_uid}>
                      {study.description ?? "Imaging study"}
                    </p>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {study.study_date ? `${study.study_date} · ` : ""}
                    {studySeries.length} series · {imageCount} image{imageCount === 1 ? "" : "s"}
                  </p>
                </div>
                {editable && (
                  <button onClick={() => setOpenImagingStudy(study)} className="btn-secondary btn-sm" title="Edit or delete this imaging study">
                    Edit
                  </button>
                )}
              </div>

              {studySeries.length === 0 ? (
                <p className="border-t border-gray-100 px-4 py-3 text-xs text-gray-400">No series in this study yet.</p>
              ) : (
                <ul className="divide-y divide-gray-50 border-t border-gray-100">
                  {studySeries.map((s) => (
                    <li key={s.id} className="flex items-center gap-4 px-4 py-2.5 transition-colors hover:bg-brand-50/30">
                      {/* The tour points at the first series' viewer button on the page. */}
                      <div className="w-10 flex-shrink-0">
                        <Thumbnail url={s.thumbnail_url} label={s.series_description ?? undefined} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-gray-800" title={s.series_instance_uid}>
                          {s.series_description ?? s.series_instance_uid}
                        </p>
                        <p className="text-xs text-gray-400">
                          {s.instance_count} image{s.instance_count === 1 ? "" : "s"}
                        </p>
                      </div>
                      <button onClick={() => setOpenSeriesId(s.id)} className="btn-secondary btn-sm">
                        Images
                      </button>
                      <a
                        href={viewerUrl(s.id, studyId, caseId, jobId, viewAs)}
                        onClick={refreshViewerHandoffOnClick}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-primary btn-sm"
                        data-guide={s.id === series[0]?.id ? "open-viewer" : undefined}
                      >
                        Open in Viewer
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

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
      {openSeriesId && (
        <SeriesInstancesModal
          seriesId={openSeriesId}
          series={series.find((s) => s.id === openSeriesId) ?? null}
          studyId={studyId}
          caseId={caseId}
          jobId={jobId}
          editable={editable}
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
  caseId,
  jobId,
  editable,
  onClose,
  onChanged,
}: {
  seriesId: string;
  series: CaseSeries | null;
  studyId: string;
  caseId: string;
  jobId: string | null;
  editable: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { viewAs } = useMe();
  const [instances, setInstances] = useState<Instance[]>([]);
  const [seriesDescription, setSeriesDescription] = useState(series?.series_description ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listInstances(seriesId)
      .then(setInstances)
      .catch((err) => setError(describeApiError(err)));
  }, [seriesId]);

  async function openPixelData(instanceId: string) {
    try {
      const { url } = await getPixelDataUrl(instanceId);
      window.open(url, "_blank");
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  async function handleSaveDescription(event: FormEvent) {
    event.preventDefault();
    try {
      await updateSeries(seriesId, { seriesDescription });
      onChanged();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this series and all its images? This cannot be undone.")) return;
    try {
      await deleteSeries(seriesId);
      onChanged();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <Modal title={series?.series_description ?? "Series"} onClose={onClose} maxWidthClassName="max-w-3xl">
      <div className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}

        {editable ? (
          <form onSubmit={handleSaveDescription} className="flex items-end gap-2">
            <label className="field flex-1">
              <span className="label">Series description</span>
              <input className="input" value={seriesDescription} onChange={(e) => setSeriesDescription(e.target.value)} />
            </label>
            <button type="submit" className="btn-secondary btn-sm">
              Save
            </button>
          </form>
        ) : (
          <p className="hint">{series?.imaging_study_description ?? ""}</p>
        )}

        <p className="hint">
          {instances.length} image{instances.length === 1 ? "" : "s"} in this series, ordered by instance number.
        </p>
        {instances.length === 0 && <EmptyState message="No images." />}
        <div className="grid max-h-96 grid-cols-2 gap-4 overflow-y-auto sm:grid-cols-3 md:grid-cols-4">
          {[...instances]
            .sort((a, b) => (a.instance_number ?? 0) - (b.instance_number ?? 0))
            .map((i) => (
              <div key={i.id}>
                <Thumbnail url={i.thumbnail_url} label={`#${i.instance_number ?? "?"}`} />
                <p className="mt-1.5 truncate text-xs font-medium text-gray-700">#{i.instance_number ?? "?"}</p>
                <p className="truncate text-xs text-gray-400" title={i.sop_instance_uid}>
                  {i.sop_instance_uid}
                </p>
                <button onClick={() => openPixelData(i.id)} className="btn-secondary btn-sm mt-1.5 w-full">
                  Download DICOM
                </button>
              </div>
            ))}
        </div>

        <div className="flex justify-between gap-2 border-t border-gray-100 pt-4">
          {editable ? (
            <button onClick={handleDelete} className="btn-danger btn-sm">
              Delete series
            </button>
          ) : (
            <span />
          )}
          <a
            href={viewerUrl(seriesId, studyId, caseId, jobId, viewAs)}
            onClick={refreshViewerHandoffOnClick}
            target="_blank"
            rel="noreferrer"
            className="btn-primary btn-sm"
          >
            Open in Viewer
          </a>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- documents

function DocumentsSection({ caseId, editable }: { caseId: string; editable: boolean }) {
  const [items, setItems] = useState<ClinicalDataItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<ClinicalDataItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  function refresh() {
    listClinicalDataItems(caseId)
      .then((list) => {
        setItems(list);
        setLoaded(true);
      })
      .catch((err) => setError(describeApiError(err)));
  }

  useEffect(refresh, [caseId]);

  async function viewFile(item: ClinicalDataItem) {
    try {
      const { url } = await getClinicalDataFileUrl(item.id);
      window.open(url, "_blank");
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <div className="card" data-guide="documents">
      <SectionHeader
        title="Documents"
        action={
          <div className="flex items-center gap-2">
            {loaded && items.length > 0 && (
              <span className="hint">
                {items.length} document{items.length === 1 ? "" : "s"}
              </span>
            )}
            {editable && (
              <button onClick={() => setCreateOpen(true)} className="btn-secondary btn-sm">
                Add document
              </button>
            )}
          </div>
        }
      />
      {error && <p className="alert-error mt-3">{error}</p>}

      {loaded && items.length === 0 ? (
        <EmptyState message={editable ? "No documents yet -- add a report, referral letter or any other file above." : "No documents."} />
      ) : (
        <div className="table-wrap mt-4">
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Type</th>
                <th>Date</th>
                <th>Tags</th>
                <th>Consent</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500">
                        <DocumentIcon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-800">{item.title}</p>
                        <p className="text-xs text-gray-400">{item.has_file ? "File attached" : "No file -- metadata only"}</p>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="badge-blue">{item.type}</span>
                  </td>
                  <td className="whitespace-nowrap text-sm text-gray-500">{item.date ?? "—"}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {item.tags.length === 0 && <span className="text-xs text-gray-300">—</span>}
                      {item.tags.map((tag) => (
                        <span key={tag} className="badge-gray">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {item.consents.length === 0 && <span className="text-xs text-gray-300">—</span>}
                      {item.consents.map((c, i) => (
                        <span key={i} className={c.status === "granted" ? "badge-green" : "badge-red"}>
                          {c.consent_type}: {c.status}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {item.has_file && (
                        <button onClick={() => viewFile(item)} className="btn-secondary btn-sm">
                          View
                        </button>
                      )}
                      {editable && (
                        <button onClick={() => setOpenItem(item)} className="text-gray-400 hover:text-gray-700" title="Edit document, tags and consent">
                          <PencilIcon className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

const DOCUMENT_TYPES = ["report", "referral_letter", "pathology", "oncology", "lab_result", "discharge_summary", "other"];

function NewDocumentModal({ caseId, onClose, onSaved }: { caseId: string; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState("report");
  const [title, setTitle] = useState("");
  const [itemDate, setItemDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await createClinicalDataItem(caseId, type, title, itemDate, file);
      onSaved();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="New document" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}
        <label className="field">
          <span className="label">Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Radiology report 2026-03-12" required autoFocus />
        </label>
        <label className="field">
          <span className="label">Type</span>
          <input className="input" list="document-types" value={type} onChange={(e) => setType(e.target.value)} required />
          <datalist id="document-types">
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <span className="hint">Pick one of the usual types or type your own -- the Filter card on the board matches on it exactly.</span>
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
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
