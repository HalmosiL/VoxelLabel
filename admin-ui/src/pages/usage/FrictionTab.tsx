import { PipelineHealthSummary, UsageSummary } from "../../api/adminApi";
import EmptyState from "../../components/EmptyState";
import { exportFilename } from "./export";
import { CardHeader, DownloadCsvButton, formatDuration, formatMs, formatWhen } from "./shared";

export default function FrictionTab({ summary, pipelineHealth, personName }: { summary: UsageSummary; pipelineHealth: PipelineHealthSummary | null; personName: string | null }) {
  return (
    <div className="space-y-5">
      <ScreensByFrictionCard summary={summary} />
      <PerformanceCard summary={summary} />
      {pipelineHealth && <BottlenecksCard summary={pipelineHealth} personName={personName} />}
    </div>
  );
}

function scoreChip(score: number): string {
  if (score >= 50) return "badge-red";
  if (score >= 25) return "badge bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200";
  return "badge-green";
}

/** What a waiting case is waiting on, in the words of the job. */
function waitingFor(row: { kind: "queue" | "work"; card_type: "annotation" | "review" }): string {
  if (row.kind === "queue") return row.card_type === "review" ? "a reviewer to start" : "an annotator to start";
  return row.card_type === "review" ? "the review decision" : "the annotation to be submitted";
}

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);

