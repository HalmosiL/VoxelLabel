import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import GuideTour, { GuideStep, guideImageSrc, placeCard } from "./GuideTour";

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

  it("keeps a tall card with a picture whole on a tablet screen (G-21)", () => {
    // the "Open in Viewer" step: target low on a 1024x768 screen, card ~444 px tall
    const target = { left: 600, top: 600, right: 760, bottom: 640, width: 160, height: 40 } as DOMRect;
    const vp = { w: 1024, h: 768 };
    const { top } = placeCard(target, "bottom", vp, 444);
    expect(top + 444).toBeLessThanOrEqual(vp.h - 8);
    expect(top).toBeGreaterThanOrEqual(8);
  });

  it("loads tour pictures under the app's base path (G-13)", () => {
    vi.stubEnv("BASE_URL", "/admin/");
    expect(guideImageSrc("workbench-jobs.png")).toBe("/admin/guide/workbench-jobs.png");
    vi.unstubAllEnvs();
    expect(guideImageSrc("workbench-jobs.png")).toBe("/guide/workbench-jobs.png");
  });
});
