import { describe, expect, it } from "vitest";

import type { WorkflowCard } from "../../api/workflowApi";
import { templateFromBoard } from "./pipelineTemplates";

function card(id: string, type: WorkflowCard["type"], extra: Partial<WorkflowCard> = {}): WorkflowCard {
  return {
    id, type, title: id, position_x: 0, position_y: 0, width: 200, height: 90, config: {}, output_case_ids: null, output_count: null,
    last_run_at: null, stale: false, ...extra,
  } as WorkflowCard;
}
const node = (c: WorkflowCard, x = 0, y = 0) => ({ id: c.id, x, y, width: 200, height: 90, card: c });

describe("templateFromBoard (K5)", () => {
  it("leaves out the cards a Split or Review makes itself and keeps their connections as feedback", () => {
    // the two-lane pilot: Split -> Lane A/B (made by the Split) -> Annotation X/Y;
    // Review R's rejected branch (made by R) back into X
    const S = card("S", "split", { materialized_card_ids: { part_0: "A", part_1: "B" } });
    const A = card("A", "dataset", { materialized_from: { card_id: "S", title: "S" } });
    const B = card("B", "dataset", { materialized_from: { card_id: "S", title: "S" } });
    const X = card("X", "annotation", { config: { assigned_user_id: "someone", labels: ["Nodule"] } });
    const Y = card("Y", "annotation");
    const R = card("R", "review", { materialized_card_ids: { approved: "AP", rejected: "RJ" } });
    const RJ = card("RJ", "dataset", { materialized_from: { card_id: "R", title: "R" } });
    const selected = [node(S, 100, 100), node(A), node(B), node(X, 400, 100), node(Y, 400, 300), node(R, 700, 100), node(RJ)];
    const edges = [
      { source: "A", target: "X", sourceHandle: "output", targetHandle: "input" },
      { source: "B", target: "Y", sourceHandle: "output", targetHandle: "input" },
      { source: "X", target: "R", sourceHandle: "output", targetHandle: "input" },
      { source: "RJ", target: "X", sourceHandle: "output", targetHandle: "input" },
    ];
    const t = templateFromBoard("Two lanes", "", selected, edges);
    expect(t.cards.map((c) => c.key)).toEqual(["S", "X", "Y", "R"]);
    expect(t.cards[0]).toMatchObject({ x: 0, y: 0 });
    expect(t.edges).toEqual([{ sourceKey: "X", sourceHandle: "output", targetKey: "R", targetHandle: "input" }]);
    expect(t.feedback).toEqual([
      { sourceKey: "S", sourceHandle: "part_0", targetKey: "X", targetHandle: "input" },
      { sourceKey: "S", sourceHandle: "part_1", targetKey: "Y", targetHandle: "input" },
      { sourceKey: "R", sourceHandle: "rejected", targetKey: "X", targetHandle: "input" },
    ]);
  });

  it("keeps a made card whose maker isn't in the selection, as a plain card", () => {
    const A = card("A", "dataset", { materialized_from: { card_id: "S", title: "S" } });
    const X = card("X", "annotation");
    const t = templateFromBoard("t", "", [node(A), node(X, 300, 0)], [{ source: "A", target: "X", sourceHandle: "output", targetHandle: "input" }]);
    expect(t.cards.map((c) => c.key)).toEqual(["A", "X"]);
    expect(t.edges).toHaveLength(1);
    expect(t.feedback).toEqual([]);
  });
});
