import { GuideStep } from "./GuideTour";

/** Tours of the full admin UI, one per page, in the same voice as the
 * workbench tours (workbenchSteps.tsx). Every `target` is a data-guide
 * attribute on that page -- or one of the three the sidebar always
 * carries (sidebar-nav, tutorial-button, account), which any page's
 * tour may point at. Steps whose target isn't on screen (an empty list,
 * a control the role doesn't get) are skipped by GuideTour itself. */

const SIDEBAR_STEP: GuideStep = {
  target: "sidebar-nav",
  title: "Getting around",
  body: (
    <>
      <p>
        <b>Workspace</b> is the day-to-day: your own jobs, the studies, and every patient across them.{" "}
        <b>Configuration</b> is platform-wide setup -- annotation types, de-identification, accounts, email, backups.
      </p>
      <p>Each page has its own short tour the first time you open it.</p>
    </>
  ),
  placement: "right",
};

const TUTORIAL_STEP: GuideStep = {
  target: "tutorial-button",
  title: "Replay any tour",
  body: "This button replays the tour of whichever page you're on. Nothing here is a one-time thing.",
  placement: "right",
};

export const STUDIES_STEPS: GuideStep[] = [
  {
    title: "Welcome to VoxelLabel admin",
    body: (
      <>
        <p>
          I'm your guide. A <b>study</b> is the unit everything hangs off: its members and their roles, its cases (one
          patient's imaging and documents each), and its workflow board that turns cases into annotation and review jobs.
        </p>
        <p>This page is every study you can see -- all of them for a platform admin, the ones you're a member of otherwise.</p>
      </>
    ),
  },
  SIDEBAR_STEP,
  {
    target: "study-card",
    title: "A study",
    body: "Click the card to open the study. Hovering shows its controls for those allowed to use them: set a cover image, edit the name and description, delete (platform admin only -- and a study with cases asks twice).",
    placement: "bottom",
  },
  {
    target: "new-study",
    title: "New study",
    body: "Name and a one-line description are all it needs. Members, cases and the board come next, on the study's own page.",
    placement: "bottom",
  },
  TUTORIAL_STEP,
];

export const STUDY_DETAIL_STEPS: GuideStep[] = [
  {
    title: "One study, top to bottom",
    body: "Everything about a study on one page, in the order it gets built: who works on it, what cases it holds, the jobs the board produced from them, and the datasets and version history that fall out of that.",
  },
  {
    target: "study-header",
    title: "Name, description, board",
    body: "Edit renames the study; Workflow board opens the canvas where cases are wired into annotation and review jobs -- the board has its own tour.",
    placement: "bottom",
  },
  {
    target: "members",
    title: "Members and roles",
    body: (
      <>
        <p>
          Who can do what <i>in this study</i>: <b>annotator</b> draws, <b>reviewer</b> accepts or rejects, <b>data manager</b>{" "}
          adds and edits cases, <b>admin</b> also manages members. A platform admin has every role everywhere.
        </p>
        <p>Accounts themselves live under Configuration → Users; this panel only grants roles to existing accounts.</p>
      </>
    ),
    placement: "top",
  },
  {
    target: "cases",
    title: "Cases",
    body: "The study's material: one case per patient examination, holding their imaging (DICOM series) and documents. Searchable and paged, since a study can hold thousands. Data managers create cases here or import DICOM in bulk; opening one shows its images and lets you jump into the viewer.",
    placement: "top",
  },
  {
    target: "annotations",
    title: "Annotation jobs",
    body: "Every Annotation card on this study's board, as a table: assignee, status and progress. A row expands to its case-by-case breakdown -- the same view the annotator gets on My Jobs, here for every job, not only your own.",
    placement: "top",
  },
  {
    target: "reviews",
    title: "Review jobs",
    body: "The Review cards, likewise. Status is automatic on both: In progress while any case is started, sent back or waiting, Done once every case is finished or decided.",
    placement: "top",
  },
  {
    target: "workflow-summary",
    title: "The rest of the board",
    body: "The board's other cards -- splits, filters, notes, milestones -- summarised as text. Read-only here; the board is where they're edited.",
    placement: "top",
  },
  {
    target: "datasets",
    title: "Datasets",
    body: "The data artifacts the board produced: each Split part, each job's annotated set. What a downstream step or an export actually consumes.",
    placement: "top",
  },
  {
    target: "versions",
    title: "Version history",
    body: "Every change to the study is captured automatically (one entry per ~10 minutes of edits by the same person); anyone who can edit can also save a named version. A study admin can restore any of them -- a safety copy of the current state is taken first, so a restore is itself reversible.",
    placement: "top",
  },
];

