import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  DragEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useParams } from "react-router-dom";

import { getStudy, KeycloakUser, listKeycloakUsers, Study } from "../api/adminApi";
import { CaseSummary, listCases } from "../api/dataApi";
import {
  createPipelineTemplate,
  createWorkflowCard,
  createWorkflowEdge,
  deleteWorkflowCard,
  deleteWorkflowEdge,
  getWorkflowBoard,
  runWorkflowCard,
  updateWorkflowCard,
  WorkflowCard,
  WorkflowCardPatchInput,
  WorkflowCardType,
  WorkflowEdge,
} from "../api/workflowApi";
import { CARD_TEMPLATES, DRAG_DATA_FORMAT } from "../components/workflow/CardLibrarySidebar";
import CardLibrarySidebar from "../components/workflow/CardLibrarySidebar";
import PipelineStore from "../components/workflow/PipelineStore";
import {
  PipelineTemplate,
  pipelineTemplateToCreateInput,
  TEMPLATE_DRAG_DATA_FORMAT,
} from "../components/workflow/pipelineTemplates";
import SaveTemplateModal from "../components/workflow/SaveTemplateModal";
import ConsortExportPage from "../components/workflow/ConsortExportPage";
import { isValidConnection } from "../components/workflow/handleRules";
import AnnotationNode from "../components/workflow/nodes/AnnotationNode";
import AnnotationSurfaceNode from "../components/workflow/nodes/AnnotationSurfaceNode";
import BuilderNode from "../components/workflow/nodes/BuilderNode";
import CriterionNode from "../components/workflow/nodes/CriterionNode";
import DatasetNode from "../components/workflow/nodes/DatasetNode";
import FilterNode from "../components/workflow/nodes/FilterNode";
import LlmNode from "../components/workflow/nodes/LlmNode";
import MilestoneNode from "../components/workflow/nodes/MilestoneNode";
import NoteNode from "../components/workflow/nodes/NoteNode";
import ReviewNode from "../components/workflow/nodes/ReviewNode";
import ReviewSurfaceNode from "../components/workflow/nodes/ReviewSurfaceNode";
import SplitNode from "../components/workflow/nodes/SplitNode";
import UnionNode from "../components/workflow/nodes/UnionNode";
import { CardNode } from "../components/workflow/types";
import { useWorkflowHistory, type Snapshot } from "../components/workflow/useWorkflowHistory";
import WorkflowPropertiesPanel from "../components/workflow/WorkflowPropertiesPanel";
import FlowEdge, { FlowTone } from "../components/workflow/edges/FlowEdge";
import LlmChatModal from "../components/workflow/LlmChatModal";

const NODE_TYPES = {
  dataset: DatasetNode,
  split: SplitNode,
  filter: FilterNode,
  annotation: AnnotationNode,
  review: ReviewNode,
  union: UnionNode,
  note: NoteNode,
  milestone: MilestoneNode,
  annotation_surface: AnnotationSurfaceNode,
  review_surface: ReviewSurfaceNode,
  llm: LlmNode,
  builder: BuilderNode,
  criterion: CriterionNode,
};

const EDGE_TYPES = { flow: FlowEdge };

// Which card types a Store template insert Runs automatically (see
// insertTemplateAt) -- deterministic, synchronous recomputes only.
// Split/Review are what actually need this (their named materialized
// children, e.g. Review's approved/rejected, are the whole point of a
// template like "Review with feedback loop"); Filter/Union/
// Annotation are included too since they're just as cheap and a card
// downstream of one may need its output_case_ids populated to Run in
// turn. Never Criterion/LLM/Builder -- those call out to a real local
// model, which must stay a deliberate, user-triggered action.
const _AUTO_RUN_TEMPLATE_TYPES = new Set<WorkflowCardType>(["split", "filter", "union", "annotation", "review"]);

function cardToNode(card: WorkflowCard): CardNode {
  return {
    id: card.id,
    type: card.type,
    position: { x: card.position_x, y: card.position_y },
    width: card.width ?? undefined,
    height: card.height ?? undefined,
    data: { card },
  };
}

