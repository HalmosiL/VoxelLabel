import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { describeApiError } from "../api/client";
import { listMyJobs, MyJob } from "../api/workflowApi";
import { useMe } from "../auth/MeContext";
import { TASK_STATUS_STYLE } from "../components/workflow/statusStyle";
import { DocumentIcon, PencilIcon } from "../components/icons";

// todo/in_progress surface first -- those are the jobs actually waiting
// on the user; done ones sink to the bottom as a record, not a queue.
const STATUS_ORDER: Record<string, number> = { todo: 0, in_progress: 1, done: 2 };

/** Everything assigned to the signed-in person, and nothing else: their
 * Annotation jobs and their Review jobs as two plain lists, each job
 * showing how much of it is still waiting on them. A pure annotator or
 * reviewer lives on this one page (see MeContext.jobsOnly); for a data
 * manager or admin it is the same list with a shortcut to the board. */
export default function MyJobsPage() {
  const { jobsOnly } = useMe();
  const [jobs, setJobs] = useState<MyJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMyJobs()
      .then(setJobs)
      .catch((err) => setError(describeApiError(err)));
  }, []);

  const pending = jobs?.filter(needsAttention) ?? null;
  const active = pending ? [...pending].sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99)) : null;
  const annotation = active?.filter((j) => j.card_type !== "review") ?? [];
  const review = active?.filter((j) => j.card_type === "review") ?? [];
  const quietCount = jobs ? jobs.length - (pending?.length ?? 0) : 0;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="page-title">My Jobs</h1>
        {active && active.length > 0 && (
          <p className="mt-1 text-sm text-gray-500">
            {countLabel(annotation.length, "annotation job")}
            {annotation.length > 0 && review.length > 0 ? " and " : ""}
            {review.length > 0 ? countLabel(review.length, "review job") : ""} waiting on you.
          </p>
        )}
      </div>
      {error && <p className="alert-error">{error}</p>}

      {active && active.length === 0 && (
        <div className="card text-center">
          <p className="font-medium text-gray-800">Nothing to do right now.</p>
          <p className="mt-1 text-sm text-gray-500">
            {jobs && jobs.length > 0
              ? "All your assigned jobs are complete. New work appears here as soon as it's assigned to you."
              : "No annotation or review jobs are assigned to you yet."}
          </p>
        </div>
      )}

      {annotation.length > 0 && <JobSection title="Annotation" jobs={annotation} showBoardLink={!jobsOnly} />}
      {review.length > 0 && <JobSection title="Review" jobs={review} showBoardLink={!jobsOnly} />}

      {quietCount > 0 && (
        <p className="hint">
          {quietCount} more assigned {quietCount === 1 ? "job has" : "jobs have"} nothing pending right now.
        </p>
      )}
    </div>
  );
}

/** A job only needs the assignee's attention while it actually has a
 * case waiting on them -- the assignment itself never goes away, but a
 * job with nothing pending has nothing to show for right now, so it
 * drops out of the active list rather than sitting there as dead weight.
 *
 * A manual "Done" is deliberately NOT an absolute override here: this is
 * exactly what makes the workflow board's feedback loop (a Review card's
 * "(rejected)" branch wired back into an Annotation card's input)
 * visible again once it fires. If Done silently beat a real rejected /
 * pending case, an annotator who'd already marked their job Done would
 * never see it reappear when the reviewer sends a case back. So Done
 * only suppresses a job that genuinely has nothing outstanding.
 *
 * What counts as pending work depends on the job type: for a Review
 * card a "rejected" case is already decided (it's the annotator's to
 * redo), so only a still-undecided "pending" case keeps a Review job
 * active; for an Annotation card, "rejected" means the annotator has
 * work to do again, so it keeps the job active like an untouched case. */
function needsAttention(job: MyJob): boolean {
  return job.cases.some((c) => (job.card_type === "review" ? c.status === "pending" : c.status !== "done"));
}

/** For an Annotation job: cases not yet annotated (rejected ones count as
 * open again). For a Review job: submitted annotations still waiting for
 * a decision. */
function openCases(job: MyJob): number {
  return job.cases.filter((c) => (job.card_type === "review" ? Boolean(c.pending_annotation_id) : c.status !== "done")).length;
}

function countLabel(n: number, noun: string): string {
  return n === 0 ? "" : `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function JobSection({ title, jobs, showBoardLink }: { title: string; jobs: MyJob[]; showBoardLink: boolean }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{title}</h2>
      <div className="flex flex-col gap-3">
        {jobs.map((job) => (
          <JobCard key={job.card_id} job={job} showBoardLink={showBoardLink} />
        ))}
      </div>
    </section>
  );
}

function JobCard({ job, showBoardLink }: { job: MyJob; showBoardLink: boolean }) {
  const style = TASK_STATUS_STYLE[job.status] ?? TASK_STATUS_STYLE.todo;
  const isReview = job.card_type === "review";
  const Icon = isReview ? DocumentIcon : PencilIcon;
  const total = job.cases.length;
  const open = openCases(job);
  const finished = job.cases.filter((c) => c.status === "done").length;
  const doneShare = total === 0 ? 0 : Math.round((finished / total) * 100);
  const cases = `${total} case${total === 1 ? "" : "s"}`;
  const progress = isReview
    ? open > 0
      ? `${open} of ${cases} awaiting your review`
      : finished === total
        ? `All ${cases} reviewed`
        : `${finished} of ${cases} reviewed · waiting for annotations`
    : open > 0
      ? `${open} of ${cases} to annotate`
      : `All ${cases} annotated`;

  return (
    <div className="card flex items-center gap-4 !p-5">
      <span
        className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ${
          isReview ? "bg-violet-50 text-violet-600" : "bg-brand-50 text-brand-600"
        }`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link to={`/my-jobs/${job.card_id}`} className="truncate font-semibold text-gray-900 hover:text-brand-700">
            {job.card_title}
          </Link>
          <span className={style.badge}>
            <span className={`badge-dot ${style.dot}`} />
            {style.label}
          </span>
        </div>
        <p className="mt-0.5 truncate text-sm text-gray-500">{job.study_name ?? "Unknown study"}</p>
        <div className="mt-2 flex items-center gap-3">
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-gray-100" aria-hidden="true">
            <div className={`h-full rounded-full ${isReview ? "bg-violet-500" : "bg-brand-500"}`} style={{ width: `${doneShare}%` }} />
          </div>
          <span className="text-xs text-gray-500">{progress}</span>
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-3">
        {showBoardLink && (
          <Link to={`/studies/${job.study_id}/workflow`} className="text-xs font-medium text-gray-400 hover:text-brand-700">
            Board
          </Link>
        )}
        <Link to={`/my-jobs/${job.card_id}`} className="btn-secondary btn-sm">
          Open
        </Link>
      </div>
    </div>
  );
}