export const PATIENTS_STEPS: GuideStep[] = [
  {
    title: "Patients across every study",
    body: "One row per patient, whatever study their cases sit in. Patients are known by a pseudonym: the real identifier is hashed on the way in and never stored in the clear.",
  },
  {
    target: "patient-search",
    title: "Find a patient",
    body: "Search by the pseudonym ID (paste the whole thing or its start). The list is searched and paged on the server, so it stays fast however many patients there are.",
    placement: "bottom",
  },
  {
    target: "new-patient",
    title: "Register a patient early",
    body: "Creates the patient before any case exists for them. Enter the real identifier (e.g. the MRN); it's pseudonymised at once, and a case created later with the same identifier resolves to this same patient, not a duplicate.",
    placement: "left",
  },
  {
    target: "patients-table",
    title: "The list",
    body: "The case count is how many examinations the platform holds for them. Click a patient to see those cases with their images and documents.",
    placement: "top",
  },
];

export const PATIENT_DETAIL_STEPS: GuideStep[] = [
  {
    title: "One patient",
    body: "Every case for this patient, across every study -- one card each, showing which study it belongs to and what imaging and documents it holds.",
  },
  {
    target: "patient-case",
    title: "A case",
    body: "The study badge and accession number identify the examination; tags are the study's own labels on it.",
    placement: "bottom",
  },
  {
    target: "open-case",
    title: "Open the case",
    body: "The full case page inside its study: notes, imaging grouped as the scanner saved it, documents, and the button into the viewer.",
    placement: "left",
  },
  {
    target: "imaging",
    title: "Imaging",
    body: "One thumbnail per imaging study. Click it to see its series and edit or delete the imaging study.",
    placement: "top",
  },
  {
    target: "documents",
    title: "Documents",
    body: "Reports and notes attached to the case (radiology, pathology, clinical). Click one to read, edit or delete it.",
    placement: "top",
  },
];

export const ANNOTATION_TYPES_STEPS: GuideStep[] = [
  {
    title: "Annotation types",
    body: "An annotation type is the shape of what annotators save -- a JSON Schema the platform validates every submission against. The viewer's segmentation masks use one; a study can define others for structured findings.",
  },
  {
    target: "types-table",
    title: "Registered types",
    body: "Name and schema of every type in use. Types are referenced by name from workflow cards, so a name can't change once jobs depend on it.",
    placement: "bottom",
  },
  {
    target: "new-type",
    title: "Register a new one",
    body: "A name and a JSON Schema. The example prefilled here is a rectangle; replace it with whatever payload your study needs. Takes effect immediately, no deployment.",
    placement: "top",
  },
];

export const DEID_STEPS: GuideStep[] = [
  {
    title: "De-identification",
    body: "How DICOM headers are cleaned when imaging is ingested. A profile is a list of rules -- one DICOM tag each -- and a study is assigned a profile; the default profile applies where none is chosen.",
  },
  {
    target: "profile",
    title: "A profile",
    body: "Its rules, tag by tag: keep the value, remove it, replace it with a fixed value, or hash it (stable pseudonyms -- the same input always gives the same output, so a patient stays linkable across studies without their identity).",
    placement: "bottom",
  },
  {
    target: "add-rule",
    title: "Add a rule",
    body: "Tag in (gggg,eeee) form, an action, and a replacement value when the action is replace_fixed. Rules apply to imaging ingested from now on, not retroactively.",
    placement: "top",
  },
  {
    target: "new-profile",
    title: "New profile",
    body: "Name it, optionally make it the default, then add its rules above.",
    placement: "top",
  },
];

