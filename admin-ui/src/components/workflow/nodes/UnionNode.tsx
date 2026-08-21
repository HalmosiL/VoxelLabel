import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { MergeIcon } from "../../icons";
import { CardNode } from "../types";
import WorkflowNodeShell from "./WorkflowNodeShell";

function UnionNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const count = typeof card.output_count === "number" ? card.output_count : null;

  return (
    <WorkflowNodeShell selected={selected} icon={<MergeIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      <p className="mt-2 text-xs text-gray-600">{count === null ? "not run yet" : `${count} cases (deduplicated)`}</p>
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="output" />
    </WorkflowNodeShell>
  );
}

export default memo(UnionNode);
