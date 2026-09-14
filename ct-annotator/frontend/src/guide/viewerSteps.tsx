import { GuideStep } from "./GuideTour";

/** The annotator's walkthrough of the viewer, in the order a first case
 * is actually worked: orient, pick what to draw, draw it, check it, hand
 * it in. Every `target` matches a data-guide attribute in ViewerPage. */
export const ANNOTATE_STEPS: GuideStep[] = [
  {
    title: "Welcome to your annotation workspace",
    body: (
      <>
        <p>
          I'm your guide. This is where you mark structures on a CT scan for the job you opened. I'll walk you through the
          screen once -- about two minutes -- and you can replay this any time from the amber <b>Tutorial</b> button in the top bar.
        </p>
        <p>
          The flow is always the same: <b>look</b> at the scan, <b>select an object</b> to draw into, <b>draw</b> it with a
          tool, <b>save</b>, and when the case is complete, <b>Mark as Annotated</b> so a reviewer can check it.
        </p>
      </>
    ),
    image: "viewer-annotate.png",
  },
  {
    target: "back",
    title: "Back to the case",
    body: "Returns to the case page in your job list. Your work is not saved automatically -- save first (I'll show you where) before you leave.",
    placement: "bottom",
  },
  {
    target: "job-status",
    title: "Your job's status",
    body: (
      <>
        <p>
          The status of the whole job (all its cases), as it shows on your job list: <b>To do</b>, <b>In progress</b> or{" "}
          <b>Done</b>. You never set it -- it follows the cases by itself: In progress as soon as any case is started or
          sent back, Done once every case is annotated (for a review job: once every submitted case has a decision).
        </p>
        <p>Each individual case's own progress is what Mark as Annotated (or Submit review) changes.</p>
      </>
    ),
    placement: "bottom",
  },
  {
    target: "case-nav",
    title: "Move between the job's cases",
    body: "Your job is a list of cases. These arrows step to the previous or next case that still needs you -- not yet handed in, or sent back by the reviewer -- skipping the ones already done, without going back to the job page. Save before you switch -- unsaved drawing stays on this case only.",
    placement: "bottom",
  },
  {
    target: "documents",
    title: "The patient's documents",
    body: "Radiology reports, pathology, clinical notes -- whatever the study attached to this case. Opening one shows it in a side panel next to the images so you can read and draw at the same time.",
    placement: "bottom",
  },
  {
    target: "panes",
    title: "The image panes",
    body: (
      <>
        <p>
          Each pane is one plane through the volume (Axial, Sagittal, Coronal) plus an optional 3D view. Which panes you see is
          set by the job.
        </p>
        <p>
          <b>Scroll</b> zooms · <kbd>Ctrl</kbd>+scroll (or the arrows and slider under the pane) changes slice · <b>drag</b> pans when zoomed ·{" "}
          <b>double-click</b> resets · <kbd>Ctrl</kbd>+click jumps every pane to that point · <kbd>Alt</kbd>+click reads the
          Hounsfield value.
        </p>
      </>
    ),
    placement: "right",
  },
  {
    target: "objects",
    title: "Objects: what you are drawing",
    body: (
      <>
        <p>
          A <b>label</b> is a kind of thing (e.g. "Nodule"); an <b>object</b> is one instance of it ("Nodule 1", "Nodule 2").
          Every voxel you paint belongs to exactly one object, so first <b>click the object</b> you want to draw into -- it
          gets highlighted and the drawing tools unlock.
        </p>
        <p>
          <b>+</b> next to a label adds a new instance. The small <b>▾ tab</b> on a row opens that object's form -- the
          label's fields (e.g. nodule type, calcified, a confidence scale) -- and its comment; it turns amber once
          anything is filled. Each row can also be hidden (eye), locked against accidental edits (lock), or deleted
          (bin). Double-click a row to jump all panes to that object.
        </p>
      </>
    ),
    image: "viewer-objects.png",
    placement: "left",
    tip: "If the job gave you labels already, you only add instances. Otherwise type a label name and press +.",
  },
  {
    target: "new-instance",
    title: "New instance, quickly",
    body: (
      <>
        <p>
          Adds another instance of the currently selected object's label and makes it active -- the fast way to start the
          second nodule when you've just finished the first. Shortcut: <kbd>N</kbd>.
        </p>
      </>
    ),
    placement: "bottom",
  },
  {
    target: "toolbar",
    title: "The drawing tools",
    body: (
      <>
        <p>Top to bottom (hover any of them later for a reminder):</p>
        <p>
          <b>Cursor</b> -- navigate only, nothing is drawn. <b>Paint</b> -- brush; drag to paint, right-drag to erase.{" "}
          <b>Eraser</b> -- removes paint from any object. <b>Fill</b> -- click inside a closed outline to fill it.{" "}
          <b>Polygon</b> -- click points around a structure, click the first point to close. <b>Auto</b> -- drag a box and the
          viewer segments by intensity; adjust the tolerance and press <kbd>Enter</kbd>. <b>Histogram</b> -- drag a box to see
          its HU distribution (measurement only).
        </p>
        <p>The job may show only some of these -- the workflow decides which tools each surface gets.</p>
      </>
    ),
    image: "viewer-toolbar.png",
    placement: "right",
    tip: "Right-click on a painted area without dragging to attach a comment to that object.",
  },
  {
    target: "draw",
    title: "Brush size and clearing a slice",
    body: "Brush size applies to Paint and Eraser. Clear hovered slice wipes the active object's paint on the slice under the mouse only -- useful when one slice went wrong and the rest is fine.",
    placement: "left",
  },
  {
    target: "undo-redo",
    title: "Undo and redo",
    body: (
      <>
        <p>
          Every paint, erase, fill and polygon is one step. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+
          <kbd>Z</kbd> redoes. History is per session -- it doesn't survive a reload, but a saved draft does.
        </p>
      </>
    ),
    placement: "bottom",
  },
  {
    target: "appearance",
    title: "Overlay opacity",
    body: "How strongly the coloured annotation overlay is drawn over the scan. Display only -- nothing about the annotation changes, just how visible it is while you work.",
    placement: "left",
  },
  {
    target: "window",
    title: "Window / level",
    body: "Presets (Soft tissue, Lung, Bone, Brain) set the greyscale mapping for the structure you're looking at; the sliders fine-tune it. This only changes how you see the image, never the data or your annotation. Reset to original puts the scan's own window back.",
    placement: "left",
  },
  {
    target: "sharpness",
    title: "Sharpness",
    body: "Enhances edges in the displayed image to make boundaries easier to follow -- 0 is the original image, higher values sharpen it. Display only, same as Window/level: never touches the data or your annotation.",
    placement: "left",
  },
  {
    target: "footer",
    title: "The hint bar",
    body: "Always shows what the mouse does with the current tool, and which object is active. If a drag does nothing, look here first -- usually no object is selected.",
    placement: "top",
  },
  {
    target: "save",
    title: "Save a draft",
    body: "Stores your current drawing as a draft on this case. Do this often; it costs nothing and you can keep editing afterwards. Drafts are only visible to you and to the study's data managers.",
    placement: "bottom",
  },
  {
    target: "mark-annotated",
    title: "Mark as Annotated -- hand it in",
    body: (
      <>
        <p>
          When the case is complete, this saves it and marks it <b>Annotated</b>: the reviewer's job now shows it as awaiting
          review.
        </p>
        <p>
          If the reviewer rejects something, the case comes back to your job as <b>Rejected</b> with their comments on the
          objects concerned (shown in your job list and here on the objects, in amber). Fix it and Mark as Annotated again.
        </p>
      </>
    ),
    placement: "bottom",
  },
  {
    title: "That's the whole loop",
    body: (
      <>
        <p>
          Select an object → draw → Save → Mark as Annotated → next case. Hover any control for a description, and press the
          amber <b>Tutorial</b> button in the top bar to see this tour again.
        </p>
      </>
    ),
  },
];

