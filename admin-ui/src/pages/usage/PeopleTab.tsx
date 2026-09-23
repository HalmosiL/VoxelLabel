import { useEffect, useMemo, useRef, useState } from "react";

import { LearningCurvePoint, UsageEventRow, UsageSession, UsageSessionDetail, UsageSummary } from "../../api/adminApi";
import EmptyState from "../../components/EmptyState";
import { exportFilename } from "./export";
import { advance, buildTimeline, GAP_MS, markIndexAt, pageAt } from "./replay";
import { ACCENT, CardHeader, DownloadCsvButton, formatDuration, formatWhen } from "./shared";

export default function PeopleTab({
  summary,
  learningCurve,
  sessionsFor,
  sessions,
  session,
  onOpenUser,
  onOpenSession,
  onCloseSessions,
}: {
  summary: UsageSummary;
  learningCurve: LearningCurvePoint[] | null;
  sessionsFor: { user_id: string; username: string } | null;
  sessions: UsageSession[] | null;
  session: UsageSessionDetail | null;
  onOpenUser: (user_id: string, username: string, replayLatest?: boolean) => void;
  onOpenSession: (id: string) => void;
  onCloseSessions: () => void;
}) {
  return (
    <div className="space-y-5">
      <PeopleCard summary={summary} onOpen={onOpenUser} />
      {sessionsFor && <SessionsCard who={sessionsFor} sessions={sessions} selected={session?.session_id ?? null} since={summary.since} until={summary.until} onOpen={onOpenSession} onClose={onCloseSessions} />}
      {session && <ReplayCard session={session} />}
      {learningCurve && <LearningCurveCard rows={learningCurve} since={summary.since} until={summary.until} />}
    </div>
  );
}

// ---------------------------------------------------------------- people

