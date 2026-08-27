import { DragEvent, useEffect, useState } from "react";

import { deletePipelineTemplate, listPipelineTemplates, WorkflowCardType } from "../../api/workflowApi";
import {
  DatabaseIcon,
  DocumentIcon,
  ForkIcon,
  FunnelCheckIcon,
  FunnelIcon,
  MergeIcon,
  PencilIcon,
  SparklesIcon,
  TrashIcon,
  WrenchIcon,
} from "../icons";
import {
  materializedChildrenFor,
  PIPELINE_TEMPLATES,
  PipelineTemplate,
  pipelineTemplateFromDTO,
  TEMPLATE_DRAG_DATA_FORMAT,
} from "./pipelineTemplates";

// The exact same icon each real node component renders for its type
// (see e.g. DatasetNode/ReviewNode/CriterionNode's own WorkflowNodeShell
// call) -- kept in one place so the Store's preview can never show a
// different icon than the real board card the template actually creates.
const TYPE_ICON: Partial<Record<WorkflowCardType, (props: { className?: string }) => JSX.Element>> = {
  dataset: DatabaseIcon,
  split: ForkIcon,
  filter: FunnelIcon,
  union: MergeIcon,
  annotation: PencilIcon,
  review: DocumentIcon,
  llm: SparklesIcon,
  builder: WrenchIcon,
  criterion: FunnelCheckIcon,
};

// Logical margin added around the template's own bounding box, in the
// same units as its x/y/width/height -- not pixels, since the whole
// layout below is positioned by percentage so it reflows to whatever
// width the sidebar actually gives it (fixed pixels here would clip on
// a template wider than the sidebar, as an earlier version of this did).
const THUMBNAIL_MARGIN = 20;

// A materialized child (Split's part, Review's approved/rejected,
// Criterion's included/excluded) is drawn as a small dashed "ghost" box
// stacked to the right of its parent card -- these sizes are
// deliberately smaller than a real card's, since a ghost represents
// something that doesn't exist as a real card until Run/evaluated.
const GHOST_WIDTH = 90;
const GHOST_HEIGHT = 28;
const GHOST_GAP = 8;
const GHOST_OFFSET_X = 30;
// Extra room left below every card/ghost for a feedback loop's own
// under-and-back route (see the `feedback` rendering below) -- only
// actually used by a template that has one.
const FEEDBACK_LANE = 34;

interface GhostBox {
  handle: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A small, deterministic diagram of a template's own card layout,
 * built from miniature versions of the *real* card shell (same white
 * rounded card, same icon-badge, same icon per type as WorkflowNodeShell
 * itself) rather than an abstract stand-in -- so what you see here is
 * recognizably the same kind of card "Insert" actually creates, not a
 * different visual language. Every position is a percentage of the
 * template's own bounding box (computed straight from its x/y/width/
 * height), so this can never drift out of sync with what gets created,
 * and reflows correctly regardless of the sidebar's actual width.
 *
 * Beyond the cards/edges a template actually creates, this also draws
 * each card's *automatic* materialized children (Split's parts,
 * Review's approved/rejected, Criterion's included/excluded) as dashed
 * "ghost" boxes with a dashed connector -- and, where a template has
 * one, an illustrative dashed feedback loop (e.g. Review's rejected
 * branch back into Annotation) -- so the diagram actually shows the
 * automatic connections a pipeline like this produces, not just the
 * ones a user had to draw by hand. */
