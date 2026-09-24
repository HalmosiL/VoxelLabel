import { PipelineTemplateDTO, WorkflowCardConfig, WorkflowCardType } from "../../api/workflowApi";

/** One card in a pipeline template -- `key` is a local, template-scoped
 * reference (not a real card id) so the template's own edges can name
 * which of its cards they connect, before any of them exist on a real
 * board. `x`/`y` are relative to the template's own origin (0,0), not
 * absolute board coordinates -- inserting a template offsets every card
 * by wherever the user drops it. */
export interface PipelineTemplateCard {
  key: string;
  type: WorkflowCardType;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  config: WorkflowCardConfig;
}

/** The named children a card automatically materializes once it's
 * actually Run/evaluated (Split's parts, Review's approved/rejected,
 * Criterion's included/excluded) -- computed fresh from the card's own
 * type/config rather than stored on the template, so it can never go
 * stale and works the same for a hand-authored built-in template and a
 * user's saved-from-the-board custom one alike. These children don't
 * exist as real cards until then, so they're never in a template's own
 * `cards` list -- PipelineStore's thumbnail draws them as dashed
 * "ghost" boxes instead, so the diagram shows the automatic
 * connections a card like this always produces, not just the ones a
 * user had to draw by hand. Purely illustrative either way -- never
 * sent to the backend, never created by inserting the template. */
export function materializedChildrenFor(card: PipelineTemplateCard): { handle: string; label: string }[] {
  if (card.type === "split") {
    const parts = (card.config.parts as { name?: string }[] | undefined) ?? [];
    return parts.map((part, i) => ({ handle: `part_${i}`, label: part.name || `Part ${i + 1}` }));
  }
  if (card.type === "review") {
    return [
      { handle: "approved", label: "approved" },
      { handle: "rejected", label: "rejected" },
    ];
  }
  if (card.type === "criterion") {
    return [
      { handle: "included", label: "included" },
      { handle: "excluded", label: "excluded" },
    ];
  }
  return [];
}

export interface PipelineTemplateEdge {
  sourceKey: string;
  sourceHandle: string;
  targetKey: string;
  targetHandle: string;
}

/** An illustrative-only dashed connection from one card's materialized
 * child (see PipelineTemplateCard.materializes) back into another
 * card's real input -- e.g. Review's "rejected" branch looping back
 * into Annotation. Never a real WorkflowEdge: the materialized child
 * doesn't exist until the source card has actually been Run, so this
 * can't be wired for real at insert time the way `edges` is -- it's
 * drawn in the Store thumbnail purely so the diagram communicates the
 * feedback loop the template's own description promises. */
export interface PipelineTemplateFeedback {
  sourceKey: string;
  sourceHandle: string;
  targetKey: string;
  targetHandle: string;
}

export interface PipelineTemplate {
  id: string;
  title: string;
  description: string;
  cards: PipelineTemplateCard[];
  edges: PipelineTemplateEdge[];
  feedback?: PipelineTemplateFeedback[];
  // Saved templates only: who saved it (Keycloak subject).
  createdBy?: string | null;
}

// Drag payload format for dragging a whole template out of the Store
// straight onto the board canvas (mirrors CardLibrarySidebar's own
// DRAG_DATA_FORMAT for a single card type). Unlike that one, this
// carries the *whole* template as JSON, not just an id to look up --
// a custom (saved-by-a-user) template only exists in PipelineStore's
// own fetched state, not in any static array WorkflowBoardPage could
// search, so the drop handler needs the complete template up front.
export const TEMPLATE_DRAG_DATA_FORMAT = "application/x-workflow-pipeline-template";

/** Converts a saved template as the API returns it (edges keyed
 * source_key/target_key, matching the backend's own field names) into
 * this module's own PipelineTemplate shape (sourceKey/targetKey) --
 * the one shape every template, built-in or custom, is rendered and
 * inserted through. */
export function pipelineTemplateFromDTO(dto: PipelineTemplateDTO): PipelineTemplate {
  return {
    id: dto.id,
    title: dto.title,
    description: dto.description,
    cards: dto.cards,
    edges: dto.edges.map((e) => ({
      sourceKey: e.source_key,
      sourceHandle: e.source_handle,
      targetKey: e.target_key,
      targetHandle: e.target_handle,
    })),
    createdBy: dto.created_by,
  };
}

/** The reverse conversion -- this module's own PipelineTemplate shape
 * into the API's create-template request body. */
export function pipelineTemplateToCreateInput(template: {
  title: string;
  description: string;
  cards: PipelineTemplateCard[];
  edges: PipelineTemplateEdge[];
}) {
  return {
    title: template.title,
    description: template.description,
    cards: template.cards,
    edges: template.edges.map((e) => ({
      source_key: e.sourceKey,
      source_handle: e.sourceHandle,
      target_key: e.targetKey,
      target_handle: e.targetHandle,
    })),
  };
}

