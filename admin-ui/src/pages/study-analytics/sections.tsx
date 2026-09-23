import { useState } from "react";
import { Link } from "react-router-dom";

import { CaseState, CaseStep, StudyAnalytics, StudyCaseRow } from "../../api/studyAnalyticsApi";
import EmptyState from "../../components/EmptyState";
import { CardHeader, DownloadCsvButton, formatDuration, formatShortWhen } from "../usage/shared";

export const STATE_LABEL: Record<CaseState, string> = {
  sent_back: "Sent back",
  awaiting_review: "Awaiting review",
  awaiting_next: "Waiting for next step",
  in_progress: "Being annotated",
  not_started: "Not started",
  done: "Finished",
};

export const STATE_HINT: Record<CaseState, string> = {
  sent_back: "Rejected at a review and not re-submitted yet",
  awaiting_review: "Submitted (or approved by an earlier review), waiting for a review step",
  awaiting_next: "Passed a step; the next annotation step hasn't finished it yet",
  in_progress: "Being annotated -- a draft is saved, or it is being reworked after a rejection",
  not_started: "Entered the workflow, nothing saved yet",
  done: "Nothing left after its last step: approved by the last review, or submitted where no review follows",
};

export const STATE_CHIP: Record<CaseState, string> = {
  sent_back: "badge-red",
  awaiting_review: "badge bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200",
  awaiting_next: "badge bg-violet-50 text-violet-800 ring-1 ring-inset ring-violet-200",
  in_progress: "badge-blue",
  not_started: "badge-gray",
  done: "badge-green",
};

export const STATE_ORDER: CaseState[] = ["sent_back", "awaiting_review", "awaiting_next", "in_progress", "not_started", "done"];

const STEP_MARK: Record<CaseStep["kind"], { mark: string; tone: string; word: string }> = {
  submitted: { mark: "↑", tone: "border-blue-200 bg-blue-50 text-blue-800", word: "sent for review" },
  approved: { mark: "✓", tone: "border-emerald-200 bg-emerald-50 text-emerald-800", word: "approved" },
  rejected: { mark: "✕", tone: "border-red-200 bg-red-50 text-red-800", word: "sent back" },
};

const stepKey = (p: CaseStep) => `${p.step}|${p.kind}`;

/** Folds back-to-back repeats of the same round -- "Annotate ↑ → Review ✕"
 * five times over -- into one group with a count. */
export function compressPath(path: CaseStep[]): { steps: CaseStep[]; times: number }[] {
  const out: { steps: CaseStep[]; times: number }[] = [];
  let i = 0;
  while (i < path.length) {
    const pair = path.slice(i, i + 2);
    let times = 1;
    if (pair.length === 2) {
      while (i + 2 * times + 1 < path.length && stepKey(path[i + 2 * times]) === stepKey(pair[0]) && stepKey(path[i + 2 * times + 1]) === stepKey(pair[1])) times += 1;
    }
    if (times > 1) {
      out.push({ steps: pair, times });
      i += 2 * times;
    } else {
      out.push({ steps: [path[i]], times: 1 });
      i += 1;
    }
  }
  return out;
}

