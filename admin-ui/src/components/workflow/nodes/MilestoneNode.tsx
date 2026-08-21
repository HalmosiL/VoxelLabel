import { type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { FlagIcon } from "../../icons";
import { CardNode } from "../types";

function MilestoneNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const text = typeof card.config.text === "string" ? card.config.text : card.title;
  const date = typeof card.config.date === "string" ? card.config.date : null;

  return (
    <div
      className={`flex h-full w-full items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-4 py-2 shadow-sm ${
        selected ? "ring-2 ring-brand-500" : ""
      }`}
    >
      <FlagIcon className="h-4 w-4 flex-shrink-0 text-brand-500" />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-brand-800">{text}</p>
        {date && <p className="text-xs text-brand-500">{date}</p>}
      </div>
    </div>
  );
}

export default memo(MilestoneNode);
