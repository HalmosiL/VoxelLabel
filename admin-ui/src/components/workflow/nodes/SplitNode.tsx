import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { ForkIcon } from "../../icons";
import { CardNode } from "../types";
import WorkflowNodeShell from "./WorkflowNodeShell";

function SplitNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const ratio = typeof card.config.ratio === "number" ? card.config.ratio : 0.8;
  const counts = card.output_count as { train: number; val: number } | null;

  return (
    <WorkflowNodeShell selected={selected} icon={<ForkIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      <p className="mt-2 text-xs text-gray-600">
        {Math.round(ratio * 100)}/{Math.round((1 - ratio) * 100)}
        {counts && ` -- train ${counts.train}, val ${counts.val}`}
      </p>
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="train" style={{ top: "35%" }} />
      <span className="pointer-events-none absolute right-2 text-[9px] text-gray-400" style={{ top: "calc(35% - 6px)" }}>
        train
      </span>
      <Handle type="source" position={Position.Right} id="val" style={{ top: "65%" }} />
      <span className="pointer-events-none absolute right-2 text-[9px] text-gray-400" style={{ top: "calc(65% - 6px)" }}>
        val
      </span>
    </WorkflowNodeShell>
  );
}

export default memo(SplitNode);
