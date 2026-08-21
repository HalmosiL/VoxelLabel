import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { FunnelIcon } from "../../icons";
import { CardNode } from "../types";
import WorkflowNodeShell from "./WorkflowNodeShell";

function FilterNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const tag = typeof card.config.tag === "string" ? card.config.tag : null;
  const count = typeof card.output_count === "number" ? card.output_count : null;

  return (
    <WorkflowNodeShell selected={selected} icon={<FunnelIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      <div className="mt-2 flex items-center gap-1.5">
        {tag ? <span className="badge-gray">{tag}</span> : <span className="hint text-xs">no tag set</span>}
        {count !== null && <span className="text-xs text-gray-500">{count} matched</span>}
      </div>
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="output" />
    </WorkflowNodeShell>
  );
}

export default memo(FilterNode);
