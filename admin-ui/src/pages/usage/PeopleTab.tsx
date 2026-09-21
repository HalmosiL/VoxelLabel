import { useEffect, useMemo, useState } from "react";

import { LearningCurvePoint, UsageEventRow, UsageSession, UsageSessionDetail, UsageSettings, UsageSummary } from "../../api/adminApi";
import EmptyState from "../../components/EmptyState";
import { exportFilename } from "./export";
import { ACCENT, CardHeader, DownloadCsvButton, formatDuration, formatWhen } from "./shared";

export default function PeopleTab({
  summary,
  settings,
  learningCurve,
  sessionsFor,
  sessions,
  session,
  onOpenUser,
  onOpenSession,
  onCloseSessions,
  onToggle,
}: {
  summary: UsageSummary;
  settings: UsageSettings | null;
  learningCurve: LearningCurvePoint[] | null;
  sessionsFor: { user_id: string; username: string } | null;
  sessions: UsageSession[] | null;
  session: UsageSessionDetail | null;
  onOpenUser: (user_id: string, username: string) => void;
  onOpenSession: (id: string) => void;
  onCloseSessions: () => void;
  onToggle: (user_id: string, enabled: boolean) => void;
}) {
  return (
    <div className="space-y-5">
      <PeopleCard summary={summary} settings={settings} onOpen={onOpenUser} onToggle={onToggle} />
      {sessionsFor && <SessionsCard who={sessionsFor} sessions={sessions} selected={session?.session_id ?? null} since={summary.since} until={summary.until} onOpen={onOpenSession} onClose={onCloseSessions} />}
      {session && <ReplayCard session={session} />}
      {learningCurve && <LearningCurveCard rows={learningCurve} since={summary.since} until={summary.until} />}
    </div>
  );
}

// ---------------------------------------------------------------- people

