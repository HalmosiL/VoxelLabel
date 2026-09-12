import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { describeApiError } from "../api/client";
import { listMyJobs, MyJob } from "../api/workflowApi";
import { AWAITING_REVIEW_STYLE, CASE_STATUS_STYLE, TASK_STATUS_STYLE } from "../components/workflow/statusStyle";
import { useMe } from "../auth/MeContext";
import { useRegisterGuide } from "../guide/GuideContext";
import { JOB_STEPS } from "../guide/workbenchSteps";
import EmptyState from "../components/EmptyState";

/** Full-page view of a single job assigned to the calling user -- reuses
 * /admin/my-jobs (already scoped to "assigned to me") rather than a
 * dedicated single-job endpoint, and finds the matching card client-side;
 * this list is per-user and small, so the extra data pulled over the
 * wire for a direct link isn't worth a second backend endpoint. */
export default function JobDetailPage() {
  const { cardId } = useParams<{ cardId: string }>();
  const { jobsOnly } = useMe();
  const [jobs, setJobs] = useState<MyJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMyJobs()
      .then(setJobs)
      .catch((err) => setError(describeApiError(err)));
  }, []);

  const job = jobs?.find((j) => j.card_id === cardId);
  useRegisterGuide("job", JOB_STEPS, Boolean(job));

  if (error) return <p className="alert-error">{error}</p>;
  if (!jobs) return null;

  if (!job) {
    return (
      <div className="flex flex-col gap-4">
        <Link to="/my-jobs" className="text-sm font-medium text-brand-600 hover:text-brand-700">
          ← Back to My Jobs
        </Link>
        <EmptyState message="This job isn't assigned to you (or no longer exists)." />
      </div>
    );
  }

  const style = TASK_STATUS_STYLE[job.status] ?? TASK_STATUS_STYLE.todo;
  const annotatedCount = job.cases.filter((c) => c.status === "done").length;

  return (
    <div className="flex flex-col gap-6">
      <Link to="/my-jobs" className="text-sm font-medium text-brand-600 hover:text-brand-700">
        ← Back to My Jobs
      </Link>

      <div className="flex items-start justify-between gap-3" data-guide="job-header">
        <div>
          <h1 className="page-title">{job.card_title}</h1>
          <p className="mt-1 text-sm text-gray-500">{job.study_name ?? "Unknown study"}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="badge-gray capitalize">{job.card_type}</span>
          <span className={style.badge}>
            <span className={`badge-dot ${style.dot}`} />
            {style.label}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between">
          <p className="section-title">
            {annotatedCount} of {job.cases.length} case{job.cases.length === 1 ? "" : "s"} annotated
          </p>
          {/* The workflow board is study-wide structure/editing surface --
              outside the reduced workbench (just this one person's own
              jobs); the route itself redirects there too. */}
          {!jobsOnly && (
            <Link to={`/studies/${job.study_id}/workflow`} className="text-xs font-medium text-brand-600 hover:text-brand-700">
              Open workflow board
            </Link>
          )}
        </div>

        <div className="table-wrap mt-4" data-guide="cases-table">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {job.cases.length === 0 && (
                <tr>
                  <td colSpan={3}>
                    <EmptyState message="No cases in scope yet." />
                  </td>
                </tr>
              )}
              {job.cases.map((c, i) => {
                // The tour uses the first row (and the first reviewer
                // comment on the page) as its examples.
                const firstComment = job.cases.findIndex((x) => x.latest_review_comment) === i;
                const caseStyle =
                  job.card_type === "review" && c.pending_annotation_id ? AWAITING_REVIEW_STYLE : CASE_STATUS_STYLE[c.status];
                return (
                  <tr key={c.id}>
                    <td>
                      <div className="flex flex-col gap-0.5">
                        <span>{c.title || `${c.id.slice(0, 8)}…`}</span>
                        {c.latest_review_comment && (
                          <span className="text-xs text-gray-500" data-guide={firstComment ? "reviewer-comment" : undefined}>
                            <span className="font-medium text-gray-600">Reviewer:</span> {c.latest_review_comment}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={caseStyle.badge}>
                        <span className={`badge-dot ${caseStyle.dot}`} />
                        {caseStyle.label}
                      </span>
                    </td>
                    <td>
                      <Link
                        to={`/studies/${job.study_id}/cases/${c.id}?jobId=${job.card_id}`}
                        className="text-xs font-medium text-brand-600 hover:text-brand-700"
                        data-guide={i === 0 ? "open-case" : undefined}
                      >
                        Open case →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
