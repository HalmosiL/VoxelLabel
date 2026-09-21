import { describe, expect, it } from "vitest";

import { csvCell, exportFilename, toCsv } from "./export";

describe("csvCell", () => {
  it("leaves plain values alone and quotes the ones CSV needs quoted", () => {
    expect(csvCell("dr-test")).toBe("dr-test");
    expect(csvCell(12)).toBe("12");
    expect(csvCell(true)).toBe("true");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("serialises empties, dates and objects predictably", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(new Date("2026-09-21T10:00:00.000Z"))).toBe("2026-09-21T10:00:00.000Z");
    expect(csvCell({ x: 1, target: "btn" })).toBe('"{""x"":1,""target"":""btn""}"');
    expect(csvCell([1, 2])).toBe('"[1,2]"');
  });
});

describe("toCsv", () => {
  it("writes a BOM, a header row and CRLF-terminated rows", () => {
    const rows = [
      { name: "dr-test", total_ms: 61_000, note: "fast, careful" },
      { name: "dr-review", total_ms: 0, note: null },
    ];
    const csv = toCsv(rows, [
      { header: "Person", value: (r) => r.name },
      { header: "Total (ms)", value: (r) => r.total_ms },
      { header: "Note", value: (r) => r.note },
    ]);
    expect(csv).toBe("﻿Person,Total (ms),Note\r\n" + 'dr-test,61000,"fast, careful"\r\n' + "dr-review,0,\r\n");
  });

  it("handles an empty table as just the header", () => {
    expect(toCsv([], [{ header: "A", value: () => 1 }])).toBe("﻿A\r\n");
  });
});

describe("exportFilename", () => {
  it("stamps the window as YYYYMMDD and falls back to 'now'", () => {
    expect(exportFilename("people", "2026-09-01T00:00:00+00:00", "2026-09-21T12:00:00+00:00", "csv")).toBe("usage-people-20260901-20260921.csv");
    expect(exportFilename("bundle", "2026-09-01", null, "json")).toBe("usage-bundle-20260901-now.json");
  });
});
