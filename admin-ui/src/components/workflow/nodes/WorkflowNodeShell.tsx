import { NodeResizer } from "@xyflow/react";
import { ReactNode } from "react";

/** Shared white-card look for every process/data node type (Dataset,
 * Split, Filter, Union, Annotation, Review). Note/Milestone render their
 * own distinct styling instead of using this shell. Each concrete node
 * component renders its own <Handle/>s alongside this -- handle count and
 * placement varies too much (single vs. two labeled outputs, no handles
 * at all) to usefully abstract further. */
export default function WorkflowNodeShell({
  selected,
  icon,
  title,
  stale,
  children,
}: {
  selected: boolean;
  icon: ReactNode;
  title: string;
  stale?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={200} minHeight={70} />
      <div className={`card relative h-full w-full !p-3 ${selected ? "ring-2 ring-brand-500" : ""}`}>
        <div className="flex items-start gap-2">
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500">
            {icon}
          </span>
          <p className="min-w-0 flex-1 break-words text-sm font-semibold text-gray-900">{title}</p>
          {stale && <span className="badge-gray flex-shrink-0 text-[10px]">stale</span>}
        </div>
        {children}
      </div>
    </>
  );
}