function TemplateThumbnail({ template }: { template: PipelineTemplate }) {
  const cardsByKey = new Map(template.cards.map((c) => [c.key, c]));
  const ghostsByCardKey = new Map<string, GhostBox[]>();
  for (const card of template.cards) {
    const children = materializedChildrenFor(card);
    if (children.length === 0) continue;
    const totalHeight = children.length * GHOST_HEIGHT + (children.length - 1) * GHOST_GAP;
    const startY = card.y + card.height / 2 - totalHeight / 2;
    ghostsByCardKey.set(
      card.key,
      children.map((child, i) => ({
        ...child,
        x: card.x + card.width + GHOST_OFFSET_X,
        y: startY + i * (GHOST_HEIGHT + GHOST_GAP),
        width: GHOST_WIDTH,
        height: GHOST_HEIGHT,
      }))
    );
  }
  const allGhosts = [...ghostsByCardKey.values()].flat();
  const hasFeedback = (template.feedback?.length ?? 0) > 0;

  const maxX = Math.max(...template.cards.map((c) => c.x + c.width), ...allGhosts.map((g) => g.x + g.width));
  const maxY = Math.max(...template.cards.map((c) => c.y + c.height), ...allGhosts.map((g) => g.y + g.height));
  const feedbackLaneY = maxY + 12;
  const contentWidth = maxX + THUMBNAIL_MARGIN * 2;
  const contentHeight = maxY + (hasFeedback ? FEEDBACK_LANE : 0) + THUMBNAIL_MARGIN * 2;
  const pct = (value: number, total: number) => `${(value / total) * 100}%`;
  const m = (value: number) => THUMBNAIL_MARGIN + value;

  return (
    <div
      className="relative w-full overflow-hidden rounded-lg bg-gray-50"
      style={{ aspectRatio: `${contentWidth} / ${contentHeight}` }}
      role="img"
      aria-label={`${template.title} pipeline diagram`}
    >
      <svg
        viewBox={`0 0 ${contentWidth} ${contentHeight}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full text-gray-300"
      >
        <defs>
          <marker id={`arrow-${template.id}`} markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
            <path d="M0,0 L5,2.5 L0,5 Z" fill="currentColor" />
          </marker>
        </defs>
        {template.edges.map((edge, i) => {
          const source = cardsByKey.get(edge.sourceKey);
          const target = cardsByKey.get(edge.targetKey);
          if (!source || !target) return null;
          return (
            <line
              key={`edge-${i}`}
              x1={m(source.x + source.width)}
              y1={m(source.y + source.height / 2)}
              x2={m(target.x)}
              y2={m(target.y + target.height / 2)}
              stroke="currentColor"
              strokeWidth={2}
              markerEnd={`url(#arrow-${template.id})`}
            />
          );
        })}
        {/* Dashed connector from each card to its own automatic
            materialized children -- same "this isn't a user-drawn edge"
            visual language the real board's own materialization
            connectors use (see WorkflowBoardPage's materializationEdges). */}
        {template.cards.flatMap((card) =>
          (ghostsByCardKey.get(card.key) ?? []).map((ghost) => (
            <line
              key={`ghost-${card.key}-${ghost.handle}`}
              x1={m(card.x + card.width)}
              y1={m(card.y + card.height / 2)}
              x2={m(ghost.x)}
              y2={m(ghost.y + ghost.height / 2)}
              stroke="currentColor"
              strokeWidth={1.5}
              strokeDasharray="3 3"
            />
          ))
        )}
        {/* Illustrative-only feedback loop(s) -- e.g. Review's rejected
            branch back into Annotation's input. Routed under everything
            (down from the ghost, across, back up into the target) so it
            reads as a distinct return path rather than crossing other
            cards. */}
        {template.feedback?.map((fb, i) => {
          const ghost = ghostsByCardKey.get(fb.sourceKey)?.find((g) => g.handle === fb.sourceHandle);
          const target = cardsByKey.get(fb.targetKey);
          if (!ghost || !target) return null;
          const startX = m(ghost.x + ghost.width / 2);
          const startY = m(ghost.y + ghost.height);
          const laneY = m(feedbackLaneY);
          const endX = m(target.x + target.width / 2);
          const endY = m(target.y + target.height);
          return (
            <path
              key={`feedback-${i}`}
              d={`M ${startX} ${startY} L ${startX} ${laneY} L ${endX} ${laneY} L ${endX} ${endY}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeDasharray="3 3"
              markerEnd={`url(#arrow-${template.id})`}
            />
          );
        })}
      </svg>
      {template.cards.map((card) => {
        const Icon = TYPE_ICON[card.type];
        return (
          <div
            key={card.key}
            // Same shell language as WorkflowNodeShell's own real card
            // (the `card` class, a gray icon badge) -- just positioned
            // by percentage instead of a fixed pixel scale.
            className="card absolute flex !items-center gap-1 overflow-hidden !rounded-lg !p-1 !shadow"
            style={{
              left: pct(m(card.x), contentWidth),
              top: pct(m(card.y), contentHeight),
              width: pct(card.width, contentWidth),
              height: pct(card.height, contentHeight),
            }}
          >
            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded bg-gray-100 text-gray-500">
              {Icon && <Icon className="h-2.5 w-2.5" />}
            </span>
            <p className="truncate text-[8px] font-semibold leading-tight text-gray-900">{card.title}</p>
          </div>
        );
      })}
      {allGhosts.map((ghost) => (
        <div
          key={ghost.handle + ghost.x + ghost.y}
          className="absolute flex items-center justify-center rounded-md border border-dashed border-gray-300 bg-white/60"
          style={{
            left: pct(m(ghost.x), contentWidth),
            top: pct(m(ghost.y), contentHeight),
            width: pct(ghost.width, contentWidth),
            height: pct(ghost.height, contentHeight),
          }}
        >
          <p className="truncate px-1 text-[7px] font-medium italic text-gray-500">{ghost.label}</p>
        </div>
      ))}
    </div>
  );
}

