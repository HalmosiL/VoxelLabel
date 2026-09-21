import { useEffect, useMemo, useState } from "react";

import {
  getUsageHeatmap,
  getUsageSession,
  getUsageSettings,
  getUsageSummary,
  listUsageSessions,
  previousRange,
  setUsageUserSwitch,
  updateUsageSettings,
  UsageEventRow,
  UsageFrictionRow,
  UsageHeatmap,
  UsageSession,
  UsageSessionDetail,
  UsageRange,
  UsageSettings,
  UsageSummary,
} from "../api/adminApi";
import { describeApiError } from "../api/client";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import { USAGE_STEPS } from "../guide/adminSteps";
import { useRegisterGuide } from "../guide/GuideContext";

const RANGES = [7, 30, 90] as const;
// One accent for every mark on this page -- there is never more than one
// series per chart, so identity is carried by the row label, not a hue.
const ACCENT = "#2563eb";

const CATEGORIES: { key: keyof UsageSettings; label: string; hint: string }[] = [
  { key: "track_pages", label: "Pages & time", hint: "which screens open, how long they stay open, focus and idle gaps" },
  { key: "track_actions", label: "Actions", hint: "viewer tools, save, Mark as Annotated, Submit review, Run, create" },
  { key: "track_clicks", label: "Clicks", hint: "where on the screen and on which control" },
  { key: "track_mouse", label: "Mouse movement", hint: "sampled pointer traces for the replay and heatmap" },
  { key: "track_scroll", label: "Scrolling", hint: "how far down a page people get; wheel use in the viewer" },
  { key: "track_keys", label: "Keyboard shortcuts", hint: "key names only, never anything typed into a field" },
  { key: "track_errors", label: "Errors", hint: "JavaScript errors, with the screen they happened on" },
];

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** `<input type="datetime-local">`'s own value format, in the browser's
 * local time zone (what the picker shows and edits) -- "now" by
 * default, or a value shifted back by `hoursAgo`. */
