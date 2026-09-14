# VoxelLabel -- feature list and user guide

VoxelLabel is a platform for building CT annotation datasets: studies
hold pseudonymised patients' imaging and documents, a workflow board
turns those cases into annotation and review jobs for named people,
and a dedicated viewer is where the drawing and reviewing happens.
This document lists every feature, surface by surface, and how to use
each one. Installation is in [`INSTALL.md`](INSTALL.md); the design
rationale in [`ARCHITECTURE.md`](ARCHITECTURE.md); testing in
[`TESTING.md`](TESTING.md).

---

## 1. Concepts and roles

| Concept | Meaning |
|---|---|
| **Study** | The unit of work and of access control: members with roles, cases, a workflow board, datasets, version history. |
| **Case** | One patient examination inside a study: its imaging studies → series → instances (DICOM) and its documents. A case belongs to exactly one study; a patient may have cases in many studies. |
| **Patient** | Known only by a pseudonym: the real identifier (e.g. MRN) is hashed on the way in and never stored in the clear. The same identifier always resolves to the same patient. |
| **Workflow board** | A canvas of cards (Dataset, Split, Filter, Union, Annotation, Review, Note, Milestone, Criterion, LLM assistant, Surface configs) joined by edges that carry cases downstream. |
| **Job** | An Annotation or Review card with an assignee. It appears on that person's My Jobs page; its status (To do / In progress / Done) is computed from the cases, never set by hand. |
| **Annotation** | What an annotator saves for a series: a 3D segmentation volume plus its labels/objects. Versioned; each version has a status (draft, submitted, approved, rejected). |
| **Dataset** | A materialised list of cases produced by the board (a Split part, a job's annotated set, a plain manual dataset) -- what exports and downstream steps consume. |

**Roles.** One platform-wide role lives in Keycloak: **Platform admin**
(everything, everywhere). Everything else is granted *per study* on
the study's Members panel:

| Study role | Can |
|---|---|
| annotator | open their assigned Annotation jobs, draw, save drafts, hand cases in |
| reviewer | open their assigned Review jobs, accept/reject objects, submit decisions |
| data_manager | create/edit/delete cases, upload DICOM and documents, edit the board, run cards, export |
| admin | all of the above plus manage the study's members, edit/restore versions |
| viewer | read-only |

Someone with **only** annotator/reviewer roles (a typical doctor) sees
a reduced UI: My Jobs and the pages it leads to, nothing else.

---

## 2. Signing in and getting an account

**Surface:** `http://<server>:5173` -- one card, two tabs.

- **Sign in** -- username + password, straight into the app (no
  redirect to a separate login site). A wrong password shows an inline
  message. The session survives reloads and browser restarts until you
  sign out; if it ever becomes invalid (e.g. an admin disabled the
  account) you're returned to this form with a short notice.
- **Create account** -- first/last name, username (letters, digits, `.`
  `_` `-`), email, optional note ("why do you need access"). No
  password is asked for. You get a receipt email; every platform admin
  gets an alert; the admin approves or declines on the Users page. On
  approval you receive a one-time password by email and are asked to
  choose your own at first sign-in. Duplicate usernames/emails and
  duplicate pending requests are refused with a clear message.
- `/register.html` (the older public link) redirects to the Create
  account tab.
- **Sign out** -- the door icon next to your name (sidebar bottom, or
  top bar for annotators).

---

## 3. My Jobs (the workbench)

**Who:** everyone; the whole UI for a pure annotator/reviewer.

- **Annotation jobs / Review jobs** -- one card per job assigned to you:
  title, study, status badge, progress bar ("3 of 6 cases annotated" /
  "decided"). A job disappears once nothing in it needs you and comes
  back by itself if a reviewer sends a case back.
- **Open** -- the job page: every case with its status (*Not annotated*,
  *Annotated*, *Rejected* with the reviewer's comment; for review jobs
  *Awaiting review*). **Open case** → the case page → **Open in Viewer**.
- **Practice: Start the tutorial** -- a synthetic-data copy of the
  viewer with the real guided tour; nothing you do there is saved.
- **Email me about my jobs** -- your personal switch for the job
  emails (assigned / status changed).
- **Tutorial button** -- replays the page's guided tour (it opens by
  itself the first time you see My Jobs, the job page and the case page).

---

## 4. The viewer (annotate) -- `ct-annotator`

**Surface:** opens in a new tab from *Open in Viewer* or a job's case.
Three MPR panes (axial, coronal, sagittal) plus optional 3D, driven by
the job's *Surface* configuration (which tools/panes are allowed).

