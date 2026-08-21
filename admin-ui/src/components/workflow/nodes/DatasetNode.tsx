import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { DatabaseIcon } from "../../icons";
import { CardNode } from "../types";
import WorkflowNodeShell from "./WorkflowNodeShell";

function DatasetNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const count = typeof card.output_count === "number" ? card.output_count : 0;

  return (
    <WorkflowNodeShell selected={selected} icon={<DatabaseIcon className="h-4 w-4" />} title={card.title}>
      <p className="mt-2 text-xs text-gray-600">
        {count} case{count === 1 ? "" : "s"}
      </p>
      <Handle type="source" position={Position.Right} id="output" />
    </WorkflowNodeShell>
  );
}

export default memo(DatasetNode);
