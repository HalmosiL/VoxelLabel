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
      {card.materialized_from && (
        <p className="mt-1 truncate text-xs text-brand-500">from: {card.materialized_from.title}</p>
      )}
      <Handle type="source" position={Position.Right} id="output" />
      {/* Real, user-connectable input: connect anything into a Dataset
          card and Run it to snapshot that upstream result as this card's
          own manual case list. */}
      <Handle type="target" position={Position.Left} id="input" />
      {/* Non-interactive anchor for the (non-deletable) connector line
          from whichever card auto-materialized this Dataset -- separate
          from the real "input" handle above so both can coexist. */}
      {card.materialized_from && (
        <Handle
          type="target"
          position={Position.Left}
          id="materialize"
          isConnectable={false}
          className="!bg-gray-300"
          style={{ top: "70%" }}
        />
      )}
    </WorkflowNodeShell>
  );
}

export default memo(DatasetNode);
