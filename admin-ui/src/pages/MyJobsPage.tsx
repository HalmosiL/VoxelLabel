import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getMyNotificationPreferences, NotificationPreference, updateMyNotificationPreferences } from "../api/adminApi";
import { describeApiError } from "../api/client";
import { listMyJobs, MyJob } from "../api/workflowApi";
import { useMe } from "../auth/MeContext";
import { refreshViewerHandoffOnClick, withViewerHandoff } from "../auth/viewerHandoff";
import { ANNOTATOR_UI_URL } from "../config";
import { useRegisterGuide } from "../guide/GuideContext";
import { MY_JOBS_STEPS } from "../guide/workbenchSteps";
import { finishedCount, sentBackCount, TASK_STATUS_STYLE } from "../components/workflow/statusStyle";
import { DocumentIcon, PencilIcon, SparklesIcon } from "../components/icons";

// todo/in_progress surface first -- those are the jobs actually waiting
// on the user; done ones sink to the bottom as a record, not a queue.
const STATUS_ORDER: Record<string, number> = { todo: 0, in_progress: 1, done: 2 };

/** Everything assigned to the signed-in person, and nothing else: their
 * Annotation jobs and their Review jobs as two plain lists, each job
 * showing how much of it is still waiting on them. A pure annotator or
 * reviewer lives on this one page (see MeContext.jobsOnly); for a data
 * manager or admin it is the same list with a shortcut to the board. */
export default function MyJobsPage() {
  const { jobsOnly, viewAs, me } = useMe();
  const [rawJobs, setRawJobs] = useState<MyJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMyJobs()
      .then(setRawJobs)
      .catch((err) => setError(describeApiError(err)));
  }, []);

  // Reviewer is a strict subset of Annotator, never the other way
  // round: a reviewer only ever reviews, so annotation jobs -- even a
  // real one this account happens to be individually assigned, since
  // assignment is independent of a person's study role -- never belong
  // on a reviewer's list. Recognises both a real reviewer-only account
  // (every membership is "reviewer", jobsOnly is true for that reason)
  // and an admin simulating "Reviewer" via View as, which otherwise
  // still sees this admin account's own real assignments untouched.
  const isReviewerOnly =
    viewAs !== "admin" ? viewAs === "reviewer" : jobsOnly && (me?.memberships.length ?? 0) > 0 && me!.memberships.every((m) => m.role === "reviewer");
  const jobs = isReviewerOnly ? (rawJobs?.filter((j) => j.card_type === "review") ?? null) : rawJobs;

  const pending = jobs?.filter(needsAttention) ?? null;
  const active = pending ? [...pending].sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99)) : null;
  const annotation = active?.filter((j) => j.card_type !== "review") ?? [];
  const review = active?.filter((j) => j.card_type === "review") ?? [];
  const quietCount = jobs ? jobs.length - (pending?.length ?? 0) : 0;

  // The tour points at the first card on the page as its example.
  const exampleId = annotation[0]?.card_id ?? review[0]?.card_id ?? null;
  useRegisterGuide("workbench", MY_JOBS_STEPS, jobs !== null);

  return (
    <div className="flex flex-col gap-8">
      <TutorialSection />

      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="page-title">My Jobs</h1>
          <EmailNotificationsToggle />
        </div>
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

      {annotation.length > 0 && (
        <JobSection title="Annotation" guide="annotation-section" jobs={annotation} showBoardLink={!jobsOnly} exampleId={exampleId} />
      )}
      {review.length > 0 && <JobSection title="Review" guide="review-section" jobs={review} showBoardLink={!jobsOnly} exampleId={exampleId} />}

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

function JobSection({
  title,
  guide,
  jobs,
  showBoardLink,
  exampleId,
}: {
  title: string;
  guide: string;
  jobs: MyJob[];
  showBoardLink: boolean;
  exampleId: string | null;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400" data-guide={guide}>
        {title}
      </h2>
      <div className="flex flex-col gap-3">
        {jobs.map((job) => (
          <JobCard key={job.card_id} job={job} showBoardLink={showBoardLink} guideExample={job.card_id === exampleId} />
        ))}
      </div>
    </section>
  );
}

function JobCard({ job, showBoardLink, guideExample }: { job: MyJob; showBoardLink: boolean; guideExample: boolean }) {
  const style = TASK_STATUS_STYLE[job.status] ?? TASK_STATUS_STYLE.todo;
  const isReview = job.card_type === "review";
  const Icon = isReview ? DocumentIcon : PencilIcon;
  const total = job.cases.length;
  const open = openCases(job);
  const finished = finishedCount(job.card_type, job.cases); // a sent-back case is reviewed too (D-09)
  const sentBack = sentBackCount(job.card_type, job.cases);
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
    <div className="card flex items-center gap-4 !p-5" data-guide={guideExample ? "job-card" : undefined}>
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
          {sentBack > 0 && (
            <span
              className="badge bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200"
              data-testid="sent-back-count"
              title="Cases the reviewer sent back to you -- open the job to see why"
            >
              Sent back: {sentBack}
            </span>
          )}
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
          <Link to={`/studies/${job.study_id}/workflow`} className="link-action text-xs font-medium text-gray-400 hover:text-brand-700">
            Board
          </Link>
        )}
        <Link to={`/my-jobs/${job.card_id}`} className="btn-secondary btn-sm" data-guide={guideExample ? "job-open" : undefined}>
          Open
        </Link>
      </div>
    </div>
  );
}

