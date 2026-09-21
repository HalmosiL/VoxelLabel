import { ReactNode } from "react";

import EmptyState from "../../components/EmptyState";
import { CsvColumn, downloadText, toCsv } from "./export";

// One accent for every mark on this page -- there is never more than one
// series per chart, so identity is carried by the row label, not a hue.
export const ACCENT = "#2563eb";

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Which direction is an improvement, for coloring a tile's delta chip
 * -- "up" and "down" get green/red, "neutral" tiles (sessions, avg
 * session length: neither direction is obviously good or bad on its
 * own) just show the number with no judgement. */
export type Better = "up" | "down" | "neutral";

export function DeltaChip({ current, previous, better }: { current: number | null; previous: number | null; better: Better }) {
  if (current === null || previous === null || previous === 0) return null;
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.01) return <span className="text-xs text-gray-400">≈ same as last period</span>;
  const rising = change > 0;
  const good = better === "neutral" ? null : (better === "up") === rising;
  const color = good === null ? "text-gray-500" : good ? "text-green-700" : "text-red-700";
  return (
    <span className={`text-xs tabular-nums ${color}`}>
      {rising ? "▲" : "▼"} {Math.round(Math.abs(change) * 100)}% vs last period
    </span>
  );
}

export function BarList({ rows, max, testId }: { rows: { key: string; label: string; value: number; display: string; note?: string }[]; max: number; testId: string }) {
  if (rows.length === 0) return <EmptyState message="Nothing recorded in this range yet." />;
  return (
    <ul className="space-y-2" data-testid={testId}>
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm" title={`${r.label}: ${r.display}${r.note ? ` · ${r.note}` : ""}`}>
          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-mono text-xs text-gray-700">{r.label}</span>
              {r.note && <span className="shrink-0 text-xs text-gray-400">{r.note}</span>}
            </div>
            <div className="mt-1 h-2 w-full rounded-sm bg-gray-100">
              <div className="h-2 rounded-sm" style={{ width: `${max ? Math.max((r.value / max) * 100, 1) : 0}%`, background: ACCENT }} />
            </div>
          </div>
          <span className="w-16 text-right tabular-nums text-gray-900">{r.display}</span>
        </li>
      ))}
    </ul>
  );
}

/** "Download CSV" for any table already on screen -- the rows come from
 * page state, so no server round trip. See export.ts. */
export function DownloadCsvButton<T>({ filename, rows, columns, testId, label = "CSV" }: { filename: string; rows: T[]; columns: CsvColumn<T>[]; testId?: string; label?: string }) {
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      disabled={rows.length === 0}
      onClick={() => downloadText(filename, toCsv(rows, columns), "text/csv;charset=utf-8")}
      title={rows.length === 0 ? "Nothing to export" : `Download ${rows.length} rows as CSV`}
      data-testid={testId}
    >
      ↓ {label}
    </button>
  );
}

/** A card header with the title on the left and actions (usually a
 * download button) on the right. */
export function CardHeader({ title, hint, actions }: { title: string; hint?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 className="section-title mb-0">{title}</h2>
        {hint && <p className="hint">{hint}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
