import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { CaseSummary, listCases } from "../api/dataApi";
import { getWorkflowBoard, WorkflowCard } from "../api/workflowApi";
import { DatabaseIcon } from "./icons";
import SectionHeader from "./SectionHeader";
import { describeApiError } from "../api/client";

/** Card-grid view (matching the workflow board's own Dataset card look)
 * of every Dataset card the board has produced for this study -- both
 * plain, manually-created ones and materialized ones (Split parts, an
 * Annotation/Review's "annotated dataset"). A separate, dedicated section
 * from WorkflowSummaryPanel (which lists every card type), since these
 * are the actual data artifacts a study produces, closer in spirit to a
 * Case's Documents list than to the board itself. */
export default function DatasetsPanel({ studyId }: { studyId: string }) {
  const [datasets, setDatasets] = useState<WorkflowCard[]>([]);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    getWorkflowBoard(studyId)
      .then((board) => setDatasets(board.cards.filter((c) => c.type === "dataset")))
      .catch((err) => setError(describeApiError(err)));
    listCases(studyId)
      .then(setCases)
      .catch((err) => setError(describeApiError(err)));
  }, [studyId]);

  const casesById = new Map(cases.map((c) => [c.id, c]));

  return (
    <div className="card">
      <SectionHeader title="Datasets" />
      {error && <p className="alert-error mt-3">{error}</p>}

      {datasets.length === 0 ? (
        <p className="hint mt-3">No datasets produced by this study's workflow board yet.</p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {datasets.map((card) => {
            const ids = (card.config.mode === "manual" ? card.config.case_ids : null) as string[] | null;
            const count = typeof card.output_count === "number" ? card.output_count : 0;
            const open = openId === card.id;

            return (
              <div key={card.id} className="card flex flex-col !p-3">
                <div className="flex items-start gap-2">
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500">
                    <DatabaseIcon className="h-4 w-4" />
                  </span>
                  <p className="min-w-0 flex-1 break-words text-sm font-semibold text-gray-900">{card.title}</p>
                </div>
                <p className="mt-2 text-xs text-gray-600">
                  {count} case{count === 1 ? "" : "s"}
                </p>
                {card.materialized_from && (
                  <p className="mt-1 truncate text-xs text-brand-500">from: {card.materialized_from.title}</p>
                )}
                {card.config.mode === "all_cases" && <p className="mt-1 text-xs text-gray-400">all cases in this study</p>}

                <div className="mt-3 flex items-center gap-3 border-t border-gray-100 pt-2">
                  {ids && ids.length > 0 && (
                    <button
                      onClick={() => setOpenId(open ? null : card.id)}
                      className="text-xs font-medium text-brand-600 hover:text-brand-700"
                    >
                      {open ? "Hide cases" : "Show cases"}
                    </button>
                  )}
                  <Link
                    to={`/studies/${studyId}/workflow`}
                    className="text-xs font-medium text-brand-600 hover:text-brand-700"
                  >
                    Open in board
                  </Link>
                </div>
                {open && ids && (
                  <ul className="mt-2 flex max-h-32 flex-col gap-1 overflow-y-auto border-t border-gray-100 pt-2">
                    {ids.map((id) => {
                      const summary = casesById.get(id);
                      return (
                        <li key={id}>
                          <Link
                            to={`/studies/${studyId}/cases/${id}`}
                            className="text-xs text-brand-600 hover:text-brand-700"
                          >
                            {summary?.title || summary?.accession_number || `${id.slice(0, 8)}…`}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
