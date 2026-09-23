import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import RatingPrompt, { askRatingIfDue } from "./RatingPrompt";
import { _reset, init, pendingEvents, setConfig, UsageConfig } from "./tracker";

const ON: UsageConfig = {
  enabled: true,
  track_pages: true,
  track_actions: true,
  track_clicks: true,
  track_mouse: true,
  track_scroll: true,
  track_keys: true,
  track_errors: true,
  mouse_sample_ms: 100,
  rating_every_n: 2,
};

beforeEach(() => {
  sessionStorage.clear();
  init({ app: "viewer", configUrl: "c", eventsUrl: "e", getToken: () => undefined, fetchImpl: (() => new Promise(() => undefined)) as typeof fetch });
  setConfig(ON);
});
afterEach(() => {
  cleanup();
  _reset();
});

describe("RatingPrompt", () => {
  it("asks on every n-th finished case and records the answer with the case it was about", () => {
    render(<RatingPrompt />);
    act(() => askRatingIfDue({ case_id: "c1", job_id: "j1", task: "annotate" }));
    expect(screen.queryByTestId("rating-prompt")).toBeNull(); // 1st finished case: not due
    act(() => askRatingIfDue({ case_id: "c2", job_id: "j1", task: "annotate" }));
    expect(screen.getByTestId("rating-prompt")).toBeTruthy();
    fireEvent.click(screen.getByTestId("rating-4"));
    expect(screen.queryByTestId("rating-prompt")).toBeNull();
    const rating = pendingEvents().find((e) => e.name === "case.rating");
    expect(rating?.detail).toEqual({ case_id: "c2", job_id: "j1", task: "annotate", rating: 4 });
  });

  it("never asks while ratings are off", () => {
    setConfig({ ...ON, rating_every_n: 0 });
    render(<RatingPrompt />);
    act(() => {
      askRatingIfDue({ case_id: "c1", job_id: null, task: "review" });
      askRatingIfDue({ case_id: "c2", job_id: null, task: "review" });
    });
    expect(screen.queryByTestId("rating-prompt")).toBeNull();
  });
});
