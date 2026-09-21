import { useEffect, useRef, useState } from "react";

import {
  getLearningCurve,
  getPipelineHealthSummary,
  getUsageFindings,
  getUsageHeatmap,
  getUsageSession,
  getUsageSettings,
  getUsageSummary,
  LearningCurvePoint,
  listUsageSessions,
  PipelineHealthSummary,
  previousRange,
  setUsageUserSwitch,
  UsageFindings,
  UsageHeatmap,
  UsageRange,
  UsageSession,
  UsageSessionDetail,
  UsageSettings,
  UsageSummary,
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
  { key: "settings", label: "Settings", question: "What gets recorded" },
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
 * admin-ui and the viewer, organised as five questions (the tabs), with
 * the page's own findings on the Overview and every dataset exportable.
 * See admin-service's app/usage and app/pipeline_health packages for
 * what each figure means. */
export default function UsagePage() {
  const [tab, setTab] = useState<UsageTab>("overview");
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
  const [findings, setFindings] = useState<UsageFindings | null>(null);
  const [settings, setSettings] = useState<UsageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heatRoute, setHeatRoute] = useState<string>("");
  const [heatmap, setHeatmap] = useState<UsageHeatmap | null>(null);
  const [sessionsFor, setSessionsFor] = useState<{ user_id: string; username: string } | null>(null);
  const [sessions, setSessions] = useState<UsageSession[] | null>(null);
  const [session, setSession] = useState<UsageSessionDetail | null>(null);
  const [pipelineHealth, setPipelineHealth] = useState<PipelineHealthSummary | null>(null);
  const [pipelineHealthPrevious, setPipelineHealthPrevious] = useState<PipelineHealthSummary | null>(null);
  const [learningCurve, setLearningCurve] = useState<LearningCurvePoint[] | null>(null);
  useRegisterGuide("usage", USAGE_STEPS, summary !== null && tab === "overview", false);
  const rangeKey = JSON.stringify(range);
  // Responses can land out of order -- a wide window's summary takes
  // longer than the narrow one picked a moment later -- so every fetch
  // is stamped and only the newest stamp is allowed to write state.
  const summarySeq = useRef(0);
  const pipelineSeq = useRef(0);
  const heatmapSeq = useRef(0);

  function refreshSummary() {
    const seq = ++summarySeq.current;
    const fresh = () => seq === summarySeq.current;
    getUsageSummary(range, userFilter || null)
      .then((s) => fresh() && setSummary(s))
      .catch((err) => fresh() && setError(describeApiError(err)));
    setPrevious(null);
    getUsageSummary(previousRange(range), userFilter || null)
      .then((s) => fresh() && setPrevious(s))
      .catch(() => undefined);
    setFindings(null);
    getUsageFindings(range, userFilter || null)
      .then((f) => fresh() && setFindings(f))
      .catch((err) => fresh() && setError(describeApiError(err)));
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
    const seq = ++pipelineSeq.current;
    const fresh = () => seq === pipelineSeq.current;
    getPipelineHealthSummary(range)
      .then((s) => fresh() && setPipelineHealth(s))
      .catch((err) => fresh() && setError(describeApiError(err)));
    setPipelineHealthPrevious(null);
    getPipelineHealthSummary(previousRange(range))
      .then((s) => fresh() && setPipelineHealthPrevious(s))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeKey is range's stable identity
  }, [rangeKey]);

  useEffect(() => {
    getLearningCurve()
      .then(setLearningCurve)
      .catch((err) => setError(describeApiError(err)));
  }, []);

  useEffect(() => {
    if (!heatRoute) {
      setHeatmap(null);
      return;
    }
    const seq = ++heatmapSeq.current;
    const fresh = () => seq === heatmapSeq.current;
    getUsageHeatmap(heatRoute, range, userFilter || null)
      .then((h) => fresh() && setHeatmap(h))
      .catch((err) => fresh() && setError(describeApiError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeKey is range's stable identity
  }, [heatRoute, rangeKey, userFilter]);

  function openUserSessions(user_id: string, username: string, replayLatest = false) {
    setTab("people");
    setSessionsFor({ user_id, username });
    setSession(null);
    setSessions(null);
    listUsageSessions(range, user_id)
      .then((list) => {
        setSessions(list);
        // "Replay": straight into their newest sitting that has pages to show.
        const latest = replayLatest ? list.find((s) => s.page_views > 0) : undefined;
        if (latest) openSession(latest.session_id);
      })
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
  const attention = findings?.findings.filter((f) => f.severity === "critical" || f.severity === "warn").length ?? 0;

  return (
    <div className="space-y-5" data-testid="usage-page">
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

      {summary && tab === "overview" && (
        <OverviewTab
          summary={summary}
          previous={previous}
          findings={findings}
          pipelineHealth={pipelineHealth}
          pipelineHealthPrevious={pipelineHealthPrevious}
          learningCurve={learningCurve}
          range={range}
          userFilter={userFilter}
          onGoTo={setTab}
          onError={setError}
        />
      )}
      {summary && tab === "behaviour" && <BehaviourTab summary={summary} heatRoute={heatRoute} onHeatRoute={setHeatRoute} heatmap={heatmap} />}
      {summary && tab === "friction" && <FrictionTab summary={summary} pipelineHealth={pipelineHealth} />}
      {summary && tab === "people" && (
        <PeopleTab
          summary={summary}
          settings={settings}
          learningCurve={learningCurve}
          sessionsFor={sessionsFor}
          sessions={sessions}
          session={session}
          onOpenUser={openUserSessions}
          onOpenSession={openSession}
          onCloseSessions={() => {
            setSessionsFor(null);
            setSession(null);
          }}
          onToggle={toggleUser}
        />
      )}
      {tab === "settings" && settings && <SettingsTab settings={settings} onSaved={setSettings} onError={setError} />}
      {!summary && tab !== "settings" && <p className="hint">Loading…</p>}
    </div>
  );
}
