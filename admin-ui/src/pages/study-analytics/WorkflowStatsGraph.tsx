import { Background, Controls, Edge, Handle, Node, NodeProps, Position, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";

import { StudyCardMetrics } from "../../api/studyAnalyticsApi";
import { WorkflowBoard, WorkflowCard } from "../../api/workflowApi";
import { annotateFlowEdges, edgeToRFEdge, materializationEdges } from "../../components/workflow/boardGraph";
import FlowEdge from "../../components/workflow/edges/FlowEdge";
import { formatDuration } from "../usage/shared";

/** The study's workflow board, read-only, with every card showing what
 * went through it: cases in, done, still open, how long they waited and
 * were worked on, the hands-on time per case, and the review outcome.
 * Edges are the board's own (FlowEdge), so the cases on each connection
 * -- including the rejected branch looping back into annotation -- show
 * with their counts. */

const TYPE_LABEL: Record<string, string> = {
  dataset: "Dataset",
  split: "Split",
  filter: "Filter",
  annotation: "Annotation",
  review: "Review",
  union: "Union",
  note: "Note",
  milestone: "Milestone",
  annotation_surface: "Annotation surface",
  review_surface: "Review surface",
  llm: "LLM",
  builder: "Builder",
  criterion: "Criterion",
  surface: "Surface",
};

// Board cards are ~220x100; these carry more, so spread the layout out.
const SCALE_X = 1.0;
const SCALE_Y = 1.45;
const NODE_W = 230;

interface StatNodeData extends Record<string, unknown> {
  card: WorkflowCard;
  metrics?: StudyCardMetrics;
  sources: string[];
  targets: string[];
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`;
}

function Row({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2" title={title}>
      <span className="text-gray-500">{label}</span>
      <span className={`tabular-nums ${tone ?? "text-gray-900"}`}>{value}</span>
    </div>
  );
}

function StatNode({ data }: NodeProps<Node<StatNodeData>>) {
  const { card, metrics: m, sources, targets } = data;
  const job = card.type === "annotation" || card.type === "review";
  const muted = card.type === "note" || card.type === "milestone";
  const count = typeof card.output_count === "number" ? card.output_count : card.output_count ? Object.values(card.output_count).reduce((a, b) => a + b, 0) : null;
  return (
    <div
      className={`rounded-xl border bg-white px-3 py-2 text-[13px] leading-snug shadow-sm ${job ? "border-indigo-200" : muted ? "border-dashed border-gray-200 opacity-70" : "border-gray-200"}`}
      style={{ width: NODE_W }}
      data-testid={`analytics-node-${card.type}`}
    >
      {targets.map((h, i) => (
        <Handle key={`t-${h}`} id={h} type="target" position={Position.Left} isConnectable={false} style={{ top: `${((i + 1) / (targets.length + 1)) * 100}%`, opacity: 0 }} />
      ))}
      {sources.map((h, i) => (
        <Handle key={`s-${h}`} id={h} type="source" position={Position.Right} isConnectable={false} style={{ top: `${((i + 1) / (sources.length + 1)) * 100}%`, opacity: 0 }} />
      ))}
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600">{TYPE_LABEL[card.type] ?? card.type}</span>
        {m?.assignee && <span className="truncate text-[11px] text-gray-500">{m.assignee}</span>}
      </div>
      <div className="mb-1.5 line-clamp-2 text-[15px] font-semibold text-gray-900">{card.title}</div>
      {job && m ? (
        <div className="space-y-0.5">
          <div className="mb-1 flex h-1.5 overflow-hidden rounded-sm bg-gray-100" title={`${m.finished} of ${m.entered} ${card.type === "review" ? "decided" : "submitted"}`}>
            <div className="h-full bg-emerald-500" style={{ width: `${m.entered ? Math.min(m.finished / m.entered, 1) * 100 : 0}%` }} />
          </div>
          <Row label={card.type === "review" ? "In · decided · here now" : "In · submitted · here now"} value={`${m.entered} · ${m.finished} · ${m.open}`} title="Cases that entered this step · that it has finished with · waiting here right now" tone={m.open ? "text-amber-700 font-medium" : undefined} />
          <Row label="Waited (median)" value={formatDuration(m.wait_median_ms)} title="From entering this step to being opened" />
          <Row label="Worked (median)" value={formatDuration(m.work_median_ms)} title="From being opened to submitted / decided -- elapsed time" />
          <Row label="Hands-on / case" value={formatDuration(m.hands_on_median_ms)} title="Active time in the viewer per case, idle left out" />
          {card.type === "annotation" ? (
            <>
              <Row label="Passed next review 1st time" value={pct(m.first_pass_rate)} tone={m.first_pass_rate !== null && m.first_pass_rate < 0.7 ? "text-red-700" : undefined} title="Of this step's cases, the share the review right after approved at the first submission" />
              <Row label="Rounds · times sent back" value={`${m.submissions ?? 0} · ${m.sent_back ?? 0}`} tone={m.sent_back ? "text-red-700" : undefined} title="Submissions from this step · how many of them a review sent back" />
            </>
          ) : (
            <>
              <Row label="Approved · sent back" value={`${m.approved ?? 0} · ${m.rejected ?? 0}`} tone={m.rejected ? "text-red-700" : undefined} title="Decisions this review step made" />
              <Row label="Approved at 1st look" value={pct(m.first_pass_rate)} title="Of the cases this step decided on, the share it approved the first time it saw them" />
            </>
          )}
        </div>
      ) : count !== null && !muted ? (
        <div className="text-gray-600">
          <span className="tabular-nums text-gray-900">{count}</span> cases
        </div>
      ) : null}
    </div>
  );
}

const NODE_TYPES = { stat: StatNode };
const EDGE_TYPES = { flow: FlowEdge };

function Graph({ board, metrics }: { board: WorkflowBoard; metrics: Record<string, StudyCardMetrics> }) {
  const { nodes, edges } = useMemo(() => {
    const raw = [...board.edges.map(edgeToRFEdge), ...materializationEdges(board.cards)].map((e) => ({ ...e, reconnectable: false, selectable: false }));
    const flow = annotateFlowEdges(raw, board.cards) as Edge[];
    const sources = new Map<string, Set<string>>();
    const targets = new Map<string, Set<string>>();
    for (const e of flow) {
      (sources.get(e.source) ?? sources.set(e.source, new Set()).get(e.source))!.add(e.sourceHandle ?? "output");
      (targets.get(e.target) ?? targets.set(e.target, new Set()).get(e.target))!.add(e.targetHandle ?? "input");
    }
    const nodes: Node<StatNodeData>[] = board.cards.map((card) => ({
      id: card.id,
      type: "stat",
      position: { x: card.position_x * SCALE_X, y: card.position_y * SCALE_Y },
      draggable: false,
      connectable: false,
      data: { card, metrics: metrics[card.id], sources: [...(sources.get(card.id) ?? [])], targets: [...(targets.get(card.id) ?? [])] },
    }));
    return { nodes, edges: flow.map((e) => ({ ...e, sourceHandle: e.sourceHandle ?? "output", targetHandle: e.targetHandle ?? "input" })) };
  }, [board, metrics]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      edgesReconnectable={false}
      deleteKeyCode={null}
      panOnScroll
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1.1 }}
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={16} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export default function WorkflowStatsGraph({ board, metrics }: { board: WorkflowBoard; metrics: Record<string, StudyCardMetrics> }) {
  if (board.cards.length === 0) return null;
  return (
    <div className="h-[26rem] w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-50" data-testid="analytics-graph">
      <ReactFlowProvider>
        <Graph board={board} metrics={metrics} />
      </ReactFlowProvider>
    </div>
  );
}