function edgeToRFEdge(edge: WorkflowEdge): Edge {
  return {
    id: edge.id,
    source: edge.source_card_id,
    sourceHandle: edge.source_handle,
    target: edge.target_card_id,
    targetHandle: edge.target_handle,
    // Right-angled routing instead of the default bezier curve, and
    // draggable by either endpoint (see handleReconnect) to rewire it
    // onto a different card/handle without deleting and redrawing.
    // "flow" (see FlowEdge) draws the same right-angled path but also
    // animates real cases moving along it -- flow data is attached
    // separately (see annotateFlowEdges) since it depends on the cards
    // on both ends, not just the edge itself.
    type: "flow",
    reconnectable: true,
  };
}

/** Derived, non-interactive connector lines from a Split/Annotation/
 * Review/LLM/Criterion card to whichever Dataset card(s) it
 * materialized -- not a real WorkflowEdge (materialized Dataset cards
 * have no real input), so these are recomputed client-side from each
 * card's materialized_card_id(s) rather than fetched, and marked
 * non-deletable/non-selectable so they can't be mistaken for a
 * user-drawn connection. Split/LLM/Criterion have no real output
 * handle of their own (see handleRules.ts), so their nodes render a
 * dedicated non-interactive "materialize" anchor to originate from;
 * Annotation and Review both still have a real "output" handle, so
 * their connector(s) originate from that instead -- Review's two
 * (approved, rejected) just both fan out from the same point. */
function materializationEdges(cards: WorkflowCard[]): Edge[] {
  const edges: Edge[] = [];
  for (const card of cards) {
    // [childId, anchor handle to draw from, semantic branch key]. Review's
    // approved/rejected both fan out from the same real "output" handle, so
    // the branch key (needed to tell them apart for flow tone/count -- see
    // annotateFlowEdges) has to travel separately from the anchor handle.
    const childEntries: Array<readonly [string, string, string]> =
      card.type === "split" || card.type === "llm" || card.type === "criterion"
        ? Object.entries(card.materialized_card_ids ?? {}).map(([key, childId]) => [childId, "materialize", key] as const)
        : card.type === "review"
          ? Object.entries(card.materialized_card_ids ?? {}).map(([key, childId]) => [childId, "output", key] as const)
          : card.type === "annotation" && card.materialized_card_id
            ? [[card.materialized_card_id, "output", "annotated"] as const]
            : [];

    for (const [childId, sourceHandle, branchKey] of childEntries) {
      edges.push({
        id: `materialize-${card.id}-${childId}`,
        source: card.id,
        sourceHandle,
        target: childId,
        targetHandle: "materialize",
        type: "flow",
        style: { strokeDasharray: "4 3" },
        deletable: false,
        selectable: false,
        focusable: false,
        data: { branchKey },
      });
    }
  }
  return edges;
}

/** Maps a card id to the tone its downstream cases should render in --
 * a Review's approved/rejected materialized children, and an
 * Annotation's materialized "(annotated)" child, carry that outcome
 * with them wherever they're wired onward (e.g. the rejected branch
 * looping back into an Annotation card's input). Everything else flows
 * "neutral": it hasn't been decided on yet. */
function buildFlowToneMap(cards: WorkflowCard[]): Record<string, FlowTone> {
  const tones: Record<string, FlowTone> = {};
  for (const card of cards) {
    if (card.type === "review") {
      const approvedId = card.materialized_card_ids?.approved;
      const rejectedId = card.materialized_card_ids?.rejected;
      if (approvedId) tones[approvedId] = "done";
      if (rejectedId) tones[rejectedId] = "rejected";
    }
    if (card.type === "criterion") {
      const includedId = card.materialized_card_ids?.included;
      const excludedId = card.materialized_card_ids?.excluded;
      if (includedId) tones[includedId] = "done";
      if (excludedId) tones[excludedId] = "rejected";
    }
    if (card.type === "annotation" && card.materialized_card_id) {
      tones[card.materialized_card_id] = "done";
    }
  }
  return tones;
}

function cardOutputCount(card: WorkflowCard | undefined, handle: string | null): number {
  if (!card) return 0;
  const count = card.output_count;
  if (count == null) return 0;
  return typeof count === "number" ? count : (count[handle ?? "output"] ?? 0);
}

/** Attaches how many cases are actually on each edge right now, and
 * which tone they carry, so FlowEdge can animate real volume instead of
 * a decorative flourish -- an edge with nothing flowing through it
 * renders idle rather than pretending otherwise. Derived entirely from
 * data the board already loads (no extra request), so it's cheap to
 * recompute on every render as cards/edges change (e.g. right after a
 * Run updates a card's counts). */
