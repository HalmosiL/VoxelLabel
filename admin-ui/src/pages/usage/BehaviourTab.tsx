import { useState } from "react";

import { UsageHeatmap, UsageJobMode, UsageSummary } from "../../api/adminApi";
import EmptyState from "../../components/EmptyState";
import { exportFilename } from "./export";
import LayoutBackdrop from "./LayoutBackdrop";
import { fitWidth, FullscreenButton, useFullscreen } from "./fullscreen";
import ScreenSnapshot from "./ScreenSnapshot";
import { ACCENT, BarList, CardHeader, DownloadCsvButton, formatDuration, formatShortWhen } from "./shared";

export default function BehaviourTab({
  summary,
  heatRoute,
  onHeatRoute,
  heatmap,
  heatMode,
  onHeatMode,
}: {
  summary: UsageSummary;
  heatRoute: string;
  onHeatRoute: (r: string) => void;
  heatmap: UsageHeatmap | null;
  heatMode: UsageJobMode | null;
  onHeatMode: (m: UsageJobMode | null) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <NavigationMapCard summary={summary} />
        <PathsCard summary={summary} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <RoutesCard summary={summary} />
        <ToolTimeCard summary={summary} />
      </div>
      <ActionsCard summary={summary} />
      <HeatmapCard summary={summary} route={heatRoute} onRoute={onHeatRoute} heatmap={heatmap} mode={heatMode} onMode={onHeatMode} />
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

function ToolTimeCard({ summary }: { summary: UsageSummary }) {
  const t = summary.tools;
  return (
    <div className="card" data-guide="usage-tools" data-testid="usage-tools">
      <CardHeader
        title="Time with each viewer tool"
        hint="How long each tool stays selected while a case is open (idle stretches left out), and how often it is picked. The tool that holds the time is where ergonomics pay off most; many switches per case mean the tools one task needs are split apart."
        actions={
          <DownloadCsvButton
            filename={exportFilename("tools", summary.since, summary.until, "csv")}
            rows={t.tools}
            columns={[
              { header: "Tool", value: (r) => r.tool },
              { header: "Time selected (ms)", value: (r) => r.time_ms },
              { header: "Share", value: (r) => r.share },
              { header: "Times picked", value: (r) => r.selections },
            ]}
            testId="usage-export-tools"
          />
        }
      />
      {t.case_visits > 0 && (
        <p className="mb-3 text-sm text-gray-600" data-testid="usage-tool-switches">
          Median <strong className="tabular-nums">{t.switches_per_case_median ?? 0}</strong> tool switches per case, over {t.case_visits} case openings.
        </p>
      )}
      <BarList
        testId="usage-tools-list"
        max={t.tools[0]?.time_ms ?? 0}
        rows={t.tools.map((x) => ({ key: x.tool, label: x.tool, value: x.time_ms, display: formatDuration(x.time_ms), note: `${Math.round(x.share * 100)}% · picked ${x.selections}×` }))}
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
 * five people with the most time in the period (the People table's
 * order), so a person keeps the same colour on every screen; anyone
 * past five folds into a neutral "Others". */
const USER_COLORS = ["#2563eb", "#d97706", "#7c3aed", "#0891b2", "#db2777"];
const OTHERS_COLOR = "#9ca3af";
const OTHERS = "__others__";

const MODE_LABEL: Record<UsageJobMode, string> = { annotation: "Annotation job", review: "Review job", other: "Not in a job" };

/** One click mark: a circle in an annotation job, a square in a review
 * job, a small circle elsewhere; hollow when it got no response. */
function ClickMark({ p, color, title, height = 90 }: { p: UsageHeatmap["points"][number]; color: string; title: string; height?: number }) {
  const cx = p.x * 160;
  const cy = p.y * height;
  // a click only placed by its screen position (no element to go by) is fainter
  const common = {
    fill: p.dead ? "none" : color,
    fillOpacity: p.placed === "screen" ? 0.3 : 0.55,
    stroke: p.dead ? color : "#ffffff",
    strokeWidth: p.dead ? 0.6 : 0.25,
    "data-testid": "usage-heatmap-dot",
    "data-dead": p.dead ? "" : undefined,
    "data-mode": p.mode,
    "data-placed": p.placed,
  } as const;
  if (p.mode === "review") {
    const r = p.dead ? 2 : 1.7;
    return (
      <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} {...common}>
        <title>{title}</title>
      </rect>
    );
  }
  return (
    <circle cx={cx} cy={cy} r={p.mode === "annotation" ? (p.dead ? 2.2 : 1.8) : 1.4} {...common}>
      <title>{title}</title>
    </circle>
  );
}

function HeatmapCard({
  summary,
  route,
  onRoute,
  heatmap,
  mode,
  onMode,
}: {
  summary: UsageSummary;
  route: string;
  onRoute: (r: string) => void;
  heatmap: UsageHeatmap | null;
  mode: UsageJobMode | null;
  onMode: (m: UsageJobMode | null) => void;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showScreen, setShowScreen] = useState(true);
  const [showImages, setShowImages] = useState(true);
  const full = useFullscreen<HTMLDivElement>();
  const users = heatmap?.users ?? [];
  const colorOf = new Map<string, string>(summary.users.slice(0, USER_COLORS.length).map((u, i) => [u.user_id, USER_COLORS[i]]));
  const named = users.filter((u) => colorOf.has(u.user_id));
  const others = users.filter((u) => !colorOf.has(u.user_id));
  const keyOf = (userId: string) => (colorOf.has(userId) ? userId : OTHERS);
  const single = users.length <= 1;
  const points = (heatmap?.points ?? []).filter((p) => !hidden.has(keyOf(p.user_id)));
  const nameOf = new Map(users.map((u) => [u.user_id, u.username]));
  const modes = heatmap?.modes ?? { annotation: 0, review: 0, other: 0 };
  const inJobs = modes.annotation + modes.review > 0;
  const layout = heatmap?.layout ?? null;
  const snapshot = heatmap?.snapshot ?? null;
  const marks = (h: number) =>
    points.map((p, i) => {
      const color = single ? ACCENT : (colorOf.get(p.user_id) ?? OTHERS_COLOR);
      return <ClickMark key={i} p={p} height={h} color={color} title={`${nameOf.get(p.user_id) ?? p.user_id} · ${MODE_LABEL[p.mode]}: ${p.target ?? "click"}${p.dead ? " -- no response" : ""}`} />;
    });

  function toggle(key: string) {
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div ref={full.ref} className={`card ${full.active ? "overflow-auto rounded-none" : ""}`} data-testid="usage-heatmap">
      <CardHeader
        title="Click heatmap"
        hint="Every click on one screen, drawn over a miniature of that screen, one colour per person (the same colour on every screen). A hollow mark is a click that got no response -- clusters of those are the thing to fix. In the viewer, circles are clicks in an annotation job and squares in a review job. Click a name to hide or show their clicks."
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
      {!heatmap || (modes.annotation + modes.review + modes.other === 0 && !layout) ? (
        <EmptyState message="No clicks recorded on this screen yet." />
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {inJobs && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kind of job" data-testid="usage-heatmap-modes">
                {([null, "annotation", "review", "other"] as const).map((m) => {
                  const n = m ? modes[m] : modes.annotation + modes.review + modes.other;
                  if (m && !n) return null;
                  return (
                    <button
                      key={m ?? "all"}
                      type="button"
                      onClick={() => onMode(m)}
                      className={`rounded-full border px-2.5 py-0.5 text-xs ${mode === m ? "border-blue-600 bg-blue-600 text-white" : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`}
                      data-testid={`usage-heatmap-mode-${m ?? "all"}`}
                    >
                      {m === "annotation" ? "● " : m === "review" ? "■ " : ""}
                      {m ? MODE_LABEL[m] : "All clicks"} <span className="tabular-nums opacity-75">{n}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {(layout || snapshot) && (
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <input type="checkbox" checked={showScreen} onChange={(e) => setShowScreen(e.target.checked)} data-testid="usage-heatmap-show-screen" />
                show the screen behind
              </label>
            )}
            {snapshot?.has_images && showScreen && (
              <label className="flex items-center gap-1.5 text-xs text-gray-600" title="The case images recorded with this screen -- off: grey blocks">
                <input type="checkbox" checked={showImages} onChange={(e) => setShowImages(e.target.checked)} data-testid="usage-heatmap-images" />
                case images
              </label>
            )}
            {full.supported && (
              <span className="ml-auto">
                <FullscreenButton active={full.active} onClick={full.toggle} testId="usage-heatmap-fullscreen" />
              </span>
            )}
          </div>
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
          <div style={full.active ? { width: fitWidth(snapshot && showScreen ? snapshot.viewport : [160, 90], 230), marginInline: "auto" } : undefined}>
          {snapshot && showScreen ? (
            <ScreenSnapshot snapshot={snapshot} images={showImages}>
              <svg viewBox={`0 0 160 ${(160 * snapshot.viewport[1]) / snapshot.viewport[0]}`} className="h-full w-full" role="img" aria-label={`${heatmap.points.length} clicks on ${heatmap.route} by ${users.length} ${users.length === 1 ? "person" : "people"}`} data-testid="usage-heatmap-svg">
                {marks((160 * snapshot.viewport[1]) / snapshot.viewport[0])}
              </svg>
            </ScreenSnapshot>
          ) : (
            <svg viewBox="0 0 160 90" className="w-full rounded border border-gray-200 bg-gray-50" role="img" aria-label={`${heatmap.points.length} clicks on ${heatmap.route} by ${users.length} ${users.length === 1 ? "person" : "people"}`} data-testid="usage-heatmap-svg">
              {layout && showScreen && <LayoutBackdrop layout={layout} />}
              {marks(90)}
            </svg>
          )}
          </div>
          {snapshot && heatmap.placement.total > 0 && (
            <p className="mt-2 text-xs text-gray-600" data-testid="usage-heatmap-placement">
              Each click is put on the element it was made on, wherever that element sits on this picture: {heatmap.placement.exact} on the same element
              {heatmap.placement.similar ? `, ${heatmap.placement.similar} on the same kind of element (e.g. another object row)` : ""}
              {heatmap.placement.screen ? `, ${heatmap.placement.screen} by screen position only (fainter -- recorded without an element)` : ""}.
              {heatmap.hidden.length > 0 && (
                <span className="text-amber-700" data-testid="usage-heatmap-hidden">
                  {" "}
                  Not on this picture: {heatmap.hidden.map((h) => `${h.target.replace(/^(testid|guide|aria):/, "")} (${h.clicks})`).join(", ")} -- e.g. a pane switched off here.
                </span>
              )}
            </p>
          )}
          <p className="hint mt-2">
            {heatmap.points.length} clicks{mode ? ` in ${MODE_LABEL[mode].toLowerCase()}s` : ""} in this period{single && users[0] ? `, all by ${users[0].username}` : ""}, {heatmap.points.filter((p) => p.dead).length} of them got no response.
            {!layout && !snapshot && " No picture of this screen yet -- it appears once someone opens it with the current version."}
            {(snapshot ?? layout) && (
              <span data-testid="usage-heatmap-layout-note">
                {" "}
                {snapshot ? "Screen as recorded" : "Screen outline recorded"} {formatShortWhen((snapshot ?? layout)?.occurred_at)}
                {(snapshot ?? layout)?.app_version ? ` (build ${(snapshot ?? layout)?.app_version})` : ""}
                {(snapshot ?? layout)?.mode && (snapshot ?? layout)?.mode !== "other" ? `, in a ${MODE_LABEL[(snapshot ?? layout)?.mode as UsageJobMode].toLowerCase()}` : ""} -- images show as grey blocks; their content is never recorded.
              </span>
            )}
          </p>
        </>
      )}
    </div>
  );
}
