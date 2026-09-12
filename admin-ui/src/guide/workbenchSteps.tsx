import { GuideStep } from "./GuideTour";

/** Tours of the three workbench pages an annotator or reviewer uses,
 * in the order they meet them: the job list, one job, one case. Each
 * `target` matches a data-guide attribute on that page. */

export const MY_JOBS_STEPS: GuideStep[] = [
  {
    title: "Welcome to your workbench",
    body: (
      <>
        <p>
          I'm your guide. This page is the whole of VoxelLabel for you: the jobs assigned to you, and nothing else. A job
          is a set of cases (patients' scans) to annotate or to review.
        </p>
        <p>
          The path is always: <b>job → case → viewer</b>. I'll show you each page the first time you open it; the{" "}
          <b>Tutorial</b> button at the top right replays the tour of the page you're on.
        </p>
      </>
    ),
    image: "workbench-jobs.png",
  },
  {
    target: "annotation-section",
    title: "Annotation jobs",
    body: "Jobs where you draw: mark the structures the study asks for on each case, then hand the case in for review.",
    placement: "bottom",
  },
  {
    target: "review-section",
    title: "Review jobs",
    body: "Jobs where you check another annotator's work: accept or reject each object they drew, and submit the decision.",
    placement: "bottom",
  },
  {
    target: "job-card",
    title: "One job",
    body: (
      <>
        <p>
          The job's name and the study it belongs to, its status badge (<b>To do</b>, <b>In progress</b>, <b>Done</b>) and a
          progress bar with how many cases still wait on you.
        </p>
        <p>A job disappears from this list once nothing in it needs you -- and comes back by itself if a reviewer sends a case back.</p>
      </>
    ),
    placement: "bottom",
  },
  {
    target: "job-open",
    title: "Open the job",
    body: "Shows the job's cases with each one's status, so you can pick the next case to work on.",
    placement: "left",
    tip: "Press Finish, then Open -- the next page has its own short tour.",
  },
];

export const JOB_STEPS: GuideStep[] = [
  {
    title: "A job, case by case",
    body: "Every case in this job, with where it stands. Work through them top to bottom; the count above the table tells you how many are done.",
    image: "workbench-job.png",
  },
  {
    target: "job-header",
    title: "Job name, study and status",
    body: "The status badge is the whole job's status, and it keeps itself up to date from the cases: In progress as soon as any case is started or sent back, Done once every case is finished (for a review job: once every submitted case has a decision). Nothing to set by hand.",
    placement: "bottom",
  },
  {
    target: "cases-table",
    title: "The cases and their status",
    body: (
      <>
        <p>
          For an annotation job: <b>Not annotated</b> (nothing handed in yet), <b>Annotated</b> (handed in, awaiting or passed
          review) or <b>Rejected</b> (the reviewer sent it back -- their comment is shown under the case name).
        </p>
        <p>
          For a review job: <b>Awaiting review</b> means an annotation is waiting for your decision.
        </p>
      </>
    ),
    placement: "top",
  },
  {
    target: "reviewer-comment",
    title: "What the reviewer said",
    body: "A rejected case carries the reviewer's latest comment right here, so you know what to fix before you even open it. The same comments appear on the objects inside the viewer.",
    placement: "bottom",
  },
  {
    target: "open-case",
    title: "Open a case",
    body: "Takes you to the case page: the patient's scans and documents, and the button that opens the viewer where the actual work happens.",
    placement: "left",
  },
];

export const CASE_STEPS: GuideStep[] = [
  {
    title: "The case",
    body: "One patient's material for this job: their identity (pseudonymised), notes, imaging and documents. From here you open the viewer.",
    image: "workbench-case.png",
  },
  {
    target: "case-header",
    title: "Who and what",
    body: "The case title, pseudonymised patient ID, accession number and date, plus the study's notes on this case. Read-only for you -- the study's data managers edit these.",
    placement: "bottom",
  },
  {
    target: "imaging",
    title: "Imaging, grouped as the scanner saved it",
    body: "Each imaging study holds one or more series (a series is one stack of slices, e.g. the axial chest CT). The Images button previews the slices; Open in Viewer is where you annotate or review.",
    placement: "top",
  },
  {
    target: "open-viewer",
    title: "Open in Viewer",
    body: (
      <>
        <p>
          Opens the annotation (or review) surface for this series in a new window, already connected to your job -- so the
          viewer knows which tools and panes the job allows and lets you step to the next case from inside it.
        </p>
        <p>The viewer has its own guided tour the first time you open it.</p>
      </>
    ),
    placement: "left",
    image: "viewer-annotate.png",
  },
  {
    target: "documents",
    title: "Documents",
    body: "Reports and notes attached to the case (radiology, pathology, clinical). You can also open them from inside the viewer, next to the images.",
    placement: "top",
  },
  {
    target: "back-to-job",
    title: "Back to the job",
    body: "Returns to the job's case list. Your annotation is saved from the viewer, not here -- this link never loses anything.",
    placement: "bottom",
  },
];
