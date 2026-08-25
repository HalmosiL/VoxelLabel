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
import { DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getStudy, KeycloakUser, listKeycloakUsers, Study } from "../api/adminApi";
import { CaseSummary, listCases } from "../api/dataApi";
import {
  createWorkflowCard,
  createWorkflowEdge,
  deleteWorkflowCard,
  deleteWorkflowEdge,
  getWorkflowBoard,
  runWorkflowCard,
  updateWorkflowCard,
  WorkflowCard,
  WorkflowCardPatchInput,
  WorkflowEdge,
} from "../api/workflowApi";
import { CARD_TEMPLATES, DRAG_DATA_FORMAT } from "../components/workflow/CardLibrarySidebar";
import CardLibrarySidebar from "../components/workflow/CardLibrarySidebar";
import { isValidConnection } from "../components/workflow/handleRules";
import AnnotationNode from "../components/workflow/nodes/AnnotationNode";
import AnnotationSurfaceNode from "../components/workflow/nodes/AnnotationSurfaceNode";
import DatasetNode from "../components/workflow/nodes/DatasetNode";
import FilterNode from "../components/workflow/nodes/FilterNode";
import MilestoneNode from "../components/workflow/nodes/MilestoneNode";
import NoteNode from "../components/workflow/nodes/NoteNode";
import ReviewNode from "../components/workflow/nodes/ReviewNode";
import ReviewSurfaceNode from "../components/workflow/nodes/ReviewSurfaceNode";
import SplitNode from "../components/workflow/nodes/SplitNode";
import UnionNode from "../components/workflow/nodes/UnionNode";
import { CardNode } from "../components/workflow/types";
import { useWorkflowHistory, type Snapshot } from "../components/workflow/useWorkflowHistory";
import WorkflowPropertiesPanel from "../components/workflow/WorkflowPropertiesPanel";

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
};

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
    type: "step",
    reconnectable: true,
  };
}

/** Derived, non-interactive connector lines from a Split/Annotation/Review
 * card to whichever Dataset card(s) it materialized -- not a real
 * WorkflowEdge (materialized Dataset cards have no real input), so these
 * are recomputed client-side from each card's materialized_card_id(s)
 * rather than fetched, and marked non-deletable/non-selectable so they
 * can't be mistaken for a user-drawn connection. Split has no real
 * output handle of its own (see handleRules.ts), so its nodes render a
 * dedicated non-interactive "materialize" anchor to originate from;
 * Annotation and Review both still have a real "output" handle, so
 * their connector(s) originate from that instead -- Review's two
 * (approved, rejected) just both fan out from the same point. */
function materializationEdges(cards: WorkflowCard[]): Edge[] {
  const edges: Edge[] = [];
  for (const card of cards) {
    const childEntries =
      card.type === "split"
        ? Object.entries(card.materialized_card_ids ?? {}).map(([, childId]) => [childId, "materialize"] as const)
        : card.type === "review"
          ? Object.entries(card.materialized_card_ids ?? {}).map(([, childId]) => [childId, "output"] as const)
          : card.type === "annotation" && card.materialized_card_id
            ? [[card.materialized_card_id, "output"] as const]
            : [];

    for (const [childId, sourceHandle] of childEntries) {
      edges.push({
        id: `materialize-${card.id}-${childId}`,
        source: card.id,
        sourceHandle,
        target: childId,
        targetHandle: "materialize",
        type: "step",
        style: { strokeDasharray: "4 3", stroke: "#c7c7c7" },
        deletable: false,
        selectable: false,
        focusable: false,
      });
    }
  }
  return edges;
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
  const clipboardRef = useRef<{ nodes: CardNode[]; edges: Edge[] } | null>(null);

  const { screenToFlowPosition, fitView } = useReactFlow();
  const history = useWorkflowHistory(studyId);
  // Materialization connector lines are derived, not user-authored -- they
  // must never enter undo/redo history or the backend-sync logic that
  // treats history edges as real WorkflowEdge rows.
  const realEdges = edges.filter((e) => e.deletable !== false);

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
    const type = event.dataTransfer.getData(DRAG_DATA_FORMAT);
    const template = CARD_TEMPLATES.find((t) => t.type === type);
    if (!template) return;

    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    history.record(nodes, realEdges);
    createWorkflowCard(studyId, {
      type: template.type,
      title: template.defaultTitle,
      position_x: position.x,
      position_y: position.y,
      width: template.defaultWidth,
      height: template.defaultHeight,
      config: template.defaultConfig,
    })
      .then((card) => setNodes((nds) => [...nds, cardToNode(card)]))
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
        <CardLibrarySidebar />

        <div
          className="relative flex-1"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onContextMenu={(e) => e.preventDefault()}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
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
          running={runningCardId !== null}
        />
      </div>
    </div>
  );
}
