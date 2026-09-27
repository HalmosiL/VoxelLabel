import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { CompareResults } from "../../../api/workflowApi";
import { ScaleIcon } from "../../icons";
import { CardNode } from "../types";
import { diceTone } from "../compareReport";
import WorkflowNodeShell from "./WorkflowNodeShell";

/** Its inputs' work on the same images, side by side: after a Run, each
 * pair's mean Dice and how many cases agree / disagree (those two are
 * materialized as Datasets -- the "materialize" handle anchors the board's
 * connector to them). */
function CompareNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const results = card.config.results as CompareResults | undefined;
  const threshold = typeof card.config.agree_dice === "number" ? card.config.agree_dice : 0.7;
  const name = (i: number) => results?.inputs[i]?.title ?? `Input ${i + 1}`;

  return (
    <WorkflowNodeShell selected={selected} icon={<ScaleIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      {results ? (
        <div className="mt-2 flex flex-col gap-1 text-xs text-gray-600">
          {results.pairs.map((p) => (
            <div key={`${p.a}-${p.b}`} className="flex items-center justify-between gap-2" data-testid="compare-pair">
              <span className="min-w-0 truncate">
                {name(p.a)} vs {name(p.b)}
              </span>
              <span className={`flex-shrink-0 rounded px-1.5 font-medium tabular-nums ${diceTone(p.mean_dice, threshold)}`}>
                {p.mean_dice === null ? "--" : `Dice ${p.mean_dice.toFixed(2)}`}
              </span>
            </div>
          ))}
          <p className="text-[11px] text-gray-500" data-testid="compare-counts">
            {results.images.length} image{results.images.length === 1 ? "" : "s"} · {results.cases_agree} agree · {results.cases_disagree} disagree
            {results.skipped.length > 0 && ` · ${results.skipped.length} not yet comparable`}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-gray-500" data-testid="compare-run-hint">
          Wire in each copy's job, then run it to compare them on the same images.
        </p>
      )}
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="materialize" isConnectable={false} className="!bg-gray-300" />
    </WorkflowNodeShell>
  );
}

export default memo(CompareNode);