function TemplateCard({
  template,
  onInsert,
  inserting,
  onDelete,
}: {
  template: PipelineTemplate;
  onInsert: (template: PipelineTemplate) => void;
  inserting: string | null;
  // Only custom (saved-by-a-user) templates get a delete affordance --
  // the 5 built-in ones ship with the app and aren't removable.
  onDelete?: (template: PipelineTemplate) => void;
}) {
  function handleDragStart(event: DragEvent<HTMLDivElement>) {
    // The *whole* template as JSON, not just an id -- a custom template
    // only exists in this component's own fetched state, not in any
    // static array the drop handler could look an id up in.
    event.dataTransfer.setData(TEMPLATE_DRAG_DATA_FORMAT, JSON.stringify(template));
    event.dataTransfer.effectAllowed = "move";
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      className="card relative cursor-grab !p-3 active:cursor-grabbing"
      title="Húzd a board-ra, hogy pontosan oda kerüljön, ahova ejted"
    >
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(template);
          }}
          className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-gray-400 shadow-sm hover:text-red-600"
          title="Sablon törlése"
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      )}
      <TemplateThumbnail template={template} />
      <p className="mt-2 text-sm font-semibold text-gray-900">{template.title}</p>
      <p className="mt-1 text-xs leading-relaxed text-gray-500">{template.description}</p>
      <button
        onClick={() => onInsert(template)}
        disabled={inserting === template.id}
        className="btn-secondary btn-sm mt-2 self-start"
      >
        {inserting === template.id ? "Beszúrás…" : "Beszúrás"}
      </button>
    </div>
  );
}

export default function PipelineStore({
  onInsert,
  inserting,
  refreshSignal,
}: {
  onInsert: (template: PipelineTemplate) => void;
  inserting: string | null;
  // Bumped by WorkflowBoardPage right after a "Mentés Store-ba" save
  // succeeds, so a newly-saved template shows up immediately even if
  // the Store tab was already open (and so never remounted/refetched
  // on its own) when the save happened.
  refreshSignal: number;
}) {
  const [customTemplates, setCustomTemplates] = useState<PipelineTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listPipelineTemplates()
      .then((dtos) => setCustomTemplates(dtos.map(pipelineTemplateFromDTO)))
      .catch((err) => setError(String(err)));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [refreshSignal]);

  function handleDelete(template: PipelineTemplate) {
    if (!window.confirm(`Törlöd a(z) "${template.title}" sablont? Ez nem vonható vissza.`)) return;
    deletePipelineTemplate(template.id)
      .then(() => setCustomTemplates((ts) => ts.filter((t) => t.id !== template.id)))
      .catch((err) => setError(String(err)));
  }

  return (
    // No width/border/scroll of its own -- shares WorkflowBoardPage's
    // <aside> with its Library tab sibling (CardLibrarySidebar).
    <div className="flex flex-col gap-4 p-3">
      <div>
        <p className="section-title">Store</p>
        <p className="hint">
          Előre elkészített pipeline-ok -- húzd a board-ra oda, ahova szeretnéd, vagy kattints a Beszúrásra a jelenlegi
          nézet közepére helyezéshez. Egy kijelölt kártyacsoportot a fenti "Mentés Store-ba" gombbal magad is
          hozzáadhatsz.
        </p>
      </div>
      {error && <p className="alert-error text-xs">{error}</p>}
      <div className="flex flex-col gap-3">
        {PIPELINE_TEMPLATES.map((template) => (
          <TemplateCard key={template.id} template={template} onInsert={onInsert} inserting={inserting} />
        ))}
      </div>
      {customTemplates.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Saját sablonok</p>
          {customTemplates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onInsert={onInsert}
              inserting={inserting}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
