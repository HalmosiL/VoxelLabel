import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import GuideTour, { GuideStep } from "./GuideTour";

const steps: GuideStep[] = [
  { title: "Intro", body: "hello" },
  { target: "present", title: "Present step", body: "x" },
  { target: "missing", title: "Missing step", body: "y" },
  { title: "Outro", body: "bye" },
];

describe("GuideTour", () => {
  it("skips steps whose target is not on the page and finishes", () => {
    const onClose = vi.fn();
    render(
      <>
        <div data-guide="present">anchor</div>
        <GuideTour steps={steps} open onClose={onClose} />
      </>
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/Intro/);
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument(); // "missing" dropped
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/Present step/);
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/Outro/);
    fireEvent.click(screen.getByText("Finish"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed and closes on Escape", () => {
    const onClose = vi.fn();
    const { rerender } = render(<GuideTour steps={steps} open={false} onClose={onClose} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<GuideTour steps={steps} open onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
