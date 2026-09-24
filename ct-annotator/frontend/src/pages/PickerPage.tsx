import { Fragment, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { getAnnotationCounts } from "../api/annotatorApi";
import { API } from "../config";
import ViewAsTabs from "../components/ViewAsTabs";
import { isPlatformAdmin, readViewAs, writeViewAs, ViewAs } from "../viewAs";
import {
  CaseSummary,
  ImagingStudySummary,
  InstanceSummary,
  listCases,
  listImagingStudies,
  listInstances,
  listSeries,
  listStudies,
  SeriesSummary,
  Study,
} from "../api/dataApi";

/** Simple drill-down picker: Study -> Case -> ImagingStudy -> Series ->
 * Instance. Reads directly from the main platform's admin-service/
 * data-service (same as admin-ui does) -- this repo never writes to
 * either. Picking an instance opens the Viewer for it. */
export default function PickerPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const [studies, setStudies] = useState<Study[]>([]);
  const [study, setStudy] = useState<Study | null>(null);

  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [selectedCase, setSelectedCase] = useState<CaseSummary | null>(null);

  const [imagingStudies, setImagingStudies] = useState<ImagingStudySummary[]>([]);
  const [imagingStudy, setImagingStudy] = useState<ImagingStudySummary | null>(null);

  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<SeriesSummary | null>(null);

  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [annotationCounts, setAnnotationCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    listStudies().then(setStudies).catch((err) => setError(String(err)));
  }, []);

  function resetToStudies() {
    setStudy(null);
    setSelectedCase(null);
    setImagingStudy(null);
    setSelectedSeries(null);
    setCases([]);
    setImagingStudies([]);
    setSeries([]);
    setInstances([]);
    setAnnotationCounts({});
  }

  function pickStudy(next: Study) {
    setStudy(next);
    setSelectedCase(null);
    setImagingStudy(null);
    setSelectedSeries(null);
    setCases([]);
    setImagingStudies([]);
    setSeries([]);
    setInstances([]);
    setAnnotationCounts({});
    listCases(next.id).then(setCases).catch((err) => setError(String(err)));
  }

  function pickCase(next: CaseSummary) {
    setSelectedCase(next);
    setImagingStudy(null);
    setSelectedSeries(null);
    setImagingStudies([]);
    setSeries([]);
    setInstances([]);
    setAnnotationCounts({});
    listImagingStudies(next.id).then(setImagingStudies).catch((err) => setError(String(err)));
  }

  function pickImagingStudy(next: ImagingStudySummary) {
    setImagingStudy(next);
    setSelectedSeries(null);
    setSeries([]);
    setInstances([]);
    setAnnotationCounts({});
    listSeries(next.id).then(setSeries).catch((err) => setError(String(err)));
  }

  function pickSeries(next: SeriesSummary) {
    setSelectedSeries(next);
    setInstances([]);
    setAnnotationCounts({});
    listInstances(next.id)
      .then((list) => setInstances([...list].sort((a, b) => (a.instance_number ?? 0) - (b.instance_number ?? 0))))
      .catch((err) => setError(String(err)));
    getAnnotationCounts(next.id)
      .then(setAnnotationCounts)
      .catch(() => {}); // best-effort -- a picker badge isn't worth surfacing an error banner for
  }

  function openInstance(instanceId: string) {
    if (!study || !selectedSeries) return;
    navigate(`/viewer/${instanceId}?studyId=${study.id}&seriesId=${selectedSeries.id}`);
  }

  const breadcrumb: { label: string; onClick: () => void }[] = [{ label: "Studies", onClick: resetToStudies }];
  if (study) breadcrumb.push({ label: study.name, onClick: () => pickStudy(study) });
  if (selectedCase)
    breadcrumb.push({ label: selectedCase.title || selectedCase.accession_number || "Case", onClick: () => pickCase(selectedCase) });
  if (imagingStudy)
    breadcrumb.push({
      label: imagingStudy.description || imagingStudy.study_instance_uid.slice(0, 12),
      onClick: () => pickImagingStudy(imagingStudy),
    });
  if (selectedSeries)
    breadcrumb.push({
      label: selectedSeries.series_description || selectedSeries.series_instance_uid.slice(0, 12),
      onClick: () => pickSeries(selectedSeries),
    });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="page-title">CT Annotator</h1>
        <PickerViewAs />
      </div>
      {error && <p className="alert-error">{error}</p>}

      <nav className="flex flex-wrap items-center gap-1 text-sm text-gray-500">
        {breadcrumb.map((segment, index) => {
          const isLast = index === breadcrumb.length - 1;
          return (
            <Fragment key={index}>
              {index > 0 && <span className="text-gray-300">›</span>}
              {isLast ? (
                <span className="font-medium text-gray-800">{segment.label}</span>
              ) : (
                <button onClick={segment.onClick} className="rounded px-1 hover:bg-gray-100 hover:text-brand-700">
                  {segment.label}
                </button>
              )}
            </Fragment>
          );
        })}
      </nav>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <PickerColumn
          title="Studies"
          items={studies}
          selectedId={study?.id ?? null}
          label={(s) => s.name}
          onPick={pickStudy}
        />
        <PickerColumn
          title="Cases"
          items={cases}
          selectedId={selectedCase?.id ?? null}
          label={(c) => c.title || c.accession_number || c.id.slice(0, 8)}
          onPick={pickCase}
        />
        <PickerColumn
          title="Imaging studies"
          items={imagingStudies}
          selectedId={imagingStudy?.id ?? null}
          label={(s) => s.description || s.study_instance_uid.slice(0, 12)}
          onPick={pickImagingStudy}
        />
        <PickerColumn
          title="Series"
          items={series}
          selectedId={selectedSeries?.id ?? null}
          label={(s) => s.series_description || s.series_instance_uid.slice(0, 12)}
          onPick={pickSeries}
        />
      </div>

      {instances.length > 0 && (
        <div className="card">
          <p className="section-title mb-3">Instances ({instances.length})</p>
          <div className="flex flex-wrap gap-3">
            {instances.map((instance) => {
              const count = annotationCounts[instance.id] ?? 0;
              return (
                <button
                  key={instance.id}
                  onClick={() => openInstance(instance.id)}
                  className="relative flex w-32 flex-col items-center gap-1.5 rounded-lg border border-gray-100 p-2 text-xs text-gray-600 shadow-sm hover:border-brand-300 hover:shadow-md"
                >
                  {count > 0 && (
                    <span className="absolute right-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold text-white">
                      {count}
                    </span>
                  )}
                  {instance.thumbnail_url ? (
                    <img src={instance.thumbnail_url.startsWith("/") ? `${API.annotator}${instance.thumbnail_url}` : instance.thumbnail_url} alt="" className="h-28 w-28 rounded object-cover" />
                  ) : (
                    <div className="flex h-28 w-28 items-center justify-center rounded bg-gray-100 text-gray-300">
                      no preview
                    </div>
                  )}
                  <span>#{instance.instance_number ?? "?"}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PickerColumn<T>({
  title,
  items,
  selectedId,
  label,
  onPick,
}: {
  title: string;
  items: (T & { id: string })[];
  selectedId: string | null;
  label: (item: T & { id: string }) => string;
  onPick: (item: T & { id: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = query.trim()
    ? items.filter((item) => label(item).toLowerCase().includes(query.trim().toLowerCase()))
    : items;

  return (
    <div className="card !p-4">
      <p className="section-title mb-3">{title}</p>
      {items.length > 5 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="input mb-2 !py-1 !text-xs"
        />
      )}
      <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
        {filtered.length === 0 && <li className="hint">{items.length === 0 ? "Nothing here yet." : "No matches."}</li>}
        {filtered.map((item) => (
          <li key={item.id}>
            <button
              onClick={() => onPick(item)}
              className={`w-full truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                selectedId === item.id ? "bg-brand-50 text-brand-700" : "text-gray-700 hover:bg-gray-50"
              }`}
            >
              {label(item)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The admin-only "View as" tabs on the picker: remembered for the
 * viewer opened from here (same origin, same storage). Light-themed
 * page, so it wraps the dark tabs in a dark chip. */
function PickerViewAs() {
  const [viewAs, setViewAs] = useState<ViewAs>(() => readViewAs(window.location.search));
  if (!isPlatformAdmin()) return null;
  return (
    <div className="rounded-lg bg-[#1a1a2e] px-3 py-1.5">
      <ViewAsTabs
        value={viewAs}
        onChange={(v) => {
          writeViewAs(v);
          setViewAs(v);
        }}
      />
    </div>
  );
}
