import { describe, expect, it } from "vitest";

import { alreadyImportedMessage } from "./ingestionApi";

describe("alreadyImportedMessage", () => {
  it("says the file is in another study, not in this case (B-21)", () => {
    expect(alreadyImportedMessage("ll1.dcm", "another_study")).toMatch(/another study, so it wasn't added/);
  });
  it("tells this case from another case of the study", () => {
    expect(alreadyImportedMessage("a.dcm", "this_case")).toBe("a.dcm was already in this case (skipped).");
    expect(alreadyImportedMessage("a.dcm", "this_study")).toMatch(/another case of this study/);
  });
});