function StepChip({ p }: { p: CaseStep }) {
  const m = STEP_MARK[p.kind];
  return (
    <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] ${m.tone}`} title={`${p.step ?? "Outside the board"}: ${m.word} by ${p.by}, ${formatShortWhen(p.at)}`}>
      {p.step ?? "–"} {m.mark}
    </span>
  );
}

/** The steps a case went through, in order: "Annotate ↑ → Review ✕ → Annotate ↑ → Review ✓".
 * `compact` folds repeated rounds into "(Annotate ↑ → Review ✕) ×5". */
export function CasePath({ path, compact = false }: { path: CaseStep[]; compact?: boolean }) {
  if (path.length === 0) return <span className="text-xs text-gray-400">–</span>;
  const groups = compact ? compressPath(path) : path.map((p) => ({ steps: [p], times: 1 }));
  return (
    <ol className="flex flex-wrap items-center gap-1" data-testid="analytics-case-path">
      {groups.map((g, i) => (
        <li key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-gray-300">→</span>}
          {g.times > 1 ? (
            <span className="flex items-center gap-1 rounded-md border border-dashed border-gray-300 px-1 py-0.5" title={`This round happened ${g.times} times in a row`}>
              {g.steps.map((p, j) => (
                <span key={j} className="flex items-center gap-1">
                  {j > 0 && <span className="text-gray-300">→</span>}
                  <StepChip p={p} />
                </span>
              ))}
              <span className="text-[11px] font-semibold tabular-nums text-gray-600">×{g.times}</span>
            </span>
          ) : (
            <StepChip p={g.steps[0]} />
          )}
        </li>
      ))}
    </ol>
  );
}

/** Rejected objects grouped by object and reason: "Nodule 1 · boundary off · reviews 1-5 (5×)". */
function groupRejected(rows: StudyCaseRow["rejected_objects"]) {
  const groups = new Map<string, { label: string; instance: number | null; reason: string | null; reviews: number[]; comment: string | null }>();
  for (const o of rows) {
    const key = `${o.label}|${o.instance}|${o.reason}`;
    const g = groups.get(key) ?? { label: o.label, instance: o.instance, reason: o.reason, reviews: [], comment: o.comment };
    g.reviews.push(o.review);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.reviews.length - a.reviews.length);
}

function CaseLink({ row, studyId }: { row: StudyCaseRow; studyId: string }) {
  return (
    <Link to={`/studies/${studyId}/cases/${row.case_id}`} className="font-medium text-blue-700 hover:underline" title={row.case_title ?? row.case_id}>
      {row.case_title ?? row.case_id.slice(0, 8)}
    </Link>
  );
}

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

// ---------------------------------------------------------------- problem cases

/** Cases that went back and forth: sent back twice or more, with what the
 * reviewers rejected and said. */
export function ProblemCasesCard({ data, studyId }: { data: StudyAnalytics; studyId: string }) {
  const rows = data.cases.filter((r) => r.sent_back >= 2).sort((a, b) => b.sent_back - a.sent_back);
  return (
    <div className="card" data-guide="analytics-problems" data-testid="analytics-problems">
      <CardHeader
        title="Cases that went back and forth"
        hint="Every case sent back at least twice, most first: the steps it went through, the objects reviewers rejected (with the reason they tagged) and what they wrote. Recurring reasons on the same kind of image usually mean the guideline or the tool, not the person."
      />
      {rows.length === 0 ? (
        <EmptyState message="No case has been sent back more than once." />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.case_id} className="rounded-lg border border-red-100 bg-red-50/30 p-3" data-testid="analytics-problem-case">
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <CaseLink row={r} studyId={studyId} />
                  <span className={STATE_CHIP[r.state]} title={STATE_HINT[r.state]}>
                    {STATE_LABEL[r.state]}
                  </span>
                </div>
                <span className="text-sm text-red-700">
                  sent back <strong className="tabular-nums">{r.sent_back}×</strong> · {r.rounds} rounds{r.slices ? ` · ${r.slices} slices` : ""}
                </span>
              </div>
              <CasePath path={r.path} compact />
              {r.rejected_objects.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5 text-xs">
                  {groupRejected(r.rejected_objects).map((o, i) => (
                    <li key={i} className="rounded bg-white px-1.5 py-0.5 text-gray-700 ring-1 ring-inset ring-red-200" title={o.comment ?? undefined}>
                      <strong className="font-medium">
                        {o.label}
                        {o.instance ? ` ${o.instance}` : ""}
                      </strong>{" "}
                      · {REASON_LABEL[o.reason ?? "untagged"] ?? o.reason} · {o.reviews.length > 1 ? `rejected ${o.reviews.length}× (reviews ${o.reviews.join(", ")})` : `review ${o.reviews[0]}`}
                    </li>
                  ))}
                </ul>
              )}
              {r.review_comments.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-gray-600">
                  {r.review_comments.map((c, i) => (
                    <li key={i}>
                      <span className="text-gray-400">
                        {c.by}, {formatShortWhen(c.at)}:
                      </span>{" "}
                      “{c.text}”
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- cases

function labelSummary(r: StudyCaseRow): string {
  return Object.entries(r.labels)
    .map(([label, n]) => `${n}× ${label}`)
    .join(", ");
}

export function CasesSection({ data, studyName, studyId }: { data: StudyAnalytics; studyName: string; studyId: string }) {
  const [filter, setFilter] = useState<CaseState | "all">("all");
  const rows = filter === "all" ? data.cases : data.cases.filter((r) => r.state === filter);
  return (
    <div className="card" data-testid="analytics-cases">
      <CardHeader
        title="Cases"
        hint="Every case in the study's workflow: where it stands, the steps it went through, how long from entering the workflow to finishing, the hands-on time on each side, the images and what was drawn -- in the first submission and in the final version. Open work first; hover a step for who and when."
        actions={
          <DownloadCsvButton
            filename={csvName(studyName, "cases")}
            rows={rows}
            columns={[
              { header: "Case", value: (r) => r.case_title ?? r.case_id },
              { header: "Case id", value: (r) => r.case_id },
              { header: "State", value: (r) => STATE_LABEL[r.state] },
              { header: "Waiting at", value: (r) => r.waiting_at_title },
              { header: "Steps", value: (r) => r.path.map((p) => `${p.step ?? "-"} ${p.kind}`).join(" > ") },
              { header: "Rounds", value: (r) => r.rounds },
              { header: "Reviews", value: (r) => r.reviews },
              { header: "Sent back", value: (r) => r.sent_back },
              { header: "Passed first time", value: (r) => r.first_pass },
              { header: "Entered", value: (r) => r.entered_at },
              { header: "Finished", value: (r) => r.done_at },
              { header: "Lead time (ms)", value: (r) => r.lead_time_ms },
              { header: "Annotating hands-on (ms)", value: (r) => r.annotate_ms },
              { header: "Reviewing hands-on (ms)", value: (r) => r.review_ms },
              { header: "Annotators", value: (r) => r.annotators.join(" ") },
              { header: "Reviewers", value: (r) => r.reviewers.join(" ") },
              { header: "Slices", value: (r) => r.slices },
              { header: "Objects first submitted", value: (r) => r.objects_first },
              { header: "Objects final", value: (r) => r.objects },
              { header: "Final objects by label", value: (r) => labelSummary(r) },
              { header: "Rejected objects", value: (r) => r.rejected_objects.map((o) => `${o.label} ${o.instance ?? ""} (${o.reason ?? "untagged"}, review ${o.review})`).join("; ") },
              { header: "Review comments", value: (r) => r.review_comments.map((c) => c.text).join(" | ") },
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
                <th>Steps</th>
                <th className="text-right" title="Times it was sent back by a review">
                  Sent back
                </th>
                <th className="text-right" title="Entered the workflow → finished, calendar time">
                  Lead time
                </th>
                <th className="text-right" title="Active viewer time annotating · reviewing, all sittings">
                  Hands-on
                </th>
                <th className="text-right" title="Images in its largest series">
                  Slices
                </th>
                <th className="text-right" title="Objects in the first submission → in the final version">
                  Objects
                </th>
                <th>Final version</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.case_id} data-testid="analytics-case-row">
                  <td className="max-w-[12rem] truncate">
                    <CaseLink row={r} studyId={studyId} />
                  </td>
                  <td className="whitespace-nowrap">
                    <span className={STATE_CHIP[r.state]} title={STATE_HINT[r.state]}>
                      {STATE_LABEL[r.state]}
                    </span>
                    {r.waiting_at_title && r.state !== "done" && <div className="mt-0.5 text-[11px] text-gray-400">at {r.waiting_at_title}</div>}
                  </td>
                  <td className="min-w-[14rem]">
                    <CasePath path={r.path} compact />
                  </td>
                  <td className={`text-right tabular-nums ${r.sent_back ? "font-semibold text-red-700" : ""}`}>{r.sent_back}</td>
                  <td className="text-right tabular-nums" title={r.done_at ? `Finished ${formatShortWhen(r.done_at)}` : undefined}>
                    {formatDuration(r.lead_time_ms)}
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    {r.annotate_ms ? formatDuration(r.annotate_ms) : "–"} · {r.review_ms ? formatDuration(r.review_ms) : "–"}
                  </td>
                  <td className="text-right tabular-nums">{r.slices ?? "–"}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    {r.objects_first === null ? "–" : r.objects_first === r.objects ? r.objects : `${r.objects_first} → ${r.objects}`}
                  </td>
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
        hint="Per label: objects in the first submissions and in the final versions (the difference is what rework added or removed), how many cases have one, and -- from the reviewers' per-object verdicts -- how often objects of that label were rejected, and why. A label rejected far more than the others usually has an unclear definition."
        actions={
          <DownloadCsvButton
            filename={csvName(studyName, "labels")}
            rows={rows}
            columns={[
              { header: "Label", value: (r) => r.label },
              { header: "Objects first submitted", value: (r) => r.objects_first },
              { header: "Objects final", value: (r) => r.objects },
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
                <th className="w-2/5" title="Objects in the final versions (first submitted → final)">
                  Objects
                </th>
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
                      <span className="w-16 whitespace-nowrap text-right tabular-nums" title="first submitted → final">
                        {r.objects_first === r.objects ? r.objects : `${r.objects_first} → ${r.objects}`}
                      </span>
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
            their annotated cases that got through every review step without being sent back.
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
              { header: "Through every review first time", value: (r) => r.first_pass_rate },
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
                <th className="text-right" title="Their annotated cases that got through every review without being sent back">
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
