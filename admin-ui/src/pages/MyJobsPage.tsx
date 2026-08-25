import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { listMyJobs, MyJob } from "../api/workflowApi";
import { TASK_STATUS_STYLE } from "../components/workflow/statusStyle";
import { PencilIcon, DocumentIcon } from "../components/icons";

// todo/in_progress surface first -- those are the jobs actually waiting
// on the user; done ones sink to the bottom as a record, not a queue.
const STATUS_ORDER: Record<string, number> = { todo: 0, in_progress: 1, done: 2 };

export default function MyJobsPage() {
  const [jobs, setJobs] = useState<MyJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMyJobs()
      .then(setJobs)
      .catch((err) => setError(String(err)));
  }, []);

  // A job only needs the assignee's attention while it actually has a
  // case waiting on them -- the assignment itself never goes away, but
  // a job with nothing pending (everything in its scope already
  // annotated/reviewed, or nothing in scope yet) has nothing to show
  // for right now, so it drops out of the active list rather than
  // sitting there as dead weight. It reappears the moment a case lands
  // back in its scope (e.g. a rejected case fed back through the
  // workflow board's feedback loop).
  const pending = jobs?.filter((job) => job.cases.some((c) => c.status !== "done")) ?? null;
  const sorted = pending
    ? [...pending].sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99))
    : null;
  const doneCount = jobs ? jobs.length - (pending?.length ?? 0) : 0;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="page-title">My Jobs</h1>
      {error && <p className="alert-error">{error}</p>}

      {sorted && sorted.length === 0 && <p className="hint">No Annotation or Review cards are assigned to you.</p>}

      <div className="flex flex-col gap-4">{sorted?.map((job) => <JobCard key={job.card_id} job={job} />)}</div>

      {doneCount > 0 && (
        <p className="hint">
          {doneCount} more assigned {doneCount === 1 ? "job has" : "jobs have"} nothing pending right now.
        </p>
      )}
    </div>
  );
}

function JobCard({ job }: { job: MyJob }) {
  const style = TASK_STATUS_STYLE[job.status] ?? TASK_STATUS_STYLE.todo;
  const Icon = job.card_type === "review" ? DocumentIcon : PencilIcon;

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500">
            <Icon className="h-4 w-4" />
          </span>
          <div>
            <p className="font-semibold text-gray-900">{job.card_title}</p>
            <p className="text-sm text-gray-500">
              {job.study_name ?? "Unknown study"} · {job.cases.length} case{job.cases.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <span className={style.badge}>
          <span className={`badge-dot ${style.dot}`} />
          {style.label}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Link to={`/my-jobs/${job.card_id}`} className="btn-secondary btn-sm">
          Open
        </Link>
        <Link to={`/studies/${job.study_id}/workflow`} className="text-xs font-medium text-brand-600 hover:text-brand-700">
          Open workflow board
        </Link>
      </div>
    </div>
  );
}
