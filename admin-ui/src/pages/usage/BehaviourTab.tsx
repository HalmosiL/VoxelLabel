import { UsageHeatmap, UsageSummary } from "../../api/adminApi";
import EmptyState from "../../components/EmptyState";
import { exportFilename } from "./export";
import { ACCENT, BarList, CardHeader, DownloadCsvButton, formatDuration } from "./shared";

export default function BehaviourTab({ summary, heatRoute, onHeatRoute, heatmap }: { summary: UsageSummary; heatRoute: string; onHeatRoute: (r: string) => void; heatmap: UsageHeatmap | null }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-6 lg:grid-cols-2">
        <RoutesCard summary={summary} />
        <PathsCard summary={summary} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ActionsCard summary={summary} />
        <HeatmapCard summary={summary} route={heatRoute} onRoute={onHeatRoute} heatmap={heatmap} />
      </div>
    </div>
  );
}

function RoutesCard({ summary }: { summary: UsageSummary }) {
  const rows = summary.routes.slice(0, 12);
  const max = rows[0]?.total_ms ?? 0;
  return (
    <div className="card" data-guide="usage-routes" data-testid="usage-routes">
      <CardHeader
        title="Where the time goes"
        hint="Total time per screen in this period, with how often it was opened and the average stay. The screens at the top are where an improvement pays off most."
        actions={
          <DownloadCsvButton
            filename={exportFilename("screens", summary.since, summary.until, "csv")}
            rows={summary.routes}
            columns={[
              { header: "Screen", value: (r) => r.route },
              { header: "Views", value: (r) => r.views },
              { header: "Total (ms)", value: (r) => r.total_ms },
              { header: "Average stay (ms)", value: (r) => r.avg_ms },
            ]}
            testId="usage-export-screens"
          />
        }
      />
      <BarList
        testId="usage-routes-list"
        max={max}
        rows={rows.map((r) => ({ key: r.route, label: r.route, value: r.total_ms, display: formatDuration(r.total_ms), note: `${r.views} views · avg ${formatDuration(r.avg_ms)}` }))}
      />
    </div>
  );
}

function ActionsCard({ summary }: { summary: UsageSummary }) {
  const rows = summary.actions.slice(0, 12);
  const max = rows[0]?.count ?? 0;
  return (
    <div className="card" data-testid="usage-actions">
      <CardHeader
        title="Viewer tools & actions"
        hint="Which tools and buttons get used -- and which never do. A tool nobody touches is a candidate to hide."
        actions={
          <DownloadCsvButton
            filename={exportFilename("actions", summary.since, summary.until, "csv")}
            rows={summary.actions}
            columns={[
              { header: "Action", value: (r) => r.name },
              { header: "Count", value: (r) => r.count },
            ]}
            testId="usage-export-actions"
          />
        }
      />
      <BarList testId="usage-actions-list" max={max} rows={rows.map((a) => ({ key: a.name, label: a.name, value: a.count, display: String(a.count) }))} />
    </div>
  );
}

function PathsCard({ summary }: { summary: UsageSummary }) {
  return (
    <div className="card" data-testid="usage-paths">
      <CardHeader
        title="Common paths"
        hint="The screen-to-screen moves people make most. A move that appears in most sessions is a shortcut waiting to be built."
        actions={
          <DownloadCsvButton
            filename={exportFilename("paths", summary.since, summary.until, "csv")}
            rows={summary.transitions}
            columns={[
              { header: "From", value: (r) => r.from },
              { header: "To", value: (r) => r.to },
              { header: "Times", value: (r) => r.count },
              { header: "Sessions", value: (r) => r.sessions },
            ]}
            testId="usage-export-paths"
          />
        }
      />
      {summary.transitions.length === 0 ? (
        <EmptyState message="No navigation recorded in this range yet." />
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th className="text-right">Times</th>
                <th className="text-right">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {summary.transitions.map((t) => (
                <tr key={`${t.from}>${t.to}`}>
                  <td className="font-mono text-xs">{t.from}</td>
                  <td className="font-mono text-xs">{t.to}</td>
                  <td className="text-right tabular-nums">{t.count}</td>
                  <td className="text-right tabular-nums">{t.sessions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HeatmapCard({ summary, route, onRoute, heatmap }: { summary: UsageSummary; route: string; onRoute: (r: string) => void; heatmap: UsageHeatmap | null }) {
  return (
    <div className="card" data-testid="usage-heatmap">
      <CardHeader
        title="Click heatmap"
        hint="Every click on one screen, on a window scaled to 16:9. Clusters where nothing is clickable are the interesting ones."
        actions={
          <select className="input" value={route} onChange={(e) => onRoute(e.target.value)} aria-label="Screen" data-testid="usage-heatmap-route">
            {summary.routes.map((r) => (
              <option key={r.route} value={r.route}>
                {r.route}
              </option>
            ))}
          </select>
        }
      />
      {!heatmap || heatmap.points.length === 0 ? (
        <EmptyState message="No clicks recorded on this screen yet." />
      ) : (
        <>
          <svg viewBox="0 0 160 90" className="w-full rounded border border-gray-200 bg-gray-50" role="img" aria-label={`${heatmap.points.length} clicks on ${heatmap.route}`} data-testid="usage-heatmap-svg">
            {heatmap.points.map((p, i) => (
              <circle key={i} cx={p.x * 160} cy={p.y * 90} r={1.8} fill={ACCENT} fillOpacity={0.35}>
                <title>{p.target ?? "click"}</title>
              </circle>
            ))}
          </svg>
          <p className="hint mt-2">{heatmap.points.length} clicks in this period.</p>
        </>
      )}
    </div>
  );
}