/** A permanent, always-on practice job -- unlike every other card on
 * this page it never comes from the backend and never goes away, so
 * there's always at least one job to click into (a brand-new account
 * with nothing real assigned yet included) and the guided tour always
 * has somewhere to run. Amber throughout, deliberately unlike the blue
 * (annotation) and violet (review) real-job cards, so it reads as
 * "practice" at a glance rather than as one more real assignment. */
function TutorialSection() {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-amber-500">Practice</h2>
      <a
        href={withViewerHandoff(`${ANNOTATOR_UI_URL}/tutorial`)}
        onClick={refreshViewerHandoffOnClick}
        target="_blank"
        rel="noreferrer"
        className="group flex items-center gap-4 rounded-2xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm transition-shadow hover:shadow-md"
      >
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
          <SparklesIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-gray-900">Tutorial job</p>
            <span className="rounded-full bg-amber-200/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
              Always available
            </span>
          </div>
          <p className="mt-0.5 text-sm text-gray-600">
            A real CT scan to practice on -- walks you through annotating and reviewing. Nothing here is saved or seen by
            anyone else.
          </p>
        </div>
        <span className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-2 text-sm font-semibold text-white shadow-sm shadow-amber-500/30 transition-colors group-hover:bg-amber-600">
          <SparklesIcon className="h-4 w-4" />
          Start the tutorial
        </span>
      </a>
    </section>
  );
}

/** The person's own opt-out for the notification service's emails --
 * one switch here (the admin's Notifications page has the per-kind
 * detail). Shows the address the emails go to so "why no email?" is
 * answered on the spot. */
function EmailNotificationsToggle() {
  const [pref, setPref] = useState<NotificationPreference | null>(null);
  useEffect(() => {
    getMyNotificationPreferences().then(setPref).catch(() => setPref(null));
  }, []);
  if (!pref) return null;
  return (
    <label className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700" data-testid="email-notifications-toggle">
      <input
        type="checkbox"
        checked={pref.email_enabled}
        onChange={async (e) => {
          const next = e.target.checked;
          setPref({ ...pref, email_enabled: next });
          try {
            setPref(await updateMyNotificationPreferences({ email_enabled: next }));
          } catch {
            setPref(pref);
          }
        }}
      />
      Email me about my jobs
      <span className="text-xs text-gray-400">{pref.email ? `(${pref.email})` : "(no email on your account)"}</span>
    </label>
  );
}