// Five ready-made pipelines covering the board's real card types -- each
// insertable as-is, then freely edited like any hand-built pipeline.
// Positions are hand-placed (not auto-laid-out) so the small preview
// diagram (see PipelineStore's renderThumbnail) reads the same shape a
// person would draw by hand.
export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: "basic-annotation",
    title: "Basic annotation pipeline",
    description:
      "The simplest workflow: every case goes straight to annotation, then review. A good starting point for a new study.",
    cards: [
      { key: "dataset", type: "dataset", title: "All Cases", x: 0, y: 0, width: 200, height: 90, config: { mode: "all_cases" } },
      {
        key: "annotation",
        type: "annotation",
        title: "Annotation",
        x: 260,
        y: 0,
        width: 220,
        height: 100,
        config: { assigned_user_id: null, status: "todo" },
      },
      { key: "review", type: "review", title: "Review", x: 520, y: 0, width: 220, height: 160, config: { assigned_user_id: null, status: "todo" } },
    ],
    edges: [
      { sourceKey: "dataset", sourceHandle: "output", targetKey: "annotation", targetHandle: "input" },
      { sourceKey: "annotation", sourceHandle: "output", targetKey: "review", targetHandle: "input" },
    ],
  },
  {
    id: "train-test-split",
    title: "Train / Test split",
    description:
      "Randomly divides cases into two parts at a given ratio (80/20 by default) -- e.g. for machine learning, or two parallel annotation rounds.",
    cards: [
      { key: "dataset", type: "dataset", title: "All Cases", x: 0, y: 0, width: 200, height: 90, config: { mode: "all_cases" } },
      {
        key: "split",
        type: "split",
        title: "Train / Test Split",
        x: 260,
        y: 0,
        width: 220,
        height: 100,
        config: {
          parts: [
            { name: "Train", ratio: 0.8 },
            { name: "Test", ratio: 0.2 },
          ],
        },
      },
    ],
    edges: [{ sourceKey: "dataset", sourceHandle: "output", targetKey: "split", targetHandle: "input" }],
  },
  {
    id: "review-feedback-loop",
    title: "Review with feedback loop",
    description:
      "The Review card's rejected cases automatically flow back to the Annotation card for re-annotation -- so a rejection is never lost, it just goes back into the queue.",
    cards: [
      { key: "dataset", type: "dataset", title: "All Cases", x: 0, y: 0, width: 200, height: 90, config: { mode: "all_cases" } },
      {
        key: "annotation",
        type: "annotation",
        title: "Annotation",
        x: 260,
        y: 0,
        width: 220,
        height: 100,
        config: { assigned_user_id: null, status: "todo" },
      },
      { key: "review", type: "review", title: "Review", x: 520, y: 0, width: 220, height: 160, config: { assigned_user_id: null, status: "todo" } },
    ],
    edges: [
      { sourceKey: "dataset", sourceHandle: "output", targetKey: "annotation", targetHandle: "input" },
      { sourceKey: "annotation", sourceHandle: "output", targetKey: "review", targetHandle: "input" },
    ],
    // Review's materialized "rejected" branch is what actually carries
    // the feedback -- there's no real WorkflowEdge to create for it at
    // insert time (the branch doesn't exist until Review has actually
    // Run), so this is illustrative only: the Store thumbnail draws it
    // as a dashed loop back into Annotation's input, matching what the
    // user is expected to wire for real after the first Run.
    feedback: [{ sourceKey: "review", sourceHandle: "rejected", targetKey: "annotation", targetHandle: "input" }],
  },
  {
    id: "consort-eligibility",
    title: "CONSORT eligibility pipeline",
    description:
      "A starting population with one AI-driven eligibility Criterion card, plus a Pipeline Builder you can use to extend the chain further by chatting -- the board itself becomes the CONSORT flow diagram.",
    cards: [
      { key: "dataset", type: "dataset", title: "All Cases", x: 0, y: 0, width: 200, height: 90, config: { mode: "all_cases" } },
      {
        key: "criterion",
        type: "criterion",
        title: "Eligibility Criterion",
        x: 260,
        y: 0,
        width: 220,
        height: 200,
        config: { criterion: "", messages: [] },
      },
      { key: "builder", type: "builder", title: "Pipeline Builder", x: 260, y: 260, width: 220, height: 150, config: { messages: [] } },
    ],
    edges: [{ sourceKey: "dataset", sourceHandle: "output", targetKey: "criterion", targetHandle: "input" }],
  },
  {
    id: "clinical-trial-assistant",
    title: "Clinical Trial Assistant filtering",
    description:
      "Connect your cases to an AI assistant you can chat with in plain language to ask questions about the connected data, or ask it to build a filtered dataset based on your own criteria.",
    cards: [
      { key: "dataset", type: "dataset", title: "All Cases", x: 0, y: 0, width: 200, height: 90, config: { mode: "all_cases" } },
      {
        key: "llm",
        type: "llm",
        title: "Clinical Trial Assistant",
        x: 260,
        y: 0,
        width: 220,
        height: 160,
        config: { messages: [] },
      },
    ],
    edges: [{ sourceKey: "dataset", sourceHandle: "output", targetKey: "llm", targetHandle: "input" }],
  },
];
