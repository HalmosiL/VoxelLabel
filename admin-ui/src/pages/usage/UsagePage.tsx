import { useEffect, useRef, useState } from "react";

import {
  getUsageHeatmap,
  getUsageOverview,
  getUsageSession,
  getUsageSettings,
  listUsagePeople,
  listUsageSessions,
  setUsageUserSwitch,
  UsageHeatmap,
  UsageOverview,
  UsagePerson,
  UsageRange,
  UsageSession,
  UsageSessionDetail,
  UsageSettings,
  UsageTab,
} from "../../api/adminApi";
import { describeApiError } from "../../api/client";
import PageHeader from "../../components/PageHeader";
import { USAGE_STEPS } from "../../guide/adminSteps";
import { useRegisterGuide } from "../../guide/GuideContext";
import BehaviourTab from "./BehaviourTab";
import FrictionTab from "./FrictionTab";
import OverviewTab from "./OverviewTab";
import PeopleTab from "./PeopleTab";
import SettingsTab from "./SettingsTab";
import { formatWhen } from "./shared";

const RANGES = [7, 30, 90] as const;

/** Each tab is the answer to one question -- that's the organising
 * principle, not which table the data came from. */
const TABS: { key: UsageTab; label: string; question: string }[] = [
  { key: "overview", label: "Overview", question: "Is it getting better or worse, and where should I look first?" },
  { key: "behaviour", label: "Behaviour", question: "How do people actually work?" },
  { key: "friction", label: "Friction", question: "Where do they struggle?" },
  { key: "people", label: "People", question: "Who, specifically?" },
  { key: "settings", label: "Settings", question: "What gets recorded, and whose activity counts in the figures?" },
];

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
    <div className="flex max-w-full flex-wrap items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-1 sm:flex-nowrap" data-testid="usage-calendar">
      <label className="text-xs text-gray-500" htmlFor="usage-from">
        📅 From
      </label>
      <input
        id="usage-from"
        type="datetime-local"
        className="input h-8 w-full min-w-0 py-0 text-sm sm:w-52"
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
        className="input h-8 w-full min-w-0 py-0 text-sm sm:w-52"
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
 * admin-ui and the viewer, organised as five questions (the tabs), with
 * the page's own findings on the Overview and every dataset exportable.
 * One /admin/usage/overview call per window and person carries every
 * figure (see admin-service's app/usage and app/pipeline_health). */
export default function UsagePage() {
  const [tab, setTab] = useState<UsageTab>("overview");
  const [range, setRange] = useState<UsageRange>({ days: 30 });
  const [userFilter, setUserFilter] = useState<string>("");
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<UsageSettings | null>(null);
  const [people, setPeople] = useState<UsagePerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heatRoute, setHeatRoute] = useState<string>("");
  const [heatmap, setHeatmap] = useState<UsageHeatmap | null>(null);
  const [sessionsFor, setSessionsFor] = useState<{ user_id: string; username: string } | null>(null);
  const [sessions, setSessions] = useState<UsageSession[] | null>(null);
  const [session, setSession] = useState<UsageSessionDetail | null>(null);
  const summary = overview?.summary ?? null;
  useRegisterGuide("usage", USAGE_STEPS, summary !== null && tab === "overview", false);
  const rangeKey = JSON.stringify(range);
  // Responses can land out of order -- a wide window takes longer than
  // the narrow one picked a moment later -- so every fetch is stamped
  // and only the newest stamp may write state.
  const overviewSeq = useRef(0);
  const heatmapSeq = useRef(0);
  const sessionsSeq = useRef(0);

  function refreshOverview() {
    const seq = ++overviewSeq.current;
    setLoading(true);
    getUsageOverview(range, userFilter || null)
      .then((o) => {
        if (seq !== overviewSeq.current) return;
        setOverview(o);
        setError(null);
      })
      .catch((err) => seq === overviewSeq.current && setError(describeApiError(err)))
      .finally(() => seq === overviewSeq.current && setLoading(false));
  }

  function refreshPeople() {
    listUsagePeople()
      .then(setPeople)
      .catch((err) => setError(describeApiError(err)));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeKey is range's stable identity
  useEffect(refreshOverview, [rangeKey, userFilter]);
  useEffect(() => {
    getUsageSettings()
      .then(setSettings)
      .catch((err) => setError(describeApiError(err)));
    refreshPeople();
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
    const seq = ++heatmapSeq.current;
    getUsageHeatmap(heatRoute, range, userFilter || null)
      .then((h) => seq === heatmapSeq.current && setHeatmap(h))
      .catch((err) => seq === heatmapSeq.current && setError(describeApiError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeKey is range's stable identity
  }, [heatRoute, rangeKey, userFilter]);

  function loadSessions(who: { user_id: string; username: string }, replayLatest: boolean) {
    const seq = ++sessionsSeq.current;
    setSessions(null);
    listUsageSessions(range, who.user_id)
      .then((list) => {
        if (seq !== sessionsSeq.current) return;
        setSessions(list);
        setSession((current) => (current && list.some((s) => s.session_id === current.session_id) ? current : null));
        // "Replay": straight into their newest sitting that has pages to show.
        const latest = replayLatest ? list.find((s) => s.page_views > 0) : undefined;
        if (latest) openSession(latest.session_id);
      })
      .catch((err) => setError(describeApiError(err)));
  }

  // The session list belongs to the window it was opened for: a new
  // window reloads it, and drops an open replay that isn't in it.
  useEffect(() => {
    if (sessionsFor) loadSessions(sessionsFor, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the window changes
  }, [rangeKey]);

  function openUserSessions(user_id: string, username: string, replayLatest = false) {
    setTab("people");
    const who = { user_id, username };
    setSessionsFor(who);
    setSession(null);
    loadSessions(who, replayLatest);
  }

  function openSession(sessionId: string) {
    setSession(null);
    getUsageSession(sessionId)
      .then(setSession)
      .catch((err) => setError(describeApiError(err)));
  }

  async function switchPerson(user_id: string, change: { enabled?: boolean; counted?: boolean }) {
    // Flip the switch on screen at once; the server's answer (or a
    // failure, which puts it back) follows.
    const before = people;
    setPeople((list) =>
      (list ?? []).map((p) =>
        p.user_id !== user_id
          ? p
          : {
              ...p,
              ...(change.enabled !== undefined ? { recorded: change.enabled } : {}),
              ...(change.counted !== undefined ? { counted_switch: change.counted, counted: change.counted && !(p.is_admin && settings?.exclude_admins) } : {}),
            }
      )
    );
    try {
      setSettings(await setUsageUserSwitch(user_id, change));
      refreshPeople();
      refreshOverview();
    } catch (err) {
      setPeople(before);
      setError(describeApiError(err));
    }
  }

  function settingsSaved(next: UsageSettings) {
    setSettings(next);
    refreshPeople();
    refreshOverview();
  }

  // Everyone who counts, whether or not they did anything in this
  // window -- so a chosen person never silently drops out of the list.
  const choosable = (people ?? []).filter((p) => p.counted || p.user_id === userFilter);
  const findings = overview ? { since: overview.since, until: overview.until, findings: overview.findings, friction_score: overview.summary.friction_score } : null;
  const attention = overview?.findings.filter((f) => f.severity === "critical" || f.severity === "warn").length ?? 0;
  const chosen = choosable.find((p) => p.user_id === userFilter);

  return (
    <div className="space-y-5" data-testid="usage-page">
      <PageHeader title="Usage" subtitle="How people actually work in the platform: where the time goes, what they click, where they get stuck, and how long a case really takes." />
      <div className="flex flex-wrap items-center gap-2" data-testid="usage-toolbar">
            <select className="input w-48 max-w-full" value={userFilter} onChange={(e) => setUserFilter(e.target.value)} aria-label="Person" data-testid="usage-user-filter">
              <option value="">Everyone</option>
              {choosable.map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.username}
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
      <p className="text-sm text-gray-500" data-testid="usage-range-label">
        {"from" in range ? `Showing ${formatWhen(range.from)} – ${range.to ? formatWhen(range.to) : "now"}` : `Showing the last ${range.days} days`}
        {chosen ? ` · only ${chosen.username}` : " · everyone"}
        {summary && (
          <span data-testid="usage-basis">
            {" "}
            · {summary.basis.people} {summary.basis.people === 1 ? "person" : "people"}, {summary.basis.sessions} sessions, {summary.basis.events.toLocaleString()} events
            {summary.basis.not_counted > 0 && (
              <>
                {" "}
                ·{" "}
                <button type="button" className="underline decoration-dotted hover:text-gray-700" onClick={() => setTab("settings")} title="Recorded, but left out of every figure -- change it in Settings">
                  {summary.basis.not_counted} {summary.basis.not_counted === 1 ? "account" : "accounts"} not counted{summary.basis.admins_left_out ? " (admins, test accounts)" : ""}
                </button>
              </>
            )}
          </span>
        )}
        {loading && <span className="ml-2 text-gray-400">updating…</span>}
      </p>
      {error && <div className="alert-error">{error}</div>}

      <div className="flex flex-wrap border-b border-gray-200/70" role="tablist" aria-label="Usage sections" data-testid="usage-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            title={t.question}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.key ? "border-blue-600 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
            data-testid={`usage-tab-${t.key}`}
            data-guide={`usage-tab-${t.key}`}
          >
            {t.label}
            {t.key === "overview" && attention > 0 && (
              <span className="badge badge-red" title={`${attention} findings need attention`}>
                {attention}
              </span>
            )}
          </button>
        ))}
      </div>
      <p className="-mt-3 text-xs text-gray-400" data-testid="usage-tab-question">
        {TABS.find((t) => t.key === tab)?.question}
      </p>

      {overview && summary && tab === "overview" && (
        <OverviewTab
          summary={summary}
          previous={overview.previous}
          findings={findings}
          pipelineHealth={overview.pipeline}
          pipelineHealthPrevious={overview.pipeline_previous}
          learningCurve={overview.learning_curve}
          range={range}
          userFilter={userFilter}
          personName={chosen?.username ?? null}
          onGoTo={setTab}
          onError={setError}
        />
      )}
      {summary && tab === "behaviour" && <BehaviourTab summary={summary} heatRoute={heatRoute} onHeatRoute={setHeatRoute} heatmap={heatmap} />}
      {overview && summary && tab === "friction" && <FrictionTab summary={summary} pipelineHealth={overview.pipeline} personName={chosen?.username ?? null} />}
      {overview && summary && tab === "people" && (
        <PeopleTab
          summary={summary}
          learningCurve={overview.learning_curve}
          sessionsFor={sessionsFor}
          sessions={sessions}
          session={session}
          onOpenUser={openUserSessions}
          onOpenSession={openSession}
          onCloseSessions={() => {
            setSessionsFor(null);
            setSession(null);
          }}
        />
      )}
      {tab === "settings" && settings && <SettingsTab settings={settings} people={people} onSaved={settingsSaved} onSwitch={switchPerson} onOpenSessions={(id, name) => openUserSessions(id, name)} onError={setError} />}
      {!summary && tab !== "settings" && <p className="hint">Loading…</p>}
    </div>
  );
}