function annotateFlowEdges(edges: Edge[], cards: WorkflowCard[]): Edge[] {
  const cardsById = new Map(cards.map((c) => [c.id, c]));
  const tones = buildFlowToneMap(cards);

  return edges.map((edge) => {
    const isMaterialization = edge.deletable === false;
    let count: number;
    let tone: FlowTone;

    if (isMaterialization) {
      const parent = cardsById.get(edge.source);
      const branchKey = (edge.data as { branchKey?: string } | undefined)?.branchKey;
      if (parent?.type === "review") {
        count = parent.materialized_counts?.[branchKey ?? ""] ?? 0;
        tone = branchKey === "approved" ? "done" : "rejected";
      } else if (parent?.type === "criterion") {
        count = parent.materialized_counts?.[branchKey ?? ""] ?? 0;
        tone = branchKey === "included" ? "done" : "rejected";
      } else if (parent?.type === "split") {
        const splitCounts = parent.output_count;
        count = splitCounts && typeof splitCounts !== "number" ? (splitCounts[branchKey ?? ""] ?? 0) : 0;
        tone = "neutral";
      } else if (parent?.type === "llm") {
        // Unlike Split's per-part counts (cached on the parent itself),
        // an LLM-created Dataset's count just lives on that Dataset card
        // like any other -- it's a plain "manual" child, computed live
        // regardless of Run history.
        const child = cardsById.get(edge.target);
        count = typeof child?.output_count === "number" ? child.output_count : 0;
        tone = "neutral";
      } else {
        count = parent?.annotation_progress?.annotated ?? 0;
        tone = "done";
      }
    } else {
      count = cardOutputCount(cardsById.get(edge.source), edge.sourceHandle ?? null);
      tone = tones[edge.source] ?? "neutral";
    }

    return { ...edge, data: { count, tone } };
  });
}

function isEditableTarget(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
}

export default function WorkflowBoardPage() {
  const { studyId } = useParams<{ studyId: string }>();
  if (!studyId) return null;
  return (
    <ReactFlowProvider>
      <WorkflowBoardInner studyId={studyId} />
    </ReactFlowProvider>
  );
}

