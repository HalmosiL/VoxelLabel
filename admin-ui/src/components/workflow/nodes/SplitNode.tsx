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
      {/* Split has no user-connectable output handle: its result is N
          materialized Dataset cards (created/updated on Run), not an
          edge the user draws -- see handleRules.ts. The "materialize"
          handle below is a non-interactive anchor purely so the board can
          draw a (non-deletable) connector line to those Dataset cards. */}
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
      {/* the parts are what gets wired on, and they only exist once it ran -- nothing said so (UX-ux-admin-09) */}
      {counts === null && (
        <p className="mt-1.5 text-[11px] text-gray-500" data-testid="split-run-hint">
          Run it to make a card per part -- you connect the parts onward.
        </p>
      )}
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="materialize" isConnectable={false} className="!bg-gray-300" />
    </WorkflowNodeShell>
  );
}

export default memo(SplitNode);