Header: **← Back** (returns to the case/job page), the **job status
badge** (automatic), **Case N of M ← →** (step through the job's
cases), **Documents** (the case's reports beside the images), **Save**
(draft) and **Mark as Annotated** (hand in for review), **Tutorial**.

**Documents** opens a report in a panel beside the images -- nothing is
downloaded and the viewer stays where it is. A PDF is shown page by
page (‹ › to step, − / + to zoom, the percentage resets to fit the
panel's width), text and images directly. Drag the panel's left edge
to resize it; on a tablet, **Full** / **Half** switches between reading
comfortably and reading next to the panes. Each pane's header has
**Maximize** (that pane alone, full width; again to restore) and
**Hide**; hidden panes come back from the eye buttons in the header.

Objects (sidebar): labels come from the job's config; **+ New
instance** creates an object of a label; a row selects it; the small
**▾ tab** on the row opens the object's form (the label's fields:
tick / pick one / scale) and its comment box -- amber once anything is
filled; a right-click on a painted voxel opens the same tab. The lock
icon protects an object from edits; double-click jumps every pane to
where that object is densest; comments from a reviewer show under the
object after a rejection.

Tools (only those the job allows are shown):

| Tool | Use |
|---|---|
| Cursor | navigate only; drag pans when zoomed; **Alt+click** shows the HU value; **Ctrl/Cmd+click** jumps all three panes to that point |
| Paint / Erase | brush on the active object; **[ ]** or the Brush size slider; right-drag erases |
| Fill | outline (scanline) fill of a closed region on the current slice |
| Polygon | click vertices, close to fill |
| Auto (tolerance) | drag a box → region-grow from the box's HU with a tolerance slider → Accept/Cancel at the box |
| Histogram | drag a box → HU histogram of the region, pick a range → fill |
| Clear hovered slice | wipes the active object on the slice under the cursor |

Navigation: mouse wheel over a pane = **zoom at the cursor** (any
tool); **Ctrl/Cmd + wheel** or **W/S / ↑↓** = step slices; **A/D / ←→**
= previous/next case; **Ctrl/Cmd+Z / Shift+Ctrl+Z** = undo/redo of
paint/erase/fill/clear gestures. Appearance: overlay opacity, window
center/width with **W/L presets** (Soft tissue, Lung, Bone, Brain), edge
enhancement (sharpness). **Saved versions** lists earlier drafts.

Saving: *Save* stores a draft version (mask volume in object storage +
labels/objects); *Mark as Annotated* stores a **submitted** version --
the case becomes *Annotated*, the job's progress and status update,
and the connected Review job's reviewer gets the case.

## 5. The viewer (review)

Same surface, review chrome: the annotator's objects are listed with
**Accept / Reject** per object and a comment box; *Submit review* is
enabled once every object is decided. If the label carries a **form**
(set on the Annotation surface card, e.g. Nodule: Type = solid /
sub-solid / ground-glass, Calcified, Confidence 1-5), it appears on
the review card above the comment box with the annotator's answers,
editable. Answers and comment are stored on the object and folded into
the review's comment on the Study page
(`Nodule 1 [Type: solid · Calcified · Confidence: 4]: ...`). Reject → the case goes back to
the annotator as *Rejected* with your comments attached to the
objects; Accept all → *Approved*. Objects can be toggled visible to
inspect; nothing can be drawn in review mode.

---

## 6. Studies

**Who:** platform admins see all studies; others the ones they're a
member of, with their role on the card.

- Grid of study cards (cover image, name, description). Hover: **set
  cover image**, **edit**, **delete** (admin only; a study with cases
  asks twice and then removes the cases *and their imaging/documents*).
- **New study** tile: name + description.

## 7. Study page

Top to bottom, each a panel:

- **Header**: name/description, **Edit**, **Workflow board**.
- **Members**: list with roles; a study admin/platform admin can add a
  member (picked from existing accounts), change a role, remove one (a
  study admin cannot remove themselves).
- **Cases**: server-side search + paging; **New case** (existing
  patient by pseudonym, or a new one from its real identifier); **Quick
  import** (bulk DICOM: a folder/zip becomes cases, with live
  progress and a summary of what landed); delete a case (cascades its
  data). Click a case → case page.
- **Annotations** / **Reviews**: every job card of that type as a table
  (assignee, status, progress); a row expands to the per-case
  breakdown -- the same view the assignee gets, for every job.
- **Workflow**: the board's non-job cards summarised as text.
- **Datasets**: every Dataset card the board produced (manual, Split
  parts, "(annotated)" sets) with counts; **Export to PyTorch** builds a
  downloadable archive of a dataset's images + masks.
- **Version history**: automatic entries (~10 min of edits by one
  person = one entry), **Save version** with a label, **Inspect /
  restore** (shows what would change; restore takes a safety copy
  first), delete a version. Study admin only for restore.

## 8. Case page

- **Header**: title, pseudonym, accession number, date, type, notes --
  editable by data managers.
- **Imaging**: imaging studies grouped as the scanner saved them, each
  with its series (modality, description, slice count, thumbnail).
  **Upload DICOM** (single files; the page polls the ingestion job and
  refreshes), **Images** (slice preview), **Open in Viewer**, edit or
  delete an imaging study/series, **Refresh**.
- **Documents**: reports/notes (radiology, pathology, clinical, other)
  with tags and consent records; upload, edit metadata, delete, open.
- **← Back to the job** when reached from a job.

## 9. Patients

- **Patients** list across all studies (pseudonym, case count),
  server-side search by pseudonym, paging, **New patient** (register a
  real identifier before any case exists; it's pseudonymised at once).
- **Patient page**: one card per case in any study (study badge,
  accession, tags), imaging thumbnails and documents (click to edit or
  delete), **Open case**.

## 10. Workflow board

**Who:** data managers/admins edit; others see a read-only board.

- **Canvas**: drag empty space to pan, wheel to zoom, Ctrl+drag to
  box-select, Delete/Backspace removes selected cards/edges, ⛶ fits
  the whole board, minimap. Every change is autosaved into the study's
  version history; **Undo / Redo**.
- **Library** (left): drag a card type onto the canvas. **Store**: saved
  pipelines (built-ins: *Basic annotation pipeline*, *Train / Test
  split*, *Review with feedback loop*, *CONSORT eligibility pipeline*,
  plus your own) inserted as a wired group; **Save to Store** turns the
  selected cards into a new template (only its author or an admin can
  delete it).
- **Cards** -- select one to open its properties on the right:
  - **Dataset**: *all cases* of the study, or a manual list. Run
    materialises its case list.
  - **Split**: parts with ratios (e.g. 70/30) and a seed; Run creates
    one child Dataset per part, deterministic for the seed.
  - **Filter**: by case tags (any/all/none); **Union**: merges inputs.
  - **Annotation**: assignee (must be a study member), labels; Run
    materialises its input cases and, if enabled, an "(annotated)"
    Dataset child that fills as cases are handed in. Assignee-only
    re-Run is allowed so *Mark as Annotated* updates it immediately.
  - **Review**: assignee; its scope is the connected Annotation's
    submitted cases.
  - **Annotation surface / Review surface**: connected to a job via the
    *surface config* handle; restricts the viewer's tools, panes and
    3D for that job. On the Annotation surface each pre-defined label
    (e.g. "Nodule") can carry a **form** -- *Add form* / *Edit form*
    next to the label opens its editor: fields with a name and a kind
    (*Tick* = yes/no, e.g. Calcified; *Pick one* = options typed as
    chips, e.g. Type: solid, sub-solid, ground-glass; *Scale* = a
    from/to range, e.g. Confidence 1-5), reorderable, with a live
    preview of the viewer's object row. Every instance of that label
    gets the form in the viewer, next to its comment.
  - **Note**, **Milestone**: documentation on the canvas.
  - **Criterion**: an eligibility rule written in plain language,
    evaluated by the local LLM over each case's documents -- yes/no per
    case with the reasoning; feeds a CONSORT-style flow.
  - **LLM assistant**: a chat card wired to the board -- ask it about
    the connected cases/documents; it can create Dataset cards and
    criteria for you (runs locally through Ollama + the MCP server).
- **Run** on a card runs it and ripples downstream; creating a case
  pushes it through every *all cases* Dataset automatically.
- **CONSORT export**: builds the enrolment flow (entered → split /
  filtered / criteria → annotated) from the board.
- **Tutorial**: the board's own guided tour.

## 11. Annotation types

The JSON Schemas annotations are validated against. Table of registered
types; **Register a new type** (name + schema). The viewer's own types
(`segmentation_volume`, `freehand_mask`) are registered by the setup
script.

## 12. De-identification profiles

Rules per DICOM tag (keep / remove / replace with a fixed value / hash
-- hashing is stable, so a patient stays linkable across studies
without their identity); one profile is the default; **New profile**,
**Add rule**. Applied at ingestion to everything uploaded from then on.

## 13. Users

**Who:** platform admin.

- **Registration requests** (only when something is pending): Approve
  (creates the account, emails the one-time password) / Decline (with
  a reason that's emailed).
- **New user**: creates an account with a temporary password you hand
  over yourself.
- Search; table with status (active/disabled, *password reset
  pending*), platform role; **Edit** (name, email, platform-admin
  flag, and the study memberships the account holds), **Reset
  password** (temporary or final), **Disable/Enable**, **Delete**
  (memberships removed; annotations stay attributed). You can't
  disable, demote or delete yourself.

## 14. Notifications

**Who:** platform admin (everyone has their own switch on My Jobs).

- **Status**: delivery on/off, last check, last error.
- **Check for changes now**: runs the observer immediately.
- **Email delivery**: SMTP host/port, STARTTLS or SSL, username,
  password (stored, never shown), sender, platform address, check
  interval; **Save settings**, then **Send test email**. The local
  stack ships with the Mailpit sandbox (nothing leaves the machine).
- **Who gets which email**: per user -- any email, new job, job status.
- **Delivery log**: every email (sent / failed with the SMTP error /
  skipped and why); click a row for the full text.

What gets sent: *New job* (assigned or reassigned to you) and *Job
status* (To do → In progress → Done and back). Never per case. Each
email is a styled job card with "What this means / What to do", no
links. Registration receipts/decisions use the same delivery log.

## 15. System

**Who:** platform admin.

- **Back up now**; last-run status; **Backups** table (daily, 14 kept;
  download, delete); **Restoring** (the host-side command).
- **Audit log**: every administrative change platform-wide (studies,
  members, cases, accounts, workflow cards and runs, versions,
  registration decisions): when, who, action, entity, details.

## 16. Guided tours

Every page has a tour ("VoxelLabel Guide", spotlight + card, → / ← /
Esc). The workbench pages (My Jobs, job, case) and both viewer modes
open theirs the first time you visit; the admin pages only on the
**Tutorial** button (sidebar bottom / board header).

## 17. Using it on a tablet

Every screen works with a finger instead of a mouse -- an iPad or an
Android tablet in either orientation, in the browser, with nothing to
install. Targets are finger-sized, wide tables scroll sideways inside
their card, and side panels turn into drawers where there isn't room:

- **Admin pages**: in portrait the left menu is a drawer -- open it with
  the ☰ button in the top bar, pick a page, it closes by itself. In
  landscape it stays a column.
- **Workflow board**: drag on empty canvas to pan, pinch to zoom, drag a
  card to move it. Add a card with the **+** on a library item (it
  lands in the middle of the view); the library itself opens from the
  header's *Library* button in portrait. Connect two cards by tapping
  one handle, then the other. Selecting a card slides its properties
  over the right edge.
- **Viewer and tutorial** (the touch equivalents of the mouse gestures):

  | With a mouse | On a tablet |
  |---|---|
  | drag (paint, erase, box) | one finger |
  | scroll to zoom | pinch with two fingers |
  | drag to pan when zoomed | two-finger drag (any tool), or one finger with the Cursor tool |
  | Ctrl/Cmd+scroll to change slice | the arrows under each pane (one slice per tap, hold to run) or its slider |
  | double-click to reset the zoom | double-tap |
  | Alt+click for the HU value | long-press (hold ~half a second) |
  | Ctrl/Cmd+click to jump all planes | two-finger tap |
  | right-drag to erase | the Eraser tool |
  | hover for a control's help | long-press the control (tap the "?" marks) |

  The side panel (objects, window/level, saved versions) opens from
  the header's **Panel** button and closes with its ✕. The footer
  line shows the gestures for the current tool. A second finger landing
  mid-stroke cancels that stroke -- lift both and start again.

  A case's **Documents** open beside the images at half the screen
  (**Full** for the whole screen), PDFs rendered page by page -- so a
  report can be read while annotating without a download. The
  tutorial's practice case has one such report, and its panes carry
  the same Maximize/Hide buttons and 3D toggle as a real case.

## 18. Clinician desktop app

`clinician-app/` packages admin-ui for a doctor: one window, only My
Jobs and what it opens, the viewer opens in a native window, the
session is remembered across launches (encrypted with the OS
keychain). Configured by a `config.json` with the same URLs as the
server's `.env`. Linux AppImage built; Windows/macOS need building on
those platforms.

## 19. APIs (for integrations)

All JSON, bearer-token (Keycloak) authenticated, same roles as the UI.

| Service | Base | Highlights |
|---|---|---|
| admin-service | `:8004/admin` | studies, members, cases, patients, clinical data items (+tags, consents), imaging metadata, annotation types, de-identification profiles, workflow cards/edges/run/surface-config, my-jobs, pipeline templates, versions, users, backups, notifications, registration requests (`/public/registration-requests` is unauthenticated), audit log |
| data-service | `:8002/data` | cases of a study, case detail, imaging studies/series/instances, presigned pixel-data and document URLs, patients search, a patient's cases |
| annotation-service | `:8003/annotations` | create a version (draft/submitted), list per study or per target, review (approve/reject), delete |
| ingestion-service | `:8001` | DICOM upload per case (async job), quick import per study, PyTorch exports |
| ct-annotator backend | `:8010` | rendering (axial/coronal/sagittal PNGs, HU probes, lung mask), mask volumes, job surface config/cases/run, a proxy for the picker and documents |

Interactive docs at `/docs` on each service.
