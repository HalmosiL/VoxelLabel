import { useState } from "react";

import {
  downloadUsageEventsCsv,
  getUsageReportMarkdown,
  LearningCurvePoint,
  PipelineHealthSummary,
  UsageFinding,
  UsageFindings,
  UsageRange,
  UsageSummary,
  UsageTab,
} from "../../api/adminApi";
import { describeApiError } from "../../api/client";
import EmptyState from "../../components/EmptyState";
import { downloadJson, downloadText, exportFilename } from "./export";
import { Better, CardHeader, DeltaChip, DownloadCsvButton, formatDuration } from "./shared";

const SEVERITY: Record<UsageFinding["severity"], { chip: string; label: string; row: string }> = {
  critical: { chip: "badge-red", label: "Act now", row: "border-red-200 bg-red-50/60" },
  warn: { chip: "badge bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200", label: "Look into", row: "border-amber-200 bg-amber-50/50" },
  info: { chip: "badge-blue", label: "Note", row: "border-gray-200" },
  good: { chip: "badge-green", label: "Good", row: "border-emerald-200 bg-emerald-50/40" },
};

const TAB_LABEL: Record<UsageTab, string> = { overview: "Overview", behaviour: "Behaviour", friction: "Friction", people: "People", settings: "Settings" };

export default function OverviewTab({
  summary,
  previous,
  findings,
  pipelineHealth,
  pipelineHealthPrevious,
  learningCurve,
  range,
  userFilter,
  onGoTo,
  onError,
}: {
  summary: UsageSummary;
  previous: UsageSummary | null;
  findings: UsageFindings | null;
  pipelineHealth: PipelineHealthSummary | null;
  pipelineHealthPrevious: PipelineHealthSummary | null;
  learningCurve: LearningCurvePoint[] | null;
  range: UsageRange;
  userFilter: string;
  onGoTo: (tab: UsageTab) => void;
  onError: (message: string) => void;
}) {
  return (
    <div className="space-y-5">
      <FindingsCard findings={findings} onGoTo={onGoTo} />
      <StatTiles summary={summary} previous={previous} />
      {pipelineHealth && <CycleTimeCard summary={pipelineHealth} previous={pipelineHealthPrevious} />}
      <ExportCard summary={summary} previous={previous} findings={findings} pipelineHealth={pipelineHealth} pipelineHealthPrevious={pipelineHealthPrevious} learningCurve={learningCurve} range={range} userFilter={userFilter} onError={onError} />
      <HowToRead />
    </div>
  );
}

// ---------------------------------------------------------------- findings

