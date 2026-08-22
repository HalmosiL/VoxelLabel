import { NodeResizer, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { FlagIcon } from "../../icons";
import { CardNode } from "../types";

function MilestoneNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const text = typeof card.config.text === "string" ? card.config.text : card.title;
  const date = typeof card.config.date === "string" ? card.config.date : null;

  return (
    <>
      <NodeResizer isVisible={selected} minWidth={140} minHeight={48} />
      <div
        className={`flex h-full w-full items-start gap-2 rounded-2xl border border-brand-200 bg-brand-50 px-4 py-2.5 shadow-sm ${
          selected ? "ring-2 ring-brand-500" : ""
        }`}
      >
        <FlagIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-500" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-semibold text-brand-800">{text}</p>
          {date && <p className="text-xs text-brand-500">{date}</p>}
        </div>
      </div>
    </>
  );
}

export default memo(MilestoneNode);
