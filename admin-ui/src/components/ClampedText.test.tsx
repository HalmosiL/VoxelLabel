import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ClampedText from "./ClampedText";

describe("ClampedText (F-16)", () => {
  it("shows a long reviewer comment shortened, and all of it on request", () => {
    const long = "look again at the apex ".repeat(300); // ~6 900 characters
    const { container } = render(<ClampedText text={long} />);
    expect(container.textContent!.length).toBeLessThan(400);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(container.textContent).toContain(long.trim());
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(container.textContent!.length).toBeLessThan(400);
  });

  it("leaves a short comment as it is", () => {
    render(<ClampedText text="Too wide." />);
    expect(screen.getByText("Too wide.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
