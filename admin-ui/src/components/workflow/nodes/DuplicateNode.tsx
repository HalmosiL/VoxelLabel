import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { CopiesIcon } from "../../icons";
import { CardNode } from "../types";
import WorkflowNodeShell from "./WorkflowNodeShell";

/** The same cases down several lanes: one row per copy, each with every
 * case -- each copy is annotated apart (its own branch of the
 * annotations), so the copies' jobs can be compared on the same images.
 * Like Split, the copies are materialized Dataset cards made on Run; the
 * "materialize" handle only anchors the board's connector to them. */
function DuplicateNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const copies = typeof card.config.copies === "number" ? card.config.copies : 2;
  const names = (card.config.names as string[] | undefined) ?? [];
  const counts = (card.output_count as Record<string, number> | null) ?? null;

  return (
    <WorkflowNodeShell selected={selected} icon={<CopiesIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      <ul className="mt-2 flex flex-col gap-0.5 text-xs text-gray-600">
        {Array.from({ length: copies }, (_, index) => (
          <li key={index} className="flex items-center justify-between gap-2" data-testid={`duplicate-copy-${index}`}>
            <span className="min-w-0 break-words">{names[index]?.trim() || `Copy ${String.fromCharCode(65 + index)}`}</span>
            <span className="flex-shrink-0 text-gray-400">{counts ? `${counts[`copy_${index}`] ?? 0} cases` : "all cases"}</span>
          </li>
        ))}
      </ul>
      {counts === null && (
        <p className="mt-1.5 text-[11px] text-gray-500" data-testid="duplicate-run-hint">
          Run it to make a card per copy -- give each copy its own Annotation job.
        </p>
      )}
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="materialize" isConnectable={false} className="!bg-gray-300" />
    </WorkflowNodeShell>
  );
}

export default memo(DuplicateNode);