/** The reviewer's walkthrough: the review surface is view-and-decide only,
 * so it is shorter -- orient, step through the objects, decide, submit. */
export const REVIEW_STEPS: GuideStep[] = [
  {
    title: "Welcome to the review surface",
    body: (
      <>
        <p>
          I'm your guide. Here you check an annotator's work on one case: you look at every object they drew, accept or
          reject each one (with a comment when rejecting), and submit the decision. Nothing here draws or edits -- the
          drawing tools are switched off on purpose.
        </p>
      </>
    ),
    image: "viewer-review.png",
  },
  {
    target: "case-nav",
    title: "Move between the job's cases",
    body: "Your review job is a list of cases; these arrows step only through the ones still awaiting your decision -- already accepted (or sent back) cases are skipped.",
    placement: "bottom",
  },
  {
    target: "documents",
    title: "The patient's documents",
    body: "The reports and notes attached to the case, opened in a side panel -- often the fastest way to decide whether an annotation is plausible.",
    placement: "bottom",
  },
  {
    target: "panes",
    title: "Inspect the annotation",
    body: (
      <>
        <p>
          The annotator's objects are drawn over the scan. <b>Scroll</b> zooms · <kbd>Ctrl</kbd>+scroll (or the arrows and slider under the pane) changes
          slice · <b>drag</b> pans · <b>double-click</b> resets · <kbd>Alt</kbd>+click reads the HU value. Window/level presets
          on the right change only how you see the image.
        </p>
      </>
    ),
    placement: "right",
  },
  {
    target: "review-objects",
    title: "The objects to review",
    body: "Every object in this annotation, with a dot for its decision: grey = not decided yet, green = accepted, red = rejected. Click one to jump to it; the card above follows.",
    image: "viewer-review-objects.png",
    placement: "left",
  },
  {
    target: "review-card",
    title: "Decide object by object",
    body: (
      <>
        <p>
          The card shows the current object (n / total) and its decision. <b>Accept</b> or <b>Reject</b> records the decision
          and moves on to the next undecided object; the arrows step back and forth. If the label has a form (e.g. nodule type, calcified, confidence), it's here above
          the comment with the annotator's answers -- correct it or add to it; it goes back with your comment.
        </p>
        <p>
          When rejecting, write <b>what is wrong</b> in the comment -- the annotator sees exactly this text next to the object
          when the case comes back to them.
        </p>
      </>
    ),
    image: "viewer-review-card.png",
    placement: "left",
  },
  {
    target: "submit-review",
    title: "Submit the review",
    body: (
      <>
        <p>
          Enabled once <b>every</b> object has a decision. One rejected object rejects the whole case -- it returns to the
          annotator with your comments; all accepted approves it and the case is done.
        </p>
      </>
    ),
    placement: "bottom",
  },
  {
    title: "That's all there is to it",
    body: "Step through the objects, decide each, submit. Hover any control for a description; press the amber Tutorial button in the top bar to replay this tour.",
  },
];
