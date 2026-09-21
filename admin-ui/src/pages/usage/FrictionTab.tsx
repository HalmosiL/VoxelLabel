import { PipelineHealthSummary, UsageSummary } from "../../api/adminApi";
import EmptyState from "../../components/EmptyState";
import { exportFilename } from "./export";
import { CardHeader, DownloadCsvButton, formatDuration, formatWhen } from "./shared";

export default function FrictionTab({ summary, pipelineHealth }: { summary: UsageSummary; pipelineHealth: PipelineHealthSummary | null }) {
  return (
    <div className="space-y-5">
      <ScreensByFrictionCard summary={summary} />
      {pipelineHealth && <BottlenecksCard summary={pipelineHealth} />}
    </div>
  );
}

function scoreChip(score: number): string {
  if (score >= 50) return "badge-red";
  if (score >= 25) return "badge bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200";
  return "badge-green";
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function ScreensByFrictionCard({ summary }: { summary: UsageSummary }) {
  const rows = summary.friction.by_screen;
  return (
    <div className="card" data-guide="usage-friction" data-testid="usage-friction">
      <CardHeader
        title="Screens by friction"
        hint={
          <>
            One score per screen (0 = smooth, 100 = everyone struggling), from four signals: <strong>bounce</strong> -- left within 3 s and went elsewhere; <strong>back &amp; forth</strong> -- returned straight to the previous screen; <strong>dead clicks</strong> -- clicks
            nothing followed within 2 s; <strong>rage</strong> -- 3+ clicks within half a second on the same spot. Idle time was {pct(summary.friction.idle_share)} of all session time.
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
              { header: "Dead clicks", value: (r) => r.dead_clicks },
              { header: "Dead click rate", value: (r) => r.dead_rate },
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
                <th className="text-right" title="Clicks nothing followed within 2 seconds">
                  Dead clicks
                </th>
                <th className="text-right" title="3+ clicks within half a second on the same spot">
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
                  <td className="text-right tabular-nums">
                    {pct(r.dead_rate)} <span className="text-xs text-gray-400">({r.dead_clicks}/{r.clicks})</span>
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

function BottlenecksCard({ summary }: { summary: PipelineHealthSummary }) {
  return (
    <div className="card" data-guide="usage-bottlenecks" data-testid="usage-bottlenecks">
      <CardHeader
        title="Bottlenecks"
        hint="Cases currently waiting, ranked by how long. Flagged rows are waiting more than twice as long as that card's own usual wait (or, for a card with too little history yet, more than a week)."
        actions={
          <DownloadCsvButton
            filename={exportFilename("bottlenecks", summary.since, summary.until, "csv")}
            rows={summary.bottlenecks}
            columns={[
              { header: "Case", value: (r) => r.case_title ?? r.case_id },
              { header: "Case id", value: (r) => r.case_id },
              { header: "Card", value: (r) => r.card_type },
              { header: "Assignee", value: (r) => r.assignee ?? "" },
              { header: "Waiting for", value: (r) => (r.kind === "queue" ? "someone to start" : "a decision") },
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
                  <td>{row.kind === "queue" ? "someone to start" : "a decision"}</td>
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
