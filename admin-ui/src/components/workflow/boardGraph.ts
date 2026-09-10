import type { Edge } from "@xyflow/react";

import type { WorkflowCard, WorkflowEdge } from "../../api/workflowApi";
import type { FlowTone } from "./edges/FlowEdge";
import type { CardNode } from "./types";

/** Pure, stateless helpers that turn the backend's board payload into
 * React Flow nodes/edges (and derive the non-interactive materialization
 * connectors + per-edge flow counts/tones from it). Kept out of
 * WorkflowBoardPage so that page holds only interaction/state logic and
 * these transformations stay unit-testable in isolation. */

export function cardToNode(card: WorkflowCard): CardNode {
  return {
    id: card.id,
    type: card.type,
    position: { x: card.position_x, y: card.position_y },
    width: card.width ?? undefined,
    height: card.height ?? undefined,
    data: { card },
  };
}

export function edgeToRFEdge(edge: WorkflowEdge): Edge {
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
export function materializationEdges(cards: WorkflowCard[]): Edge[] {
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
export function buildFlowToneMap(cards: WorkflowCard[]): Record<string, FlowTone> {
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

export function cardOutputCount(card: WorkflowCard | undefined, handle: string | null): number {
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
export function annotateFlowEdges(edges: Edge[], cards: WorkflowCard[]): Edge[] {
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