function WorkflowBoardInner({ studyId }: { studyId: string }) {
  const [study, setStudy] = useState<Study | null>(null);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [keycloakUsers, setKeycloakUsers] = useState<KeycloakUser[]>([]);
  const [nodes, setNodes] = useState<CardNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runningCardId, setRunningCardId] = useState<string | null>(null);
  // Which LLM card's chat session (if any) is open -- lifted here rather
  // than into LlmNode/WorkflowPropertiesPanel so the modal can call the
  // same refreshBoard() every other board-mutating action already uses.
  const [chatCardId, setChatCardId] = useState<string | null>(null);
  // Which panel the left sidebar shows -- the draggable card library, or
  // the Store's ready-made pipeline templates (see handleInsertTemplate).
  const [sidebarTab, setSidebarTab] = useState<"library" | "store">("library");
  // Store's own width, user-resizable (see the drag handle next to the
  // <aside> below) and remembered across sessions -- the Library tab
  // stays a fixed compact width, since its plain draggable card list
  // never needs more room the way the Store's pipeline thumbnails do.
  const [storeSidebarWidth, setStoreSidebarWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem("workflowStoreSidebarWidth"));
      return saved >= 320 && saved <= 900 ? saved : 384;
    } catch {
      return 384;
    }
  });
  const [insertingTemplateId, setInsertingTemplateId] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [showConsortExport, setShowConsortExport] = useState(false);
  // Bumped after a template save succeeds so PipelineStore refetches
  // even if the Store tab (and so PipelineStore itself) was already
  // mounted when the save happened -- see its own prop comment.
  const [templateRefreshSignal, setTemplateRefreshSignal] = useState(0);
  const clipboardRef = useRef<{ nodes: CardNode[]; edges: Edge[] } | null>(null);

  const { screenToFlowPosition, fitView } = useReactFlow();
  const history = useWorkflowHistory(studyId);
  // Materialization connector lines are derived, not user-authored -- they
  // must never enter undo/redo history or the backend-sync logic that
  // treats history edges as real WorkflowEdge rows.
  const realEdges = edges.filter((e) => e.deletable !== false);
  // Recomputed from the current cards on every render (cheap, no extra
  // request) rather than threaded through every edge-mutation call site,
  // so a Run's updated counts animate correctly no matter how the edge
  // it's on was created (drawn, reconnected, pasted, ...).
  const renderedEdges = useMemo(
    () => annotateFlowEdges(edges, nodes.map((n) => n.data.card)),
    [edges, nodes],
  );

  function refreshBoard() {
    getWorkflowBoard(studyId)
      .then((board) => {
        setNodes(board.cards.map(cardToNode));
        setEdges([...board.edges.map(edgeToRFEdge), ...materializationEdges(board.cards)]);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(() => {
    getStudy(studyId).then(setStudy).catch((err) => setError(String(err)));
    listCases(studyId).then(setCases).catch((err) => setError(String(err)));
    listKeycloakUsers()
      .then(setKeycloakUsers)
      .catch(() => setKeycloakUsers([]));
    refreshBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyId]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== "remove"), nds) as CardNode[]);
  }, []);

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes.filter((c) => c.type !== "remove"), eds));
  }, []);

  function applySnapshot(snapshot: Snapshot) {
    setNodes(snapshot.nodes);
    setEdges([...snapshot.edges, ...materializationEdges(snapshot.nodes.map((n) => n.data.card))]);
  }

  function handleNodeDragStart() {
    history.record(nodes, realEdges);
  }

  function handleNodeDragStop(_event: unknown, _node: CardNode, draggedNodes: CardNode[]) {
    // draggedNodes is every node that moved -- when several cards are
    // multi-selected, dragging any one of them (Miro-style) moves the
    // whole group, so every member's new position needs persisting, not
    // just the one the pointer happened to grab.
    Promise.all(
      draggedNodes.map((node) =>
        updateWorkflowCard(node.id, { position_x: node.position.x, position_y: node.position.y })
      )
    ).catch((err) => setError(String(err)));
  }

  function handleConnect(connection: Connection) {
    const sourceNode = nodes.find((n) => n.id === connection.source);
    const targetNode = nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) return;
    if (
      !isValidConnection(
        sourceNode.data.card.type,
        connection.sourceHandle,
        targetNode.data.card.type,
        connection.targetHandle
      )
    ) {
      setError("That connection isn't allowed between these card types.");
      return;
    }
    history.record(nodes, realEdges);
    createWorkflowEdge(studyId, {
      source_card_id: connection.source,
      source_handle: connection.sourceHandle ?? "output",
      target_card_id: connection.target,
      target_handle: connection.targetHandle ?? "input",
    })
      .then((edge) => setEdges((eds) => [...eds, edgeToRFEdge(edge)]))
      .catch((err) => setError(String(err)));
  }

  /** Dragging an existing edge's endpoint onto a different handle rewires
   * it -- there's no PATCH for an edge's endpoints server-side (each edge
   * is an immutable created/deleted row, like everywhere else in this
   * graph), so this deletes the old one and creates a new one, then
   * swaps it into place in local state once the new id comes back. */
  function handleReconnect(oldEdge: Edge, newConnection: Connection) {
    const sourceNode = nodes.find((n) => n.id === newConnection.source);
    const targetNode = nodes.find((n) => n.id === newConnection.target);
    if (!sourceNode || !targetNode) return;
    if (
      !isValidConnection(
        sourceNode.data.card.type,
        newConnection.sourceHandle,
        targetNode.data.card.type,
        newConnection.targetHandle
      )
    ) {
      setError("That connection isn't allowed between these card types.");
      return;
    }
    history.record(nodes, realEdges);
    Promise.all([
      deleteWorkflowEdge(oldEdge.id),
      createWorkflowEdge(studyId, {
        source_card_id: newConnection.source,
        source_handle: newConnection.sourceHandle ?? "output",
        target_card_id: newConnection.target,
        target_handle: newConnection.targetHandle ?? "input",
      }),
    ])
      .then(([, edge]) => setEdges((eds) => eds.map((e) => (e.id === oldEdge.id ? edgeToRFEdge(edge) : e))))
      .catch((err) => setError(String(err)));
  }

  function handleNodesDelete(deleted: CardNode[]) {
    if (deleted.length === 0) return;
    const deletedIds = new Set(deleted.map((n) => n.id));
    history.record(nodes, realEdges);
    const affectedEdgeIds = realEdges
      .filter((e) => deletedIds.has(e.source) || deletedIds.has(e.target))
      .map((e) => e.id);

    setNodes((nds) => nds.filter((n) => !deletedIds.has(n.id)));
    setEdges((eds) => eds.filter((e) => !deletedIds.has(e.source) && !deletedIds.has(e.target)));

    Promise.all([
      ...Array.from(deletedIds).map((id) => deleteWorkflowCard(id).catch(() => undefined)),
      ...affectedEdgeIds.map((id) => deleteWorkflowEdge(id).catch(() => undefined)),
    ]).catch((err) => setError(String(err)));
  }

  function handleEdgesDelete(deleted: Edge[]) {
    // deletable:false on materialization edges should already keep them out
    // of react-flow's delete cascade, but filter defensively anyway --
    // they don't correspond to a real WorkflowEdge to delete.
    const real = deleted.filter((e) => e.deletable !== false);
    if (real.length === 0) return;
    history.record(nodes, realEdges);
    const deletedIds = new Set(real.map((e) => e.id));
    setEdges((eds) => eds.filter((e) => !deletedIds.has(e.id)));
    Promise.all(Array.from(deletedIds).map((id) => deleteWorkflowEdge(id).catch(() => undefined))).catch((err) =>
      setError(String(err))
    );
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();

    const templateJson = event.dataTransfer.getData(TEMPLATE_DRAG_DATA_FORMAT);
    if (templateJson) {
      // The whole template travels as JSON, not just an id -- a custom
      // (saved-by-a-user) one only exists in PipelineStore's own
      // fetched state, nowhere this page could look an id up in.
      try {
        const template: PipelineTemplate = JSON.parse(templateJson);
        // Dropped exactly where the cursor let go -- the template's own
        // (0,0) origin lands there, same as a single card's position_x/y
        // becomes exactly the drop point below.
        insertTemplateAt(template, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      } catch (err) {
        setError(String(err));
      }
      return;
    }

    const type = event.dataTransfer.getData(DRAG_DATA_FORMAT);
    const cardTemplate = CARD_TEMPLATES.find((t) => t.type === type);
    if (!cardTemplate) return;

    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    history.record(nodes, realEdges);
    createWorkflowCard(studyId, {
      type: cardTemplate.type,
      title: cardTemplate.defaultTitle,
      position_x: position.x,
      position_y: position.y,
      width: cardTemplate.defaultWidth,
      height: cardTemplate.defaultHeight,
      config: cardTemplate.defaultConfig,
    })
      .then((card) => setNodes((nds) => [...nds, cardToNode(card)]))
      .catch((err) => setError(String(err)));
  }

  /** Instantiates a whole Store template at once -- same create-cards-
   * then-create-edges-by-key shape as the Ctrl+V clipboard-paste handler
   * above (see its own comments), just sourced from a static template's
   * relative positions instead of copied real nodes. `origin` is
   * wherever the template's own (0,0) should land in flow space -- the
   * drop point for a drag (see handleDrop), or the current viewport's
   * center for the Store's "Insert" button (see handleInsertTemplate). */
  async function insertTemplateAt(template: PipelineTemplate, origin: { x: number; y: number }) {
    setInsertingTemplateId(template.id);
    history.record(nodes, realEdges);
    try {
      const keyToId = new Map<string, string>();
      for (const card of template.cards) {
        const created = await createWorkflowCard(studyId, {
          type: card.type,
          title: card.title,
          position_x: origin.x + card.x,
          position_y: origin.y + card.y,
          width: card.width,
          height: card.height,
          config: card.config,
        });
        keyToId.set(card.key, created.id);
      }

      for (const edge of template.edges) {
        const source = keyToId.get(edge.sourceKey);
        const target = keyToId.get(edge.targetKey);
        if (!source || !target) continue;
        await createWorkflowEdge(studyId, {
          source_card_id: source,
          source_handle: edge.sourceHandle,
          target_card_id: target,
          target_handle: edge.targetHandle,
        });
      }

      // Run every deterministic, already-wired card in the template, in
      // the order it's listed (source before target, by construction --
      // see PIPELINE_TEMPLATES) -- this is what actually materializes
      // Split's parts / Review's approved-rejected, so a template like
      // "Review with feedback loop" produces its real named
      // children immediately instead of only once someone happens to
      // click Run later. AI-driven cards (Criterion, LLM, Builder) are
      // deliberately excluded -- evaluating a criterion is a real model
      // call a user should trigger on purpose, never a side effect of
      // dropping a template on the board. A card with no incoming edge
      // (a template's own root Dataset) is skipped too -- Running one
      // requires exactly one incoming connection.
      const hasIncomingEdge = new Set(template.edges.map((e) => e.targetKey));
      const runResultByKey = new Map<string, WorkflowCard>();
      for (const card of template.cards) {
        if (!_AUTO_RUN_TEMPLATE_TYPES.has(card.type) || !hasIncomingEdge.has(card.key)) continue;
        const cardId = keyToId.get(card.key);
        if (!cardId) continue;
        const result = await runWorkflowCard(cardId);
        runResultByKey.set(card.key, result);
      }

      // Now that Review/Split have actually materialized their named
      // children for real, wire up any illustrative feedback loop (see
      // PipelineTemplateFeedback) as a real WorkflowEdge too -- e.g.
      // Review's freshly-created "(rejected)" Dataset back into
      // Annotation's input, completing the loop the template promises
      // instead of leaving it as just a diagram.
      for (const fb of template.feedback ?? []) {
        const childId = runResultByKey.get(fb.sourceKey)?.materialized_card_ids?.[fb.sourceHandle];
        const targetId = keyToId.get(fb.targetKey);
        if (!childId || !targetId) continue;
        await createWorkflowEdge(studyId, {
          source_card_id: childId,
          source_handle: "output",
          target_card_id: targetId,
          target_handle: fb.targetHandle,
        });
      }

      // A plain create-cards-then-create-edges insert could patch local
      // state directly (see the old version of this function), but Run
      // creates cards (the materialized children) this page doesn't
      // know about yet -- simplest to just pull the complete result
      // from the server instead of hand-reconciling all of it locally.
      refreshBoard();
    } catch (err) {
      setError(String(err));
    } finally {
      setInsertingTemplateId(null);
    }
  }

  /** The Store's "Insert" button -- centers the template on whatever's
   * currently in view, for a click-only insert with no drag involved. */
  function handleInsertTemplate(template: PipelineTemplate) {
    insertTemplateAt(
      template,
      screenToFlowPosition({
        x: window.innerWidth / 2 - 200,
        y: window.innerHeight / 2 - 150,
      })
    );
  }

  /** Drag-to-resize the Store sidebar (see the handle rendered right
   * after the <aside> below) -- plain window-level mouse listeners for
   * the drag's duration, the same pattern as any other drag-resize
   * handle, since React Flow's own drag handling doesn't cover the
   * surrounding page chrome. Persisted to localStorage so the chosen
   * width survives a reload -- purely a per-browser convenience, never
   * anything the backend needs to know about. */
  function startStoreSidebarResize(event: ReactMouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = storeSidebarWidth;

    function onMouseMove(moveEvent: MouseEvent) {
      const next = Math.min(900, Math.max(320, startWidth + (moveEvent.clientX - startX)));
      setStoreSidebarWidth(next);
      try {
        localStorage.setItem("workflowStoreSidebarWidth", String(next));
      } catch {
        // Storage unavailable (private browsing, disabled) -- the resize
        // itself still works for the rest of this session, just isn't
        // remembered next time.
      }
    }
    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  /** The toolbar's "Save to Store" flow -- snapshots the current
   * selection (cards, relative to the selection's own top-left corner,
   * plus whichever real edges run between two selected cards) into a
   * new template, the reverse of insertTemplateAt. */
  function handleSaveTemplate(title: string, description: string) {
    const selected = nodes.filter((n) => n.selected);
    if (selected.length === 0) return;
    const minX = Math.min(...selected.map((n) => n.position.x));
    const minY = Math.min(...selected.map((n) => n.position.y));
    const selectedIds = new Set(selected.map((n) => n.id));

    const template = {
      title,
      description,
      cards: selected.map((n) => ({
        key: n.id,
        type: n.data.card.type,
        title: n.data.card.title,
        x: n.position.x - minX,
        y: n.position.y - minY,
        width: n.width ?? n.data.card.width ?? 200,
        height: n.height ?? n.data.card.height ?? 90,
        config: n.data.card.config,
      })),
      edges: realEdges
        .filter((e) => selectedIds.has(e.source) && selectedIds.has(e.target))
        .map((e) => ({
          sourceKey: e.source,
          sourceHandle: e.sourceHandle ?? "output",
          targetKey: e.target,
          targetHandle: e.targetHandle ?? "input",
        })),
    };

    createPipelineTemplate(pipelineTemplateToCreateInput(template))
      .then(() => {
        setSavingTemplate(false);
        setSidebarTab("store");
        setTemplateRefreshSignal((n) => n + 1);
      })
      .catch((err) => setError(String(err)));
  }

  function handleSelectCard(cardId: string) {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === cardId })));
    fitView({ nodes: [{ id: cardId }], duration: 300, maxZoom: 1 }).catch(() => undefined);
  }

  function handlePatch(cardId: string, patch: WorkflowCardPatchInput) {
    updateWorkflowCard(cardId, patch)
      .then((updated) => setNodes((nds) => nds.map((n) => (n.id === cardId ? { ...n, data: { card: updated } } : n))))
      .catch((err) => setError(String(err)));
  }

  function handleDeleteCard(cardId: string) {
    handleNodesDelete(nodes.filter((n) => n.id === cardId));
  }

  function handleBulkDelete() {
    handleNodesDelete(nodes.filter((n) => n.selected));
  }

  function handleRun(cardId: string) {
    setRunningCardId(cardId);
    runWorkflowCard(cardId)
      .then(() => refreshBoard())
      .catch((err) => setError(String(err)))
      .finally(() => setRunningCardId(null));
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (isEditableTarget()) return;
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;

      if (event.key === "z" && !event.shiftKey) {
        event.preventDefault();
        history.undo(nodes, realEdges, applySnapshot);
      } else if (event.key === "y" || (event.key === "z" && event.shiftKey)) {
        event.preventDefault();
        history.redo(nodes, realEdges, applySnapshot);
      } else if (event.key === "c") {
        const selected = nodes.filter((n) => n.selected);
        if (selected.length === 0) return;
        const selectedIds = new Set(selected.map((n) => n.id));
        const innerEdges = realEdges.filter((e) => selectedIds.has(e.source) && selectedIds.has(e.target));
        clipboardRef.current = { nodes: selected, edges: innerEdges };
      } else if (event.key === "v") {
        const clip = clipboardRef.current;
        if (!clip) return;
        history.record(nodes, realEdges);
        const idMap = new Map<string, string>();
        Promise.all(
          clip.nodes.map((n) =>
            createWorkflowCard(studyId, {
              type: n.data.card.type,
              title: n.data.card.title,
              position_x: n.position.x + 40,
              position_y: n.position.y + 40,
              width: n.width ?? undefined,
              height: n.height ?? undefined,
              config: n.data.card.config,
            }).then((created) => {
              idMap.set(n.id, created.id);
              return created;
            })
          )
        )
          .then((createdCards) => {
            setNodes((nds) => [...nds, ...createdCards.map(cardToNode)]);
            return Promise.all(
              clip.edges.map((edge) => {
                const source = idMap.get(edge.source);
                const target = idMap.get(edge.target);
                if (!source || !target) return Promise.resolve(null);
                return createWorkflowEdge(studyId, {
                  source_card_id: source,
                  source_handle: edge.sourceHandle ?? "output",
                  target_card_id: target,
                  target_handle: edge.targetHandle ?? "input",
                });
              })
            );
          })
          .then((createdEdges) => {
            const valid = createdEdges.filter((e): e is WorkflowEdge => e !== null);
            if (valid.length > 0) setEdges((eds) => [...eds, ...valid.map(edgeToRFEdge)]);
          })
          .catch((err) => setError(String(err)));
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, studyId]);

  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedCard = selectedNodes.length === 1 ? selectedNodes[0].data.card : null;
  const hasIncomingEdge = selectedCard ? realEdges.some((e) => e.target === selectedCard.id) : false;
  const chatCard = chatCardId ? (nodes.find((n) => n.id === chatCardId)?.data.card ?? null) : null;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-gray-200/70 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <Link to={`/studies/${studyId}`} className="btn-secondary btn-sm">
            ← Back
          </Link>
          <div>
            <h1 className="text-sm font-semibold text-gray-900">{study?.name ?? "Study"}</h1>
            <p className="text-xs text-gray-400">Workflow board</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowConsortExport(true)} className="btn-secondary btn-sm">
            CONSORT export
          </button>
          <button
            onClick={() => setSavingTemplate(true)}
            disabled={selectedNodes.length === 0}
            className="btn-secondary btn-sm"
            title={selectedNodes.length === 0 ? "Select at least one card" : "Save the selected cards as a new Store template"}
          >
            Save to Store
          </button>
          <button
            onClick={() => history.undo(nodes, realEdges, applySnapshot)}
            disabled={!history.canUndo}
            className="btn-secondary btn-sm"
          >
            Undo
          </button>
          <button
            onClick={() => history.redo(nodes, realEdges, applySnapshot)}
            disabled={!history.canRedo}
            className="btn-secondary btn-sm"
          >
            Redo
          </button>
        </div>
      </header>
      {error && (
        <div className="flex-shrink-0 border-b border-red-100 bg-red-50 px-5 py-2">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Wider on the Store tab -- the pipeline thumbnails need real
            room to stay legible; the plain draggable card list doesn't
            need (or want) that extra width, so it only widens while
            Store is actually open. The Store's own width is further
            user-resizable via the drag handle right after this <aside>
            (inline style, not a Tailwind width class, since it's a
            continuous user-chosen value, not one of a fixed set). */}
        <aside
          className="flex flex-shrink-0 flex-col border-r border-gray-200/70 bg-white/80 transition-[width]"
          style={{ width: sidebarTab === "store" ? storeSidebarWidth : 224 }}
        >
          <div className="flex flex-shrink-0 border-b border-gray-200/70 text-sm">
            <button
              onClick={() => setSidebarTab("library")}
              className={`flex-1 border-b-2 px-3 py-2 font-medium ${
                sidebarTab === "library" ? "border-brand-600 text-brand-700" : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Library
            </button>
            <button
              onClick={() => setSidebarTab("store")}
              className={`flex-1 border-b-2 px-3 py-2 font-medium ${
                sidebarTab === "store" ? "border-brand-600 text-brand-700" : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Store
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {sidebarTab === "library" ? (
              <CardLibrarySidebar />
            ) : (
              <PipelineStore
                onInsert={handleInsertTemplate}
                inserting={insertingTemplateId}
                refreshSignal={templateRefreshSignal}
              />
            )}
          </div>
        </aside>

        {sidebarTab === "store" && (
          <div
            onMouseDown={startStoreSidebarResize}
            className="w-1 flex-shrink-0 cursor-col-resize bg-gray-200/70 transition-colors hover:bg-brand-400 active:bg-brand-500"
            title="Drag to resize the sidebar"
          />
        )}

        <div
          className="relative flex-1"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onContextMenu={(e) => e.preventDefault()}
        >
          <ReactFlow
            nodes={nodes}
            edges={renderedEdges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onNodeDragStart={handleNodeDragStart}
            onNodeDragStop={handleNodeDragStop}
            onConnect={handleConnect}
            onReconnect={handleReconnect}
            onNodesDelete={handleNodesDelete}
            onEdgesDelete={handleEdgesDelete}
            deleteKeyCode={["Backspace", "Delete"]}
            // Plain left-drag (or middle-click-drag) on empty canvas pans
            // the board; holding Ctrl while dragging switches to a
            // selection box (multi-select) instead -- selectionKeyCode
            // overrides panOnDrag for the duration the key is held, no
            // separate selectionOnDrag flag needed. Right-click-drag
            // (button 2) was tried too but isn't reliably supported by
            // React Flow's underlying zoom/pan handling, so it's
            // deliberately left out rather than offered as a broken
            // affordance.
            panOnDrag={[0, 1]}
            selectionKeyCode="Control"
            panOnScroll
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={16} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        <WorkflowPropertiesPanel
          card={selectedCard}
          selectedCount={selectedNodes.length}
          cases={cases}
          keycloakUsers={keycloakUsers}
          studyId={studyId}
          hasIncomingEdge={hasIncomingEdge}
          onClose={() => setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))}
          onPatch={handlePatch}
          onDelete={handleDeleteCard}
          onBulkDelete={handleBulkDelete}
          onRun={handleRun}
          onSelectCard={handleSelectCard}
          onOpenChat={setChatCardId}
          running={runningCardId !== null}
        />

        {chatCard && (
          <LlmChatModal card={chatCard} onClose={() => setChatCardId(null)} onBoardChanged={refreshBoard} />
        )}

        {savingTemplate && (
          <SaveTemplateModal
            cardCount={selectedNodes.length}
            onClose={() => setSavingTemplate(false)}
            onSave={handleSaveTemplate}
          />
        )}

        {showConsortExport && <ConsortExportPage studyId={studyId} onClose={() => setShowConsortExport(false)} />}
      </div>
    </div>
  );
}
