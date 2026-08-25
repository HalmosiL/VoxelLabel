import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { MonitorCheckIcon } from "../../icons";
import { CardNode } from "../types";
import WorkflowNodeShell from "./WorkflowNodeShell";

// Deliberately no tools/3D summary here -- the review surface never has
// either, unconditionally (see ct-annotator's ViewerPage reviewMode),
// so this card only ever configures which MPR panes are visible.
function ReviewSurfaceNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const panes = Array.isArray(card.config.panes) ? (card.config.panes as string[]) : [];

  return (
    <WorkflowNodeShell selected={selected} icon={<MonitorCheckIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      <p className="mt-2 text-xs text-gray-500">
        {panes.length} pane{panes.length === 1 ? "" : "s"} · no tools · no 3D
      </p>
      <Handle type="source" position={Position.Bottom} id="surface_config" />
    </WorkflowNodeShell>
  );
}

export default memo(ReviewSurfaceNode);
