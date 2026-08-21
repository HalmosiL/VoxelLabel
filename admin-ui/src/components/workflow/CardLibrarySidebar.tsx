import { DragEvent, ReactNode } from "react";

import { WorkflowCardConfig, WorkflowCardType } from "../../api/workflowApi";
import { DatabaseIcon, DocumentIcon, FlagIcon, ForkIcon, FunnelIcon, MergeIcon, PencilIcon } from "../icons";

export interface CardTemplate {
  type: WorkflowCardType;
  label: string;
  icon: ReactNode;
  defaultTitle: string;
  defaultConfig: WorkflowCardConfig;
}

const GROUPS: { label: string; items: CardTemplate[] }[] = [
  {
    label: "Data",
    items: [
      {
        type: "dataset",
        label: "Dataset",
        icon: <DatabaseIcon className="h-4 w-4" />,
        defaultTitle: "Dataset",
        defaultConfig: { mode: "all_cases" },
      },
    ],
  },
  {
    label: "Process",
    items: [
      {
        type: "annotation",
        label: "Annotation",
        icon: <PencilIcon className="h-4 w-4" />,
        defaultTitle: "Annotation",
        defaultConfig: { assigned_user_id: null, status: "todo" },
      },
      {
        type: "review",
        label: "Review",
        icon: <DocumentIcon className="h-4 w-4" />,
        defaultTitle: "Review",
        defaultConfig: { assigned_user_id: null, status: "todo" },
      },
      {
        type: "split",
        label: "Split",
        icon: <ForkIcon className="h-4 w-4" />,
        defaultTitle: "Split",
        defaultConfig: { ratio: 0.8 },
      },
      {
        type: "union",
        label: "Union",
        icon: <MergeIcon className="h-4 w-4" />,
        defaultTitle: "Union",
        defaultConfig: {},
      },
      {
        type: "filter",
        label: "Filter",
        icon: <FunnelIcon className="h-4 w-4" />,
        defaultTitle: "Filter",
        defaultConfig: { criterion_type: "tag", tag: "" },
      },
    ],
  },
  {
    label: "Other",
    items: [
      {
        type: "note",
        label: "Note",
        icon: <DocumentIcon className="h-4 w-4" />,
        defaultTitle: "Note",
        defaultConfig: { text: "" },
      },
      {
        type: "milestone",
        label: "Milestone",
        icon: <FlagIcon className="h-4 w-4" />,
        defaultTitle: "Milestone",
        defaultConfig: { text: "Milestone", date: null },
      },
    ],
  },
];

export const CARD_TEMPLATES: CardTemplate[] = GROUPS.flatMap((g) => g.items);

export function templateFor(type: WorkflowCardType): CardTemplate {
  const template = CARD_TEMPLATES.find((t) => t.type === type);
  if (!template) throw new Error(`Unknown workflow card type: ${type}`);
  return template;
}

export const DRAG_DATA_FORMAT = "application/x-workflow-card-type";

export default function CardLibrarySidebar() {
  function handleDragStart(event: DragEvent<HTMLDivElement>, type: WorkflowCardType) {
    event.dataTransfer.setData(DRAG_DATA_FORMAT, type);
    event.dataTransfer.effectAllowed = "move";
  }

  return (
    <aside className="flex w-56 flex-shrink-0 flex-col gap-5 overflow-y-auto border-r border-gray-200/70 bg-white/80 p-4">
      {GROUPS.map((group) => (
        <div key={group.label}>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{group.label}</div>
          <div className="flex flex-col gap-1.5">
            {group.items.map((item) => (
              <div
                key={item.type}
                draggable
                onDragStart={(e) => handleDragStart(e, item.type)}
                className="flex cursor-grab items-center gap-2 rounded-lg border border-gray-100 bg-white px-2.5 py-2 text-sm text-gray-700 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
              >
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500">
                  {item.icon}
                </span>
                {item.label}
              </div>
            ))}
          </div>
        </div>
      ))}
    </aside>
  );
}
