import { DragEvent, ReactNode } from "react";

import { WorkflowCardConfig, WorkflowCardType } from "../../api/workflowApi";
import {
  DatabaseIcon,
  DocumentIcon,
  FlagIcon,
  ForkIcon,
  FunnelCheckIcon,
  FunnelIcon,
  MergeIcon,
  MonitorCheckIcon,
  MonitorIcon,
  PencilIcon,
  SparklesIcon,
  WrenchIcon,
} from "../icons";

export interface CardTemplate {
  type: WorkflowCardType;
  label: string;
  icon: ReactNode;
  defaultTitle: string;
  defaultConfig: WorkflowCardConfig;
  // Given explicitly (rather than left to auto-measurement) so a fresh
  // card always starts with enough room for its title to render in full.
  defaultWidth: number;
  defaultHeight: number;
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
        defaultWidth: 200,
        defaultHeight: 90,
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
        defaultWidth: 220,
        defaultHeight: 100,
      },
      {
        type: "review",
        label: "Review",
        icon: <DocumentIcon className="h-4 w-4" />,
        defaultTitle: "Review",
        defaultConfig: { assigned_user_id: null, status: "todo" },
        defaultWidth: 220,
        // Taller than Annotation's 100 -- also needs room for the
        // always-shown approved/rejected named-output rows.
        defaultHeight: 160,
      },
      {
        type: "split",
        label: "Split",
        icon: <ForkIcon className="h-4 w-4" />,
        defaultTitle: "Split",
        // Generic by default -- not a fixed train/val shape. Freely
        // renameable/addable, e.g. to Train/Val or any other N parts.
        defaultConfig: {
          parts: [
            { name: "Part 1", ratio: 0.5 },
            { name: "Part 2", ratio: 0.5 },
          ],
        },
        defaultWidth: 220,
        defaultHeight: 100,
      },
      {
        type: "union",
        label: "Union",
        icon: <MergeIcon className="h-4 w-4" />,
        defaultTitle: "Union",
        defaultConfig: {},
        defaultWidth: 200,
        defaultHeight: 90,
      },
      {
        type: "filter",
        label: "Filter",
        icon: <FunnelIcon className="h-4 w-4" />,
        defaultTitle: "Filter",
        defaultConfig: { criterion_type: "tag", tag: "" },
        defaultWidth: 200,
        defaultHeight: 90,
      },
      {
        type: "llm",
        label: "Clinical Trial Assistant",
        icon: <SparklesIcon className="h-4 w-4" />,
        defaultTitle: "Clinical Trial Assistant",
        // An empty transcript is the only state a fresh session needs.
        defaultConfig: { messages: [] },
        defaultWidth: 220,
        // Tall enough for a 2-line title plus its own connected-count
        // row *and* the "N datasets created" row once that's non-zero
        // (a very ordinary state once the session has actually been
        // used) -- 100, then 130, both proved too tight in practice
        // (confirmed live: even the *default*, un-edited title left the
        // last row clipped at 120/130) -- this leaves real margin
        // instead of a razor-thin fit that breaks on small rendering
        // differences (line-height rounding, font fallback, ...).
        defaultHeight: 160,
      },
      {
        type: "builder",
        label: "Pipeline Builder",
        icon: <WrenchIcon className="h-4 w-4" />,
        defaultTitle: "Pipeline Builder",
        // Scoped to the whole Study rather than connected data -- no
        // other state a fresh session needs beyond its own transcript.
        defaultConfig: { messages: [] },
        defaultWidth: 220,
        // Tall enough for a 2-line title plus its own MCP badge and
        // (2-line-clamped) description rows, with real margin -- 100,
        // then 120, both still clipped the description's last line in
        // practice, confirmed live even with the plain default title.
        defaultHeight: 150,
      },
      {
        type: "criterion",
        label: "Eligibility Criterion",
        icon: <FunnelCheckIcon className="h-4 w-4" />,
        defaultTitle: "Eligibility Criterion",
        // `criterion` holds the one natural-language rule this
        // sub-agent judges connected cases against.
        defaultConfig: { criterion: "", messages: [] },
        defaultWidth: 220,
        // Taller than a plain chat card -- also needs room for its own
        // criterion text (up to 2 lines) plus the always-shown
        // included/excluded named-output rows.
        defaultHeight: 200,
      },
      {
        type: "annotation_surface",
        label: "Annotation Surface",
        icon: <MonitorIcon className="h-4 w-4" />,
        defaultTitle: "Annotation Surface",
        // Permissive by default -- connect it to an Annotation card and
        // uncheck things to restrict; an unconnected Annotation card
        // behaves as if every tool/pane/3D were enabled regardless.
        defaultConfig: {
          tools: ["paint", "erase", "fill", "polygon", "auto", "histogram"],
          panes: ["sagittal", "coronal", "axial"],
          show_3d: true,
        },
        defaultWidth: 200,
        defaultHeight: 90,
      },
      {
        type: "review_surface",
        label: "Review Surface",
        icon: <MonitorCheckIcon className="h-4 w-4" />,
        defaultTitle: "Review Surface",
        // No tools/3D field at all -- the review surface never has
        // either, unconditionally, so this only ever configures panes.
        defaultConfig: { panes: ["sagittal", "coronal", "axial"] },
        defaultWidth: 200,
        defaultHeight: 90,
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
        defaultWidth: 200,
        defaultHeight: 120,
      },
      {
        type: "milestone",
        label: "Milestone",
        icon: <FlagIcon className="h-4 w-4" />,
        defaultTitle: "Milestone",
        defaultConfig: { text: "Milestone", date: null },
        defaultWidth: 180,
        defaultHeight: 60,
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

export default function CardLibrarySidebar({ onAdd }: { onAdd?: (type: WorkflowCardType) => void }) {
  function handleDragStart(event: DragEvent<HTMLDivElement>, type: WorkflowCardType) {
    event.dataTransfer.setData(DRAG_DATA_FORMAT, type);
    event.dataTransfer.effectAllowed = "move";
  }

  return (
    // No width/border/scroll of its own -- WorkflowBoardPage wraps this
    // (and its Store tab sibling, PipelineStore) in one shared <aside>
    // that owns those, so switching tabs doesn't visually reset them.
    <div className="flex flex-col gap-5 p-4">
      {GROUPS.map((group) => (
        <div key={group.label}>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{group.label}</div>
          <div className="flex flex-col gap-1.5">
            {group.items.map((item) => (
              <div
                key={item.type}
                draggable
                onDragStart={(e) => handleDragStart(e, item.type)}
                className="flex cursor-grab items-center gap-2 rounded-lg border border-gray-100 bg-white py-1 pl-2.5 pr-1 text-sm text-gray-700 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
              >
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500">
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1 truncate py-1">{item.label}</span>
                {/* HTML5 drag-and-drop doesn't exist on most touch
                    browsers: the "+" drops the card in the middle of the
                    current view instead -- also just quicker with a
                    mouse when exact placement doesn't matter. */}
                {onAdd && (
                  <button
                    type="button"
                    onClick={() => onAdd(item.type)}
                    aria-label={`Add ${item.label} card`}
                    title="Add to the board (middle of the view)"
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-brand-50 hover:text-brand-700"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                      <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