function localDateTimeInput(hoursAgo = 0): string {
  const d = new Date(Date.now() - hoursAgo * 3600_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** A specific day-and-hour window, for drilling into exactly when
 * something happened rather than "the last N days" -- e.g. one
 * afternoon a person reported trouble in. Sits next to the quick-range
 * buttons; picking a "From" here takes over from them (a day-range
 * button click clears it back out, in the parent). */
function CalendarPicker({ range, onChange }: { range: UsageRange; onChange: (r: UsageRange) => void }) {
  const active = "from" in range;
  const from = active ? (range as { from: string }).from : "";
  const to = active ? ((range as { to?: string }).to ?? "") : "";

  function openDefault() {
    onChange({ from: localDateTimeInput(24), to: localDateTimeInput(0) });
  }

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-1" data-testid="usage-calendar">
      <label className="text-xs text-gray-500" htmlFor="usage-from">
        📅 From
      </label>
      <input
        id="usage-from"
        type="datetime-local"
        className="input h-8 py-0 text-sm"
        value={from}
        max={to || undefined}
        onChange={(e) => (e.target.value ? onChange({ from: e.target.value, to: to || undefined }) : onChange({ days: 30 }))}
        onFocus={() => !active && openDefault()}
        data-testid="usage-from-input"
      />
      <label className="text-xs text-gray-500" htmlFor="usage-to">
        to
      </label>
      <input
        id="usage-to"
        type="datetime-local"
        className="input h-8 py-0 text-sm"
        value={to}
        min={from || undefined}
        disabled={!active}
        onChange={(e) => onChange({ from, to: e.target.value || undefined })}
        data-testid="usage-to-input"
      />
      {active && (
        <button type="button" className="text-xs text-gray-400 hover:text-gray-600" onClick={() => onChange({ days: 30 })} data-testid="usage-calendar-clear" aria-label="Clear custom range">
          ✕
        </button>
      )}
    </div>
  );
}

/** Platform admin's usage analytics: how everyone really works in
 * admin-ui and the viewer, with the recording switches. See
 * admin-service's app/usage package for what each figure means. */
export default function UsagePage() {
  const [range, setRange] = useState<UsageRange>({ days: 30 });
  // Two independent pickers for the same `range`: the quick presets and
  // the calendar. Editing the calendar's own fields is what puts it in
  // control -- see CalendarPicker's onChange -- so both can share the
  // header without fighting over which one "wins".
  const [userFilter, setUserFilter] = useState<string>("");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  // The immediately preceding period of the same length -- what the
  // stat tiles' "vs. last period" deltas compare against. Best-effort:
  // if it fails to load the tiles still render, just without deltas.
  const [previous, setPrevious] = useState<UsageSummary | null>(null);
  const [settings, setSettings] = useState<UsageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heatRoute, setHeatRoute] = useState<string>("");
  const [heatmap, setHeatmap] = useState<UsageHeatmap | null>(null);
  const [sessionsFor, setSessionsFor] = useState<{ user_id: string; username: string } | null>(null);
  const [sessions, setSessions] = useState<UsageSession[] | null>(null);
  const [session, setSession] = useState<UsageSessionDetail | null>(null);
  useRegisterGuide("usage", USAGE_STEPS, summary !== null, false);
  const rangeKey = JSON.stringify(range);

  function refreshSummary() {
    getUsageSummary(range, userFilter || null)
      .then(setSummary)
      .catch((err) => setError(describeApiError(err)));
    setPrevious(null);
    getUsageSummary(previousRange(range), userFilter || null)
      .then(setPrevious)
      .catch(() => undefined);
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeKey is range's stable identity
  useEffect(refreshSummary, [rangeKey, userFilter]);
  useEffect(() => {
    getUsageSettings()
      .then(setSettings)
      .catch((err) => setError(describeApiError(err)));
  }, []);

  useEffect(() => {
    if (!summary) return;
    if (!heatRoute || !summary.routes.some((r) => r.route === heatRoute)) {
      setHeatRoute(summary.routes[0]?.route ?? "");
    }
  }, [summary, heatRoute]);

  useEffect(() => {
    if (!heatRoute) {
      setHeatmap(null);
      return;
    }
    getUsageHeatmap(heatRoute, range, userFilter || null)
      .then(setHeatmap)
      .catch((err) => setError(describeApiError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeKey is range's stable identity
  }, [heatRoute, rangeKey, userFilter]);

  function openUserSessions(user_id: string, username: string) {
    setSessionsFor({ user_id, username });
    setSession(null);
    setSessions(null);
    listUsageSessions(range, user_id)
      .then(setSessions)
      .catch((err) => setError(describeApiError(err)));
  }

  function openSession(sessionId: string) {
    setSession(null);
    getUsageSession(sessionId)
      .then(setSession)
      .catch((err) => setError(describeApiError(err)));
  }

  async function toggleUser(user_id: string, enabled: boolean) {
    try {
      setSettings(await setUsageUserSwitch(user_id, enabled));
      refreshSummary();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  const users = summary?.users ?? [];

  return (
    <div className="space-y-6" data-testid="usage-page">
      <PageHeader
        title="Usage"
        subtitle="How people actually work in the platform -- where the time goes, what they click, where they get stuck. Recorded for every signed-in person; never patient data or anything typed."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <select className="input" value={userFilter} onChange={(e) => setUserFilter(e.target.value)} aria-label="Person" data-testid="usage-user-filter">
              <option value="">Everyone</option>
              {users.map((u) => (
                <option key={u.user_id} value={u.user_id}>
                  {u.username}
                </option>
              ))}
            </select>
            <div className="flex rounded-md border border-gray-200 bg-white" role="group" aria-label="Range">
              {RANGES.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRange({ days: n })}
                  className={`px-3 py-1.5 text-sm ${"days" in range && range.days === n ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-50"}`}
                  data-testid={`usage-range-${n}`}
                >
                  {n} d
                </button>
              ))}
            </div>
            <CalendarPicker range={range} onChange={setRange} />
          </div>
        }
      />
      {"from" in range && (
        <p className="text-sm text-gray-500" data-testid="usage-range-label">
          Showing {formatWhen(range.from)} – {range.to ? formatWhen(range.to) : "now"}
        </p>
      )}
      {error && <div className="alert-error">{error}</div>}

      {settings && <RecordingCard settings={settings} onSaved={setSettings} onError={setError} />}

      {summary && (
        <>
          <StatTiles summary={summary} previous={previous} />
          <div className="grid gap-6 lg:grid-cols-2">
            <RoutesCard summary={summary} />
            <PathsCard summary={summary} />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <ActionsCard summary={summary} />
            <HeatmapCard summary={summary} route={heatRoute} onRoute={setHeatRoute} heatmap={heatmap} />
          </div>
          <FrictionCard summary={summary} />
          <PeopleCard
            summary={summary}
            settings={settings}
            onOpen={openUserSessions}
            onToggle={toggleUser}
          />
          {sessionsFor && (
            <SessionsCard
              who={sessionsFor}
              sessions={sessions}
              selected={session?.session_id ?? null}
              onOpen={openSession}
              onClose={() => {
                setSessionsFor(null);
                setSession(null);
              }}
            />
          )}
          {session && <ReplayCard session={session} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- recording switches

function RecordingCard({ settings, onSaved, onError }: { settings: UsageSettings; onSaved: (s: UsageSettings) => void; onError: (m: string) => void }) {
  const [form, setForm] = useState<UsageSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(settings), [settings]);
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);

  async function save() {
    setBusy(true);
    setSaved(false);
    try {
      const next = await updateUsageSettings({
        enabled: form.enabled,
        track_pages: form.track_pages,
        track_actions: form.track_actions,
        track_clicks: form.track_clicks,
        track_mouse: form.track_mouse,
        track_scroll: form.track_scroll,
        track_keys: form.track_keys,
        track_errors: form.track_errors,
        mouse_sample_ms: form.mouse_sample_ms,
        retention_days: form.retention_days,
      });
      onSaved(next);
      setSaved(true);
    } catch (err) {
      onError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  const excluded = settings.disabled_user_ids.length;
  return (
    <div className="card" data-guide="usage-recording" data-testid="usage-recording">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="section-title mb-0">Recording</h2>
          <p className="hint">
            {settings.enabled
              ? excluded
                ? `Recording everyone except ${excluded} ${excluded === 1 ? "person" : "people"} (switched off in the People table).`
                : "Recording everyone. Switch a single person off in the People table."
              : "Recording is off for everyone."}{" "}
            Open tabs pick up a change within five minutes.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} data-testid="usage-switch-enabled" />
          Record usage
        </label>
      </div>
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        {CATEGORIES.map((c) => (
          <label key={c.key} className={`flex items-start gap-2 text-sm ${form.enabled ? "" : "opacity-50"}`} title={c.hint}>
            <input
              type="checkbox"
              className="mt-0.5"
              checked={Boolean(form[c.key])}
              disabled={!form.enabled}
              onChange={(e) => setForm({ ...form, [c.key]: e.target.checked })}
              data-testid={`usage-switch-${c.key}`}
            />
            <span>
              {c.label}
              <span className="block text-xs text-gray-500">{c.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div className="field">
          <label className="label" htmlFor="usage-sample">
            Mouse sample every (ms)
          </label>
          <input
            id="usage-sample"
            type="number"
            className="input w-32"
            min={20}
            max={2000}
            value={form.mouse_sample_ms}
            onChange={(e) => setForm({ ...form, mouse_sample_ms: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="usage-retention">
            Keep events for (days)
          </label>
          <input
            id="usage-retention"
            type="number"
            className="input w-32"
            min={1}
            max={3650}
            value={form.retention_days}
            onChange={(e) => setForm({ ...form, retention_days: Number(e.target.value) })}
          />
        </div>
        <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={save} data-testid="usage-save-settings">
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && !dirty && <span className="text-sm text-green-700">Saved.</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tiles

/** Which direction is an improvement, for coloring a tile's delta chip
 * -- "up" and "down" get green/red, "neutral" tiles (sessions, avg
 * session length: neither direction is obviously good or bad on its
 * own) just show the number with no judgement. */
type Better = "up" | "down" | "neutral";

function DeltaChip({ current, previous, better }: { current: number | null; previous: number | null; better: Better }) {
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

function StatTiles({ summary, previous }: { summary: UsageSummary; previous: UsageSummary | null }) {
  const t = summary.totals;
  const p = previous?.totals;
  const pt = previous?.tasks;
  const tiles: { label: string; value: string; sub?: string; current: number | null; previous: number | null; better: Better }[] = [
    { label: "Active people", value: String(t.active_users), current: t.active_users, previous: p?.active_users ?? null, better: "up" },
    { label: "Sessions", value: String(t.sessions), current: t.sessions, previous: p?.sessions ?? null, better: "neutral" },
    { label: "Avg session", value: formatDuration(t.avg_session_ms), current: t.avg_session_ms, previous: p?.avg_session_ms ?? null, better: "neutral" },
    {
      label: "Median time to annotate",
      value: formatDuration(summary.tasks.annotate.median_ms),
      sub: `${summary.tasks.annotate.count} cases`,
      current: summary.tasks.annotate.median_ms,
      previous: pt?.annotate.median_ms ?? null,
      better: "down",
    },
    {
      label: "Median time to review",
      value: formatDuration(summary.tasks.review.median_ms),
      sub: `${summary.tasks.review.count} cases`,
      current: summary.tasks.review.median_ms,
      previous: pt?.review.median_ms ?? null,
      better: "down",
    },
    { label: "Errors", value: String(t.errors), current: t.errors, previous: p?.errors ?? null, better: "down" },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6" data-testid="usage-tiles">
      {tiles.map((tile) => (
        <div key={tile.label} className="stat-card">
          <div className="stat-value tabular-nums">{tile.value}</div>
          <div className="stat-label">{tile.label}</div>
          {tile.sub && <div className="text-xs text-gray-400">{tile.sub}</div>}
          <div className="mt-1" data-testid={`usage-tile-delta-${tile.label.toLowerCase().replace(/\s+/g, "-")}`}>
            <DeltaChip current={tile.current} previous={tile.previous} better={tile.better} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- bars

function BarList({ rows, max, testId }: { rows: { key: string; label: string; value: number; display: string; note?: string }[]; max: number; testId: string }) {
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

function RoutesCard({ summary }: { summary: UsageSummary }) {
  const rows = summary.routes.slice(0, 12);
  const max = rows[0]?.total_ms ?? 0;
  return (
    <div className="card" data-guide="usage-routes" data-testid="usage-routes">
      <h2 className="section-title">Where the time goes</h2>
      <p className="hint mb-3">Total time per screen in the last {summary.days} days, with how often it was opened and the average stay.</p>
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
      <h2 className="section-title">Viewer tools & actions</h2>
      <p className="hint mb-3">Which tools and buttons get used -- and which never do.</p>
      <BarList testId="usage-actions-list" max={max} rows={rows.map((a) => ({ key: a.name, label: a.name, value: a.count, display: String(a.count) }))} />
    </div>
  );
}

function PathsCard({ summary }: { summary: UsageSummary }) {
  return (
    <div className="card" data-testid="usage-paths">
      <h2 className="section-title">Common paths</h2>
      <p className="hint mb-3">The screen-to-screen moves people make most.</p>
      {summary.transitions.length === 0 ? (
        <EmptyState message="No navigation recorded in this range yet." />
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="py-1.5 pr-2">From</th>
                <th className="py-1.5 pr-2">To</th>
                <th className="py-1.5 text-right">Times</th>
                <th className="py-1.5 text-right">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {summary.transitions.map((t) => (
                <tr key={`${t.from}>${t.to}`} className="border-t border-gray-100">
                  <td className="py-1.5 pr-2 font-mono text-xs">{t.from}</td>
                  <td className="py-1.5 pr-2 font-mono text-xs">{t.to}</td>
                  <td className="py-1.5 text-right tabular-nums">{t.count}</td>
                  <td className="py-1.5 text-right tabular-nums">{t.sessions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- heatmap

function HeatmapCard({ summary, route, onRoute, heatmap }: { summary: UsageSummary; route: string; onRoute: (r: string) => void; heatmap: UsageHeatmap | null }) {
  return (
    <div className="card" data-testid="usage-heatmap">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="section-title mb-0">Click heatmap</h2>
          <p className="hint">Every click on one screen, on a window scaled to 16:9.</p>
        </div>
        <select className="input" value={route} onChange={(e) => onRoute(e.target.value)} aria-label="Screen" data-testid="usage-heatmap-route">
          {summary.routes.map((r) => (
            <option key={r.route} value={r.route}>
              {r.route}
            </option>
          ))}
        </select>
      </div>
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
          <p className="hint mt-2">{heatmap.points.length} clicks in the last {heatmap.days} days.</p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- friction

function FrictionList({ title, hint, rows, unit, rate }: { title: string; hint: string; rows: UsageFrictionRow[]; unit: keyof UsageFrictionRow; rate?: boolean }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      <p className="mb-2 text-xs text-gray-500">{hint}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-400">None in this range.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.slice(0, 5).map((r) => (
            <li key={r.route} className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-xs text-gray-700">{r.route}</span>
              <span className="shrink-0 tabular-nums">
                {rate && r.rate !== null && r.rate !== undefined && <span className="badge badge-red mr-1">{Math.round(r.rate * 100)}%</span>}
                {String(r[unit] ?? 0)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FrictionCard({ summary }: { summary: UsageSummary }) {
  const f = summary.friction;
  return (
    <div className="card" data-guide="usage-friction" data-testid="usage-friction">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="section-title mb-0">Friction signals</h2>
          <p className="hint">Where the interface is making someone think. Idle time was {Math.round(f.idle_share * 100)}% of all session time.</p>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-5">
        <FrictionList title="Bounces" hint="Left within 3 seconds, then went somewhere else." rows={f.bounces} unit="bounces" rate />
        <FrictionList title="Back and forth" hint="Returned to the screen visited two steps earlier." rows={f.back_and_forth} unit="returns" rate />
        <FrictionList title="Rage clicks" hint="3+ clicks within half a second on the same spot." rows={f.rage_clicks} unit="bursts" />
        <FrictionList title="Dead clicks" hint="Clicks nothing followed within 2 seconds." rows={f.dead_clicks} unit="clicks" />
        <FrictionList title="Errors" hint="JavaScript errors by screen." rows={f.errors} unit="errors" />
      </div>
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
      <h2 className="section-title">People</h2>
      <p className="hint mb-3">One row per person. Open a row for their sessions and a replay of each.</p>
      {summary.users.length === 0 ? (
        <EmptyState message="Nobody has been recorded in this range yet." />
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="py-1.5 pr-2">Person</th>
                <th className="py-1.5 pr-2">Recording</th>
                <th className="py-1.5 text-right">Sessions</th>
                <th className="py-1.5 text-right">Total time</th>
                <th className="py-1.5 text-right">Pages / session</th>
                <th className="py-1.5 text-right">Avg stay</th>
                <th className="py-1.5 text-right" title="Share of navigations that went straight back to the previous screen">
                  Back & forth
                </th>
                <th className="py-1.5 text-right">Clicks / min</th>
                <th className="py-1.5 text-right" title="Pointer travel per page, in pixels">
                  Mouse px / page
                </th>
                <th className="py-1.5 text-right">Annotated</th>
                <th className="py-1.5 text-right">Reviewed</th>
                <th className="py-1.5 text-right">Errors</th>
                <th className="py-1.5 pl-2">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {summary.users.map((u) => (
                <tr key={u.user_id} className="border-t border-gray-100 hover:bg-gray-50" data-testid={`usage-user-${u.username}`}>
                  <td className="py-1.5 pr-2">
                    <button type="button" className="font-medium text-blue-700 hover:underline" onClick={() => onOpen(u.user_id, u.username)} data-testid={`usage-open-${u.username}`}>
                      {u.username}
                    </button>
                    {u.email && <div className="text-xs text-gray-400">{u.email}</div>}
                  </td>
                  <td className="py-1.5 pr-2">
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" checked={!disabled.has(u.user_id)} onChange={(e) => onToggle(u.user_id, e.target.checked)} aria-label={`Record ${u.username}`} />
                      {disabled.has(u.user_id) ? "off" : "on"}
                    </label>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{u.sessions}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatDuration(u.total_ms)}</td>
                  <td className="py-1.5 text-right tabular-nums">{u.pages_per_session}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatDuration(u.avg_dwell_ms)}</td>
                  <td className="py-1.5 text-right tabular-nums">{Math.round(u.back_and_forth * 100)}%</td>
                  <td className="py-1.5 text-right tabular-nums">{u.clicks_per_min}</td>
                  <td className="py-1.5 text-right tabular-nums">{u.mouse_px_per_page}</td>
                  <td className="py-1.5 text-right tabular-nums">{u.annotated}</td>
                  <td className="py-1.5 text-right tabular-nums">{u.reviewed}</td>
                  <td className="py-1.5 text-right tabular-nums">{u.errors}</td>
                  <td className="py-1.5 pl-2 text-xs text-gray-500">{formatWhen(u.last_seen_at)}</td>
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
  onOpen,
  onClose,
}: {
  who: { user_id: string; username: string };
  sessions: UsageSession[] | null;
  selected: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="card" data-testid="usage-sessions">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="section-title mb-0">Sessions · {who.username}</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
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
  const [pageIndex, setPageIndex] = useState(0);
  const [progress, setProgress] = useState(1);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    setPageIndex(0);
    setProgress(1);
    setPlaying(false);
  }, [session.session_id]);
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
      <h2 className="section-title">
        Replay · {session.username} · {session.app}
      </h2>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <select className="input" value={pageIndex} onChange={(e) => { setPageIndex(Number(e.target.value)); setProgress(1); setPlaying(false); }} aria-label="Page" data-testid="usage-replay-page">
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
