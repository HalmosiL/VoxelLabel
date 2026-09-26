import { describe, expect, it } from "vitest";

import { deletedSince, diffByObject, roundChangeText } from "./roundDiff";

describe("roundDiff", () => {
  it("counts what each object gained and lost", () => {
    const prev = new Uint8Array([1, 1, 1, 0, 2, 2, 0, 0]);
    const now = new Uint8Array([1, 1, 0, 1, 2, 2, 3, 3]);
    const d = diffByObject(prev, now);
    expect(d.get(1)).toEqual({ before: 3, after: 3, added: 1, removed: 1 });
    expect(d.get(2)).toEqual({ before: 2, after: 2, added: 0, removed: 0 });
    expect(d.get(3)).toEqual({ before: 0, after: 2, added: 2, removed: 0 });
  });
  it("says it in a line", () => {
    expect(roundChangeText({ before: 2, after: 2, added: 0, removed: 0 }, true)).toBe("Unchanged since the last round");
    expect(roundChangeText(undefined, true)).toBe("Unchanged since the last round"); // nothing painted, then or now
    expect(roundChangeText({ before: 0, after: 2, added: 2, removed: 0 }, false)).toBe("New since the last round");
    expect(roundChangeText({ before: 0, after: 2, added: 2, removed: 0 }, true)).toBe("Changed since the last round: +2 / −0 voxels (0 → 2)");
    expect(roundChangeText({ before: 3, after: 3, added: 1, removed: 1 }, true)).toBe("Changed since the last round: +1 / −1 voxels (3 → 3)");
  });
  it("names what was deleted", () => {
    const o = (id: number, n: number) => ({ id, label_id: 1, instance_number: n, locked: false, hidden: false });
    expect(deletedSince([o(1, 1), o(2, 2)], [o(1, 1)], [{ id: 1, name: "Nodule", color: "#f00" }])).toEqual(["Nodule 2"]);
  });
});
