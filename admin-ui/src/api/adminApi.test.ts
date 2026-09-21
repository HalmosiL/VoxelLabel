import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { previousRange } from "./adminApi";

describe("previousRange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("shifts a day-count preset back by its own length, ending where the current one starts", () => {
    // { days: 30 } means "the 30 days up to now" -- the period right
    // before that runs from 60 days ago to 30 days ago.
    const prev = previousRange({ days: 30 });
    expect("from" in prev && prev.from).toBe(new Date("2026-07-23T12:00:00.000Z").toISOString());
    expect("from" in prev && prev.to).toBe(new Date("2026-08-22T12:00:00.000Z").toISOString());
  });

  it("shifts a custom from/to window back by its own duration", () => {
    const prev = previousRange({ from: "2026-09-20T10:00", to: "2026-09-20T14:00" });
    expect("from" in prev && prev.from).toBe(new Date("2026-09-20T06:00:00.000Z").toISOString());
    expect("from" in prev && prev.to).toBe(new Date("2026-09-20T10:00:00.000Z").toISOString());
  });

  it("treats a missing `to` as now for the duration, but still ends at `from`", () => {
    // 6 hours before "now" (system time above) to now -> 6h duration
    const prev = previousRange({ from: "2026-09-21T06:00" });
    expect("from" in prev && prev.to).toBe(new Date("2026-09-21T06:00:00.000Z").toISOString());
    expect("from" in prev && prev.from).toBe(new Date("2026-09-21T00:00:00.000Z").toISOString());
  });
});