function PeopleCard({
  summary,
  settings,
  onOpen,
  onToggle,
}: {
  summary: UsageSummary;
  settings: UsageSettings | null;
  onOpen: (user_id: string, username: string) => void;
  onToggle: (user_id: string, enabled: boolean) => void;
}) {
  const disabled = new Set(settings?.disabled_user_ids ?? summary.recording.disabled_user_ids);
  return (
    <div className="card" data-guide="usage-people" data-testid="usage-people">
      <CardHeader
        title="People"
        hint="One row per person. Open a row for their sessions and a replay of each. The recording switch here turns one person off without touching anyone else."
        actions={
          <DownloadCsvButton
            filename={exportFilename("people", summary.since, summary.until, "csv")}
            rows={summary.users}
            columns={[
              { header: "Person", value: (u) => u.username },
              { header: "Email", value: (u) => u.email },
              { header: "User id", value: (u) => u.user_id },
              { header: "Sessions", value: (u) => u.sessions },
              { header: "Total time (ms)", value: (u) => u.total_ms },
              { header: "Page views", value: (u) => u.page_views },
              { header: "Pages per session", value: (u) => u.pages_per_session },
              { header: "Average stay (ms)", value: (u) => u.avg_dwell_ms },
              { header: "Back-and-forth ratio", value: (u) => u.back_and_forth },
              { header: "Clicks", value: (u) => u.clicks },
              { header: "Clicks per minute", value: (u) => u.clicks_per_min },
              { header: "Mouse px per page", value: (u) => u.mouse_px_per_page },
              { header: "Annotated", value: (u) => u.annotated },
              { header: "Reviewed", value: (u) => u.reviewed },
              { header: "Errors", value: (u) => u.errors },
              { header: "Last seen", value: (u) => u.last_seen_at },
            ]}
            testId="usage-export-people"
          />
        }
      />
      {summary.users.length === 0 ? (
        <EmptyState message="Nobody has been recorded in this range yet." />
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Person</th>
                <th>Recording</th>
                <th className="text-right">Sessions</th>
                <th className="text-right">Total time</th>
                <th className="text-right">Pages / session</th>
                <th className="text-right">Avg stay</th>
                <th className="text-right" title="Share of navigations that went straight back to the previous screen -- carrying something in their head the UI should show">
                  Back &amp; forth
                </th>
                <th className="text-right">Clicks / min</th>
                <th className="text-right" title="Pointer travel per page, in pixels -- a lot of it is a lot of searching">
                  Mouse px / page
                </th>
                <th className="text-right">Annotated</th>
                <th className="text-right">Reviewed</th>
                <th className="text-right">Errors</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {summary.users.map((u) => (
                <tr key={u.user_id} data-testid={`usage-user-${u.username}`}>
                  <td>
                    <button type="button" className="font-medium text-blue-700 hover:underline" onClick={() => onOpen(u.user_id, u.username)} data-testid={`usage-open-${u.username}`}>
                      {u.username}
                    </button>
                    {u.email && <div className="text-xs text-gray-400">{u.email}</div>}
                  </td>
                  <td>
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" checked={!disabled.has(u.user_id)} onChange={(e) => onToggle(u.user_id, e.target.checked)} aria-label={`Record ${u.username}`} />
                      {disabled.has(u.user_id) ? "off" : "on"}
                    </label>
                  </td>
                  <td className="text-right tabular-nums">{u.sessions}</td>
                  <td className="text-right tabular-nums">{formatDuration(u.total_ms)}</td>
                  <td className="text-right tabular-nums">{u.pages_per_session}</td>
                  <td className="text-right tabular-nums">{formatDuration(u.avg_dwell_ms)}</td>
                  <td className="text-right tabular-nums">{Math.round(u.back_and_forth * 100)}%</td>
                  <td className="text-right tabular-nums">{u.clicks_per_min}</td>
                  <td className="text-right tabular-nums">{u.mouse_px_per_page}</td>
                  <td className="text-right tabular-nums">{u.annotated}</td>
                  <td className="text-right tabular-nums">{u.reviewed}</td>
                  <td className="text-right tabular-nums">{u.errors}</td>
                  <td className="text-xs text-gray-500">{formatWhen(u.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SessionsCard({
  who,
  sessions,
  selected,
  since,
  until,
  onOpen,
  onClose,
}: {
  who: { user_id: string; username: string };
  sessions: UsageSession[] | null;
  selected: string | null;
  since: string;
  until: string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="card" data-testid="usage-sessions">
      <CardHeader
        title={`Sessions · ${who.username}`}
        actions={
          <>
            <DownloadCsvButton
              filename={exportFilename(`sessions-${who.username}`, since, until, "csv")}
              rows={sessions ?? []}
              columns={[
                { header: "Session id", value: (s) => s.session_id },
                { header: "App", value: (s) => s.app },
                { header: "Started", value: (s) => s.started_at },
                { header: "Ended", value: (s) => s.ended_at },
                { header: "Duration (ms)", value: (s) => s.duration_ms },
                { header: "Page views", value: (s) => s.page_views },
                { header: "Actions", value: (s) => s.actions },
                { header: "Clicks", value: (s) => s.clicks },
                { header: "Errors", value: (s) => s.errors },
                { header: "Path", value: (s) => s.routes.join(" > ") },
              ]}
              testId="usage-export-sessions"
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              Close
            </button>
          </>
        }
      />
      {sessions === null ? (
        <p className="hint">Loading…</p>
      ) : sessions.length === 0 ? (
        <EmptyState message="No sessions in this range." />
      ) : (
        <ul className="divide-y divide-gray-100">
          {sessions.map((s) => (
            <li key={s.session_id}>
              <button
                type="button"
                onClick={() => onOpen(s.session_id)}
                className={`flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-1 py-2 text-left text-sm hover:bg-gray-50 ${selected === s.session_id ? "bg-blue-50" : ""}`}
                data-testid="usage-session-row"
              >
                <span className="w-40 text-gray-700">{formatWhen(s.started_at)}</span>
                <span className="badge badge-gray">{s.app}</span>
                <span className="tabular-nums">{formatDuration(s.duration_ms)}</span>
                <span className="text-xs text-gray-500">
                  {s.page_views} pages · {s.actions} actions · {s.clicks} clicks{s.errors ? ` · ${s.errors} errors` : ""}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-400">{s.routes.join(" → ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- replay

interface PageSlice {
  index: number;
  route: string;
  startedAt: number;
  viewport: [number, number] | null;
  points: number[][];
  clicks: { x: number; y: number; target: string | null }[];
}

/** Splits a session's events into one slice per page view: the mouse
 * trace points (re-based to the page's own start) and clicks recorded
 * while it was open, for the replay panel. */
export function slicePages(events: UsageEventRow[]): PageSlice[] {
  const slices: PageSlice[] = [];
  let current: PageSlice | null = null;
  for (const e of events) {
    const at = Date.parse(e.occurred_at);
    const detail = e.detail ?? {};
    if (e.event_type === "page_view") {
      const vp = Array.isArray(detail.viewport) && detail.viewport.length === 2 ? ([Number(detail.viewport[0]), Number(detail.viewport[1])] as [number, number]) : null;
      current = { index: slices.length, route: e.route, startedAt: at, viewport: vp, points: [], clicks: [] };
      slices.push(current);
    } else if (current && e.event_type === "mouse_trace" && Array.isArray(detail.points)) {
      const vp = Array.isArray(detail.viewport) && detail.viewport.length === 2 ? ([Number(detail.viewport[0]), Number(detail.viewport[1])] as [number, number]) : null;
      if (!current.viewport && vp) current.viewport = vp;
      const base = at - current.startedAt;
      for (const p of detail.points as number[][]) current.points.push([base + p[0], p[1], p[2]]);
    } else if (current && e.event_type === "click" && typeof detail.x === "number" && typeof detail.y === "number") {
      const vp = Array.isArray(detail.viewport) && detail.viewport.length === 2 ? ([Number(detail.viewport[0]), Number(detail.viewport[1])] as [number, number]) : null;
      if (!current.viewport && vp) current.viewport = vp;
      current.clicks.push({ x: detail.x, y: detail.y, target: typeof detail.target === "string" ? detail.target : null });
    }
  }
  for (const s of slices) s.points.sort((a, b) => a[0] - b[0]);
  return slices;
}

function describeEvent(e: UsageEventRow): string {
  const d = e.detail ?? {};
  switch (e.event_type) {
    case "page_view":
      return `Opened ${e.route}`;
    case "page_leave":
      return `Left ${e.route} after ${formatDuration(e.duration_ms)}`;
    case "action":
      return `Action: ${e.name}`;
    case "click":
      return `Click on ${typeof d.target === "string" ? d.target : "?"}`;
    case "mouse_trace":
      return `Mouse: ${Array.isArray(d.points) ? d.points.length : 0} samples`;
    case "scroll":
      return e.name === "wheel" ? `Wheel: ${String(d.depth)} ticks` : `Scrolled ${Math.round(Number(d.depth ?? 0) * 100)}% down`;
    case "key":
      return `Key: ${e.name}`;
    case "focus":
      return e.name === "blur" ? "Window lost focus" : "Window focused";
    case "idle":
      return `Idle for ${formatDuration(e.duration_ms)}`;
    case "error":
      return `Error: ${typeof d.message === "string" ? d.message : "?"}`;
    default:
      return e.event_type;
  }
}

function ReplayCard({ session }: { session: UsageSessionDetail }) {
  const slices = useMemo(() => slicePages(session.events), [session]);
  // Open on the first page with something to replay -- a session often
  // starts on a redirect page (the viewer's /viewer/series/:id lasts
  // under 100 ms) that has no pointer samples at all.
  const firstWithTrace = useMemo(() => Math.max(0, slices.findIndex((s) => s.points.length > 1)), [slices]);
  const [pageIndex, setPageIndex] = useState(firstWithTrace);
  const [progress, setProgress] = useState(1);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    setPageIndex(firstWithTrace);
    setProgress(1);
    setPlaying(false);
  }, [session.session_id, firstWithTrace]);
  useEffect(() => {
    if (!playing) return;
    const handle = window.setInterval(() => {
      setProgress((p) => {
        if (p >= 1) {
          setPlaying(false);
          return 1;
        }
        return Math.min(p + 0.02, 1);
      });
    }, 100);
    return () => window.clearInterval(handle);
  }, [playing]);

  const slice = slices[pageIndex] ?? null;
  const start = Date.parse(session.events[0].occurred_at);
  const shown = slice ? slice.points.slice(0, Math.max(1, Math.round(slice.points.length * progress))) : [];
  const vp = slice?.viewport ?? [1600, 900];
  const path = shown.map((p) => `${((p[1] / vp[0]) * 160).toFixed(1)},${((p[2] / vp[1]) * 90).toFixed(1)}`).join(" ");

  return (
    <div className="card" data-testid="usage-timeline">
      <CardHeader
        title={`Replay · ${session.username} · ${session.app}`}
        actions={
          <DownloadCsvButton
            filename={`usage-session-${session.session_id.slice(0, 8)}.csv`}
            rows={session.events}
            columns={[
              { header: "Occurred at", value: (e) => e.occurred_at },
              { header: "Type", value: (e) => e.event_type },
              { header: "Screen", value: (e) => e.route },
              { header: "Name", value: (e) => e.name },
              { header: "Duration (ms)", value: (e) => e.duration_ms },
              { header: "Detail", value: (e) => e.detail },
            ]}
            testId="usage-export-session-events"
          />
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <select
              className="input"
              value={pageIndex}
              onChange={(e) => {
                setPageIndex(Number(e.target.value));
                setProgress(1);
                setPlaying(false);
              }}
              aria-label="Page"
              data-testid="usage-replay-page"
            >
              {slices.map((s) => (
                <option key={s.index} value={s.index}>
                  {s.route} · {s.points.length} samples · {s.clicks.length} clicks
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!slice || slice.points.length < 2}
              onClick={() => {
                if (progress >= 1) setProgress(0);
                setPlaying((p) => !p);
              }}
              data-testid="usage-replay-play"
            >
              {playing ? "Pause" : "Play"}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={progress}
              onChange={(e) => {
                setPlaying(false);
                setProgress(Number(e.target.value));
              }}
              className="flex-1 accent-blue-600"
              aria-label="Scrub"
            />
          </div>
          {slice ? (
            <svg viewBox="0 0 160 90" className="w-full rounded border border-gray-200 bg-gray-50" role="img" aria-label={`Mouse trace on ${slice.route}`} data-testid="usage-replay-svg">
              {shown.length > 1 && <polyline points={path} fill="none" stroke={ACCENT} strokeWidth={0.5} strokeOpacity={0.8} strokeLinejoin="round" />}
              {shown.length > 0 && <circle cx={(shown[shown.length - 1][1] / vp[0]) * 160} cy={(shown[shown.length - 1][2] / vp[1]) * 90} r={1.6} fill={ACCENT} />}
              {slice.clicks.map((c, i) => (
                <circle key={i} cx={(c.x / vp[0]) * 160} cy={(c.y / vp[1]) * 90} r={2.2} fill="none" stroke="#dc2626" strokeWidth={0.6}>
                  <title>{c.target ?? "click"}</title>
                </circle>
              ))}
            </svg>
          ) : (
            <EmptyState message="No page views in this session." />
          )}
          <p className="hint mt-2">Blue: pointer path (sampled). Red rings: clicks. The window is scaled to 16:9.</p>
        </div>
        <div className="max-h-[28rem] overflow-y-auto">
          <ul className="divide-y divide-gray-100 text-sm">
            {session.events.map((e) => (
              <li key={e.id} className="flex gap-3 py-1">
                <span className="w-16 shrink-0 tabular-nums text-xs text-gray-400">+{formatDuration(Date.parse(e.occurred_at) - start)}</span>
                <span className={`badge ${e.event_type === "error" ? "badge-red" : e.event_type === "action" ? "badge-blue" : "badge-gray"} shrink-0`}>{e.event_type}</span>
                <span className="min-w-0 truncate" title={describeEvent(e)}>
                  {describeEvent(e)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- learning curve

function LearningCurveCard({ rows, since, until }: { rows: LearningCurvePoint[]; since: string; until: string }) {
  const byPerson = useMemo(() => {
    const grouped = new Map<string, { username: string; card_type: string; points: LearningCurvePoint[] }>();
    for (const row of rows) {
      const key = `${row.actor_id}:${row.card_type}`;
      const entry = grouped.get(key) ?? { username: row.username ?? row.actor_id, card_type: row.card_type, points: [] };
      entry.points.push(row);
      grouped.set(key, entry);
    }
    for (const entry of grouped.values()) entry.points.sort((a, b) => a.week - b.week);
    return [...grouped.values()].filter((entry) => entry.points.length >= 2);
  }, [rows]);

  return (
    <div className="card" data-guide="usage-learning-curve" data-testid="usage-learning-curve">
      <CardHeader
        title="Learning curve"
        hint="Each person's own median time per case, week by week since their first one -- never compared to anyone else's pace. A falling line is someone still getting faster; flat from week one means it was never hard."
        actions={
          <DownloadCsvButton
            filename={exportFilename("learning-curve", since, until, "csv")}
            rows={rows}
            columns={[
              { header: "Person", value: (r) => r.username },
              { header: "User id", value: (r) => r.actor_id },
              { header: "Role", value: (r) => r.card_type },
              { header: "Week of tenure", value: (r) => r.week },
              { header: "Median time per case (ms)", value: (r) => r.median_ms },
              { header: "Cases", value: (r) => r.count },
            ]}
            testId="usage-export-learning-curve"
          />
        }
      />
      {byPerson.length === 0 ? (
        <EmptyState message="Not enough weeks of history yet -- this fills in as people keep working." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {byPerson.map((entry) => {
            const max = Math.max(...entry.points.map((p) => p.median_ms));
            const w = 220;
            const h = 56;
            const xy = (p: LearningCurvePoint, i: number) => ({
              x: entry.points.length > 1 ? (i / (entry.points.length - 1)) * w : 0,
              y: h - (max ? (p.median_ms / max) * (h - 8) : 0) - 4,
            });
            const path = entry.points
              .map((p, i) => {
                const { x, y } = xy(p, i);
                return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
              })
              .join(" ");
            const trend = entry.points[entry.points.length - 1].median_ms <= entry.points[0].median_ms;
            return (
              <div key={`${entry.username}-${entry.card_type}`} className="rounded border border-gray-200 p-3" data-testid="usage-learning-curve-figure">
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-medium text-gray-800">{entry.username}</span>
                  <span className="badge badge-gray capitalize">{entry.card_type}</span>
                </div>
                <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`${entry.username}'s ${entry.card_type} time per case by week of tenure`}>
                  <path d={path} fill="none" stroke={trend ? "#15803d" : "#b45309"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                  {entry.points.map((p, i) => {
                    const { x, y } = xy(p, i);
                    return <circle key={p.week} cx={x} cy={y} r={2.5} fill={trend ? "#15803d" : "#b45309"} />;
                  })}
                </svg>
                <div className="mt-1 flex justify-between text-xs text-gray-400">
                  <span>
                    Week {entry.points[0].week}: {formatDuration(entry.points[0].median_ms)}
                  </span>
                  <span>
                    Week {entry.points[entry.points.length - 1].week}: {formatDuration(entry.points[entry.points.length - 1].median_ms)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
