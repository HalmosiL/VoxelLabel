import { ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getWorkflowBoard, SplitPart, WorkflowCard, WorkflowCardType } from "../api/workflowApi";
import { TASK_STATUS_STYLE } from "./workflow/statusStyle";
import { DatabaseIcon, DocumentIcon, FlagIcon, ForkIcon, FunnelIcon, MergeIcon, MonitorIcon, PencilIcon } from "./icons";
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
  surface: <MonitorIcon className="h-4 w-4" />,
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
      const date = card.config.date as string | null | undefined;
      return date ? date : "";
    }
    case "surface": {
      const tools = (card.config.tools as string[] | undefined)?.length ?? 0;
      const panes = (card.config.panes as string[] | undefined)?.length ?? 0;
      const show3d = card.config.show_3d === true;
      return `${tools} tools · ${panes} panes · 3D ${show3d ? "on" : "off"}`;
    }
    default:
      return "";
  }
}

function MiniCard({ card, studyId }: { card: WorkflowCard; studyId: string }) {
  const body = describeCard(card);

  if (card.type === "note") {
    return (
      <Link
        to={`/studies/${studyId}/workflow`}
        className="block rounded-lg border border-amber-200 bg-amber-50 p-3 shadow-sm transition-shadow hover:shadow-md"
      >
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600">Note</p>
        <p className="line-clamp-4 text-sm text-amber-900">{body}</p>
      </Link>
    );
  }

  if (card.type === "milestone") {
    return (
      <Link
        to={`/studies/${studyId}/workflow`}
        className="flex items-start gap-2 rounded-2xl border border-brand-200 bg-brand-50 p-3 shadow-sm transition-shadow hover:shadow-md"
      >
        <FlagIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-500" />
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-brand-800">{card.title}</p>
          {body && <p className="text-xs text-brand-500">{body}</p>}
        </div>
      </Link>
    );
  }

  return (
    <Link to={`/studies/${studyId}/workflow`} className="card block !p-3 transition-shadow hover:shadow-md">
      <div className="flex items-start gap-2">
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500">
          {TYPE_ICON[card.type]}
        </span>
        <p className="min-w-0 flex-1 break-words text-sm font-semibold text-gray-900">{card.title}</p>
        {card.stale && <span className="badge-gray flex-shrink-0 text-[10px]">stale</span>}
      </div>
      {body && <p className="mt-2 text-xs text-gray-600">{body}</p>}
    </Link>
  );
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

      {cards.length === 0 ? (
        <p className="hint mt-3">No cards on this study's workflow board yet.</p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <MiniCard key={card.id} card={card} studyId={studyId} />
          ))}
        </div>
      )}
    </div>
  );
}
