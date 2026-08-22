import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { ForkIcon } from "../../icons";
import { SplitPart } from "../../../api/workflowApi";
import { CardNode } from "../types";
import WorkflowNodeShell from "./WorkflowNodeShell";

function SplitNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const parts = (card.config.parts as SplitPart[] | undefined) ?? [];
  const counts = (card.output_count as Record<string, number> | null) ?? null;

  return (
    <WorkflowNodeShell selected={selected} icon={<ForkIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      {/* Split has no output handle: its result is N materialized Dataset
          cards (created/updated on Run), not a graph edge -- see handleRules.ts. */}
      <ul className="mt-2 flex flex-col gap-0.5 text-xs text-gray-600">
        {parts.map((part, index) => (
          <li key={index} className="flex items-center justify-between gap-2">
            <span className="min-w-0 break-words">{part.name || `Part ${index + 1}`}</span>
            <span className="flex-shrink-0 text-gray-400">
              {Math.round(part.ratio * 100)}%{counts && ` -- ${counts[`part_${index}`] ?? 0}`}
            </span>
          </li>
        ))}
      </ul>
      <Handle type="target" position={Position.Left} id="input" />
    </WorkflowNodeShell>
  );
}

export default memo(SplitNode);