function ScreensByFrictionCard({ summary }: { summary: UsageSummary }) {
  const rows = summary.friction.by_screen;
  return (
    <div className="card" data-guide="usage-friction" data-testid="usage-friction">
      <CardHeader
        title="Screens by friction"
        hint={
          <>
            Every screen ranked by one score (0 smooth, 100 everyone struggling) built from four signals: <strong>bounce</strong> -- left within 3 s for another screen; <strong>back &amp; forth</strong> -- went straight back to the screen before; <strong>no response</strong> -- clicked
            something that looks clickable and nothing on the page changed within a second; <strong>rage</strong> -- 3+ quick clicks on one spot, none answered. Start at the top. Redirects and tutorial clicks are left out. {pct(summary.friction.idle_share)} of session time had no input for
            30 s or more.
          </>
        }
        actions={
          <DownloadCsvButton
            filename={exportFilename("friction", summary.since, summary.until, "csv")}
            rows={rows}
            columns={[
              { header: "Screen", value: (r) => r.route },
              { header: "Score", value: (r) => r.score },
              { header: "Views", value: (r) => r.views },
              { header: "Clicks", value: (r) => r.clicks },
              { header: "Bounces", value: (r) => r.bounces },
              { header: "Bounce rate", value: (r) => r.bounce_rate },
              { header: "Returns", value: (r) => r.returns },
              { header: "Back-and-forth rate", value: (r) => r.back_rate },
              { header: "Measured clicks", value: (r) => r.measured_clicks },
              { header: "No-response clicks", value: (r) => r.dead_clicks },
              { header: "No-response rate", value: (r) => r.dead_rate },
              { header: "Rage bursts", value: (r) => r.rage_bursts },
              { header: "Errors", value: (r) => r.errors },
            ]}
            testId="usage-export-friction"
          />
        }
      />
      {rows.length === 0 ? (
        <EmptyState message="No screens recorded in this range yet." />
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Screen</th>
                <th title="0 = smooth, 100 = everyone struggling">Score</th>
                <th className="text-right">Views</th>
                <th className="text-right" title="Left within 3 seconds, then went somewhere else">
                  Bounce
                </th>
                <th className="text-right" title="Returned to the screen visited two steps earlier">
                  Back &amp; forth
                </th>
                <th className="text-right" title="Clicks on something that looks clickable where nothing on the page changed within a second -- out of the clicks where that could be measured">
                  No response
                </th>
                <th className="text-right" title="3+ clicks within half a second on the same spot, none of them answered">
                  Rage bursts
                </th>
                <th className="text-right">Errors</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.route} data-testid="usage-friction-row">
                  <td className="font-mono text-xs">{r.route}</td>
                  <td>
                    <span className={`${scoreChip(r.score)} tabular-nums`}>{r.score}</span>
                  </td>
                  <td className="text-right tabular-nums">{r.views}</td>
                  <td className="text-right tabular-nums">
                    {pct(r.bounce_rate)} <span className="text-xs text-gray-400">({r.bounces})</span>
                  </td>
                  <td className="text-right tabular-nums">
                    {pct(r.back_rate)} <span className="text-xs text-gray-400">({r.returns})</span>
                  </td>
                  <td className="text-right tabular-nums" title={r.dead_rate === null ? "No click here could be measured yet (bare background, the image canvas, or recorded before this was measured)" : undefined}>
                    {pct(r.dead_rate)} {r.measured_clicks > 0 && <span className="text-xs text-gray-400">({r.dead_clicks}/{r.measured_clicks})</span>}
                  </td>
                  <td className="text-right tabular-nums">{r.rage_bursts}</td>
                  <td className={`text-right tabular-nums ${r.errors ? "font-semibold text-red-700" : ""}`}>{r.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PerformanceCard({ summary }: { summary: UsageSummary }) {
  const rows = summary.performance;
  return (
    <div className="card" data-guide="usage-performance" data-testid="usage-performance">
      <CardHeader
        title="Requests people wait on"
        hint="API calls as the browser timed them, per endpoint, the most total waiting first. Red: a mean over 1.5 s, or more than 5% failing. Waiting on the system looks like work in the cycle time -- this separates the two."
        actions={
          <DownloadCsvButton
            filename={exportFilename("requests", summary.since, summary.until, "csv")}
            rows={rows}
            columns={[
              { header: "App", value: (r) => r.app },
              { header: "Endpoint", value: (r) => r.endpoint },
              { header: "Calls", value: (r) => r.calls },
              { header: "Total wait (ms)", value: (r) => r.total_ms },
              { header: "Mean (ms)", value: (r) => r.mean_ms },
              { header: "Worst (ms)", value: (r) => r.max_ms },
              { header: "Slower than 1 s", value: (r) => r.slow_share },
              { header: "Failed", value: (r) => r.failure_rate },
            ]}
            testId="usage-export-requests"
          />
        }
      />
      {rows.length === 0 ? (
        <EmptyState message="No request timings in this period yet (switch: Settings → Request timings)." />
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>App</th>
                <th className="text-right">Calls</th>
                <th className="text-right" title="All the time spent waiting on it, together">
                  Total wait
                </th>
                <th className="text-right">Mean</th>
                <th className="text-right">Worst</th>
                <th className="text-right">Over 1 s</th>
                <th className="text-right">Failed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const bad = r.mean_ms >= 1500 || r.failure_rate >= 0.05;
                return (
                  <tr key={`${r.app}-${r.endpoint}`} className={bad ? "bg-red-50" : ""} data-testid="usage-perf-row">
                    <td className="max-w-[22rem] truncate font-mono text-xs" title={r.endpoint}>
                      {r.endpoint}
                    </td>
                    <td className="text-xs text-gray-500">{r.app}</td>
                    <td className="text-right tabular-nums">{r.calls}</td>
                    <td className="text-right tabular-nums">{formatMs(r.total_ms)}</td>
                    <td className={`text-right tabular-nums ${r.mean_ms >= 1500 ? "font-semibold text-red-700" : ""}`}>{formatMs(r.mean_ms)}</td>
                    <td className="text-right tabular-nums">{formatMs(r.max_ms)}</td>
                    <td className="text-right tabular-nums">{pct(r.slow_share)}</td>
                    <td className={`text-right tabular-nums ${r.failure_rate >= 0.05 ? "font-semibold text-red-700" : ""}`}>{pct(r.failure_rate)}</td>
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

function BottlenecksCard({ summary, personName }: { summary: PipelineHealthSummary; personName: string | null }) {
  return (
    <div className="card" data-guide="usage-bottlenecks" data-testid="usage-bottlenecks">
      <CardHeader
        title="Bottlenecks"
        hint={
          <>
            Cases waiting right now, longest first. A red row waits more than twice as long as that job usually does (or, with too little history, more than a week) -- the ones to chase.
            {personName && <strong> Only cases assigned to {personName}.</strong>}
          </>
        }
        actions={
          <DownloadCsvButton
            filename={exportFilename("bottlenecks", summary.since, summary.until, "csv")}
            rows={summary.bottlenecks}
            columns={[
              { header: "Case", value: (r) => r.case_title ?? r.case_id },
              { header: "Case id", value: (r) => r.case_id },
              { header: "Card", value: (r) => r.card_type },
              { header: "Assignee", value: (r) => r.assignee ?? "" },
              { header: "Waiting for", value: (r) => waitingFor(r) },
              { header: "Waiting (ms)", value: (r) => r.waiting_ms },
              { header: "Usual (ms)", value: (r) => r.baseline_ms },
              { header: "Flagged", value: (r) => r.flagged },
            ]}
            testId="usage-export-bottlenecks"
          />
        }
      />
      {summary.bottlenecks.length === 0 ? (
        <EmptyState message="Nothing is currently waiting -- the pipeline is caught up." />
      ) : (
        <div className="table-wrap mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Case</th>
                <th>Card</th>
                <th>Assignee</th>
                <th>Waiting for</th>
                <th className="text-right">Waiting</th>
                <th className="text-right">Usually</th>
              </tr>
            </thead>
            <tbody>
              {summary.bottlenecks.map((row) => (
                <tr key={`${row.card_id}-${row.case_id}`} className={row.flagged ? "bg-red-50" : ""} data-testid="usage-bottleneck-row">
                  <td>{row.case_title ?? row.case_id}</td>
                  <td className="capitalize">{row.card_type}</td>
                  <td>{row.assignee ?? "Unassigned"}</td>
                  <td>{waitingFor(row)}</td>
                  <td className={`text-right tabular-nums ${row.flagged ? "font-semibold text-red-700" : ""}`}>{formatDuration(row.waiting_ms)}</td>
                  <td className="text-right tabular-nums text-gray-400">{row.baseline_ms ? formatDuration(row.baseline_ms) : "no history yet"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {summary.assignee_load.length > 0 && (
        <>
          <CardHeader
            title="Who's carrying the load"
            actions={
              <DownloadCsvButton
                filename={exportFilename("assignee-load", summary.since, summary.until, "csv")}
                rows={summary.assignee_load}
                columns={[
                  { header: "Person", value: (r) => r.assignee ?? r.assignee_id },
                  { header: "Card", value: (r) => r.card_type },
                  { header: "Open cases", value: (r) => r.open_count },
                  { header: "Oldest since", value: (r) => r.oldest_since },
                ]}
                testId="usage-export-load"
              />
            }
          />
          <div className="table-wrap">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Card</th>
                  <th className="text-right">Open cases</th>
                  <th className="text-right">Oldest since</th>
                </tr>
              </thead>
              <tbody>
                {summary.assignee_load.map((row) => (
                  <tr key={`${row.assignee_id}-${row.card_type}`} data-testid="usage-load-row">
                    <td>{row.assignee ?? row.assignee_id}</td>
                    <td className="capitalize">{row.card_type}</td>
                    <td className="text-right tabular-nums">{row.open_count}</td>
                    <td className="text-right text-xs text-gray-500">{formatWhen(row.oldest_since)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
