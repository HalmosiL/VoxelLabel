import { describe, expect, it, vi } from "vitest";

import { announceUndone, clearUndo, currentUndo, offerUndo, onUndone, subscribeUndo, UNDO_OFFER_MS } from "./undoStore";

const step = { annotationId: "a1", message: "Case 1 handed in", undoneMessage: "a draft again", backTo: "/viewer/series/s1" };

describe("undoStore", () => {
  it("offers the step for a while, then not any more", () => {
    offerUndo(step, 1000);
    expect(currentUndo(1000 + UNDO_OFFER_MS - 1)?.annotationId).toBe("a1");
    expect(currentUndo(1000 + UNDO_OFFER_MS)).toBeNull();
  });

  it("a new step replaces the old one, and listeners hear of both", () => {
    const heard = vi.fn();
    const stop = subscribeUndo(heard);
    offerUndo(step);
    offerUndo({ ...step, annotationId: "a2" });
    expect(currentUndo()?.annotationId).toBe("a2");
    clearUndo();
    expect(currentUndo()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(3);
    stop();
  });

  it("tells who asked that a step was taken back", () => {
    const heard = vi.fn();
    const stop = onUndone(heard);
    announceUndone("a1");
    stop();
    announceUndone("a2");
    expect(heard.mock.calls).toEqual([["a1"]]);
  });
});
