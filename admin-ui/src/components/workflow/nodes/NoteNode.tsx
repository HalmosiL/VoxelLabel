import { NodeResizer, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { CardNode } from "../types";

function NoteNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const text = typeof card.config.text === "string" ? card.config.text : "";

  return (
    <>
      <NodeResizer isVisible={selected} minWidth={140} minHeight={100} />
      <div
        className={`h-full w-full overflow-hidden rounded-lg border border-amber-200 bg-amber-50 p-3 shadow-sm ${
          selected ? "ring-2 ring-brand-500" : ""
        }`}
      >
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-600">Note</p>
        <p className="whitespace-pre-wrap text-sm text-amber-900">{text}</p>
      </div>
    </>
  );
}

export default memo(NoteNode);