function PeopleCard({ summary, onOpen }: { summary: UsageSummary; onOpen: (user_id: string, username: string, replayLatest?: boolean) => void }) {
  return (
    <div className="card" data-guide="usage-people" data-testid="usage-people">
      <CardHeader
        title="People"
        hint="One row per person who counts in the figures (admin and test accounts are managed in Settings). Open a name for their sessions, or Replay to watch their newest sitting as it happened."
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
              { header: "Cases worked", value: (u) => u.cases_worked },
              { header: "Hands-on time per case (ms)", value: (u) => u.active_per_case_ms },
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
                <th className="text-right" title="Sittings -- one per browser tab per visit">
                  Sessions
                </th>
                <th className="text-right" title="Total time with the platform open">
                  Time in the app
                </th>
                <th className="text-right" title="Cases they opened in the viewer from a job in this period">
                  Cases worked
                </th>
                <th className="text-right" title="Median active time in the viewer per case, across all sittings, idle stretches left out. Lower is better -- compare a person with their own earlier weeks, not with each other.">
                  Hands-on / case
                </th>
                <th className="text-right" title="Mark as annotated / Submit review clicks in the viewer">
                  Annotated · Reviewed
                </th>
                <th className="text-right" title="Share of moves that went straight back to the screen before -- carrying something in their head the UI should show side by side. Lower is better.">
                  Back &amp; forth
                </th>
                <th className="text-right" title="JavaScript errors they hit">
                  Errors
                </th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {summary.users.map((u) => (
                <tr key={u.user_id} data-testid={`usage-user-${u.username}`}>
                  <td>
                    <div className="flex items-center gap-2">
                      <button type="button" className="font-medium text-blue-700 hover:underline" onClick={() => onOpen(u.user_id, u.username)} data-testid={`usage-open-${u.username}`}>
                        {u.username}
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen(u.user_id, u.username, true)} title="Replay their newest session" data-testid={`usage-replay-${u.username}`}>
                        ▶ Replay
                      </button>
                    </div>
                    {u.email && <div className="text-xs text-gray-400">{u.email}</div>}
                  </td>
                  <td className="text-right tabular-nums">{u.sessions}</td>
                  <td className="text-right tabular-nums">{formatDuration(u.total_ms)}</td>
                  <td className="text-right tabular-nums">{u.cases_worked}</td>
                  <td className="text-right tabular-nums">{formatDuration(u.active_per_case_ms)}</td>
                  <td className="text-right tabular-nums">
                    {u.annotated} · {u.reviewed}
                  </td>
                  <td className="text-right tabular-nums">{Math.round(u.back_and_forth * 100)}%</td>
                  <td className={`text-right tabular-nums ${u.errors ? "font-semibold text-red-700" : ""}`}>{u.errors}</td>
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

const SPEEDS = [1, 2, 4, 8, 16, 32] as const;
/** A click stays highlighted this long after it happened. */
const CLICK_FLASH_MS = 700;
/** A key press / action is shown on the stage this long. */
const TOAST_MS = 1500;
const STAGE_W = 160;
const STAGE_H = 90;

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Plays one session back on a clock: the page the person was on, the
 * pointer moving as it did, clicks flashing where they landed, keys and
 * actions popping up, and the event log following along. Long pauses
 * are skipped by default so a two-hour sitting plays in minutes. */
function ReplayCard({ session }: { session: UsageSessionDetail }) {
  const timeline = useMemo(() => buildTimeline(session.events), [session]);
  const [head, setHead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(4);
  const [skipGaps, setSkipGaps] = useState(true);
  const logRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    setHead(0);
    setPlaying(false);
  }, [session.session_id]);

  // The playback clock: real time × speed, with pauses skipped.
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      setHead((h) => {
        const next = advance(timeline, h, dt, speed, skipGaps);
        if (next >= timeline.duration) setPlaying(false);
        return next;
      });
      frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, speed, skipGaps, timeline]);

  const page = pageAt(timeline.pages, head);
  const markIndex = markIndexAt(timeline.marks, head);
  const currentMark = timeline.marks[markIndex] ?? null;

  // Keep the log's current row in view while playing.
  useEffect(() => {
    if (!playing || !logRef.current) return;
    const row = logRef.current.querySelector<HTMLElement>(`[data-mark="${markIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [markIndex, playing]);

  const vp = page?.viewport ?? [1600, 900];
  const sx = (x: number) => (x / vp[0]) * STAGE_W;
  const sy = (y: number) => (y / vp[1]) * STAGE_H;
  const shownPoints = page ? timeline.points.filter((p) => p.page === page.index && p.t <= head) : [];
  const shownClicks = page ? timeline.clicks.filter((c) => c.page === page.index && c.t <= head) : [];
  const cursor = shownPoints[shownPoints.length - 1] ?? null;
  const path = shownPoints.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const toast = currentMark && head - currentMark.t <= TOAST_MS && (currentMark.event.event_type === "key" || currentMark.event.event_type === "action" || currentMark.event.event_type === "error") ? currentMark.event : null;

  function seek(t: number) {
    setPlaying(false);
    setHead(Math.max(0, Math.min(t, timeline.duration)));
  }

  return (
    <div className="card" data-testid="usage-timeline">
      <CardHeader
        title={`Replay · ${session.username} · ${session.app}`}
        hint={`${clock(timeline.duration)} long, ${timeline.pages.length} pages, ${timeline.clicks.length} clicks. Blue: the pointer. Red rings: clicks. The window is scaled to 16:9.`}
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
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={timeline.duration === 0}
              onClick={() => {
                if (head >= timeline.duration) setHead(0);
                setPlaying((p) => !p);
              }}
              data-testid="usage-replay-play"
            >
              {playing ? "❚❚ Pause" : "▶ Play"}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => seek(0)} title="Back to the start" aria-label="Back to the start">
              ⏮
            </button>
            <select className="input h-8 py-0 text-sm" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed" data-testid="usage-replay-speed">
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-gray-600" title={`Jump over pauses longer than ${GAP_MS / 1000} s`}>
              <input type="checkbox" checked={skipGaps} onChange={(e) => setSkipGaps(e.target.checked)} data-testid="usage-replay-skip-gaps" />
              skip pauses
            </label>
            <span className="ml-auto tabular-nums text-sm text-gray-700" data-testid="usage-replay-clock">
              {clock(head)} / {clock(timeline.duration)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(timeline.duration, 1)}
            step={50}
            value={head}
            onChange={(e) => seek(Number(e.target.value))}
            className="mb-2 w-full accent-blue-600"
            aria-label="Scrub"
            data-testid="usage-replay-scrub"
          />
          <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
            <span className="font-mono" data-testid="usage-replay-page">
              {page ? page.route : "–"}
            </span>
            {page && (
              <span>
                page {page.index + 1} of {timeline.pages.length}
              </span>
            )}
          </div>
          {timeline.pages.length === 0 ? (
            <EmptyState message="No page views in this session." />
          ) : (
            <svg viewBox={`0 0 ${STAGE_W} ${STAGE_H}`} className="w-full rounded border border-gray-200 bg-gray-50" role="img" aria-label={`Replay of ${page?.route ?? "the session"}`} data-testid="usage-replay-svg">
              {shownPoints.length > 1 && <polyline points={path} fill="none" stroke={ACCENT} strokeWidth={0.5} strokeOpacity={0.7} strokeLinejoin="round" />}
              {shownClicks.map((c, i) => {
                const fresh = head - c.t <= CLICK_FLASH_MS;
                return (
                  <circle key={i} cx={sx(c.x)} cy={sy(c.y)} r={fresh ? 3.5 : 2} fill={fresh ? "#dc2626" : "none"} fillOpacity={fresh ? 0.35 : 0} stroke="#dc2626" strokeWidth={fresh ? 0.8 : 0.5}>
                    <title>{c.target ?? "click"}</title>
                  </circle>
                );
              })}
              {cursor && (
                <g transform={`translate(${sx(cursor.x).toFixed(1)} ${sy(cursor.y).toFixed(1)})`}>
                  <circle r={2.4} fill="#ffffff" stroke={ACCENT} strokeWidth={0.6} />
                  <circle r={1.1} fill={ACCENT} />
                </g>
              )}
              {toast && (
                <g transform={`translate(${STAGE_W / 2} ${STAGE_H - 6})`}>
                  <rect x={-40} y={-4} width={80} height={7} rx={1.5} fill="#111827" fillOpacity={0.85} />
                  <text textAnchor="middle" y={1} fontSize={3.6} fill="#ffffff">
                    {describeEvent(toast)}
                  </text>
                </g>
              )}
            </svg>
          )}
        </div>
        <div className="max-h-[28rem] overflow-y-auto">
          <ul className="divide-y divide-gray-100 text-sm" ref={logRef}>
            {timeline.marks.map((m, i) => (
              <li key={m.event.id} data-mark={i}>
                <button
                  type="button"
                  onClick={() => seek(m.t)}
                  className={`flex w-full gap-3 px-1 py-1 text-left ${i === markIndex ? "bg-blue-50" : m.t > head ? "opacity-50" : ""}`}
                  title="Jump here"
                >
                  <span className="w-14 shrink-0 tabular-nums text-xs text-gray-400">{clock(m.t)}</span>
                  <span className={`badge ${m.event.event_type === "error" ? "badge-red" : m.event.event_type === "action" ? "badge-blue" : "badge-gray"} shrink-0`}>{m.event.event_type}</span>
                  <span className="min-w-0 truncate" title={describeEvent(m.event)}>
                    {describeEvent(m.event)}
                  </span>
                </button>
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
