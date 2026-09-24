import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { SparklesIcon } from "../../icons";
import { CardNode } from "../types";
import WorkflowNodeShell from "./WorkflowNodeShell";
import UnrunSourcesHint from "../UnrunSourcesHint";

/** The Clinical Trial module's data-connected chat card -- a real small
 * model driven through a real MCP server (see services/mcp-server),
 * opened from the properties panel (see WorkflowPropertiesPanel's
 * LlmFields) to answer questions about, and optionally materialize
 * filtered Dataset(s) from, whatever Dataset(s) are wired into its
 * input. Like Split, it has no real "output" handle of its own: what
 * it produces is N named, materialized Dataset cards (one per "create
 * a dataset" request), reached through the same non-interactive
 * "materialize" anchor Split's node uses. */
function LlmNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const connectedCount = card.llm_connected_case_count ?? 0;
  const createdCount = Object.keys(card.materialized_card_ids ?? {}).length;

  return (
    <WorkflowNodeShell selected={selected} icon={<SparklesIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      <div className="mt-2 flex flex-col gap-1 text-xs text-gray-600">
        <span className="badge-blue self-start">MCP</span>
        <span>
          {connectedCount} case{connectedCount === 1 ? "" : "s"} connected
        </span>
        <UnrunSourcesHint titles={card.llm_unrun_sources} />
        {createdCount > 0 && (
          <span>
            {createdCount} dataset{createdCount === 1 ? "" : "s"} created
          </span>
        )}
      </div>
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="materialize" isConnectable={false} className="!bg-gray-300" />
    </WorkflowNodeShell>
  );
}

export default memo(LlmNode);
