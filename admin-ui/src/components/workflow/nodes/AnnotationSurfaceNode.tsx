import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { MonitorIcon } from "../../icons";
import { CardNode } from "../types";
import WorkflowNodeShell from "./WorkflowNodeShell";

function AnnotationSurfaceNode({ data, selected }: NodeProps<CardNode>) {
  const { card } = data;
  const tools = Array.isArray(card.config.tools) ? (card.config.tools as string[]) : [];
  const panes = Array.isArray(card.config.panes) ? (card.config.panes as string[]) : [];
  const show3d = card.config.show_3d === true;

  return (
    <WorkflowNodeShell selected={selected} icon={<MonitorIcon className="h-4 w-4" />} title={card.title} stale={card.stale}>
      <p className="mt-2 text-xs text-gray-500">
        {tools.length} tool{tools.length === 1 ? "" : "s"} · {panes.length} pane{panes.length === 1 ? "" : "s"} · 3D{" "}
        {show3d ? "on" : "off"}
      </p>
      {/* Positioned distinctly from the ordinary data input handle (Left,
          used by every other card type) since this is a separate,
          independent connection -- restricting a job, not feeding it data. */}
      <Handle type="source" position={Position.Bottom} id="surface_config" />
    </WorkflowNodeShell>
  );
}

export default memo(AnnotationSurfaceNode);
