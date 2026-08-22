import { ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getWorkflowBoard, SplitPart, WorkflowCard, WorkflowCardType } from "../api/workflowApi";
import { TASK_STATUS_STYLE } from "./workflow/statusStyle";
import EmptyState from "./EmptyState";
import { DatabaseIcon, DocumentIcon, FlagIcon, ForkIcon, FunnelIcon, MergeIcon, PencilIcon } from "./icons";
import SectionHeader from "./SectionHeader";

const TYPE_ICON: Record<WorkflowCardType, ReactNode> = {
  dataset: <DatabaseIcon className="h-4 w-4" />,
  split: <ForkIcon className="h-4 w-4" />,
  filter: <FunnelIcon className="h-4 w-4" />,
  union: <MergeIcon className="h-4 w-4" />,
  annotation: <PencilIcon className="h-4 w-4" />,
  review: <DocumentIcon className="h-4 w-4" />,
  note: <DocumentIcon className="h-4 w-4" />,
  milestone: <FlagIcon className="h-4 w-4" />,
};

/** One-line, per-type description matching what each card shows on the
 * board's canvas -- read-only here, just summarized as plain text instead
 * of a full node. */
function describeCard(card: WorkflowCard): string {
  switch (card.type) {
    case "dataset": {
      const count = typeof card.output_count === "number" ? card.output_count : 0;
      const origin = card.materialized_from ? ` · from ${card.materialized_from.title}` : "";
      return `${count} case${count === 1 ? "" : "s"}${origin}`;
    }
    case "split": {
      const parts = (card.config.parts as SplitPart[] | undefined) ?? [];
      const counts = (card.output_count as Record<string, number> | null) ?? null;
      return parts
        .map((p, i) => `${p.name} ${Math.round(p.ratio * 100)}%${counts ? ` (${counts[`part_${i}`] ?? 0})` : ""}`)
        .join(", ");
    }
    case "filter": {
      const tag = card.config.tag as string | undefined;
      const count = card.output_count as number | null;
      return `${tag ? `tag "${tag}"` : "no tag set"} · ${count === null ? "not run yet" : `${count} matched`}`;
    }
    case "union": {
      const count = card.output_count as number | null;
      return count === null ? "not run yet" : `${count} cases (deduplicated)`;
    }
    case "annotation":
    case "review": {
      const assignedUserId = card.config.assigned_user_id as string | null;
      const status = (card.config.status as string) ?? "todo";
      const style = TASK_STATUS_STYLE[status] ?? TASK_STATUS_STYLE.todo;
      const assignee = assignedUserId ? `${assignedUserId.slice(0, 8)}…` : "unassigned";
      const progress = card.annotation_progress;
      const progressText = progress ? ` · ${progress.annotated}/${progress.total} annotated` : "";
      return `${style.label} · ${assignee}${progressText}`;
    }
    case "note":
      return (card.config.text as string | undefined) || "(empty)";
    case "milestone": {
      const text = (card.config.text as string | undefined) || card.title;
      const date = card.config.date as string | null | undefined;
      return date ? `${text} · ${date}` : text;
    }
    default:
      return "";
  }
}

export default function WorkflowSummaryPanel({ studyId }: { studyId: string }) {
  const [cards, setCards] = useState<WorkflowCard[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getWorkflowBoard(studyId)
      .then((board) => setCards(board.cards))
      .catch((err) => setError(String(err)));
  }, [studyId]);

  return (
    <div className="card">
      <SectionHeader
        title="Workflow"
        action={
          <Link to={`/studies/${studyId}/workflow`} className="btn-secondary btn-sm">
            Open board
          </Link>
        }
      />
      {error && <p className="alert-error mt-3">{error}</p>}

      <div className="table-wrap mt-4">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Title</th>
              <th>Summary</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {cards.length === 0 && (
              <tr>
                <td colSpan={4}>
                  <EmptyState message="No cards on this study's workflow board yet." />
                </td>
              </tr>
            )}
            {cards.map((card) => (
              <tr key={card.id}>
                <td>
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-gray-100 text-gray-500">
                    {TYPE_ICON[card.type]}
                  </span>
                </td>
                <td className="text-sm font-medium text-gray-900">{card.title}</td>
                <td className="text-xs text-gray-500">{describeCard(card)}</td>
                <td>{card.stale && <span className="badge-gray text-[10px]">needs re-run</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
