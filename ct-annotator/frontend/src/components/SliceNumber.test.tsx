import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SliceNumber from "./SliceNumber";

describe("SliceNumber (G-15)", () => {
  it("numbers slices from 1, in the viewer and the tutorial alike", () => {
    expect(render(<SliceNumber index={0} />).container.textContent).toBe("1");
    expect(render(<SliceNumber index={41} />).container.textContent).toBe("42");
  });
});
