import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { FunnelCheckIcon } from "../../icons";
import { CardNode } from "../types";
import WorkflowNodeShell from "./WorkflowNodeShell";
import UnrunSourcesHint from "../UnrunSourcesHint";

// The two named outputs a Criterion card materializes once its own
// chat session has been asked to evaluate -- included cases are meant
// to chain onward (the next criterion, or a Split/Annotation/Review),
// excluded ones are the CONSORT-diagram's own drop-off count at this
// stage. Same shape as Review's approved/rejected.
const CRITERION_BRANCHES: { handle: string; label: string; dot: string }[] = [
  { handle: "included", label: "included", dot: "bg-emerald-500" },
  { handle: "excluded", label: "excluded", dot: "bg-red-500" },
];

/** One eligibility-criterion sub-agent in a CONSORT-style pipeline: a
 * real small model + real MCP server (like its LLM sibling), scoped to
 * judging every case connected into its input against its own one
 * stored `config.criterion` rule (see WorkflowPropertiesPanel's
 * LlmFields, which opens its chat session). Like LLM/Split, it has no
 * real "output" edge of its own -- what it produces is always the two
 * named materialized children below, via evaluate_criterion. */
function CriterionNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const criterionText = typeof card.config.criterion === "string" ? card.config.criterion : "";
  const connectedCount = card.llm_connected_case_count ?? 0;
  const counts = card.materialized_counts;

  return (
    <WorkflowNodeShell selected={selected} icon={<FunnelCheckIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      <div className="mt-2 flex flex-col gap-1 text-xs text-gray-600">
        <span className="badge-blue self-start">MCP</span>
        {criterionText ? (
          <p className="line-clamp-2 italic text-gray-500" title={criterionText}>
            "{criterionText}"
          </p>
        ) : (
          <p className="text-gray-400">no criterion set yet</p>
        )}
        <span>
          {connectedCount} case{connectedCount === 1 ? "" : "s"} connected
        </span>
        <UnrunSourcesHint titles={card.llm_unrun_sources} />
      </div>
      <ul className="mt-2 flex flex-col gap-0.5 text-xs text-gray-600">
        {CRITERION_BRANCHES.map((branch) => (
          <li key={branch.handle} className="flex items-center gap-1.5">
            <span className={`badge-dot ${branch.dot}`} />
            <span>{branch.label}</span>
            <span className="ml-auto text-gray-400">{counts?.[branch.handle] ?? 0}</span>
          </li>
        ))}
      </ul>
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="materialize" isConnectable={false} className="!bg-gray-300" />
    </WorkflowNodeShell>
  );
}

export default memo(CriterionNode);
