import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getStudy, Study } from "../../api/adminApi";
import { describeApiError } from "../../api/client";
import { getStudyAnalytics, StudyAnalytics } from "../../api/studyAnalyticsApi";
import { getWorkflowBoard, WorkflowBoard } from "../../api/workflowApi";
import PageHeader from "../../components/PageHeader";
import { STUDY_ANALYTICS_STEPS } from "../../guide/adminSteps";
import { useRegisterGuide } from "../../guide/GuideContext";
import { formatDuration, formatShortWhen } from "../usage/shared";
import { CasesSection, LabelsSection, PeopleSection, STATE_CHIP, STATE_LABEL, WeeklyCard } from "./sections";
import WorkflowStatsGraph from "./WorkflowStatsGraph";

type Tab = "workflow" | "cases" | "labels" | "people";
const TABS: { key: Tab; label: string; question: string }[] = [
  { key: "workflow", label: "Workflow", question: "How did cases move through the board, and where do they wait?" },
  { key: "cases", label: "Cases", question: "Where does each case stand, and how many rounds did it take?" },
  { key: "labels", label: "Labels", question: "What was drawn, and what gets rejected?" },
  { key: "people", label: "People", question: "Who did what, and how much time went into it?" },
];

function Tile({ value, label, sub, title, testId }: { value: string; label: string; sub?: string; title: string; testId: string }) {
  return (
    <div className="stat-card" title={title} data-testid={testId}>
      <div className="min-w-0">
        <div className="stat-value tabular-nums">{value}</div>
        <div className="stat-label">{label}</div>
        {sub && <div className="text-xs text-gray-400">{sub}</div>}
      </div>
    </div>
  );
}

/** One study's workflow analytics: what happened to its cases on the
 * board -- rounds, rework, time, what was drawn and who did it. For the
 * study's admins and data managers. See admin-service's
 * app/study_analytics for how each figure is built. */
export default function StudyAnalyticsPage() {
  const { studyId = "" } = useParams<{ studyId: string }>();
  const [study, setStudy] = useState<Study | null>(null);
  const [data, setData] = useState<StudyAnalytics | null>(null);
  const [board, setBoard] = useState<WorkflowBoard | null>(null);
  const [tab, setTab] = useState<Tab>("workflow");
  const [error, setError] = useState<string | null>(null);
  useRegisterGuide("study-analytics", STUDY_ANALYTICS_STEPS, data !== null && board !== null);

  useEffect(() => {
    getStudy(studyId).then(setStudy).catch((err) => setError(describeApiError(err)));
    getStudyAnalytics(studyId).then(setData).catch((err) => setError(describeApiError(err)));
    getWorkflowBoard(studyId).then(setBoard).catch((err) => setError(describeApiError(err)));
  }, [studyId]);

  const h = data?.headline;
  const name = study?.name ?? "Study";
  const approvedShare = h && h.cases ? Math.round((h.states.approved / h.cases) * 100) : 0;
  return (
    <div className="space-y-5" data-testid="study-analytics-page">
      <PageHeader
        title={`${name} · analytics`}
        subtitle="How this study's cases went through its workflow: how long each step took, how often cases went back and forth, what was drawn, and who did the work."
        action={
          <div className="flex items-center gap-2">
            <Link to={`/studies/${studyId}`} className="btn-secondary btn-sm">
              ← Study
            </Link>
            <Link to={`/studies/${studyId}/workflow`} className="btn-secondary btn-sm">
              Workflow board
            </Link>
          </div>
        }
      />
      {error && <div className="alert-error">{error}</div>}
      {!data || !h ? (
        !error && <p className="hint">Loading…</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-guide="analytics-tiles" data-testid="analytics-tiles">
            <Tile
              testId="analytics-tile-progress"
              value={`${h.states.approved} / ${h.cases}`}
              label="Cases approved"
              sub={`${approvedShare}% done`}
              title="Cases of this study that entered the workflow (or were annotated), and how many are approved"
            />
            <Tile
              testId="analytics-tile-lead"
              value={formatDuration(h.lead_time_median_ms)}
              label="Lead time per case"
              sub="median, entered → approved"
              title="Calendar time from a case entering the first Annotation card to its approval -- nights, weekends and every round included"
            />
            <Tile
              testId="analytics-tile-first-pass"
              value={h.first_pass_rate === null ? "–" : `${Math.round(h.first_pass_rate * 100)}%`}
              label="Passed review first time"
              sub={h.rounds_median === null ? undefined : `approved cases took ${h.rounds_median} ${h.rounds_median === 1 ? "round" : "rounds"} (median)`}
              title="Share of reviewed cases approved at their first review"
            />
            <Tile
              testId="analytics-tile-hands-on"
              value={formatDuration(h.hands_on_total_ms)}
              label="Hands-on time in total"
              sub={`${formatDuration(h.annotate_per_case_median_ms)} annotating · ${formatDuration(h.review_per_case_median_ms)} reviewing per case`}
              title="Active time spent in the viewer on this study's jobs, idle stretches left out; per case figures are medians"
            />
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs" data-testid="analytics-states">
            {(["sent_back", "awaiting_review", "in_progress", "not_started", "approved"] as const).map((s) => (
              <span key={s} className={STATE_CHIP[s]} title={s === "sent_back" ? "Rejected at review and not re-submitted yet" : undefined}>
                {STATE_LABEL[s]} <span className="tabular-nums">{h.states[s]}</span>
              </span>
            ))}
            <span className="ml-auto text-gray-400">
              {h.objects} objects drawn · updated {formatShortWhen(data.generated_at)}
            </span>
          </div>

          <div className="flex flex-wrap border-b border-gray-200/70" role="tablist" aria-label="Analytics sections" data-testid="analytics-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                title={t.question}
                onClick={() => setTab(t.key)}
                className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${tab === t.key ? "border-blue-600 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-700"}`}
                data-testid={`analytics-tab-${t.key}`}
                data-guide={`analytics-tab-${t.key}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="-mt-3 text-xs text-gray-400">{TABS.find((t) => t.key === tab)?.question}</p>

          {tab === "workflow" && (
            <div className="space-y-5">
              <div className="card" data-guide="analytics-graph">
                <h2 className="section-title mb-0">The workflow, with what went through it</h2>
                <p className="hint mb-3">
                  The study&apos;s board as it is, with each Annotation and Review card showing the cases that entered, finished and are still open, the median wait and work time, the hands-on time per case, and the review outcome. The numbers on the lines are the
                  cases on each connection -- red is the rejected branch going back for another round.
                </p>
                {board ? <WorkflowStatsGraph board={board} metrics={data.cards} /> : <p className="hint">Loading the board…</p>}
              </div>
              <WeeklyCard data={data} />
            </div>
          )}
          {tab === "cases" && <CasesSection data={data} studyName={name} />}
          {tab === "labels" && <LabelsSection data={data} studyName={name} />}
          {tab === "people" && <PeopleSection data={data} studyName={name} />}
        </>
      )}
    </div>
  );
}
