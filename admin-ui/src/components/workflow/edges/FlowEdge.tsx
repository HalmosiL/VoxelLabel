import { BaseEdge, EdgeProps, getSmoothStepPath } from "@xyflow/react";

export type FlowTone = "neutral" | "done" | "rejected";

export interface FlowEdgeData extends Record<string, unknown> {
  // How many cases actually sit on this connection right now (a Split
  // part's count, a Review branch's materialized count, a plain card's
  // output_count, ...). Zero means nothing is flowing here yet -- the
  // line renders idle instead of animating, per an explicit product
  // decision: only edges with real cases in flight should look alive.
  count: number;
  tone: FlowTone;
}

const TONE_COLOR: Record<FlowTone, string> = {
  neutral: "#4f46e5", // brand-600 -- the ordinary case-shaping flow
  done: "#10b981", // emerald-500 -- approved / annotated
  rejected: "#ef4444", // red-500 -- rejected, feeding back as rework
};

const IDLE_COLOR = "#d1d5db"; // gray-300

// However many cases are actually on an edge, only this many dots ever
// render -- a literal one-dot-per-case count would be unreadable (or
// unusably slow) once a dataset has hundreds of cases. The real number
// still shows as a label; the dots are a rate indicator, not a census.
const MAX_DOTS = 5;
const LOOP_SECONDS = 3.2;
const STROKE_WIDTH = 3.5;

export default function FlowEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 0,
  });

  const flowData = data as FlowEdgeData | undefined;
  const count = flowData?.count ?? 0;
  const tone = flowData?.tone ?? "neutral";
  const color = count > 0 ? TONE_COLOR[tone] : IDLE_COLOR;
  const dots = Math.min(count, MAX_DOTS);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ ...style, stroke: color, strokeWidth: STROKE_WIDTH, strokeOpacity: count > 0 ? 0.9 : 0.5 }}
      />
      {Array.from({ length: dots }, (_, i) => (
        <circle key={i} r={5.5} fill={color}>
          <animateMotion dur={`${LOOP_SECONDS}s`} repeatCount="indefinite" begin={`${-(i * LOOP_SECONDS) / dots}s`} path={path} />
        </circle>
      ))}
      {count > 0 && (
        <g transform={`translate(${labelX}, ${labelY})`}>
          <circle r={10} fill="white" stroke={color} strokeWidth={1.8} />
          <text textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={600} fill={color}>
            {count}
          </text>
        </g>
      )}
    </>
  );
}
