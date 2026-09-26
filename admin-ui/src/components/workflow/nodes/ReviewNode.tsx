import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import Avatar from "../../Avatar";
import { DocumentIcon, QuestionMarkCircleIcon } from "../../icons";
import { CardNode } from "../types";
import { TASK_STATUS_STYLE } from "../statusStyle";
import WorkflowNodeShell from "./WorkflowNodeShell";
import { useAssigneeLabel } from "../assigneeDirectory";

// The two named outputs a Review card materializes on Run -- approved
// cases flow onward, rejected ones are meant to be wired back into an
// Annotation card's input as a feedback loop (see WorkflowPropertiesPanel).
const REVIEW_BRANCHES: { handle: string; label: string; dot: string }[] = [
  { handle: "approved", label: "approved", dot: "bg-emerald-500" },
  { handle: "rejected", label: "rejected", dot: "bg-red-500" },
];

function ReviewNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const assignedUserId = typeof card.config.assigned_user_id === "string" ? card.config.assigned_user_id : null;
  const assigneeLabel = useAssigneeLabel(assignedUserId);
  const status = typeof card.config.status === "string" ? card.config.status : "todo";
  const style = TASK_STATUS_STYLE[status] ?? TASK_STATUS_STYLE.todo;
  const progress = card.annotation_progress;
  const counts = card.materialized_counts;

  return (
    <WorkflowNodeShell selected={selected} icon={<DocumentIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      <div className="mt-2 flex items-center justify-between gap-2">
        {assignedUserId ? (
          <div className="flex items-center gap-1.5">
            <Avatar id={assignedUserId} name={assigneeLabel} />
            <span className="truncate text-xs text-gray-600">{assigneeLabel}</span>
          </div>
        ) : (
          <span className="flex items-center gap-1 text-xs text-red-500" title="Nobody is assigned to this job">
            <QuestionMarkCircleIcon className="h-3.5 w-3.5" />
            unassigned
          </span>
        )}
        <span className={style.badge}>
          <span className={`badge-dot ${style.dot}`} />
          {style.label}
        </span>
      </div>
      {progress && (
        <p className="mt-1 text-xs text-gray-500">
          {progress.annotated} of {progress.total} reviewed
        </p>
      )}
      <ul className="mt-2 flex flex-col gap-0.5 text-xs text-gray-600">
        {REVIEW_BRANCHES.map((branch) => (
          <li key={branch.handle} className="flex items-center gap-1.5">
            <span className={`badge-dot ${branch.dot}`} />
            <span>{branch.label}</span>
            <span className="ml-auto text-gray-400">{counts?.[branch.handle] ?? 0}</span>
          </li>
        ))}
      </ul>
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="output" />
      {/* Separate handle for a Surface card's job restriction -- unrelated
          to the ordinary data-flow input above, so it's placed on a
          different side to stay visually distinct. */}
      <Handle type="target" position={Position.Top} id="surface_config" />
    </WorkflowNodeShell>
  );
}

export default memo(ReviewNode);
