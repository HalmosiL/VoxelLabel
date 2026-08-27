import { type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { WrenchIcon } from "../../icons";
import { CardNode } from "../types";
import WorkflowNodeShell from "./WorkflowNodeShell";

/** The Pipeline Builder card -- a real small model + real MCP server,
 * scoped to the whole Study rather than to connected data (see
 * WorkflowPropertiesPanel's LlmFields, which opens its chat session).
 * It has no data-flow handles at all (see handleRules.ts): it doesn't
 * take or produce a case list itself, it constructs other cards
 * (Dataset/Criterion) on the board through its own tool calls. Uses the
 * same card shell as its LLM/Criterion siblings (WorkflowNodeShell)
 * rather than Note/Milestone's marker styling, since it belongs
 * visually with the rest of the Process group. */
function BuilderNode({ selected, data }: NodeProps<CardNode>) {
  const { card } = data;

  return (
    <WorkflowNodeShell selected={selected} icon={<WrenchIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      <div className="mt-2 flex flex-col gap-1 text-xs text-gray-600">
        <span className="badge-blue self-start">MCP</span>
        <span>Helps plan and construct the eligibility pipeline</span>
      </div>
    </WorkflowNodeShell>
  );
}

export default memo(BuilderNode);
