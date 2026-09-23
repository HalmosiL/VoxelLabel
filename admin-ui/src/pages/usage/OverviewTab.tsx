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
import { BarList, Better, CardHeader, DeltaChip, DownloadCsvButton, formatDuration, formatShortWhen } from "./shared";

const SEVERITY: Record<UsageFinding["severity"], { chip: string; label: string; row: string }> = {
  critical: { chip: "badge-red", label: "Act now", row: "border-red-200 bg-red-50/60" },
  warn: { chip: "badge bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200", label: "Look into", row: "border-amber-200 bg-amber-50/50" },
  info: { chip: "badge-blue", label: "Note", row: "border-gray-200" },
  good: { chip: "badge-green", label: "Good", row: "border-emerald-200 bg-emerald-50/40" },
};

const TAB_LABEL: Record<UsageTab, string> = { overview: "Overview", behaviour: "Behaviour", friction: "Friction", cases: "Cases", people: "People", settings: "Settings" };

export default function OverviewTab({
  summary,
  previous,
  findings,
  pipelineHealth,
  pipelineHealthPrevious,
  learningCurve,
  range,
  userFilter,
  personName,
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
  personName: string | null;
  onGoTo: (tab: UsageTab) => void;
  onError: (message: string) => void;
}) {
  return (
    <div className="space-y-5">
      <FindingsCard findings={findings} onGoTo={onGoTo} />
      <StatTiles summary={summary} previous={previous} pipeline={pipelineHealth} pipelinePrevious={pipelineHealthPrevious} />
      {pipelineHealth && <CycleTimeCard summary={pipelineHealth} previous={pipelineHealthPrevious} personName={personName} />}
      <div className="grid items-start gap-6 2xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ReleasesCard summary={summary} />
        <ReasonsCard summary={summary} />
      </div>
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

/** Below this many cases a median is a hint, not a trend -- the tile
 * says so and doesn't claim a change against last period. */
const MIN_CASES = 5;

interface Tile {
  key: string;
  label: string;
  value: string;
  sub?: string;
  title: string;
  current: number | null;
  previous: number | null;
  better: Better;
  /** Number of cases behind the figure, when it is a per-case median. */
  n?: number;
  previousN?: number;
}

function StatTiles({ summary, previous, pipeline, pipelinePrevious }: { summary: UsageSummary; previous: UsageSummary | null; pipeline: PipelineHealthSummary | null; pipelinePrevious: PipelineHealthSummary | null }) {
  const e = summary.effort;
  const pe = previous?.effort;
  const q = pipeline?.quality;
  const pq = pipelinePrevious?.quality;
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);
  const sittings = (v: number | null) => (v === null ? "" : ` · ${v} ${v === 1 ? "sitting" : "sittings"}`);
  const tiles: Tile[] = [
    {
      key: "hands-on-annotating",
      label: "Hands-on time per case · annotating",
      value: formatDuration(e.annotation.active_median_ms),
      sub: `${e.annotation.cases} cases${sittings(e.annotation.sittings_median)}`,
      title: "Median active time spent in the viewer on one case of an annotation job, summed over every sitting, idle stretches (30 s+ without input) left out. The real labour cost of a case. Lower is better.",
      current: e.annotation.active_median_ms,
      previous: pe?.annotation.active_median_ms ?? null,
      better: "down",
      n: e.annotation.cases,
      previousN: pe?.annotation.cases,
    },
    {
      key: "hands-on-reviewing",
      label: "Hands-on time per case · reviewing",
      value: formatDuration(e.review.active_median_ms),
      sub: `${e.review.cases} cases${sittings(e.review.sittings_median)}`,
      title: "The same for review jobs: median active viewer time per reviewed case. Lower is better.",
      current: e.review.active_median_ms,
      previous: pe?.review.active_median_ms ?? null,
      better: "down",
      n: e.review.cases,
      previousN: pe?.review.cases,
    },
    {
      key: "first-pass",
      label: "Passed review first time",
      value: pct(q?.first_pass_rate),
      sub: q ? `${q.decided} cases decided` : undefined,
      title: "Share of annotated cases a reviewer approved on the first submission. Every rejection sends the whole case round the pipeline again. Higher is better.",
      current: q?.first_pass_rate ?? null,
      previous: pq?.first_pass_rate ?? null,
      better: "up",
      n: q?.decided,
      previousN: pq?.decided,
    },
    {
      key: "first-action",
      label: "Wait before the first action",
      value: formatDuration(e.all.first_input_median_ms),
      sub: `${e.all.first_input_count} case openings`,
      title: "Median time from opening a case in the viewer to the first click or key: image loading plus getting oriented, paid on every single case. Lower is better.",
      current: e.all.first_input_median_ms,
      previous: pe?.all.first_input_median_ms ?? null,
      better: "down",
      n: e.all.first_input_count,
      previousN: pe?.all.first_input_count,
    },
    {
      key: "friction-score",
      label: "Friction score",
      value: summary.friction_score === null ? "–" : String(summary.friction_score),
      sub: "0 smooth · 100 everyone struggling",
      title: "Every screen's friction score (bounces, back-and-forth, clicks that got no response, rage clicks), averaged by how often each screen was opened. See the Friction tab. Lower is better.",
      current: summary.friction_score,
      previous: previous?.friction_score ?? null,
      better: "down",
    },
    {
      key: "errors",
      label: "Errors",
      value: String(summary.totals.errors),
      sub: "JavaScript errors people hit",
      title: "Every one is a moment the app broke for someone. Zero is the goal.",
      current: summary.totals.errors,
      previous: previous?.totals.errors ?? null,
      better: "down",
    },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-guide="usage-tiles" data-testid="usage-tiles">
      {tiles.map((tile) => {
        const thin = tile.n !== undefined && tile.n < MIN_CASES;
        const comparable = !thin && (tile.previousN === undefined || tile.previousN >= MIN_CASES);
        return (
          <div key={tile.key} className="stat-card" title={tile.title} data-testid={`usage-tile-${tile.key}`}>
            <div className="min-w-0">
              <div className="stat-value tabular-nums">{tile.value}</div>
              <div className="stat-label">{tile.label}</div>
              {tile.sub && <div className="text-xs text-gray-400">{tile.sub}</div>}
              <div className="mt-1 text-xs" data-testid={`usage-tile-delta-${tile.key}`}>
                {thin ? (
                  <span className="text-amber-700" title={`Fewer than ${MIN_CASES} cases -- read it as a hint, not a trend`}>
                    few cases -- a hint only
                  </span>
                ) : comparable ? (
                  <DeltaChip current={tile.current} previous={tile.previous} better={tile.better} />
                ) : null}
              </div>
              {tile.better !== "neutral" && <div className="text-[11px] text-gray-400">{tile.better === "down" ? "lower is better" : "higher is better"}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- cycle time

const LEG_LABELS: Record<string, string> = {
  annotation_queue: "Waiting for an annotator",
  annotation_work: "Annotating: opened → submitted",
  review_queue: "Waiting for a reviewer",
  review_work: "Reviewing: opened → decided",
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

function CycleTimeCard({ summary, previous, personName }: { summary: PipelineHealthSummary; previous: PipelineHealthSummary | null; personName: string | null }) {
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
        hint={
          <>
            Elapsed calendar time for a case to move through the pipeline (nights and weekends included), split into waiting for someone and someone working it -- work starts when the case is first opened in the viewer. The hands-on tiles above are the time actually spent in the viewer. Medians; lower is better.
            {personName && <strong> Only the cases {personName} was assigned or worked on.</strong>}
          </>
        }
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
      {summary.quality.decided > 0 && (
        <p className="mt-3 text-sm text-gray-600" data-testid="usage-review-quality">
          Review outcome: <strong>{Math.round((summary.quality.first_pass_rate ?? 0) * 100)}%</strong> of {summary.quality.decided} decided cases passed first time
          {summary.quality.sent_back_rate ? `, ${Math.round(summary.quality.sent_back_rate * 100)}% were sent back at least once` : ""}
          {summary.quality.rounds_to_approve ? `; approved cases took ${summary.quality.rounds_to_approve} submissions on average` : ""}.
        </p>
      )}
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

// ---------------------------------------------------------------- releases

/** Better/worse against the build before it (same app), for one measure. */
function versus(now: number | null, before: number | null | undefined, lowerIsBetter = true): string {
  if (now === null || before === null || before === undefined || before === 0) return "";
  const change = (now - before) / before;
  if (Math.abs(change) < 0.1) return "text-gray-900";
  return (change < 0) === lowerIsBetter ? "text-green-700" : "text-red-700";
}

function ReleasesCard({ summary }: { summary: UsageSummary }) {
  const rows = summary.releases;
  return (
    <div className="card" data-guide="usage-releases" data-testid="usage-releases">
      <CardHeader
        title="Release by release"
        hint="The same measures for every build of each app, oldest first -- green where a build did better than the one before it, red where worse. Builds are stamped automatically; &quot;unknown&quot; is activity from before that. Compare builds with a similar number of cases."
        actions={
          <DownloadCsvButton
            filename={exportFilename("releases", summary.since, summary.until, "csv")}
            rows={rows}
            columns={[
              { header: "App", value: (r) => r.app },
              { header: "Build", value: (r) => r.version },
              { header: "First seen", value: (r) => r.first_seen },
              { header: "Last seen", value: (r) => r.last_seen },
              { header: "People", value: (r) => r.people },
              { header: "Sessions", value: (r) => r.sessions },
              { header: "Cases", value: (r) => r.cases },
              { header: "Hands-on per case (ms)", value: (r) => r.active_median_ms },
              { header: "Wait before first action (ms)", value: (r) => r.first_input_median_ms },
              { header: "No-response rate", value: (r) => r.no_response_rate },
              { header: "Friction score", value: (r) => r.friction_score },
              { header: "Errors", value: (r) => r.errors },
            ]}
            testId="usage-export-releases"
          />
        }
      />
      {rows.length === 0 ? (
        <EmptyState message="Nothing recorded in this period." />
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>App · build</th>
                <th>First seen</th>
                <th className="text-right">Cases</th>
                <th className="text-right" title="Median hands-on time per case">
                  Hands-on
                </th>
                <th className="text-right" title="Median wait from opening a case to the first action">
                  First action
                </th>
                <th className="text-right" title="Clicks on something clickable-looking that got no response">
                  No response
                </th>
                <th className="text-right">Errors</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const before = rows[i - 1]?.app === r.app ? rows[i - 1] : undefined;
                return (
                  <tr key={`${r.app}-${r.version}`} data-testid="usage-release-row">
                    <td className="whitespace-nowrap">
                      <span className="text-xs text-gray-500">{r.app}</span> <span className="font-mono text-xs">{r.version}</span>
                    </td>
                    <td className="whitespace-nowrap text-xs text-gray-500">{formatShortWhen(r.first_seen)}</td>
                    <td className="text-right tabular-nums">{r.cases}</td>
                    <td className={`text-right tabular-nums ${versus(r.active_median_ms, before?.active_median_ms)}`}>{formatDuration(r.active_median_ms)}</td>
                    <td className={`text-right tabular-nums ${versus(r.first_input_median_ms, before?.first_input_median_ms)}`}>{formatDuration(r.first_input_median_ms)}</td>
                    <td className={`text-right tabular-nums ${versus(r.no_response_rate, before?.no_response_rate)}`}>{r.no_response_rate === null ? "–" : `${Math.round(r.no_response_rate * 100)}%`}</td>
                    <td className={`text-right tabular-nums ${r.errors ? "font-semibold text-red-700" : ""}`}>{r.errors}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const REASON_LABEL: Record<string, string> = {
  boundary: "Boundary off",
  missed: "Missed finding",
  wrong_label: "Wrong label",
  not_a_finding: "Not a finding",
  form: "Form answers",
  other: "Other",
};

function ReasonsCard({ summary }: { summary: UsageSummary }) {
  const r = summary.reject_reasons;
  return (
    <div className="card" data-guide="usage-reasons" data-testid="usage-reasons">
      <CardHeader title="Why objects are sent back" hint="The reason reviewers tag with one tap after Reject. One reason dominating points at a guideline or a tool, not at people." />
      {r.total === 0 ? (
        <EmptyState message="No tagged rejections in this period yet." />
      ) : (
        <BarList
          testId="usage-reasons-list"
          max={r.reasons[0]?.count ?? 0}
          rows={r.reasons.map((x) => ({ key: x.reason, label: REASON_LABEL[x.reason] ?? x.reason, value: x.count, display: String(x.count), note: `${Math.round(x.share * 100)}%` }))}
        />
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
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm text-gray-600 md:grid-cols-2">
        <div>
          <dt className="font-medium text-gray-800">What is recorded</dt>
          <dd>Which screens people open and for how long, the tools and buttons they use, where they click and whether the page reacted, how the pointer moves, keyboard shortcuts, errors. Never anything typed into a field.</dd>
        </div>
        <div>
          <dt className="font-medium text-gray-800">Whose activity counts</dt>
          <dd>Everyone except admin and test accounts, which are still recorded but left out of every figure (Settings). The line under the header says how many events and accounts a view is built from.</dd>
        </div>
        <div>
          <dt className="font-medium text-gray-800">What is left out before counting</dt>
          <dd>Pages passed through in under a second (redirects, fast menu clicks) and clicks inside the tutorial -- neither is the person's own work.</dd>
        </div>
        <div>
          <dt className="font-medium text-gray-800">Hands-on vs. cycle time</dt>
          <dd>Hands-on is time actually spent in the viewer on a case, across all sittings, idle stretches left out. Cycle time is calendar time from a case entering a job to it being finished.</dd>
        </div>
        <div>
          <dt className="font-medium text-gray-800">Friction signals</dt>
          <dd>
            <b>Bounce</b>: left within 3 s for another screen. <b>Back &amp; forth</b>: straight back to the screen before. <b>No response</b>: clicked something that looks clickable and nothing on the page changed within 1 s. <b>Rage</b>: 3+ quick clicks on one spot, none answered.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-gray-800">How findings are decided</dt>
          <dd>Fixed rules with fixed thresholds, one finding per problem, and trends only when both periods have at least 5 cases. The same data always gives the same findings; nothing here is a guess.</dd>
        </div>
      </dl>
    </details>
  );
}
