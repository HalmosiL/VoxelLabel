import { useState } from "react";

import { CaseState, StudyAnalytics, StudyCaseRow } from "../../api/studyAnalyticsApi";
import EmptyState from "../../components/EmptyState";
import { CardHeader, DownloadCsvButton, formatDuration, formatShortWhen } from "../usage/shared";

export const STATE_LABEL: Record<CaseState, string> = {
  sent_back: "Sent back",
  awaiting_review: "Awaiting review",
  in_progress: "Being annotated",
  not_started: "Not started",
  approved: "Approved",
};

export const STATE_CHIP: Record<CaseState, string> = {
  sent_back: "badge-red",
  awaiting_review: "badge bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200",
  in_progress: "badge-blue",
  not_started: "badge-gray",
  approved: "badge-green",
};

const REASON_LABEL: Record<string, string> = {
  boundary: "boundary off",
  missed: "missed finding",
  wrong_label: "wrong label",
  not_a_finding: "not a finding",
  form: "form answers",
  other: "other",
  untagged: "no reason tagged",
};

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);

function csvName(studyName: string, dataset: string): string {
  const slug = studyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "study";
  return `${slug}-${dataset}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.csv`;
}

// ---------------------------------------------------------------- weekly throughput

const SERIES = [
  { key: "submitted", label: "Submitted for review", color: "#2563eb" },
  { key: "approved", label: "Approved", color: "#059669" },
  { key: "rejected", label: "Sent back", color: "#dc2626" },
] as const;

