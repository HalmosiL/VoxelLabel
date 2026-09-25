import type { Edge } from "@xyflow/react";
import { useCallback, useRef, useState } from "react";

import { createWorkflowCard, createWorkflowEdge, deleteWorkflowCard, deleteWorkflowEdge } from "../../api/workflowApi";
import { CardNode } from "./types";

export interface Snapshot {
  nodes: CardNode[];
  edges: Edge[];
}

function cloneSnapshot(nodes: CardNode[], edges: Edge[]): Snapshot {
  return { nodes: nodes.map((n) => ({ ...n, position: { ...n.position } })), edges: edges.map((e) => ({ ...e })) };
}

/** After undo/redo/paste/bulk-delete settles local canvas state, fire the
 * minimal set of granular admin-service calls to bring the backend back in
 * line with the new snapshot -- every normal interaction (drag, connect,
 * delete) already persists itself the moment it happens, so this only
 * needs to reconcile the *difference* a history jump introduces. Recreated
 * cards/edges pass their original id back to the server so anything else
 * still referencing them (an edge, a selection) stays valid. */
async function diffAndSync(prev: Snapshot, next: Snapshot, studyId: string): Promise<void> {
  const prevNodeIds = new Set(prev.nodes.map((n) => n.id));
  const nextNodeIds = new Set(next.nodes.map((n) => n.id));
  const prevEdgeIds = new Set(prev.edges.map((e) => e.id));
  const nextEdgeIds = new Set(next.edges.map((e) => e.id));

  await Promise.all(
    prev.edges.filter((e) => !nextEdgeIds.has(e.id)).map((e) => deleteWorkflowEdge(e.id).catch(() => undefined))
  );
  await Promise.all(
    prev.nodes.filter((n) => !nextNodeIds.has(n.id)).map((n) => deleteWorkflowCard(n.id).catch(() => undefined))
  );
  await Promise.all(
    next.nodes
      .filter((n) => !prevNodeIds.has(n.id))
      .map((n) =>
        createWorkflowCard(studyId, {
          id: n.id,
          type: n.data.card.type,
          title: n.data.card.title,
          position_x: n.position.x,
          position_y: n.position.y,
          width: n.width ?? undefined,
          height: n.height ?? undefined,
          config: n.data.card.config,
          // restored as it was, progress and all (D-12)
          created_at: n.data.card.created_at,
          last_run_at: n.data.card.last_run_at,
          output_case_ids: n.data.card.output_case_ids,
        }).catch(() => undefined)
      )
  );
  await Promise.all(
    next.edges
      .filter((e) => !prevEdgeIds.has(e.id))
      .map((e) =>
        createWorkflowEdge(studyId, {
          id: e.id,
          source_card_id: e.source,
          source_handle: e.sourceHandle ?? "output",
          target_card_id: e.target,
          target_handle: e.targetHandle ?? "input",
        }).catch(() => undefined)
      )
  );
}

/** Client-side {past[], present, future[]} snapshot stack -- cheap at the
 * dozens-of-cards scale a workflow board actually reaches. Uses refs (not
 * state) for the stacks themselves so undo/redo can read the current
 * stack synchronously; `bump` forces a re-render so canUndo/canRedo stay
 * accurate for the caller. */
export function useWorkflowHistory(studyId: string) {
  const pastRef = useRef<Snapshot[]>([]);
  const futureRef = useRef<Snapshot[]>([]);
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const record = useCallback(
    (nodes: CardNode[], edges: Edge[]) => {
      pastRef.current = [...pastRef.current, cloneSnapshot(nodes, edges)];
      futureRef.current = [];
      bump();
    },
    [bump]
  );

  const undo = useCallback(
    (currentNodes: CardNode[], currentEdges: Edge[], apply: (snapshot: Snapshot) => void) => {
      const past = pastRef.current;
      if (past.length === 0) return;
      const previous = past[past.length - 1];
      const current = cloneSnapshot(currentNodes, currentEdges);
      pastRef.current = past.slice(0, -1);
      futureRef.current = [...futureRef.current, current];
      apply(previous);
      void diffAndSync(current, previous, studyId);
      bump();
    },
    [studyId, bump]
  );

  const redo = useCallback(
    (currentNodes: CardNode[], currentEdges: Edge[], apply: (snapshot: Snapshot) => void) => {
      const future = futureRef.current;
      if (future.length === 0) return;
      const next = future[future.length - 1];
      const current = cloneSnapshot(currentNodes, currentEdges);
      futureRef.current = future.slice(0, -1);
      pastRef.current = [...pastRef.current, current];
      apply(next);
      void diffAndSync(current, next, studyId);
      bump();
    },
    [studyId, bump]
  );

  return { record, undo, redo, canUndo: pastRef.current.length > 0, canRedo: futureRef.current.length > 0 };
}
