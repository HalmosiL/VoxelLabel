import { refreshViewerHandoffOnClick, withViewerHandoff } from "../../auth/viewerHandoff";
import { CompareResults } from "../../api/workflowApi";
import { ANNOTATOR_UI_URL } from "../../config";
import { downloadText } from "../../pages/usage/export";
import Modal from "../Modal";
import { compareCsv, diceTone } from "./compareReport";

/** A Compare card's report: each pair of inputs summed up, then every
 * image compared -- worst agreement first -- with each input's work one
 * click away in the viewer (on that input's own branch), the cases not
 * comparable yet, and a CSV of it all. */
export default function CompareReportModal({
  title,
  results,
  studyId,
  names,
  onClose,
}: {
  title: string;
  results: CompareResults;
  studyId: string;
  // user id -> display name, for "whose work" beside each input
  names: Record<string, string>;
  onClose: () => void;
}) {
  const threshold = results.agree_dice;
  const input = (i: number) => results.inputs[i];
  const who = (i: number) => {
    const id = input(i)?.assigned_user_id;
    return id ? (names[id] ?? id) : null;
  };
  const images = [...results.images].sort((x, y) => (x.min_dice ?? 1) - (y.min_dice ?? 1));
  const viewerLink = (inputIndex: number, caseId: string, seriesId: string) => {
    const jobId = input(inputIndex)?.job_id;
    if (!jobId) return null;
    return withViewerHandoff(`${ANNOTATOR_UI_URL}/viewer/series/${seriesId}?studyId=${studyId}&caseId=${caseId}&jobId=${jobId}&returnUrl=${encodeURIComponent(window.location.href)}`);
  };
  const dice = (value: number | null) => (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${diceTone(value, threshold)}`}>{value === null ? "--" : value.toFixed(2)}</span>
  );

  return (
    <Modal title={`${title} -- report`} onClose={onClose} maxWidthClassName="max-w-5xl">
      <div className="flex flex-col gap-5" data-testid="compare-report">
        <p className="text-sm text-gray-600">
          Each input's latest hand-in, compared image by image. Dice runs from 0 (no overlap) to 1 (identical); at or above{" "}
          <b>{threshold.toFixed(2)}</b> a case counts as agreeing. A finding is drawn by both when their outlines overlap enough (IoU ≥ 0.1).
          Computed {new Date(results.computed_at).toLocaleString()}.
        </p>

        <section className="flex flex-col gap-2">
          <h3 className="label">By pair</h3>
          <div className="table-wrap">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-gray-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">Inputs</th>
                  <th className="py-1 pr-3 font-medium">Mean Dice</th>
                  <th className="py-1 pr-3 font-medium">Images</th>
                  <th className="py-1 pr-3 font-medium">Findings by both</th>
                  <th className="py-1 pr-3 font-medium">Only the first</th>
                  <th className="py-1 font-medium">Only the second</th>
                </tr>
              </thead>
              <tbody>
                {results.pairs.map((p) => (
                  <tr key={`${p.a}-${p.b}`} className="border-t border-gray-100" data-testid="compare-report-pair">
                    <td className="py-1.5 pr-3">
                      <span className="font-medium text-gray-800">{input(p.a)?.title}</span>
                      {who(p.a) && <span className="text-gray-500"> ({who(p.a)})</span>}
                      <span className="text-gray-400"> vs </span>
                      <span className="font-medium text-gray-800">{input(p.b)?.title}</span>
                      {who(p.b) && <span className="text-gray-500"> ({who(p.b)})</span>}
                    </td>
                    <td className="py-1.5 pr-3">{dice(p.mean_dice)}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{p.images}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{p.objects.both}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{p.objects.only_a}</td>
                    <td className="py-1.5 tabular-nums">{p.objects.only_b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="label">
              By image <span className="font-normal normal-case text-gray-500">-- worst agreement first · {results.cases_agree} agree, {results.cases_disagree} disagree</span>
            </h3>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => downloadText(`compare-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`, compareCsv(results), "text/csv;charset=utf-8")}
              data-testid="compare-report-csv"
            >
              Download CSV
            </button>
          </div>
          {images.length === 0 ? (
            <p className="hint">Nothing compared yet -- no case has a hand-in from two inputs.</p>
          ) : (
            <div className="table-wrap">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-gray-500">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Case</th>
                    <th className="py-1 pr-3 font-medium">Inputs</th>
                    <th className="py-1 pr-3 font-medium">Dice</th>
                    <th className="py-1 pr-3 font-medium">By label</th>
                    <th className="py-1 pr-3 font-medium">Findings (both · first · second)</th>
                    <th className="py-1 font-medium">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {images.flatMap((image) =>
                    image.pairs.map((pair) => {
                      const linkA = viewerLink(pair.a, image.case_id, image.series_id);
                      const linkB = viewerLink(pair.b, image.case_id, image.series_id);
                      return (
                        <tr key={`${image.series_id}-${pair.a}-${pair.b}`} className="border-t border-gray-100 align-top" data-testid="compare-image-row">
                          <td className="py-1.5 pr-3 font-medium text-gray-800">{image.case_title}</td>
                          <td className="py-1.5 pr-3 text-gray-600">
                            {input(pair.a)?.title} vs {input(pair.b)?.title}
                          </td>
                          <td className="py-1.5 pr-3">{dice(pair.dice)}</td>
                          <td className="py-1.5 pr-3">
                            <span className="flex flex-wrap gap-1">
                              {Object.entries(pair.by_label).map(([label, value]) => (
                                <span key={label} className="text-xs text-gray-600">
                                  {label} {dice(value)}
                                </span>
                              ))}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 tabular-nums text-gray-700">
                            {pair.objects.both} · {pair.objects.only_a} · {pair.objects.only_b}
                          </td>
                          <td className="py-1.5">
                            <span className="flex gap-2 text-xs font-medium">
                              {linkA && (
                                <a href={linkA} onClick={refreshViewerHandoffOnClick} target="_blank" rel="noreferrer" className="text-brand-600 hover:text-brand-700">
                                  {input(pair.a)?.title}
                                </a>
                              )}
                              {linkB && (
                                <a href={linkB} onClick={refreshViewerHandoffOnClick} target="_blank" rel="noreferrer" className="text-brand-600 hover:text-brand-700">
                                  {input(pair.b)?.title}
                                </a>
                              )}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {results.skipped.length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 className="label">Not comparable yet</h3>
            <ul className="text-sm text-gray-600" data-testid="compare-report-skipped">
              {results.skipped.map((s) => (
                <li key={s.case_id}>
                  <span className="font-medium text-gray-800">{s.case_title}</span> -- {s.reason}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
