import { useState } from "react";

import { UsageHeatmap, UsageSummary } from "../../api/adminApi";
import EmptyState from "../../components/EmptyState";
import { exportFilename } from "./export";
import { ACCENT, BarList, CardHeader, DownloadCsvButton, formatDuration } from "./shared";

export default function BehaviourTab({ summary, heatRoute, onHeatRoute, heatmap }: { summary: UsageSummary; heatRoute: string; onHeatRoute: (r: string) => void; heatmap: UsageHeatmap | null }) {
  return (
    <div className="space-y-5">
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <NavigationMapCard summary={summary} />
        <PathsCard summary={summary} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <RoutesCard summary={summary} />
        <ActionsCard summary={summary} />
      </div>
      <HeatmapCard summary={summary} route={heatRoute} onRoute={onHeatRoute} heatmap={heatmap} />
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

// ---------------------------------------------------------------- navigation map

const MAP_W = 640;
const MAP_H = 440;
const MAP_R = 150;
const MAP_NODES = 12;

/** Every screen as a node sized by the time spent on it, every move
 * between screens as an arrow weighted by how often it was made. One
 * picture of "where do they go from where" -- with the person filter
 * set, one person's own habits. Nodes sit on a ring ordered by time,
 * so the busiest screens are next to each other at the top; a curve
 * bows to the right of its direction of travel, so A -> B and B -> A
 * stay apart. The Common paths table beside it is the same data as text. */
function NavigationMapCard({ summary }: { summary: UsageSummary }) {
  const nodes = summary.routes.slice(0, MAP_NODES);
  const index = new Map(nodes.map((n, i) => [n.route, i]));
  const edges = summary.transitions.filter((t) => index.has(t.from) && index.has(t.to) && t.from !== t.to);
  const maxTime = nodes[0]?.total_ms ?? 1;
  const maxCount = edges[0]?.count ?? 1;
  const cx = MAP_W / 2;
  const cy = MAP_H / 2;
  const pos = nodes.map((n, i) => {
    const angle = -Math.PI / 2 + (i / nodes.length) * Math.PI * 2;
    return { x: cx + Math.cos(angle) * MAP_R, y: cy + Math.sin(angle) * MAP_R, angle, r: 6 + 14 * Math.sqrt(n.total_ms / maxTime) };
  });
  const labelled = new Set(edges.slice(0, 6));

  return (
    <div className="card" data-testid="usage-navmap">
      <CardHeader
        title="How they move between screens"
        hint="Each circle is a screen, sized by the time spent there; each arrow a move from one screen to another, thicker the more often it was made. Pick a person above to see their own habits. Hover anything for the numbers."
      />
      {nodes.length < 2 || edges.length === 0 ? (
        <EmptyState message="Not enough navigation in this range to draw yet." />
      ) : (
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="w-full" role="img" aria-label={`${nodes.length} screens and ${edges.length} moves between them`} data-testid="usage-navmap-svg">
          <defs>
            <marker id="usage-navmap-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={ACCENT} fillOpacity={0.7} />
            </marker>
          </defs>
          {edges.map((e) => {
            const a = pos[index.get(e.from) as number];
            const b = pos[index.get(e.to) as number];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            // perpendicular to the right of travel -> opposite directions bow apart
            const bow = Math.max(14, Math.min(0.3 * len, 50));
            const mx = (a.x + b.x) / 2 + -uy * bow;
            const my = (a.y + b.y) / 2 + ux * bow;
            // start and end on the circles' edges, not their centres
            const sdx = mx - a.x;
            const sdy = my - a.y;
            const sl = Math.hypot(sdx, sdy) || 1;
            const x1 = a.x + (sdx / sl) * (a.r + 1);
            const y1 = a.y + (sdy / sl) * (a.r + 1);
            const edx = b.x - mx;
            const edy = b.y - my;
            const el = Math.hypot(edx, edy) || 1;
            const x2 = b.x - (edx / el) * (b.r + 6);
            const y2 = b.y - (edy / el) * (b.r + 6);
            const width = 1 + 5 * (e.count / maxCount);
            // point on the curve at t = 0.5, for the count label
            const lx = 0.25 * x1 + 0.5 * mx + 0.25 * x2;
            const ly = 0.25 * y1 + 0.5 * my + 0.25 * y2;
            return (
              <g key={`${e.from}>${e.to}`} data-testid="usage-navmap-edge">
                <path d={`M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`} fill="none" stroke={ACCENT} strokeOpacity={0.45} strokeWidth={width} strokeLinecap="round" markerEnd="url(#usage-navmap-arrow)">
                  <title>{`${e.from} → ${e.to}: ${e.count} times in ${e.sessions} sessions`}</title>
                </path>
                {labelled.has(e) && (
                  <g transform={`translate(${lx.toFixed(1)} ${ly.toFixed(1)})`} pointerEvents="none">
                    <rect x={-9} y={-6.5} width={18} height={13} rx={6.5} fill="#ffffff" stroke="#e5e7eb" strokeWidth={0.75} />
                    <text textAnchor="middle" y={3.5} fontSize={9.5} fill="#374151" className="tabular-nums">
                      {e.count}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          {nodes.map((n, i) => {
            const p = pos[i];
            const right = Math.cos(p.angle) > 0.05;
            const left = Math.cos(p.angle) < -0.05;
            const lx = p.x + Math.cos(p.angle) * (p.r + 8);
            const ly = p.y + Math.sin(p.angle) * (p.r + 8);
            return (
              <g key={n.route} data-testid="usage-navmap-node">
                <circle cx={p.x} cy={p.y} r={p.r} fill={ACCENT} fillOpacity={0.15} stroke={ACCENT} strokeWidth={1.5}>
                  <title>{`${n.route}: ${formatDuration(n.total_ms)} over ${n.views} views (avg ${formatDuration(n.avg_ms)})`}</title>
                </circle>
                <text x={lx} y={ly + 3.5} fontSize={10.5} fill="#374151" textAnchor={right ? "start" : left ? "end" : "middle"} fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
                  {n.route}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- heatmap

/** Validated categorical palette (dataviz check: lightness, chroma,
 * CVD separation, contrast all pass in this order) -- assigned to the
 * five people with the most clicks on the screen, in fixed order;
 * anyone past five folds into a neutral "Others". */
const USER_COLORS = ["#2563eb", "#d97706", "#7c3aed", "#0891b2", "#db2777"];
const OTHERS_COLOR = "#9ca3af";
const OTHERS = "__others__";

function HeatmapCard({ summary, route, onRoute, heatmap }: { summary: UsageSummary; route: string; onRoute: (r: string) => void; heatmap: UsageHeatmap | null }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const users = heatmap?.users ?? [];
  const named = users.slice(0, USER_COLORS.length);
  const others = users.slice(USER_COLORS.length);
  const colorOf = new Map<string, string>(named.map((u, i) => [u.user_id, USER_COLORS[i]]));
  const keyOf = (userId: string) => (colorOf.has(userId) ? userId : OTHERS);
  const single = users.length <= 1;
  const points = (heatmap?.points ?? []).filter((p) => !hidden.has(keyOf(p.user_id)));
  const nameOf = new Map(users.map((u) => [u.user_id, u.username]));

  function toggle(key: string) {
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="card" data-testid="usage-heatmap">
      <CardHeader
        title="Click heatmap"
        hint="Every click on one screen, on a window scaled to 16:9, one colour per person. Clusters where nothing is clickable are the interesting ones; click a name to hide or show their dots."
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
          {!single && (
            <ul className="mb-2 flex flex-wrap gap-x-3 gap-y-1" data-testid="usage-heatmap-legend">
              {[...named.map((u) => ({ key: u.user_id, label: u.username, clicks: u.clicks, color: colorOf.get(u.user_id) as string })), ...(others.length ? [{ key: OTHERS, label: `Others (${others.length})`, clicks: others.reduce((n, u) => n + u.clicks, 0), color: OTHERS_COLOR }] : [])].map((item) => (
                <li key={item.key}>
                  <button type="button" onClick={() => toggle(item.key)} className={`flex items-center gap-1.5 text-xs ${hidden.has(item.key) ? "text-gray-400 line-through" : "text-gray-700"}`} aria-pressed={!hidden.has(item.key)} data-testid="usage-heatmap-legend-item">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: item.color, opacity: hidden.has(item.key) ? 0.3 : 1 }} />
                    {item.label} <span className="text-gray-400">{item.clicks}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <svg viewBox="0 0 160 90" className="w-full rounded border border-gray-200 bg-gray-50" role="img" aria-label={`${heatmap.points.length} clicks on ${heatmap.route} by ${users.length} ${users.length === 1 ? "person" : "people"}`} data-testid="usage-heatmap-svg">
            {points.map((p, i) => (
              <circle key={i} cx={p.x * 160} cy={p.y * 90} r={1.8} fill={single ? ACCENT : (colorOf.get(p.user_id) ?? OTHERS_COLOR)} fillOpacity={0.45}>
                <title>{`${nameOf.get(p.user_id) ?? p.user_id}: ${p.target ?? "click"}`}</title>
              </circle>
            ))}
          </svg>
          <p className="hint mt-2">
            {heatmap.points.length} clicks in this period{single && users[0] ? `, all by ${users[0].username}` : ""}.
          </p>
        </>
      )}
    </div>
  );
}