export function WeeklyCard({ data }: { data: StudyAnalytics }) {
  const weeks = data.weekly.slice(-16);
  const max = Math.max(1, ...weeks.flatMap((w) => [w.submitted, w.approved, w.rejected]));
  const W = 640;
  const H = 180;
  const PAD_B = 22;
  const PAD_T = 10;
  const slot = weeks.length ? W / weeks.length : W;
  const bar = Math.min(14, (slot - 10) / 3);
  return (
    <div className="card" data-testid="analytics-weekly">
      <CardHeader title="Week by week" hint="Cases sent for review, approved and sent back each week (last 16 weeks). Approvals keeping pace with submissions means the review side is not the bottleneck." />
      {weeks.length === 0 ? (
        <EmptyState message="Nothing submitted or reviewed yet." />
      ) : (
        <>
          <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
            {SERIES.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Cases submitted, approved and sent back per week">
            <line x1={0} x2={W} y1={H - PAD_B} y2={H - PAD_B} stroke="#e5e7eb" />
            {weeks.map((w, i) => {
              const x0 = i * slot + (slot - bar * 3 - 4) / 2;
              return (
                <g key={w.week}>
                  {SERIES.map((s, j) => {
                    const v = w[s.key];
                    const h = ((H - PAD_B - PAD_T) * v) / max;
                    return (
                      <rect key={s.key} x={x0 + j * (bar + 2)} y={H - PAD_B - h} width={bar} height={Math.max(h, v ? 1 : 0)} rx={2} fill={s.color}>
                        <title>{`Week of ${w.week}: ${v} ${s.label.toLowerCase()}`}</title>
                      </rect>
                    );
                  })}
                  <text x={i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="#6b7280">
                    {w.week.slice(5)}
                  </text>
                </g>
              );
            })}
          </svg>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- cases

const STATE_ORDER: CaseState[] = ["sent_back", "awaiting_review", "in_progress", "not_started", "approved"];

function labelSummary(r: StudyCaseRow): string {
  return Object.entries(r.labels)
    .map(([label, n]) => `${n}× ${label}`)
    .join(", ");
}

export function CasesSection({ data, studyName }: { data: StudyAnalytics; studyName: string }) {
  const [filter, setFilter] = useState<CaseState | "all">("all");
  const rows = filter === "all" ? data.cases : data.cases.filter((r) => r.state === filter);
  return (
    <div className="card" data-testid="analytics-cases">
      <CardHeader
        title="Cases"
        hint="Every case in the study's workflow: where it stands, how many rounds it took, how long from entering the workflow to approval, the hands-on time on each side, who worked on it and what was drawn. Open work first."
        actions={
          <DownloadCsvButton
            filename={csvName(studyName, "cases")}
            rows={rows}
            columns={[
              { header: "Case", value: (r) => r.case_title ?? r.case_id },
              { header: "Case id", value: (r) => r.case_id },
              { header: "State", value: (r) => STATE_LABEL[r.state] },
              { header: "Rounds", value: (r) => r.rounds },
              { header: "Sent back", value: (r) => r.sent_back },
              { header: "Passed first time", value: (r) => r.first_pass },
              { header: "Entered", value: (r) => r.entered_at },
              { header: "Approved", value: (r) => r.approved_at },
              { header: "Lead time (ms)", value: (r) => r.lead_time_ms },
              { header: "Annotating hands-on (ms)", value: (r) => r.annotate_ms },
              { header: "Reviewing hands-on (ms)", value: (r) => r.review_ms },
              { header: "Annotators", value: (r) => r.annotators.join(" ") },
              { header: "Reviewers", value: (r) => r.reviewers.join(" ") },
              { header: "Objects", value: (r) => r.objects },
              { header: "Objects by label", value: (r) => labelSummary(r) },
            ]}
            testId="analytics-export-cases"
          />
        }
      />
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by state">
        {(["all", ...STATE_ORDER] as const).map((s) => {
          const n = s === "all" ? data.cases.length : data.headline.states[s];
          return (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${filter === s ? "border-blue-600 bg-blue-600 text-white" : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`}
              data-testid={`analytics-filter-${s}`}
            >
              {s === "all" ? "All" : STATE_LABEL[s]} <span className="tabular-nums opacity-75">{n}</span>
            </button>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <EmptyState message="No case in this state." />
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Case</th>
                <th>State</th>
                <th className="text-right" title="Times it was sent for review">
                  Rounds
                </th>
                <th className="text-right">Sent back</th>
                <th className="text-right" title="Entered the workflow → first approval, calendar time">
                  Lead time
                </th>
                <th className="text-right" title="Active viewer time annotating, all sittings">
                  Annotating
                </th>
                <th className="text-right" title="Active viewer time reviewing, all sittings">
                  Reviewing
                </th>
                <th>Annotated by</th>
                <th>Reviewed by</th>
                <th>Drawn</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.case_id} data-testid="analytics-case-row">
                  <td className="max-w-[14rem] truncate" title={r.case_title ?? r.case_id}>
                    {r.case_title ?? r.case_id.slice(0, 8)}
                  </td>
                  <td>
                    <span className={STATE_CHIP[r.state]}>{STATE_LABEL[r.state]}</span>
                  </td>
                  <td className="text-right tabular-nums">{r.rounds}</td>
                  <td className={`text-right tabular-nums ${r.sent_back ? "font-semibold text-red-700" : ""}`}>{r.sent_back}</td>
                  <td className="text-right tabular-nums" title={r.approved_at ? `Approved ${formatShortWhen(r.approved_at)}` : undefined}>
                    {formatDuration(r.lead_time_ms)}
                  </td>
                  <td className="text-right tabular-nums">{r.annotate_ms ? formatDuration(r.annotate_ms) : "–"}</td>
                  <td className="text-right tabular-nums">{r.review_ms ? formatDuration(r.review_ms) : "–"}</td>
                  <td className="text-xs text-gray-600">{r.annotators.join(", ") || "–"}</td>
                  <td className="text-xs text-gray-600">{r.reviewers.join(", ") || "–"}</td>
                  <td className="text-xs text-gray-600">{r.objects ? labelSummary(r) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- labels

export function LabelsSection({ data, studyName }: { data: StudyAnalytics; studyName: string }) {
  const rows = data.labels;
  const max = Math.max(1, ...rows.map((r) => r.objects));
  return (
    <div className="card" data-testid="analytics-labels">
      <CardHeader
        title="What was drawn"
        hint="Per label: objects in each case's latest submission, how many cases have one, and -- from the reviewers' per-object verdicts -- how often objects of that label were rejected, and why. A label rejected far more than the others usually has an unclear definition."
        actions={
          <DownloadCsvButton
            filename={csvName(studyName, "labels")}
            rows={rows}
            columns={[
              { header: "Label", value: (r) => r.label },
              { header: "Objects", value: (r) => r.objects },
              { header: "Cases", value: (r) => r.cases },
              { header: "Objects reviewed", value: (r) => r.reviewed },
              { header: "Objects rejected", value: (r) => r.rejected },
              { header: "Rejection rate", value: (r) => r.rejection_rate },
              { header: "Reasons", value: (r) => r.reasons.map((x) => `${REASON_LABEL[x.reason] ?? x.reason}: ${x.count}`).join("; ") },
            ]}
            testId="analytics-export-labels"
          />
        }
      />
      {rows.length === 0 ? (
        <EmptyState message="Nothing has been drawn yet." />
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Label</th>
                <th className="w-2/5">Objects</th>
                <th className="text-right">Cases</th>
                <th className="text-right" title="Objects a reviewer accepted or rejected one by one">
                  Reviewed
                </th>
                <th className="text-right">Rejected</th>
                <th>Why rejected</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} data-testid="analytics-label-row">
                  <td className="font-medium text-gray-800">{r.label}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 rounded-sm bg-gray-100">
                        <div className="h-2 rounded-sm bg-blue-600" style={{ width: `${(r.objects / max) * 100}%` }} />
                      </div>
                      <span className="w-10 text-right tabular-nums">{r.objects}</span>
                    </div>
                  </td>
                  <td className="text-right tabular-nums">{r.cases}</td>
                  <td className="text-right tabular-nums">{r.reviewed}</td>
                  <td className={`text-right tabular-nums ${r.rejection_rate !== null && r.rejection_rate >= 0.3 ? "font-semibold text-red-700" : ""}`}>
                    {r.rejected} <span className="text-xs text-gray-400">({pct(r.rejection_rate)})</span>
                  </td>
                  <td className="text-xs text-gray-600">{r.reasons.map((x) => `${REASON_LABEL[x.reason] ?? x.reason} ${x.count}`).join(", ") || "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- people

export function PeopleSection({ data, studyName }: { data: StudyAnalytics; studyName: string }) {
  const rows = data.people;
  return (
    <div className="card" data-testid="analytics-people">
      <CardHeader
        title="Who did what"
        hint={
          <>
            Each person's work on this study, both sides. Per case and per object times make people comparable only on similar cases -- read them against the Cases tab, and against the same person's earlier figures, before calling anyone slow or fast. Passed first time is the share of
            their annotated cases approved at the first review.
          </>
        }
        actions={
          <DownloadCsvButton
            filename={csvName(studyName, "people")}
            rows={rows}
            columns={[
              { header: "Person", value: (r) => r.username },
              { header: "Cases annotated", value: (r) => r.annotated_cases },
              { header: "Submissions", value: (r) => r.submissions },
              { header: "Passed first time", value: (r) => r.first_pass_rate },
              { header: "Sent back", value: (r) => r.sent_back },
              { header: "Objects drawn", value: (r) => r.objects },
              { header: "Annotating hands-on total (ms)", value: (r) => r.annotate_total_ms },
              { header: "Annotating per case (ms)", value: (r) => r.annotate_per_case_ms },
              { header: "Annotating per object (ms)", value: (r) => r.annotate_per_object_ms },
              { header: "Reviews", value: (r) => r.reviews },
              { header: "Approved", value: (r) => r.approved },
              { header: "Sent back (as reviewer)", value: (r) => r.rejected },
              { header: "Reviewing hands-on total (ms)", value: (r) => r.review_total_ms },
              { header: "Reviewing per case (ms)", value: (r) => r.review_per_case_ms },
              { header: "Review turnaround (ms)", value: (r) => r.review_turnaround_ms },
              { header: "Open now", value: (r) => r.open_now },
            ]}
            testId="analytics-export-people"
          />
        }
      />
      {rows.length === 0 ? (
        <EmptyState message="Nobody has worked on this study's cases yet." />
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th rowSpan={2}>Person</th>
                <th colSpan={6} className="border-b border-gray-100 text-center">
                  Annotating
                </th>
                <th colSpan={4} className="border-b border-gray-100 text-center">
                  Reviewing
                </th>
                <th rowSpan={2} className="text-right" title="Cases assigned to them that are not finished">
                  Open now
                </th>
              </tr>
              <tr>
                <th className="text-right">Cases</th>
                <th className="text-right" title="Annotated cases approved at the first review">
                  1st time
                </th>
                <th className="text-right">Sent back</th>
                <th className="text-right">Objects</th>
                <th className="text-right" title="Total active viewer time annotating">
                  Hands-on
                </th>
                <th className="text-right" title="Median per case · total divided by objects">
                  Per case · object
                </th>
                <th className="text-right">Reviews</th>
                <th className="text-right" title="Approved · sent back">
                  ✓ · ✕
                </th>
                <th className="text-right" title="Total active viewer time reviewing">
                  Hands-on
                </th>
                <th className="text-right" title="Median from opening a case for review to the decision, elapsed">
                  Turnaround
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user_id} data-testid="analytics-person-row">
                  <td className="font-medium text-gray-800">{r.username}</td>
                  <td className="text-right tabular-nums">{r.annotated_cases}</td>
                  <td className={`text-right tabular-nums ${r.first_pass_rate !== null && r.first_pass_rate < 0.7 ? "text-red-700" : ""}`}>{pct(r.first_pass_rate)}</td>
                  <td className="text-right tabular-nums">{r.sent_back}</td>
                  <td className="text-right tabular-nums">{r.objects}</td>
                  <td className="text-right tabular-nums">{r.annotate_total_ms ? formatDuration(r.annotate_total_ms) : "–"}</td>
                  <td className="text-right tabular-nums">
                    {formatDuration(r.annotate_per_case_ms)} · {formatDuration(r.annotate_per_object_ms)}
                  </td>
                  <td className="text-right tabular-nums">{r.reviews}</td>
                  <td className="text-right tabular-nums">
                    {r.approved} · {r.rejected}
                  </td>
                  <td className="text-right tabular-nums">{r.review_total_ms ? formatDuration(r.review_total_ms) : "–"}</td>
                  <td className="text-right tabular-nums">{formatDuration(r.review_turnaround_ms)}</td>
                  <td className={`text-right tabular-nums ${r.open_now ? "font-semibold" : ""}`}>{r.open_now}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