function FindingsCard({ findings, onGoTo }: { findings: UsageFindings | null; onGoTo: (tab: UsageTab) => void }) {
  return (
    <div className="card" data-guide="usage-findings" data-testid="usage-findings">
      <CardHeader
        title="What stands out"
        hint="The page's own first pass at the numbers -- each line says what happened, how much, and where to look. Rules and thresholds are fixed, so the same data always gives the same findings."
      />
      {findings === null ? (
        <p className="hint">Working it out…</p>
      ) : findings.findings.length === 0 ? (
        <EmptyState message="Nothing to report." />
      ) : (
        <ul className="space-y-2">
          {findings.findings.map((f) => (
            <li key={f.id} className={`rounded-lg border px-3 py-2 ${SEVERITY[f.severity].row}`} data-testid="usage-finding" data-severity={f.severity}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`${SEVERITY[f.severity].chip} shrink-0`}>{SEVERITY[f.severity].label}</span>
                    <span className="font-medium text-gray-900">{f.title}</span>
                  </div>
                  <p className="mt-0.5 text-sm text-gray-600">{f.detail}</p>
                </div>
                {f.tab !== "overview" && (
                  <button type="button" className="btn btn-secondary btn-sm shrink-0" onClick={() => onGoTo(f.tab)} data-testid="usage-finding-goto">
                    {TAB_LABEL[f.tab]} →
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- tiles

function StatTiles({ summary, previous }: { summary: UsageSummary; previous: UsageSummary | null }) {
  const t = summary.totals;
  const p = previous?.totals;
  const pt = previous?.tasks;
  const tiles: { label: string; value: string; sub?: string; title: string; current: number | null; previous: number | null; better: Better }[] = [
    { label: "Active people", value: String(t.active_users), title: "People with at least one recorded session in this period. More is better.", current: t.active_users, previous: p?.active_users ?? null, better: "up" },
    { label: "Sessions", value: String(t.sessions), title: "Sittings -- one per browser tab per visit. Neither direction is good or bad on its own.", current: t.sessions, previous: p?.sessions ?? null, better: "neutral" },
    { label: "Avg session", value: formatDuration(t.avg_session_ms), title: "Average length of a sitting. Longer can mean more work done or more struggling -- read it with the friction score.", current: t.avg_session_ms, previous: p?.avg_session_ms ?? null, better: "neutral" },
    {
      label: "Median time to annotate",
      value: formatDuration(summary.tasks.annotate.median_ms),
      sub: `${summary.tasks.annotate.count} cases`,
      title: "From opening a case in the viewer to Mark as Annotated, in one sitting. Lower is better.",
      current: summary.tasks.annotate.median_ms,
      previous: pt?.annotate.median_ms ?? null,
      better: "down",
    },
    {
      label: "Median time to review",
      value: formatDuration(summary.tasks.review.median_ms),
      sub: `${summary.tasks.review.count} cases`,
      title: "From opening a case in the viewer to Submit review, in one sitting. Lower is better.",
      current: summary.tasks.review.median_ms,
      previous: pt?.review.median_ms ?? null,
      better: "down",
    },
    { label: "Errors", value: String(t.errors), title: "JavaScript errors people hit. Zero is the goal.", current: t.errors, previous: p?.errors ?? null, better: "down" },
    {
      label: "Friction score",
      value: summary.friction_score === null ? "–" : String(summary.friction_score),
      sub: "0 = smooth, 100 = everyone struggling",
      title: "View-weighted average of every screen's friction score (bounces, back-and-forth, dead clicks, rage clicks). Lower is better.",
      current: summary.friction_score,
      previous: previous?.friction_score ?? null,
      better: "down",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7" data-guide="usage-tiles" data-testid="usage-tiles">
      {tiles.map((tile) => (
        <div key={tile.label} className="stat-card" title={tile.title}>
          <div className="min-w-0">
            <div className="stat-value tabular-nums">{tile.value}</div>
            <div className="stat-label">{tile.label}</div>
            {tile.sub && <div className="text-xs text-gray-400">{tile.sub}</div>}
            <div className="mt-1" data-testid={`usage-tile-delta-${tile.label.toLowerCase().replace(/\s+/g, "-")}`}>
              <DeltaChip current={tile.current} previous={tile.previous} better={tile.better} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- cycle time

const LEG_LABELS: Record<string, string> = {
  annotation_queue: "Waiting to be annotated",
  annotation_work: "Being annotated",
  review_queue: "Waiting to be reviewed",
  review_work: "Being reviewed",
};
// Same hue family throughout, light -> dark by pipeline order -- these
// four segments are always the same four, in the same order, so the
// direct labels under the bar carry it.
const LEG_COLORS: Record<string, string> = {
  annotation_queue: "#bfdbfe",
  annotation_work: "#3b82f6",
  review_queue: "#fde68a",
  review_work: "#f59e0b",
};

function CycleTimeCard({ summary, previous }: { summary: PipelineHealthSummary; previous: PipelineHealthSummary | null }) {
  const legs = [
    { key: "annotation_queue", ...summary.legs.annotation?.queue },
    { key: "annotation_work", ...summary.legs.annotation?.work },
    { key: "review_queue", ...summary.legs.review?.queue },
    { key: "review_work", ...summary.legs.review?.work },
  ];
  const previousByKey: Record<string, number | null> = {
    annotation_queue: previous?.legs.annotation?.queue.median_ms ?? null,
    annotation_work: previous?.legs.annotation?.work.median_ms ?? null,
    review_queue: previous?.legs.review?.queue.median_ms ?? null,
    review_work: previous?.legs.review?.work.median_ms ?? null,
  };
  const total = legs.reduce((sum, leg) => sum + (leg.median_ms ?? 0), 0);
  const csvRows = legs.map((leg) => ({ leg: LEG_LABELS[leg.key], median_ms: leg.median_ms ?? null, mean_ms: leg.mean_ms ?? null, cases: leg.count ?? 0, previous_median_ms: previousByKey[leg.key] }));

  return (
    <div className="card" data-guide="usage-cycle-time" data-testid="usage-cycle-time">
      <CardHeader
        title="Cycle time"
        hint="How long a case actually takes to move through the pipeline, split into waiting for someone vs. someone actively working it. Lower is better everywhere here."
        actions={
          <DownloadCsvButton
            filename={exportFilename("cycle-time", summary.since, summary.until, "csv")}
            rows={csvRows}
            columns={[
              { header: "Leg", value: (r) => r.leg },
              { header: "Median (ms)", value: (r) => r.median_ms },
              { header: "Mean (ms)", value: (r) => r.mean_ms },
              { header: "Cases", value: (r) => r.cases },
              { header: "Previous period median (ms)", value: (r) => r.previous_median_ms },
            ]}
            testId="usage-export-cycle-time"
          />
        }
      />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5" data-testid="usage-cycle-tiles">
        {legs.map((leg) => (
          <div key={leg.key} className="stat-card">
            <div className="min-w-0">
              <div className="stat-value tabular-nums">{formatDuration(leg.median_ms ?? null)}</div>
              <div className="stat-label">{LEG_LABELS[leg.key]}</div>
              <div className="text-xs text-gray-400">{leg.count ?? 0} cases</div>
              <div className="mt-1">
                <DeltaChip current={leg.median_ms ?? null} previous={previousByKey[leg.key]} better="down" />
              </div>
            </div>
          </div>
        ))}
        <div className="stat-card border-l-2 border-gray-200 pl-3">
          <div>
            <div className="stat-value tabular-nums">{formatDuration(total || null)}</div>
            <div className="stat-label">Total (sum of medians)</div>
          </div>
        </div>
      </div>
      {total > 0 && (
        <div className="mt-4">
          <div className="flex h-6 w-full overflow-hidden rounded-sm" data-testid="usage-cycle-bar">
            {legs
              .filter((leg) => (leg.median_ms ?? 0) > 0)
              .map((leg) => (
                <div key={leg.key} style={{ width: `${((leg.median_ms ?? 0) / total) * 100}%`, background: LEG_COLORS[leg.key] }} title={`${LEG_LABELS[leg.key]}: ${formatDuration(leg.median_ms ?? null)}`} />
              ))}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            {legs
              .filter((leg) => (leg.median_ms ?? 0) > 0)
              .map((leg) => (
                <span key={leg.key} className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ background: LEG_COLORS[leg.key] }} />
                  {LEG_LABELS[leg.key]}
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- export

function ExportCard({
  summary,
  previous,
  findings,
  pipelineHealth,
  pipelineHealthPrevious,
  learningCurve,
  range,
  userFilter,
  onError,
}: {
  summary: UsageSummary;
  previous: UsageSummary | null;
  findings: UsageFindings | null;
  pipelineHealth: PipelineHealthSummary | null;
  pipelineHealthPrevious: PipelineHealthSummary | null;
  learningCurve: LearningCurvePoint[] | null;
  range: UsageRange;
  userFilter: string;
  onError: (message: string) => void;
}) {
  const [includeMouse, setIncludeMouse] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(what: string, work: () => Promise<string>) {
    setBusy(what);
    setDone(null);
    try {
      setDone(await work());
    } catch (err) {
      onError(describeApiError(err));
    } finally {
      setBusy(null);
    }
  }

  const events = () =>
    run("events", async () => {
      const name = await downloadUsageEventsCsv(range, userFilter || null, includeMouse);
      return `Downloaded ${name}`;
    });
  const copyReport = () =>
    run("copy", async () => {
      const text = await getUsageReportMarkdown(range, userFilter || null);
      await navigator.clipboard.writeText(text);
      return "Summary copied -- paste it into Jira, Slack or an e-mail.";
    });
  const downloadReport = () =>
    run("report", async () => {
      const text = await getUsageReportMarkdown(range, userFilter || null);
      const name = exportFilename("report", summary.since, summary.until, "md");
      downloadText(name, text, "text/markdown;charset=utf-8");
      return `Downloaded ${name}`;
    });
  const bundle = () =>
    run("bundle", async () => {
      const name = exportFilename("bundle", summary.since, summary.until, "json");
      downloadJson(name, { range, user_filter: userFilter || null, exported_at: new Date().toISOString(), summary, previous, findings, pipeline_health: pipelineHealth, pipeline_health_previous: pipelineHealthPrevious, learning_curve: learningCurve });
      return `Downloaded ${name}`;
    });

  return (
    <div className="card" data-guide="usage-export" data-testid="usage-export">
      <CardHeader title="Export" hint="Take the data out of the browser -- for the monthly review, a spreadsheet, or your own analysis. Every table on the other tabs also has its own CSV button." />
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-gray-200 p-3">
          <h3 className="text-sm font-semibold text-gray-800">Summary report</h3>
          <p className="mb-2 text-xs text-gray-500">The findings and headline numbers above as Markdown -- for Jira, Slack or e-mail.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={copyReport} data-testid="usage-export-copy-report">
              {busy === "copy" ? "Copying…" : "Copy summary"}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={downloadReport} data-testid="usage-export-report">
              ↓ .md
            </button>
          </div>
        </div>
        <div className="rounded-lg border border-gray-200 p-3">
          <h3 className="text-sm font-semibold text-gray-800">Raw events</h3>
          <p className="mb-2 text-xs text-gray-500">Every recorded event in this period, one row each, as CSV -- for Python, R or a BI tool.</p>
          <label className="mb-2 flex items-center gap-2 text-xs text-gray-600">
            <input type="checkbox" checked={includeMouse} onChange={(e) => setIncludeMouse(e.target.checked)} data-testid="usage-export-include-mouse" />
            include mouse traces (much bigger)
          </label>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={events} data-testid="usage-export-events">
            {busy === "events" ? "Preparing…" : "↓ events.csv"}
          </button>
        </div>
        <div className="rounded-lg border border-gray-200 p-3">
          <h3 className="text-sm font-semibold text-gray-800">Everything</h3>
          <p className="mb-2 text-xs text-gray-500">All of this page's data for the period as one JSON file -- to archive or process elsewhere.</p>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={bundle} data-testid="usage-export-bundle">
            ↓ bundle.json
          </button>
        </div>
      </div>
      {done && (
        <p className="mt-3 text-sm text-green-700" data-testid="usage-export-done">
          {done}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- how to read

function HowToRead() {
  return (
    <details className="card" data-testid="usage-how-to-read">
      <summary className="cursor-pointer text-sm font-semibold text-gray-800">How to read this page</summary>
      <div className="mt-2 space-y-2 text-sm text-gray-600">
        <p>
          <strong>What is measured:</strong> which screens people open and for how long, the tools and buttons they use, where they click, how the pointer moves, keyboard shortcuts, and how long a case takes at each pipeline step. Recorded for everyone with recording on
          (Settings).
        </p>
        <p>
          <strong>What is never recorded:</strong> patient data, DICOM contents, anything typed into a field. Events carry internal ids and short control names only.
        </p>
        <p>
          <strong>How findings are decided:</strong> fixed rules -- e.g. a screen counts as "bounced" when someone leaves within 3 seconds and goes elsewhere; a case is "stuck" when it has waited more than twice that job's usual wait (or a week, with no history yet). The same
          data always yields the same findings; nothing here is a guess.
        </p>
      </div>
    </details>
  );
}
