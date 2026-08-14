import { ChangeEvent, ReactNode, useEffect, useState } from "react";

import { getPixelDataUrl, Instance, listInstances, listSeries, listStudies, Series, Study } from "../api/dataApi";
import { uploadDicom } from "../api/ingestionApi";

type View =
  | { level: "studies" }
  | { level: "series"; study: Study }
  | { level: "instances"; study: Study; series: Series };

export default function StudiesPanel({ projectId }: { projectId: string }) {
  const [studies, setStudies] = useState<Study[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [view, setView] = useState<View>({ level: "studies" });

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

      <Breadcrumbs view={view} onNavigate={setView} />

      {view.level === "studies" && (
        <StudiesTable studies={studies} onSelect={(study) => setView({ level: "series", study })} />
      )}
      {view.level === "series" && (
        <SeriesTable study={view.study} onSelect={(series) => setView({ level: "instances", study: view.study, series })} />
      )}
      {view.level === "instances" && <InstancesTable series={view.series} />}
    </div>
  );
}

function Breadcrumbs({ view, onNavigate }: { view: View; onNavigate: (v: View) => void }) {
  const crumbs: { label: string; onClick: () => void }[] = [
    { label: "Studies", onClick: () => onNavigate({ level: "studies" }) },
  ];
  if (view.level === "series" || view.level === "instances") {
    crumbs.push({
      label: view.study.description || view.study.study_instance_uid,
      onClick: () => onNavigate({ level: "series", study: view.study }),
    });
  }
  if (view.level === "instances") {
    crumbs.push({
      label: view.series.series_description || view.series.series_instance_uid,
      onClick: () => onNavigate(view),
    });
  }

  return (
    <div className="flex items-center gap-1.5 text-sm text-gray-500">
      {crumbs.map((c, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-gray-300">/</span>}
          {i === crumbs.length - 1 ? (
            <span className="font-medium text-gray-900">{c.label}</span>
          ) : (
            <button onClick={c.onClick} className="text-brand-600 hover:text-brand-700 hover:underline">
              {c.label}
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

function RowButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <tr onClick={onClick} className={onClick ? "cursor-pointer" : undefined}>
      {children}
    </tr>
  );
}

function StudiesTable({ studies, onSelect }: { studies: Study[]; onSelect: (s: Study) => void }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Study UID</th>
            <th>Modality</th>
            <th>Description</th>
            <th></th>
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
            <RowButton key={s.id} onClick={() => onSelect(s)}>
              <td className="font-mono text-xs">{s.study_instance_uid}</td>
              <td>{s.modality && <span className="badge-blue">{s.modality}</span>}</td>
              <td>{s.description}</td>
              <td className="text-right text-gray-300">
                <ChevronRight />
              </td>
            </RowButton>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeriesTable({ study, onSelect }: { study: Study; onSelect: (s: Series) => void }) {
  const [series, setSeries] = useState<Series[]>([]);

  useEffect(() => {
    listSeries(study.id).then(setSeries);
  }, [study.id]);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Series UID</th>
            <th>Description</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {series.length === 0 && (
            <tr>
              <td colSpan={3} className="py-6 text-center text-gray-400">
                No series in this study.
              </td>
            </tr>
          )}
          {series.map((s) => (
            <RowButton key={s.id} onClick={() => onSelect(s)}>
              <td className="font-mono text-xs">{s.series_instance_uid}</td>
              <td>{s.series_description}</td>
              <td className="text-right text-gray-300">
                <ChevronRight />
              </td>
            </RowButton>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InstancesTable({ series }: { series: Series }) {
  const [instances, setInstances] = useState<Instance[]>([]);

  useEffect(() => {
    listInstances(series.id).then(setInstances);
  }, [series.id]);

  async function openPixelData(instanceId: string) {
    const { url } = await getPixelDataUrl(instanceId);
    window.open(url, "_blank");
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>SOP Instance UID</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {instances.length === 0 && (
            <tr>
              <td colSpan={3} className="py-6 text-center text-gray-400">
                No instances in this series.
              </td>
            </tr>
          )}
          {instances.map((i) => (
            <tr key={i.id}>
              <td>{i.instance_number ?? "?"}</td>
              <td className="font-mono text-xs">{i.sop_instance_uid}</td>
              <td className="text-right">
                <button onClick={() => openPixelData(i.id)} className="btn-secondary btn-sm">
                  Download pixel data
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChevronRight() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="ml-auto h-4 w-4">
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
        clipRule="evenodd"
      />
    </svg>
  );
}