export const USERS_STEPS: GuideStep[] = [
  {
    title: "Accounts",
    body: (
      <>
        <p>
          Every account in the platform. Two things live here and nowhere else: creating accounts, and the one platform-wide
          role -- <b>Platform admin</b>, who can do everything, everywhere.
        </p>
        <p>What someone may do <i>inside a study</i> is granted on that study's Members panel, not here.</p>
      </>
    ),
  },
  {
    target: "registration-requests",
    title: "Registration requests",
    body: "People who asked for an account through the sign-in page's Create account tab. Approve creates their account and emails them a one-time password (they choose their own at first sign-in); Decline emails them your reason. This panel only appears while something is pending.",
    placement: "bottom",
  },
  {
    target: "new-user",
    title: "New user",
    body: "Creates an account directly with a temporary password you hand over yourself -- the person is asked to choose their own the first time they sign in.",
    placement: "left",
  },
  {
    target: "user-search",
    title: "Find an account",
    body: "By name, username or email.",
    placement: "bottom",
  },
  {
    target: "users-table",
    title: "The accounts",
    body: (
      <>
        <p>
          Status is <b>active</b> or <b>disabled</b> (a disabled account can't sign in until re-enabled); <i>password reset
          pending</i> means they must choose a new password at their next sign-in.
        </p>
        <p>Edit changes name, email and the platform-admin flag; Reset password sets a new one; Disable and Delete are here too. You can't disable, demote or delete yourself.</p>
      </>
    ),
    placement: "top",
  },
];

export const NOTIFICATIONS_STEPS: GuideStep[] = [
  {
    title: "Email notifications",
    body: "The platform emails people when a job is assigned to them and when a job's status changes -- one message per job, never one per case. This page is where delivery is configured and watched.",
  },
  {
    target: "notif-status",
    title: "Is it working?",
    body: "Whether delivery is switched on, when the last check ran and what it found, and the last error if the SMTP server refused something.",
    placement: "bottom",
  },
  {
    target: "notif-run-now",
    title: "Check now",
    body: "The service looks for changes on a timer (the interval is in the settings below). This runs one check immediately -- handy right after changing settings.",
    placement: "left",
  },
  {
    target: "notif-settings",
    title: "Delivery settings",
    body: (
      <>
        <p>
          The SMTP server to send through. In the local stack the <b>Mailpit</b> sandbox catches everything at localhost:8025
          and nothing leaves the machine; point this at a real server (host, port, STARTTLS or SSL, credentials, sender
          address) to send for real.
        </p>
        <p>Save settings first, then Send test email -- the test goes through the saved settings, not the form.</p>
      </>
    ),
    placement: "top",
  },
  {
    target: "notif-preferences",
    title: "Who gets which email",
    body: "Per person: any email at all, new-job emails, job-status emails. People can also switch their own emails off from My Jobs.",
    placement: "top",
  },
  {
    target: "notif-log",
    title: "Delivery log",
    body: "Every email the service decided about -- sent, failed (with the SMTP error), or skipped and why. Click a row to read the message that went out.",
    placement: "top",
  },
];

export const SYSTEM_STEPS: GuideStep[] = [
  {
    title: "System",
    body: "Operations: backups of the metadata database (studies, cases, members, workflow, annotations). Images, documents and masks live in object storage and are backed up separately.",
  },
  {
    target: "backup-now",
    title: "Back up now",
    body: "Queues an on-demand backup; the backup service picks it up within about 30 seconds. Daily backups run on their own, kept for 14 days.",
    placement: "left",
  },
  {
    target: "backup-status",
    title: "The last run",
    body: "What the most recent backup run reported, and when. Red means it failed -- the message says why.",
    placement: "bottom",
  },
  {
    target: "backups",
    title: "Backup files",
    body: "Each is a compressed pg_dump with a checksum. Download one for an off-site copy; delete old ones you no longer need.",
    placement: "top",
  },
  {
    target: "restoring",
    title: "Restoring",
    body: "A full restore is a command on the host, shown here, and replaces the whole database. For a mistake inside one study, use that study's Version history instead -- it restores without touching anything else.",
    placement: "top",
  },
  {
    target: "audit-log",
    title: "Audit log",
    body: "Who changed what, platform-wide: studies created or renamed, members added or removed, cases, accounts, workflow cards and runs, version restores, registration decisions. Newest first. Annotations aren't listed here -- each keeps its own version history on the case.",
    placement: "top",
  },
];

export const BOARD_STEPS: GuideStep[] = [
  {
    title: "The workflow board",
    body: (
      <>
        <p>
          Where a study's cases become work. Cards are steps -- a Dataset of cases, a Split into parts, a Filter, an{" "}
          <b>Annotation</b> or <b>Review</b> job with an assignee -- and edges carry cases from one card to the next.
        </p>
        <p>Drag on empty canvas to pan, scroll to zoom, hold Ctrl and drag to select several cards.</p>
      </>
    ),
  },
  {
    target: "board-header",
    title: "Which study, and Back",
    body: "Back returns to the study page. Read-only here means your role in this study can look but not edit -- the backend enforces the same rule.",
    placement: "bottom",
  },
  {
    target: "board-library",
    title: "Library and Store",
    body: "Library lists the card types: drag one onto the canvas. Store holds saved pipelines -- whole sets of wired cards -- to insert in one go.",
    placement: "right",
  },
  {
    target: "board-canvas",
    title: "The canvas",
    body: "Select a card and its properties open on the right: its name, its assignee for a job, its config, and Run. Running a card materialises its output -- a job's cases become assignable, a Split produces its parts. Delete removes selected cards or edges.",
    placement: "left",
  },
  {
    target: "board-toolbar",
    title: "Save to Store, Undo, Redo",
    body: "Select cards and Save to Store to reuse them as a pipeline template in any study. Undo and Redo cover card and edge changes.",
    placement: "bottom",
  },
  {
    target: "consort-export",
    title: "CONSORT export",
    body: "Builds a CONSORT-style flow of how many cases entered, were split, filtered and annotated -- straight from the board.",
    placement: "bottom",
  },
  {
    target: "board-tutorial",
    title: "This tour",
    body: "Replay it any time from here.",
    placement: "bottom",
  },
];
