import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import Avatar from "../../Avatar";
import { PencilIcon } from "../../icons";
import { CardNode } from "../types";
import { TASK_STATUS_STYLE } from "../statusStyle";
import WorkflowNodeShell from "./WorkflowNodeShell";

function AnnotationNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const assignedUserId = typeof card.config.assigned_user_id === "string" ? card.config.assigned_user_id : null;
  const status = typeof card.config.status === "string" ? card.config.status : "todo";
  const style = TASK_STATUS_STYLE[status] ?? TASK_STATUS_STYLE.todo;
  const progress = card.annotation_progress;

  return (
    <WorkflowNodeShell selected={selected} icon={<PencilIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      <div className="mt-2 flex items-center justify-between gap-2">
        {assignedUserId ? (
          <div className="flex items-center gap-1.5">
            <Avatar id={assignedUserId} />
            <span className="truncate text-xs text-gray-600">{assignedUserId.slice(0, 8)}…</span>
          </div>
        ) : (
          <span className="hint text-xs">unassigned</span>
        )}
        <span className={style.badge}>
          <span className={`badge-dot ${style.dot}`} />
          {style.label}
        </span>
      </div>
      {progress && (
        <p className="mt-1 text-xs text-gray-500">
          {progress.annotated} of {progress.total} annotated
        </p>
      )}
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="output" />
    </WorkflowNodeShell>
  );
}

export default memo(AnnotationNode);
