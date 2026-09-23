/** Client-side export helpers for the Usage page: CSV for any table
 * already on screen, JSON bundles, and the download idiom this app
 * already uses (PytorchExportModal, ConsortExportPage): a Blob, an
 * object URL, a temporary <a download>. */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

/** RFC 4180: every cell quoted when it holds a comma, quote, CR or LF;
 * quotes doubled. Objects/arrays become JSON, null/undefined empty,
 * dates ISO. */
export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  // A text cell a spreadsheet would run as a formula gets a leading
  // apostrophe (shown as text). Numbers -- negative ones included -- stay as they are.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Header row + one row per item, CRLF line ends, with a UTF-8 BOM so
 * Excel opens accented usernames correctly instead of guessing the
 * encoding. */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function downloadText(filename: string, text: string, mime = "text/plain;charset=utf-8"): void {
  const blob = new Blob([text], { type: mime });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename: string, data: unknown): void {
  downloadText(filename, JSON.stringify(data, null, 2), "application/json;charset=utf-8");
}

/** `usage-<dataset>-<from>-<to>.<ext>` with the dates as YYYYMMDD --
 * sorts correctly in a folder and says what it is. */
export function exportFilename(dataset: string, since: string | null | undefined, until: string | null | undefined, ext: string): string {
  const stamp = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).replace(/-/g, "") : "now");
  return `usage-${dataset}-${stamp(since)}-${stamp(until)}.${ext}`;
}
