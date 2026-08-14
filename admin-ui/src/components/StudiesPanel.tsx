import { ChangeEvent, useEffect, useState } from "react";

import { getPixelDataUrl, Instance, listInstances, listSeries, listStudies, Series, Study } from "../api/dataApi";
import { uploadDicom } from "../api/ingestionApi";

export default function StudiesPanel({ projectId }: { projectId: string }) {
  const [studies, setStudies] = useState<Study[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [expandedStudy, setExpandedStudy] = useState<string | null>(null);

  function refresh() {
    listStudies(projectId)
      .then(setStudies)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, [projectId]);

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadStatus("Uploading...");
    try {
      const result = await uploadDicom(projectId, file);
      setUploadStatus(`Queued as job ${result.job_id}. Processing happens in the background -- refresh in a moment.`);
    } catch (err) {
      setUploadStatus(null);
      setError(String(err));
    }
    event.target.value = "";
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="alert-error">{error}</p>}

      <div className="card flex flex-wrap items-center gap-4">
        <label className="btn-secondary cursor-pointer">
          Upload DICOM file
          <input type="file" accept=".dcm" onChange={handleUpload} className="hidden" />
        </label>
        <button onClick={refresh} className="btn-secondary">
          Refresh studies
        </button>
        {uploadStatus && <p className="hint">{uploadStatus}</p>}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="w-10"></th>
              <th>Study UID</th>
              <th>Modality</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {studies.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-gray-400">
                  No studies yet -- upload a DICOM file above.
                </td>
              </tr>
            )}
            {studies.map((s) => (
              <StudyRow
                key={s.id}
                study={s}
                expanded={expandedStudy === s.id}
                onToggle={() => setExpandedStudy(expandedStudy === s.id ? null : s.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
    >
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** A standalone toggle button -- only used where it isn't nested inside
 * another clickable element (see StudyRow; SeriesList instead makes the
 * whole row a single <button> with an inline Chevron, to avoid nested
 * <button> elements, which are invalid HTML). */
function ExpandButton({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"
    >
      <Chevron expanded={expanded} />
    </button>
  );
}

function StudyRow({ study, expanded, onToggle }: { study: Study; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <tr>
        <td>
          <ExpandButton expanded={expanded} onClick={onToggle} />
        </td>
        <td className="font-mono text-xs">{study.study_instance_uid}</td>
        <td>{study.modality && <span className="badge-blue">{study.modality}</span>}</td>
        <td>{study.description}</td>
      </tr>
      {expanded && (
        <tr>
          <td></td>
          <td colSpan={3} className="bg-gray-50 py-3">
            <SeriesList studyId={study.id} />
          </td>
        </tr>
      )}
    </>
  );
}

function SeriesList({ studyId }: { studyId: string }) {
  const [series, setSeries] = useState<Series[]>([]);
  const [expandedSeries, setExpandedSeries] = useState<string | null>(null);

  useEffect(() => {
    listSeries(studyId).then(setSeries);
  }, [studyId]);

  return (
    <ul className="flex flex-col gap-1">
      {series.map((s) => {
        const expanded = expandedSeries === s.id;
        return (
          <li key={s.id}>
            <button
              onClick={() => setExpandedSeries(expanded ? null : s.id)}
              className="flex items-center gap-1.5 rounded px-1.5 py-1 text-sm text-gray-700 hover:bg-gray-100"
            >
              <Chevron expanded={expanded} />
              {s.series_description ?? s.series_instance_uid}
            </button>
            {expanded && <InstanceList seriesId={s.id} />}
          </li>
        );
      })}
    </ul>
  );
}

function InstanceList({ seriesId }: { seriesId: string }) {
  const [instances, setInstances] = useState<Instance[]>([]);

  useEffect(() => {
    listInstances(seriesId).then(setInstances);
  }, [seriesId]);

  async function openPixelData(instanceId: string) {
    const { url } = await getPixelDataUrl(instanceId);
    window.open(url, "_blank");
  }

  return (
    <ul className="ml-8 flex flex-col gap-1 border-l border-gray-200 pl-4">
      {instances.map((i) => (
        <li key={i.id} className="flex items-center justify-between gap-3 py-1 text-sm">
          <span className="text-gray-600">
            #{i.instance_number ?? "?"} <span className="font-mono text-xs text-gray-400">{i.sop_instance_uid}</span>
          </span>
          <button onClick={() => openPixelData(i.id)} className="btn-secondary btn-sm">
            Download pixel data
          </button>
        </li>
      ))}
    </ul>
  );
}
