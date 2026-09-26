import { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import {
  AnnotationSummary,
  AnnotationType,
  fetchAxialBlobUrl,
  fetchCoronalBlobUrl,
  fetchSagittalBlobUrl,
  fetchSlabBlobUrl,
  fetchJobCases,
  fetchPlaneHU,
  fetchSegmentationVolume,
  fetchSurfaceConfig,
  fetchVoxelHU,
  JobCase,
  runJob,
  submitAnnotationReview,
  getInstanceMetadata,
  InstanceMetadata,
  listAnnotations,
  listAnnotationTypes,
  saveSegmentationVolume,
  SegLabel,
  SegObject,
  SlabMode,
  SurfaceConfig,
} from "../api/annotatorApi";
import { ApiError } from "../api/client";
import { askRatingIfDue } from "../usage/RatingPrompt";
import { trackAction } from "../usage/tracker";
import DocumentPanel, { DocumentSource } from "../components/DocumentPanel";
import { ObjectAnswers, ObjectField, ObjectFormEditor, ObjectFormTab, formatAnswers } from "../components/ObjectForm";
import SliceControl from "../components/SliceControl";
import SliceNumber from "../components/SliceNumber";
import { enterFullscreen, exitFullscreen, fullscreenDeclined, fullscreenElement, onFullscreenChange, rememberFullscreenDeclined } from "../lib/fullscreen";
import { nextUndecidedIndex } from "../lib/reviewNav";
import { handInObjects, isNewThisRound, previousReviewText, REJECT_REASONS, rejectReasonLabel, reviewCommentText } from "../lib/reviewRound";
import { reviewBlockedMessage, ReviewState, reviewStateOf } from "../lib/reviewState";
import { TAP_ACTION_DELAY_MS, TapDetector, TapGesture, TouchTracker, useCoarsePointer, useCompactLayout } from "../lib/touch";
import {
  CaseDocument,
  getDocumentFile,
  InstanceSummary,
  listCaseDocuments,
  listImagingStudies,
  listInstances,
  listSeries,
} from "../api/dataApi";
import Tip from "../components/Tip";
import ViewAsTabs from "../components/ViewAsTabs";
import { isPlatformAdmin, readViewAs, withViewAs, writeViewAs, ViewAs } from "../viewAs";
import Viewer3D from "../components/Viewer3D";
import GuideTour from "../guide/GuideTour";
import { useGuide } from "../guide/useGuide";
import { ANNOTATE_STEPS, REVIEW_STEPS } from "../guide/viewerSteps";
import { growRegion, HU_MAX, HU_MIN, suggestRange } from "../lib/autoContour";
import { polygonMask, scanlineFill } from "../lib/scanlineFill";
import { returnUrlForCase, safeReturnUrl } from "../lib/returnUrl";
import { errorText } from "../lib/errorText";

// Layout modeled on CVAT (Computer Vision Annotation Tool): a top job
// bar (Save/Undo/Redo), a left icon toolbar (Cursor/Paint/Erase/Fill --
// no separate mode tabs, the selected tool IS the mode), a canvas, and a
// right objects sidebar listing every labeled object as its own
// color-coded row with lock/hide toggles. Keeps this app's own dark
// theme (not CVAT's light chrome) and its own data model: a real
// whole-series 3D segmentation volume (see
// ~/.claude/plans/unified-splashing-blossom.md) where each voxel stores
// which *object* owns it, not a plain painted/unpainted mask -- so
// multiple named, numbered instances per label (e.g. "Nodule 1",
// "Nodule 2") can coexist, each independently locked/hidden/deleted.
const DEFAULT_PANE_SIZE = 480; // fallback before the ResizeObserver below measures the real available space
const DEFAULT_WINDOW_CENTER = 40;
const DEFAULT_WINDOW_WIDTH = 400;
const DEFAULT_OVERLAY_OPACITY = 70; // percent
const LABEL_COLOR_PALETTE = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];
const MAX_OBJECT_ID = 255; // one byte per voxel; 0 is reserved for background

type PaneKey = "sagittal" | "coronal" | "axial";
const PANE_ORDER: PaneKey[] = ["sagittal", "coronal", "axial"];
const PANE_LABELS: Record<PaneKey, string> = { sagittal: "Sagittal", coronal: "Coronal", axial: "Axial" };
// Each plane's own colour: its crosshair line in the other panes, and
// the dot beside its name, so "that orange line is the sagittal" reads.
const PLANE_COLORS: Record<PaneKey, string> = { sagittal: "#f59e0b", coronal: "#22c55e", axial: "#38bdf8" };
// Half the empty gap the crosshair leaves around the point where its
// lines would meet (screen px) -- the middle is what's being looked at.
const CROSSHAIR_GAP_PX = 16;
// Width of the slice strip standing along each pane's right edge.
const SLICE_STRIP_PX = { mouse: 26, touch: 40 };
// Mouse window/level drag: HU per pixel of movement, relative to the
// current width (a wide window moves faster), and the drag distance
// that tells a drag from a click.
const WINDOW_DRAG_HU_PER_PX = 1 / 300;
const WINDOW_DRAG_THRESHOLD_PX = 4;
const SLAB_THICKNESSES = [1, 3, 5, 9, 15, 25];
const SLAB_LABEL: Record<SlabMode, string> = { avg: "Average", mip: "MIP", minip: "MinIP" };
const SLAB_HELP: Record<SlabMode, string> = {
  avg: "The mean of the slices: less noise, like a thicker reconstruction.",
  mip: "Maximum intensity projection: the brightest voxel through the slab -- vessels and nodules stand out against the lung.",
  minip: "Minimum intensity projection: the darkest voxel through the slab -- airways and air trapping.",
};

// The 3D pane is visually a 4th column alongside the three MPR panes,
// but never participates in the drawing math (planeDims/readSliceValue/
// etc, all keyed on PaneKey) -- kept as a separate union rather than
// added to PaneKey so every switch/lookup over drawing-plane logic
// doesn't need a dead "three_d" case threaded through it.
type VisiblePaneKey = PaneKey | "three_d";
const ALL_PANE_VISIBILITY_KEYS: VisiblePaneKey[] = ["sagittal", "coronal", "axial", "three_d"];

type DrawTool = "cursor" | "paint" | "erase" | "fill" | "polygon" | "auto" | "histogram";
const STATUS_OPTIONS = ["draft", "submitted", "approved", "rejected"];


// Same 3-value set the admin-ui workflow board's Annotation/Review
// TaskFields Status dropdown uses (see WorkflowPropertiesPanel.tsx) --
// keep the labels in sync with that if they ever change there.
// The job's own todo/in_progress/done -- shown, never edited here: it's
// computed by admin-service from the cases' real annotation state
// (compute_job_status), so a manual pick would only be overwritten by
// the next fetch. Colors mirror admin-ui's TASK_STATUS_STYLE.
const JOB_STATUS_STYLE: Record<string, { label: string; className: string }> = {
  todo: { label: "To do", className: "border-red-500/40 bg-red-500/15 text-red-300" },
  in_progress: { label: "In progress", className: "border-blue-500/40 bg-blue-500/15 text-blue-300" },
  done: { label: "Done", className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" },
};

// Standard clinical CT window/level presets (Hounsfield-unit-based center
// and width), matching the values common CT viewers ship as quick-select
// buttons -- see e.g. Weasis/MedDream's "CT Lung"/"CT Bone" presets.
const PRESET_HELP: Record<string, string> = {
  "Soft tissue": "General-purpose view of organs and soft tissue.",
  Lung: "Wide window for lung parenchyma and nodules.",
  Bone: "Wide, bright window for cortical and trabecular bone.",
  Brain: "Narrow window for subtle grey/white-matter contrast.",
};

const WINDOW_PRESETS: { label: string; center: number; width: number }[] = [
  { label: "Soft tissue", center: 40, width: 400 },
  { label: "Lung", center: -600, width: 1500 },
  { label: "Bone", center: 300, width: 1500 },
  { label: "Brain", center: 40, width: 80 },
];

interface ZoomState {
  scale: number;
  panX: number;
  panY: number;
}
const IDLE_ZOOM: ZoomState = { scale: 1, panX: 0, panY: 0 };

interface SliceSnapshot {
  pane: PaneKey;
  index: number;
  slice: Uint8Array;
}

// A dragged <input type="range"> fires its onChange on every intermediate
// value, not just on release. Feeding that straight into a fetch-triggering
// effect would flood the backend with one request per pixel of drag
// movement, so the committed value is rate-limited -- but *throttled*
// (fires on a fixed cadence during the drag, leading + trailing edge),
// not *debounced* (fires only once, after the user stops). Debouncing
// left the image frozen for the whole gesture and only jumping to the
// final frame on release; throttling keeps it visibly advancing while
// still dragging, capped to at most one request per intervalMs.
function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastFiredRef = useRef(0);

  useEffect(() => {
    const elapsed = Date.now() - lastFiredRef.current;
    if (elapsed >= intervalMs) {
      lastFiredRef.current = Date.now();
      setThrottled(value);
      return;
    }
    const timer = setTimeout(() => {
      lastFiredRef.current = Date.now();
      setThrottled(value);
    }, intervalMs - elapsed);
    return () => clearTimeout(timer);
  }, [value, intervalMs]);

  return throttled;
}

async function gzipUint8Array(data: Uint8Array): Promise<ArrayBuffer> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function gunzipToUint8Array(gzipBytes: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([gzipBytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.replace("#", ""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const HU_HISTOGRAM_BINS = 32;

interface HuStats {
  min: number;
  max: number;
  mean: number;
  count: number;
  bins: number[];
}

/** Min/max/mean + a fixed-bin-count histogram over a flat list of HU
 * values -- shared by the Histogram tool's own box (every value in it)
 * and the Auto-contour tool's "Histogram" button (only the values the
 * region-grow actually selected), so both popups render identically off
 * one implementation. Pure, no DOM/React involved. */
function computeHuStats(values: ArrayLike<number>): HuStats | null {
  if (values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const count = values.length;
  const mean = sum / count;
  const range = Math.max(1, max - min);
  const bins = new Array(HU_HISTOGRAM_BINS).fill(0);
  for (let i = 0; i < count; i++) {
    const bin = Math.min(HU_HISTOGRAM_BINS - 1, Math.max(0, Math.floor(((values[i] - min) / range) * HU_HISTOGRAM_BINS)));
    bins[bin]++;
  }
  return { min, max, mean, count, bins };
}

export default function ViewerPage() {
  const { instanceId: routeInstanceId } = useParams<{ instanceId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const studyId = searchParams.get("studyId");
  const seriesId = searchParams.get("seriesId");
  const jobId = searchParams.get("jobId");
  // The case this series belongs to, when opened from admin-ui (which
  // knows it from the route it came from) -- absent on a plain visit or
  // one predating this param. Needed only to place this case in
  // `jobCases` for the Prev/Next arrows below; the viewer itself has
  // never needed to know its own case id for anything else.
  const caseId = searchParams.get("caseId");
  // Set when the viewer was opened from admin-ui (a Case page's "Open in
  // Viewer" link, which opens in a new tab with no browser history to go
  // back to) -- lets the header's Back arrow return there instead of to
  // this app's own picker, which a plain/standalone visit still uses.
  // Only ever one of our own pages -- see lib/returnUrl.ts (J-03).
  const returnUrl = safeReturnUrl(searchParams.get("returnUrl"));

  const [error, setError] = useState<string | null>(null);
  // Set instead of the generic `error` banner specifically when the
  // backend reports a series can't form a real 3D stack (e.g. a scout/
  // localizer series -- see backend/app/main.py's _get_volume) --
  // that's an expected, non-alarming state for this series, not a
  // failure, so it renders as a quiet in-pane message rather than the
  // red top-of-page error banner every other fetch failure uses.
  const [volumeUnavailable, setVolumeUnavailable] = useState<string | null>(null);

  // A Surface card's mandatory tool/pane/3D restriction for this job --
  // null means unrestricted, both before a jobId's config has loaded and
  // permanently when there's no jobId at all (a plain, non-job visit),
  // so the viewer behaves exactly as it did before this feature existed
  // unless it's explicitly opened as someone's assigned job.
  const [surfaceConfig, setSurfaceConfig] = useState<SurfaceConfig | null>(null);
  // The job's settings didn't load: nothing is known about what this job
  // allows (a Review job must never fall back to editing), so the viewer
  // stays read-only instead of opening the full annotation surface (F-14).
  const [surfaceFailed, setSurfaceFailed] = useState(false);
  // The saved segmentation didn't load (e.g. storage down): editing an
  // empty canvas would only end in a refused save, so stay read-only (I-07).
  const [maskLoadFailed, setMaskLoadFailed] = useState(false);
  const readOnlyLocked = surfaceFailed || maskLoadFailed;
  useEffect(() => {
    if (!jobId) return;
    setSurfaceFailed(false);
    fetchSurfaceConfig(jobId)
      .then(setSurfaceConfig)
      .catch(() => setSurfaceFailed(true));
  }, [jobId]);
  // A Review job (as opposed to Annotation) never edits the mask -- it
  // swaps the whole chrome for a simplified, view-and-decide-only
  // surface: no toolbar, no 3D, an object-by-object navigator instead of
  // the full Objects panel. Only ever true when opened via a Review
  // card's jobId; a plain visit or an Annotation job's jobId behaves
  // exactly as before.
  // A platform admin's "View as" choice (see viewAs.ts). Reviewer is a
  // strict subset of Annotator on this platform (an annotator may also
  // hold review jobs; a reviewer never holds annotation ones -- see
  // admin-ui's My Jobs, which already hides Annotation cards from a
  // reviewer's list for the same reason), so the simulation follows
  // that: "reviewer" forces the review surface no matter which job the
  // viewer was opened with (a reviewer should never land anywhere
  // else), but "annotator" does NOT force the annotation surface on a
  // real Review job -- that would show a false picture of what an
  // actual annotator sees when one of their own review assignments
  // opens. Anyone else, and "annotator" itself: the job's real type
  // decides, same as always.
  const platformAdmin = isPlatformAdmin();
  const [viewAs, setViewAsState] = useState<ViewAs>(() => readViewAs(window.location.search));
  const simulatedRole: ViewAs | null = platformAdmin && viewAs !== "admin" ? viewAs : null;
  function changeViewAs(value: ViewAs) {
    writeViewAs(value);
    setViewAsState(value);
  }
  const reviewMode = simulatedRole === "reviewer" ? true : surfaceConfig?.card_type === "review";
  const effectiveSurface = surfaceConfig;
  // The job's Surface decides the tools; the Eraser also drives right-drag
  // erase and "Clear hovered slice", so neither is a way around a Surface
  // without it (E-10).
  // Never in review mode: that surface views and decides, it doesn't edit (F-13).
  useEffect(() => {
    if (reviewMode) setTool("cursor"); // e.g. an admin switching "View as" to Reviewer mid-stroke (F-13)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewMode]);
  const eraseAllowed = !reviewMode && !readOnlyLocked && (!effectiveSurface || effectiveSurface.tools.includes("erase"));

  // The job's own todo/in_progress/done status -- editable right here
  // (see the header's status <select>) instead of only from the
  // admin-ui workflow board, via updateJobStatus's self-service PATCH.
  // Local state (not read straight from surfaceConfig) so the dropdown
  // reflects a change immediately rather than waiting on a re-fetch.
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  useEffect(() => {
    if (surfaceConfig) setJobStatus(surfaceConfig.status);
  }, [surfaceConfig]);

  // Every case in this job, in the order admin-ui's own Job detail page
  // lists them -- backs the Prev/Next case arrows in the header. Only
  // fetched for a real job visit; a plain/standalone visit has no
  // "queue" to step through.
  const [jobCases, setJobCases] = useState<JobCase[] | null>(null);
  useEffect(() => {
    if (!jobId) return;
    fetchJobCases(jobId)
      .then(setJobCases)
      .catch((err) => setError(errorText(err)));
  }, [jobId]);
  const jobCaseIndex = jobCases && caseId ? jobCases.findIndex((c) => c.id === caseId) : -1;
  // Which cases still need this person: for an Annotation job every
  // case not yet handed in (a rejected one is open again); for a Review
  // job only a case awaiting a decision (a rejected one is decided --
  // it's the annotator's to redo). The header's arrows and the
  // after-submit advance move through THIS queue, never landing on a
  // case that's already done; the current case stays in it even when
  // done (opened deliberately from the job page) so the position and
  // the arrows still make sense from there.
  function caseIsOpen(c: JobCase): boolean {
    return reviewMode ? c.status === "pending" : c.status !== "done";
  }
  const openQueue = jobCases ? jobCases.filter((c) => caseIsOpen(c) || c.id === caseId) : null;
  const openQueueIndex = openQueue && caseId ? openQueue.findIndex((c) => c.id === caseId) : -1;
  const currentCaseDone = jobCaseIndex >= 0 && jobCases ? !caseIsOpen(jobCases[jobCaseIndex]) : false;

  // Navigates to another case in this same job by resolving it down to
  // one of its series and handing off to the existing series->instance
  // redirect route (the same one admin-ui's own "Open in Viewer" link
  // already uses) -- reuses that resolution instead of duplicating it
  // here. Picks the first imaging study's first series; cases in this
  // platform have never had a notion of a "primary" series beyond that.
  const [caseNavPending, setCaseNavPending] = useState(false);
  async function goToCase(targetCaseId: string) {
    if (!studyId || caseNavPending) return;
    if (!confirmLeavingUnsaved()) return;
    setCaseNavPending(true);
    setError(null);
    try {
      const studies = await listImagingStudies(targetCaseId);
      const series = studies.length > 0 ? await listSeries(studies[0].id) : [];
      if (series.length === 0) {
        setError("This case has no imaging series to view.");
        return;
      }
      const jobParam = jobId ? `&jobId=${jobId}` : "";
      const nextReturn = returnUrlForCase(returnUrl, caseId, targetCaseId);
      const returnParam = nextReturn ? `&returnUrl=${encodeURIComponent(nextReturn)}` : "";
      navigate(`/viewer/series/${series[0].id}?studyId=${studyId}&caseId=${targetCaseId}${jobParam}${returnParam}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setCaseNavPending(false);
    }
  }

  // The case's clinical documents (reports, notes, etc.) -- a Documents
  // tab in the header so the annotator can check them without leaving
  // the viewer for admin-ui. Fetched lazily, on first open, rather than
  // eagerly like jobCases above: unlike the case queue (needed just to
  // compute Prev/Next), nothing else on this page depends on knowing
  // the document list before the annotator actually asks for it.
  const [documents, setDocuments] = useState<CaseDocument[] | null>(null);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  function toggleDocuments() {
    const opening = !documentsOpen;
    setDocumentsOpen(opening);
    if (opening && caseId && documents === null) {
      listCaseDocuments(caseId)
        .then(setDocuments)
        .catch((err) => setError(errorText(err)));
    }
  }
  // Opened in an in-page side panel (components/DocumentPanel.tsx), not
  // a new browser tab -- unlike admin-ui's own DocumentModal (a separate
  // app where navigating away costs nothing), leaving this page
  // mid-annotation is exactly what an annotator checking a report while
  // working doesn't want. The panel gets a loader, not a URL: the bytes
  // come through this app's backend with the bearer token, and the
  // panel renders them itself (a PDF page by page), which is what makes
  // the preview work on a tablet too.
  const [openDoc, setOpenDoc] = useState<DocumentSource | null>(null);
  function openDocument(doc: CaseDocument) {
    setOpenDoc({ title: doc.title, load: () => getDocumentFile(doc.id) });
    setDocumentsOpen(false);
  }

  /** Re-reads the job's computed status after anything that can change
   * it (a save, Mark as Annotated, a review decision) so the header
   * badge catches up without a reload. Best-effort: a failure here
   * shouldn't read as the action itself having failed. */
  function refreshJobStatus() {
    if (!jobId) return;
    fetchSurfaceConfig(jobId)
      .then((config) => setJobStatus(config.status))
      .catch((err) => console.warn("Couldn't refresh the job's status:", err));
  }

  // Alt+click voxel inspector: shows the Hounsfield-unit value at the
  // clicked point as a small floating tooltip, auto-hidden after a few
  // seconds. `clientX`/`clientY` are viewport coordinates -- this and
  // every other floating "chrome" popup (the auto-contour panel, the
  // comment popup below) render once at the top level of the page,
  // outside every pane's zoom/pan-transformed wrapper, specifically so
  // a zoomed pane's CSS `scale(...)` never inflates their text/buttons
  // along with the image (a `transform` on an ancestor also becomes the
  // containing block for `position: fixed` descendants, so this only
  // works by being structurally outside that subtree, not just styled
  // differently). Overlays that are SUPPOSED to visually track the
  // zoomed image (the brush cursor ring, the polygon outline, the
  // auto-contour box's dashed border) stay inside the transformed
  // wrapper in local units, unchanged.
  const [huReadout, setHuReadout] = useState<{ clientX: number; clientY: number; text: string } | null>(null);
  const huReadoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A right-click on a painted voxel opens that object's form + comment
  // tab in the Objects list (see ObjectsSidebar) -- the nonce makes a
  // repeat request for the same object re-open / re-scroll it.
  const [formRequest, setFormRequest] = useState<{ objectId: number; nonce: number } | null>(null);
  const [tool, setTool] = useState<DrawTool>("cursor");
  function selectTool(next: DrawTool) {
    if (next !== tool) trackAction(`tool.${next}`);
    setTool(next);
  }
  const tab: "view" | "annotate" = tool === "cursor" ? "view" : "annotate";
  // If a restriction loads in (or changes) after the user already picked
  // a tool it no longer allows, fall back to Cursor rather than leaving
  // a hidden/disallowed tool selected.
  useEffect(() => {
    if (effectiveSurface && tool !== "cursor" && !effectiveSurface.tools.includes(tool)) setTool("cursor");
  }, [effectiveSurface, tool]);
  const [windowCenter, setWindowCenter] = useState(DEFAULT_WINDOW_CENTER);
  const [windowWidth, setWindowWidth] = useState(DEFAULT_WINDOW_WIDTH);
  // Thick slices on every pane (display only; drawing still lands on
  // the centre slice): `thickness` neighbouring slices projected into
  // one picture by `mode`.
  const [slab, setSlab] = useState<{ thickness: number; mode: SlabMode }>({ thickness: 1, mode: "avg" });
  // Where the other two planes cut each pane, as coloured lines that
  // stop short of their meeting point. On by default; C toggles it.
  const [showCrosshair, setShowCrosshair] = useState(() => {
    try {
      return localStorage.getItem("vl.viewer.crosshair") !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("vl.viewer.crosshair", showCrosshair ? "1" : "0");
    } catch {
      // private mode: the choice just isn't remembered
    }
  }, [showCrosshair]);
  // The window each pane's current picture was rendered with. While the
  // window moves (a mouse drag, a slider) the picture on screen is
  // re-mapped at once by a CSS filter (see windowFilterFor) until the
  // server's exact rendering for the new window arrives.
  const [renderedWindow, setRenderedWindow] = useState<Record<PaneKey, { c: number; w: number } | null>>({ sagittal: null, coronal: null, axial: null });
  // A mouse window/level drag in progress: right button with the Cursor
  // tool, middle button with any tool.
  const windowDragRef = useRef<{ pane: PaneKey; pointerId: number; button: number; x0: number; y0: number; c0: number; w0: number; moved: boolean } | null>(null);
  const suppressContextMenuUntilRef = useRef(0);
  // Unsharp-mask amount, applied server-side after windowing (see
  // backend/app/dicom_render.py's _unsharp_mask) -- 0 renders exactly
  // as before (no filter pass at all). Same slider-and-refetch pattern
  // as Center/Width, just a third render parameter.
  const [sharpness, setSharpness] = useState(0);
  const [brushRadius, setBrushRadius] = useState(6);
  const [overlayOpacity, setOverlayOpacity] = useState(DEFAULT_OVERLAY_OPACITY); // percent, applies to every object's overlay

  // 3D starts hidden -- it's the heaviest pane to render and most
  // sessions are 2D-drawing-first, so showing it only on request avoids
  // paying for a WebGL context/build most views won't need immediately.
  const [paneVisible, setPaneVisible] = useState<Record<VisiblePaneKey, boolean>>({
    sagittal: true,
    coronal: true,
    axial: true,
    three_d: false,
  });
  function togglePaneVisible(pane: VisiblePaneKey) {
    setPaneVisible((prev) => ({ ...prev, [pane]: !prev[pane] }));
  }

  // Maximizing a pane reuses the same "only render visible panes" idea
  // one level further: while set, it overrides paneVisible entirely (see
  // visiblePaneKeys below) so exactly one pane renders, full width --
  // toggling it back off returns to whatever paneVisible already had,
  // no separate "remembered state" bookkeeping needed.
  const [maximizedPane, setMaximizedPane] = useState<VisiblePaneKey | null>(null);
  // Tablet: a finger instead of a mouse (touch gestures, bigger targets,
  // touch hints in the footer) and, below ~1100px, the side panel as a
  // drawer over the panes instead of next to them.
  const coarse = useCoarsePointer();
  const compact = useCompactLayout();
  const [panelOpen, setPanelOpen] = useState(false);
  function toggleMaximized(pane: VisiblePaneKey) {
    setMaximizedPane((prev) => (prev === pane ? null : pane));
  }

  // A hard restriction, not just a default: a pane not in
  // surfaceConfig.panes (or 3D when show_3d is false) is excluded from
  // this list outright, so there's no toggle anywhere that could re-show
  // it -- see the toggle-button row below, which maps over this same
  // list rather than ALL_PANE_VISIBILITY_KEYS. Review mode additionally
  // excludes 3D unconditionally, regardless of what a Surface card
  // says -- the review surface is MPR-only by design, not just by
  // whatever restriction happens to be configured.
  const allowedPaneKeys: VisiblePaneKey[] = (
    effectiveSurface
      ? ALL_PANE_VISIBILITY_KEYS.filter((p) => (p === "three_d" ? effectiveSurface.show_3d : effectiveSurface.panes.includes(p)))
      : ALL_PANE_VISIBILITY_KEYS
  ).filter((p) => !reviewMode || p !== "three_d");
  const visiblePaneKeys: VisiblePaneKey[] = maximizedPane
    ? [maximizedPane]
    : allowedPaneKeys.filter((p) => paneVisible[p]);
  // The 3D view is the only thing on screen (its siblings hidden, or it
  // maximized): it then gets the whole row instead of a square -- see
  // the pane's own comment further down.
  const only3d = visiblePaneKeys.length === 1 && visiblePaneKeys[0] === "three_d";
  // Hiding a pane unmounts it, so showing it again hands it a brand-new,
  // blank canvas -- while the draw effects below only re-run when the
  // *data* changes (slice, window/level, sharpness). Without this in
  // their dependencies a pane that comes back stays black until
  // something else happens to redraw it. Same for the mask overlays.
  const paneMountKey = visiblePaneKeys.join("|");

  // Each pane is a fixed square box (see the "stretch to fill" comment
  // on the pane JSX below for why), but *how big* that square is now
  // responds to how much room is actually available -- hiding panes (or
  // maximizing one) should let the rest grow, not leave dead space.
  // Measured via ResizeObserver on the row container rather than
  // computed from window size, since the sidebar/toolbar widths aren't
  // worth hardcoding and would drift if either changes independently.
  const paneRowRef = useRef<HTMLDivElement>(null);
  const [paneSize, setPaneSize] = useState(DEFAULT_PANE_SIZE);
  // handleWheel below is registered inside a mount-only effect, so its
  // closure never sees later renders' paneSize directly -- mirrored into
  // a ref, updated every render, same pattern already used for
  // rows/columns/numSlices for the same reason.
  const paneSizeRef = useRef(paneSize);
  paneSizeRef.current = paneSize;

  useEffect(() => {
    const el = paneRowRef.current;
    if (!el) return;
    // Rough vertical chrome budget per pane: label row + either a slice
    // slider (MPR panes) or the 3D pane's own mode-toggle row -- both
    // similar heights, not worth measuring exactly for this estimate.
    // The touch stylesheet makes the slice slider a 2rem-tall control
    // (see styles.css), so a pane column's chrome is taller under a
    // coarse pointer.
    // Only the label row now: the slice control stands along the pane's
    // right edge (SLICE_STRIP_PX), which comes off the width instead.
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    const CHROME_HEIGHT = coarsePointer ? 44 : 28;
    const STRIP = coarsePointer ? SLICE_STRIP_PX.touch : SLICE_STRIP_PX.mouse;
    const GAP = 1; // the row's gap-px
    function recompute() {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const count = Math.max(1, visiblePaneKeys.length);
      // One row of `count` panes -- unless the row is narrow and tall
      // (a tablet in portrait), where three side-by-side panes would be
      // ~240px strips over a mostly black column: then wrap into two
      // columns (the row is flex-wrap) and let the height budget be
      // shared by the rows instead. Whichever gives the bigger pane.
      // Floor, and account for the gaps: a fractional size that adds up
      // to 2px more than the row is exactly what makes flex-wrap push
      // the last pane onto a second row.
      const fit = (space: number, n: number) => Math.floor((space - GAP * (n - 1)) / n) - STRIP;
      const single = Math.min(fit(rect.width, count), rect.height - CHROME_HEIGHT);
      const cols = 2;
      const rowsWrapped = Math.ceil(count / cols);
      const fitHeight = (space: number, n: number) => Math.floor((space - GAP * (n - 1)) / n);
      const wrapped = count > 1 && rect.width < 900 ? Math.min(fit(rect.width, cols), fitHeight(rect.height, rowsWrapped) - CHROME_HEIGHT) : 0;
      setPaneSize(Math.max(160, Math.max(single, wrapped)));
    }
    recompute();
    const resizeObserver = new ResizeObserver(recompute);
    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePaneKeys.length]);

  const viewerRootRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Fullscreen is the whole document, not this root element -- see
  // lib/fullscreen.ts: the tour, tooltips and popups portal into
  // document.body and were invisible while only the root was shown.
  const autoFullscreenRef = useRef(false);
  useEffect(() => {
    function handleFullscreenChange() {
      const active = fullscreenElement() !== null;
      setIsFullscreen(active);
      // Left fullscreen after this page had entered it by itself: a
      // choice, remembered for the tab.
      if (!active && autoFullscreenRef.current) {
        autoFullscreenRef.current = false;
        rememberFullscreenDeclined();
      }
    }
    return onFullscreenChange(handleFullscreenChange);
  }, []);
  function toggleFullscreen() {
    if (fullscreenElement()) void exitFullscreen();
    else {
      autoFullscreenRef.current = false;
      void enterFullscreen();
    }
  }
  // A touch screen: the viewer goes fullscreen on the first touch (the
  // browser only allows it from a gesture, and page load isn't one) --
  // the browser's own bars are exactly the height a portrait tablet is
  // short of. Not again once declined in this tab.
  useEffect(() => {
    if (!coarse) return;
    function onTouch(e: PointerEvent) {
      if (e.pointerType !== "touch" || fullscreenElement() || fullscreenDeclined()) return;
      autoFullscreenRef.current = true;
      void enterFullscreen().then((ok) => {
        if (!ok) autoFullscreenRef.current = false;
      });
    }
    document.addEventListener("pointerdown", onTouch, true);
    return () => document.removeEventListener("pointerdown", onTouch, true);
  }, [coarse]);
  const [saving, setSaving] = useState(false);
  // Brief confirmation after a successful Save/"Mark as Annotated" --
  // without this, a click that has no *visible* effect (e.g. the case
  // was already marked annotated by someone else) looks indistinguishable
  // from a click that silently failed.
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const savedMessageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [maskReady, setMaskReady] = useState(false);
  // The assistant-led tour of this screen: opens by itself the first
  // time a person lands here from a job (annotate and review each have
  // their own), and any time from the "?" button in the header.
  const guide = useGuide(reviewMode ? "review" : "annotate", maskReady && jobId !== null);
  // Compact layout during the tour: the side panel's stops (objects,
  // window/level, draw, ...) only exist while the panel is open -- see
  // GuideTour's visibleSteps -- so it opens for the tour's duration and
  // goes back to how it was afterwards. startTour opens it in the same
  // render as the tour, so the tour's first inventory already sees it;
  // the effect covers a tour that opens by itself (first visit).
  const panelBeforeTourRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!compact) return;
    if (guide.open) {
      if (panelBeforeTourRef.current === null) panelBeforeTourRef.current = panelOpen;
      setPanelOpen(true);
    } else if (panelBeforeTourRef.current !== null) {
      setPanelOpen(panelBeforeTourRef.current);
      panelBeforeTourRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide.open, compact]);
  function startTour() {
    if (compact) {
      panelBeforeTourRef.current = panelOpen;
      setPanelOpen(true);
    }
    guide.start();
  }

  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [axialIndex, setAxialIndex] = useState(0);
  const [sagittalIndex, setSagittalIndex] = useState<number | null>(null);
  const [coronalIndex, setCoronalIndex] = useState<number | null>(null);
  const currentInstanceId = instances[axialIndex]?.id ?? routeInstanceId ?? null;

  // 80ms cadence: fast enough to read as continuous motion while a slider
  // is being dragged, slow enough that a full-speed drag still only
  // generates ~10-12 backend requests/sec instead of one per pixel.
  const SLIDER_THROTTLE_MS = 80;
  const debouncedWindowCenter = useThrottledValue(windowCenter, SLIDER_THROTTLE_MS);
  const debouncedWindowWidth = useThrottledValue(windowWidth, SLIDER_THROTTLE_MS);
  const debouncedSharpness = useThrottledValue(sharpness, SLIDER_THROTTLE_MS);
  const debouncedInstanceId = useThrottledValue(currentInstanceId, SLIDER_THROTTLE_MS);
  const debouncedSagittalIndex = useThrottledValue(sagittalIndex, SLIDER_THROTTLE_MS);
  const debouncedCoronalIndex = useThrottledValue(coronalIndex, SLIDER_THROTTLE_MS);
  const debouncedSlab = useThrottledValue(slab, SLIDER_THROTTLE_MS);

  const [metadata, setMetadata] = useState<InstanceMetadata | null>(null);
  const [annotations, setAnnotations] = useState<AnnotationSummary[]>([]);
  const [annotationTypes, setAnnotationTypes] = useState<AnnotationType[]>([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

  // ── Labels (reusable named/colored categories) and objects (concrete
  // numbered instances of a label, e.g. "Nodule 1") -- see the plan doc.
  const [labels, setLabels] = useState<SegLabel[]>([]);
  const [objects, setObjects] = useState<SegObject[]>([]);
  const [activeObjectId, setActiveObjectId] = useState<number | null>(null);
  const nextLabelIdRef = useRef(1);
  const nextObjectIdRef = useRef(1);

  // ── Polygon tool: click a sequence of points, close the loop to fill
  // the interior with the active object -- points are in the same
  // native slice-pixel space canvasPoint()/stampCircle already use.
  const [polygonDraft, setPolygonDraft] = useState<{ pane: PaneKey; points: { x: number; y: number }[] } | null>(null);
  const [polygonCursor, setPolygonCursor] = useState<{ x: number; y: number } | null>(null);
  const POLYGON_CLOSE_RADIUS_PX = 10;

  // ── Auto-contour tool: drag a box, fetch that box's raw HU values
  // once, then grow a region from the box's center entirely client-side
  // as the tolerance slider moves (no per-tick network round trip --
  // see the plan doc for why that matters here). autoBox is the
  // committed (post-drag) box; autoHu is the fetched data for it;
  // autoRange (a HU range, suggested from the box -- see
  // lib/autoContour) and autoFillHoles drive the live preview.
  const [autoBox, setAutoBox] = useState<
    { pane: PaneKey; index: number; x0: number; y0: number; x1: number; y1: number; panelClientX: number; panelClientY: number } | null
  >(null);
  const [autoHu, setAutoHu] = useState<{ data: Int16Array; width: number; height: number; x0: number; y0: number } | null>(null);
  const [autoRange, setAutoRange] = useState<{ low: number; high: number }>({ low: -400, high: HU_MAX });
  const [autoFillHoles, setAutoFillHoles] = useState(true);
  const [autoLoading, setAutoLoading] = useState(false);
  const autoDragRef = useRef<{ pane: PaneKey; index: number; x0: number; y0: number; x1: number; y1: number } | null>(null);

  // A range, not "centre ± tolerance": a nodule's calcified core made
  // the old centre seed useless (the grow stayed inside the
  // calcification). Grown from the in-range pixel nearest the box
  // centre; enclosed holes filled when asked.
  const autoPreviewMask = useMemo(() => {
    if (!autoHu) return null;
    return growRegion(autoHu, autoRange, { fillHoles: autoFillHoles });
  }, [autoHu, autoRange, autoFillHoles]);
  // Each new box starts from the range its own content suggests.
  useEffect(() => {
    if (autoHu) setAutoRange(suggestRange(autoHu));
  }, [autoHu]);
  const autoPreviewCount = autoPreviewMask ? autoPreviewMask.reduce((sum, v) => sum + v, 0) : 0;

  // "Histogram" button in the auto-contour panel: HU stats for just the
  // pixels the region-grow actually selected (autoPreviewMask), not the
  // whole dragged box -- reuses computeHuStats, the exact same
  // implementation the standalone Histogram tool's own popup uses.
  const [showAutoSegmentedHistogram, setShowAutoSegmentedHistogram] = useState(false);
  const autoSegmentedStats = useMemo(() => {
    if (!autoHu || !autoPreviewMask) return null;
    const selected = new Int16Array(autoPreviewCount);
    let j = 0;
    for (let i = 0; i < autoPreviewMask.length; i++) {
      if (autoPreviewMask[i]) selected[j++] = autoHu.data[i];
    }
    return computeHuStats(selected);
  }, [autoHu, autoPreviewMask, autoPreviewCount]);

  // renderMaskOverlaySlice's preview-drawing check reads these refs, not
  // the state above, directly -- cancelAutoContour/applyAutoContour call
  // it synchronously right after setAutoBox(null)/setAutoHu(null), and
  // React state updates aren't applied until the next render, so reading
  // the state there would still see the pre-clear (non-null) values and
  // redraw a stale preview one frame too long (same staleness class as
  // paneSizeRef elsewhere in this file, fixed the same way: mirror into
  // a ref every render, and let the two commit paths write the ref
  // synchronously before their explicit repaint call).
  const autoBoxRef = useRef(autoBox);
  autoBoxRef.current = autoBox;
  const autoHuRef = useRef(autoHu);
  autoHuRef.current = autoHu;
  const autoPreviewMaskRef = useRef(autoPreviewMask);
  autoPreviewMaskRef.current = autoPreviewMask;

  // ── Histogram/ROI tool: drag a box (same gesture as Auto-contour,
  // reusing the same fetchPlaneHU endpoint), then show its HU
  // distribution (min/max/mean + a histogram) in a popup -- purely a
  // read-only inspection, no mask volume involved at all, so unlike
  // Auto-contour there's nothing to Apply/Cancel or protect with a lock
  // check; Close just clears the box.
  const [roiBox, setRoiBox] = useState<
    { pane: PaneKey; index: number; x0: number; y0: number; x1: number; y1: number; panelClientX: number; panelClientY: number } | null
  >(null);
  const [roiHu, setRoiHu] = useState<{ data: Int16Array; width: number; height: number; x0: number; y0: number } | null>(null);
  const [roiLoading, setRoiLoading] = useState(false);
  const roiDragRef = useRef<{ pane: PaneKey; index: number; x0: number; y0: number; x1: number; y1: number } | null>(null);

  const roiStats = useMemo(() => (roiHu ? computeHuStats(roiHu.data) : null), [roiHu]);

  function startRoiBox(pane: PaneKey, point: { x: number; y: number }) {
    roiDragRef.current = { pane, index: currentIndex(pane), x0: point.x, y0: point.y, x1: point.x, y1: point.y };
    setRoiBox(null);
    setRoiHu(null);
  }

  function updateRoiBox(pane: PaneKey, point: { x: number; y: number }) {
    const drag = roiDragRef.current;
    if (!drag || drag.pane !== pane) return;
    drag.x1 = point.x;
    drag.y1 = point.y;
    setRoiBox({ ...drag, panelClientX: 0, panelClientY: 0 }); // panel coords aren't known/needed until the drag ends -- see finishRoiBox
  }

  function finishRoiBox(panelClientX: number, panelClientY: number) {
    const drag = roiDragRef.current;
    roiDragRef.current = null;
    if (!drag || !seriesId) return;
    const x0 = Math.round(Math.min(drag.x0, drag.x1));
    const x1 = Math.round(Math.max(drag.x0, drag.x1));
    const y0 = Math.round(Math.min(drag.y0, drag.y1));
    const y1 = Math.round(Math.max(drag.y0, drag.y1));
    if (x1 - x0 < 2 || y1 - y0 < 2) {
      setRoiBox(null);
      setError("That box is too small -- drag out a larger area to see its HU distribution.");
      return;
    }
    setRoiBox({ pane: drag.pane, index: drag.index, x0, y0, x1, y1, panelClientX, panelClientY });
    setRoiLoading(true);
    fetchPlaneHU(seriesId, drag.pane, drag.index, x0, y0, x1, y1)
      .then(setRoiHu)
      .catch((err) => setError(errorText(err)))
      .finally(() => setRoiLoading(false));
  }

  function closeRoiHistogram() {
    setRoiBox(null);
    setRoiHu(null);
  }

  useEffect(() => {
    listAnnotationTypes()
      .then(setAnnotationTypes)
      .catch((err) => setError(errorText(err)));
  }, []);

  const filteredAnnotations = annotations.filter(
    (a) => (statusFilter === "all" || a.status === statusFilter) && (typeFilter === "all" || a.type_id === typeFilter)
  );

  const [zoom, setZoom] = useState<Record<PaneKey, ZoomState>>({
    sagittal: IDLE_ZOOM,
    coronal: IDLE_ZOOM,
    axial: IDLE_ZOOM,
  });
  // Mirrored for the WASD-pan keydown listener below, which runs inside
  // a mount-only effect (not re-subscribed on every zoom change, same
  // reason paneSizeRef/numSlicesRef/etc. exist) but needs the *current*
  // scale to decide whether panning does anything.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // The overlays' own redraw for the same reason as paneMountKey above.
  useEffect(() => {
    if (!maskReady) return;
    renderAllPaneOverlays();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneMountKey, maskReady]);

  const imageCanvasRefs = {
    sagittal: useRef<HTMLCanvasElement>(null),
    coronal: useRef<HTMLCanvasElement>(null),
    axial: useRef<HTMLCanvasElement>(null),
  };
  // One overlay canvas per pane, all rendered from the same shared 3D
  // volume (maskVolumeRef) -- painting/erasing/filling on any pane
  // mutates that one volume, so re-rendering the other panes' overlays
  // from it is what makes an edit on axial appear correctly on
  // sagittal/coronal.
  const overlayRefs = {
    sagittal: useRef<HTMLCanvasElement>(null),
    coronal: useRef<HTMLCanvasElement>(null),
    axial: useRef<HTMLCanvasElement>(null),
  };
  const brushCursorRefs = {
    sagittal: useRef<HTMLDivElement>(null),
    coronal: useRef<HTMLDivElement>(null),
    axial: useRef<HTMLDivElement>(null),
  };
  // The segmentation itself: one byte per voxel, flat-indexed as
  // z*rows*columns + y*columns + x (same axis convention the backend's
  // image volume already uses) -- 0 means background, 1-255 is the id of
  // the object that owns that voxel. Lives only in the browser; the
  // backend only ever stores/retrieves it as an opaque gzip blob (see
  // annotatorApi.ts), alongside the labels/objects that give the ids
  // meaning.
  const maskVolumeRef = useRef<Uint8Array | null>(null);
  // The saved version the mask on screen started from (null = nothing was
  // saved; undefined = not loaded yet). Sent with every save, so a newer
  // save by another tab or person is refused rather than overwritten (J-11).
  const loadedVersionRef = useRef<string | null | undefined>(undefined);
  // Review mode: can the loaded version be reviewed at all (handed in, not
  // yet decided)? Saves made while reviewing refer to its handed-in id.
  const [reviewState, setReviewState] = useState<ReviewState | null>(null);
  // Unsaved work (E-04): any mask edit since the last load/save, or labels/
  // objects that differ from what was loaded/saved. Leaving the case --
  // arrows, Back, reload, closing the tab -- asks first.
  const maskDirtyRef = useRef(false);
  const savedDefsRef = useRef<string | null>(null);
  const drawingRef = useRef(false);
  // Right mouse button always erases for the duration of that one stroke,
  // regardless of which tool is selected -- lets the user fix a slip
  // without breaking flow to click the Eraser button and back.
  const forceEraseRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  // Set by stampCircle whenever a stroke's brush passes over a voxel it
  // can't touch (owned by a locked object) -- surfaced as an error banner
  // on pointer-up, since silently doing nothing there reads as "broken".
  const strokeBlockedByLockRef = useRef(false);
  // Right-click is overloaded, in *any* annotate tool (not just when the
  // View tool is active): a plain click (released without dragging past
  // RIGHT_CLICK_DRAG_THRESHOLD_PX) opens the comment popup for whatever
  // object is under it; dragging past that threshold instead erases,
  // same as it always has. Nothing starts on pointerdown -- resolved
  // lazily in pointermove/pointerup once it's known which one this is.
  const rightClickRef = useRef<{ pane: PaneKey; startClientX: number; startClientY: number; moved: boolean; point: { x: number; y: number } } | null>(
    null
  );
  const RIGHT_CLICK_DRAG_THRESHOLD_PX = 4;
  const dragRef = useRef<{ pane: PaneKey; startX: number; startY: number; panX: number; panY: number } | null>(null);

  // ── Touch (tablet) ──────────────────────────────────────────────────
  // See lib/touch.ts for the gesture vocabulary. One tracker + tap
  // detector per pane; the detectors call back through a ref so they
  // always reach the latest render's handlers without being recreated.
  const gestureHandlerRef = useRef<(gesture: TapGesture, pane: PaneKey, x: number, y: number) => void>(() => {});
  const touchRef = useRef<Record<PaneKey, TouchTracker>>({ sagittal: new TouchTracker(), coronal: new TouchTracker(), axial: new TouchTracker() });
  const tapRef = useRef<Record<PaneKey, TapDetector>>({
    sagittal: new TapDetector((g, x, y) => gestureHandlerRef.current(g, "sagittal", x, y)),
    coronal: new TapDetector((g, x, y) => gestureHandlerRef.current(g, "coronal", x, y)),
    axial: new TapDetector((g, x, y) => gestureHandlerRef.current(g, "axial", x, y)),
  });
  // A touch stroke doesn't stamp at pointerdown the way a mouse stroke
  // does (a long-press for the HU readout would leave a dot under it):
  // it starts on the first real move, and a finger that never moves
  // becomes a tap. A tap's own action (a paint dot, a fill) is then
  // held back TAP_ACTION_DELAY_MS so a second tap can still make the
  // pair a double-tap (zoom reset) instead.
  const pendingTapRef = useRef<{ pane: PaneKey; kind: "dot" | "fill"; point: { x: number; y: number }; clientX: number; clientY: number } | null>(null);
  const pendingTapTimerRef = useRef<number | null>(null);
  const blobUrlsRef = useRef<string[]>([]);
  // Undo/redo history: one {pane, index, slice} snapshot per mutating
  // gesture (a paint/erase drag, a fill click, or an explicit "Clear
  // slice") -- a gesture only ever touches the one slice its pane was
  // showing when it started, regardless of which pane initiated it, so
  // snapshotting just that slice is always sufficient (not the whole
  // volume). Undo pushes the pre-undo state onto redo and vice versa;
  // any *new* mutating gesture clears redo (standard invalidation).
  const undoStackRef = useRef<SliceSnapshot[]>([]);
  const redoStackRef = useRef<SliceSnapshot[]>([]);
  const HISTORY_LIMIT = 20;

  // The series' image size, fixed by the first slice's metadata: a series
  // mixing sizes used to re-allocate the mask on reaching a slice of the
  // other size, silently dropping every unsaved label, object and stroke
  // (E-11). Such a series gets a warning instead (mixedSizes).
  const [seriesDims, setSeriesDims] = useState<{ seriesId: string; rows: number; columns: number } | null>(null);
  const [mixedSizes, setMixedSizes] = useState<string | null>(null);
  const dimsForSeries = seriesDims && seriesDims.seriesId === seriesId ? seriesDims : null;
  useEffect(() => setMixedSizes(null), [seriesId]);
  const rows = dimsForSeries?.rows ?? 0;
  const columns = dimsForSeries?.columns ?? 0;
  const numSlices = instances.length;

  // The wheel listener below is attached once (mount-only effect) so its
  // closure doesn't naturally see later renders' rows/columns/numSlices --
  // mirrored into refs, updated every render, so the slice-clamping logic
  // inside that stable closure always reads the current values.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const numSlicesRef = useRef(numSlices);
  numSlicesRef.current = numSlices;

  useEffect(() => {
    if (!seriesId) return;
    listInstances(seriesId)
      .then((list) => {
        const sorted = [...list].sort((a, b) => (a.instance_number ?? 0) - (b.instance_number ?? 0));
        setInstances(sorted);
        const initialIndex = sorted.findIndex((i) => i.id === routeInstanceId);
        setAxialIndex(initialIndex >= 0 ? initialIndex : 0);
      })
      .catch((err) => setError(errorText(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId]);

  useEffect(() => {
    if (!debouncedInstanceId) return;
    getInstanceMetadata(debouncedInstanceId)
      .then((meta) => {
        setMetadata(meta);
        if (seriesId && meta.rows && meta.columns) {
          setSeriesDims((prev) => {
            if (!prev || prev.seriesId !== seriesId) return { seriesId, rows: meta.rows ?? 0, columns: meta.columns ?? 0 };
            if (prev.rows !== meta.rows || prev.columns !== meta.columns) {
              setMixedSizes(
                `This series mixes image sizes (${prev.columns}×${prev.rows} and ${meta.columns}×${meta.rows}). Painting only works on slices of the first size, and 3D views aren't available.`
              );
            }
            return prev;
          });
        }
        setWindowCenter((prev) => (prev === DEFAULT_WINDOW_CENTER ? meta.window_center ?? prev : prev));
        setWindowWidth((prev) => (prev === DEFAULT_WINDOW_WIDTH ? meta.window_width ?? prev : prev));
        setSagittalIndex((prev) => prev ?? Math.floor((meta.columns ?? 1) / 2));
        setCoronalIndex((prev) => prev ?? Math.floor((meta.rows ?? 1) / 2));
      })
      .catch((err) => setError(errorText(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedInstanceId]);

  function drawBlobUrlToCanvas(canvas: HTMLCanvasElement | null, blobUrl: string, width: number, height: number, pane?: PaneKey, win?: { c: number; w: number }) {
    if (!canvas) return;
    blobUrlsRef.current.push(blobUrl);
    const img = new Image();
    img.onload = () => {
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.drawImage(img, 0, 0, width, height);
      if (pane && win) setRenderedWindow((prev) => (prev[pane]?.c === win.c && prev[pane]?.w === win.w ? prev : { ...prev, [pane]: win }));
    };
    img.src = blobUrl;
  }

  /** The CSS filter that re-maps a pane's picture, rendered for one
   * window, to the window now chosen: grey level p of the old mapping is
   * HU (c0 - w0/2 + p*w0), which the new window shows as a*p + b --
   * an exact linear map (feComponentTransfer, see the <svg> filters in
   * the page). Values the old window had clipped stay clipped until
   * the server's own rendering arrives a moment later. */
  function windowFilterFor(pane: PaneKey): string | undefined {
    const r = renderedWindow[pane];
    if (!r || (r.c === windowCenter && r.w === windowWidth) || windowWidth <= 0) return undefined;
    return `url(#vl-window-${pane})`;
  }
  function windowFilterParams(pane: PaneKey): { slope: number; intercept: number } {
    const r = renderedWindow[pane];
    if (!r || windowWidth <= 0) return { slope: 1, intercept: 0 };
    return { slope: r.w / windowWidth, intercept: (r.c - r.w / 2 - (windowCenter - windowWidth / 2)) / windowWidth };
  }

  useEffect(() => {
    if (!debouncedInstanceId || !rows || !columns) return;
    let cancelled = false;
    const win = { c: debouncedWindowCenter, w: debouncedWindowWidth };
    // A thick slab needs the whole volume (the backend's slab.png); a
    // single slice keeps the quick one-instance render.
    const slabIndex = instances.findIndex((i) => i.id === debouncedInstanceId);
    const thick = debouncedSlab.thickness > 1 && seriesId && slabIndex >= 0 && !volumeUnavailable;
    (thick
      ? fetchSlabBlobUrl(seriesId, "axial", slabIndex, debouncedSlab.thickness, debouncedSlab.mode, win.c, win.w, debouncedSharpness || null)
      : fetchAxialBlobUrl(debouncedInstanceId, win.c, win.w, debouncedSharpness || null)
    )
      .then((url) => !cancelled && drawBlobUrlToCanvas(imageCanvasRefs.axial.current, url, columns, rows, "axial", win))
      .catch((err) => setError(errorText(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedInstanceId, rows, columns, debouncedWindowCenter, debouncedWindowWidth, debouncedSharpness, debouncedSlab, paneMountKey]);

  useEffect(() => {
    if (!seriesId || debouncedSagittalIndex === null || !rows || !numSlices) return;
    let cancelled = false;
    const win = { c: debouncedWindowCenter, w: debouncedWindowWidth };
    (debouncedSlab.thickness > 1
      ? fetchSlabBlobUrl(seriesId, "sagittal", debouncedSagittalIndex, debouncedSlab.thickness, debouncedSlab.mode, win.c, win.w, debouncedSharpness || null)
      : fetchSagittalBlobUrl(seriesId, debouncedSagittalIndex, win.c, win.w, debouncedSharpness || null)
    )
      .then((url) => {
        if (cancelled) return;
        setVolumeUnavailable(null);
        drawBlobUrlToCanvas(imageCanvasRefs.sagittal.current, url, rows, numSlices, "sagittal", win);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 422) setVolumeUnavailable(err.body);
        else setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId, debouncedSagittalIndex, rows, numSlices, debouncedWindowCenter, debouncedWindowWidth, debouncedSharpness, debouncedSlab, paneMountKey]);

  useEffect(() => {
    if (!seriesId || debouncedCoronalIndex === null || !columns || !numSlices) return;
    let cancelled = false;
    const win = { c: debouncedWindowCenter, w: debouncedWindowWidth };
    (debouncedSlab.thickness > 1
      ? fetchSlabBlobUrl(seriesId, "coronal", debouncedCoronalIndex, debouncedSlab.thickness, debouncedSlab.mode, win.c, win.w, debouncedSharpness || null)
      : fetchCoronalBlobUrl(seriesId, debouncedCoronalIndex, win.c, win.w, debouncedSharpness || null)
    )
      .then((url) => {
        if (cancelled) return;
        setVolumeUnavailable(null);
        drawBlobUrlToCanvas(imageCanvasRefs.coronal.current, url, columns, numSlices, "coronal", win);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 422) setVolumeUnavailable(err.body);
        else setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId, debouncedCoronalIndex, columns, numSlices, debouncedWindowCenter, debouncedWindowWidth, debouncedSharpness, debouncedSlab, paneMountKey]);

  useEffect(() => {
    const urls = blobUrlsRef.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  // ── Segmentation volume: allocate once per series, hydrate from the
  // latest saved segmentation (volume + labels + objects) if one exists ──

  useEffect(() => {
    if (!seriesId || !rows || !columns || !numSlices) return;
    let cancelled = false;
    setMaskReady(false);
    setMaskLoadFailed(false);
    undoStackRef.current = [];
    redoStackRef.current = [];

    (async () => {
      const size = numSlices * rows * columns;
      let volume = new Uint8Array(size);
      let loadedLabels: SegLabel[] = [];
      let loadedObjects: SegObject[] = [];
      try {
        const loaded = await fetchSegmentationVolume(seriesId);
        loadedVersionRef.current = loaded.versionId;
        setReviewState(reviewStateOf(loaded.versionId, loaded.versionStatus, loaded.reviewOfId));
        const result = loaded.volume;
        if (result) {
          const unpacked = await gunzipToUint8Array(result.gzipBytes);
          if (unpacked.length === size) {
            volume = unpacked;
            loadedLabels = result.labels;
            loadedObjects = result.objects;
          } else {
            console.warn("Saved segmentation size doesn't match this series' current dimensions -- starting empty.");
          }
        }
      } catch {
        setMaskLoadFailed(true);
      }

      // Seed from the Annotation Surface's pre-defined labels (e.g.
      // "Nodule") -- but only when this series genuinely has no saved
      // labels of its own yet. Fetched independently here (not read off
      // the shared `surfaceConfig` state, which loads on its own
      // schedule keyed on jobId) so this can't race: re-running this
      // whole effect later because `surfaceConfig` state changed would
      // reset maskVolumeRef and wipe out any painting the annotator had
      // already started in the meantime.
      if (loadedLabels.length === 0 && jobId) {
        try {
          const config = await fetchSurfaceConfig(jobId);
          if (config.labels.length > 0) {
            loadedLabels = config.labels.map((l, i) => ({ id: i + 1, name: l.name, color: l.color, ...(l.fields?.length ? { fields: l.fields } : {}) }));
          }
        } catch {
          // No surface connected, or the fetch failed -- fall back to
          // the normal empty-labels start, same as before this existed.
        }
      }

      if (cancelled) return;
      maskVolumeRef.current = volume;
      setLabels(loadedLabels);
      setObjects(loadedObjects);
      maskDirtyRef.current = false;
      savedDefsRef.current = JSON.stringify({ labels: loadedLabels, objects: loadedObjects });
      setActiveObjectId(loadedObjects[0]?.id ?? null);
      nextLabelIdRef.current = Math.max(0, ...loadedLabels.map((l) => l.id)) + 1;
      // Past every id in use -- by an object, or by voxels an older save
      // left without one -- so a new object never inherits someone
      // else's painting (E-05).
      let maxVoxel = 0;
      for (let i = 0; i < volume.length; i++) if (volume[i] > maxVoxel) maxVoxel = volume[i];
      nextObjectIdRef.current = Math.max(maxVoxel, ...loadedObjects.map((o) => o.id)) + 1;
      setMaskReady(true);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId, rows, columns, numSlices]);

  useEffect(() => {
    refreshAnnotations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentInstanceId, seriesId]);

  function refreshAnnotations() {
    if (!currentInstanceId && !seriesId) return;
    Promise.all([
      currentInstanceId ? listAnnotations("instance", currentInstanceId) : Promise.resolve([]),
      seriesId ? listAnnotations("series", seriesId) : Promise.resolve([]),
    ])
      .then(([instanceAnnotations, seriesAnnotations]) => setAnnotations([...seriesAnnotations, ...instanceAnnotations]))
      .catch((err) => setError(errorText(err)));
  }

  // ── Labels & objects: CVAT-style categories + numbered instances ────

  function addLabel(name: string) {
    if (!name.trim()) return;
    trackAction("label.add");
    const id = nextLabelIdRef.current++;
    const color = LABEL_COLOR_PALETTE[labels.length % LABEL_COLOR_PALETTE.length];
    setLabels((prev) => [...prev, { id, name: name.trim(), color }]);
  }

  function recolorLabel(id: number, color: string) {
    setLabels((prev) => prev.map((l) => (l.id === id ? { ...l, color } : l)));
  }

  /** Removes these objects' voxels from the volume AND from every
   * undo/redo snapshot -- otherwise Undo right after a delete brought the
   * painting back with no object owning it (E-05). */
  function purgeObjectIds(ids: Set<number>) {
    const volume = maskVolumeRef.current;
    if (volume) for (let i = 0; i < volume.length; i++) if (ids.has(volume[i])) volume[i] = 0;
    for (const entry of [...undoStackRef.current, ...redoStackRef.current]) {
      for (let i = 0; i < entry.slice.length; i++) if (ids.has(entry.slice[i])) entry.slice[i] = 0;
    }
    maskDirtyRef.current = true;
  }

  function deleteLabel(labelId: number) {
    const doomed = new Set(objects.filter((o) => o.label_id === labelId).map((o) => o.id));
    const name = labels.find((l) => l.id === labelId)?.name ?? "this label";
    if (!window.confirm(`Delete "${name}" and its ${doomed.size} object${doomed.size === 1 ? "" : "s"}? Their painting is removed, and this can't be undone.`)) return;
    purgeObjectIds(doomed);
    setObjects((prev) => prev.filter((o) => !doomed.has(o.id)));
    setLabels((prev) => prev.filter((l) => l.id !== labelId));
    if (activeObjectId !== null && doomed.has(activeObjectId)) setActiveObjectId(null);
  }

  function createObject(labelId: number) {
    if (nextObjectIdRef.current > MAX_OBJECT_ID) {
      setError(`Can't create more than ${MAX_OBJECT_ID} objects in one series.`);
      return;
    }
    trackAction("object.add");
    const id = nextObjectIdRef.current++;
    // Never a number already used in this label: counting the objects gave
    // a second "Dup 2" after "Dup 1" was deleted, and the name is what the
    // review card and comments use (E-12).
    const instanceNumber = Math.max(0, ...objects.filter((o) => o.label_id === labelId).map((o) => o.instance_number)) + 1;
    setObjects((prev) => [...prev, { id, label_id: labelId, instance_number: instanceNumber, locked: false, hidden: false }]);
    setActiveObjectId(id);
  }

  function deleteObject(id: number) {
    const obj = objects.find((o) => o.id === id);
    const name = obj ? `${labels.find((l) => l.id === obj.label_id)?.name ?? "Object"} ${obj.instance_number}` : "this object";
    if (!window.confirm(`Delete ${name}? Its painting is removed, and this can't be undone.`)) return;
    purgeObjectIds(new Set([id]));
    setObjects((prev) => prev.filter((o) => o.id !== id));
    if (activeObjectId === id) setActiveObjectId(null);
  }

  function toggleObjectLock(id: number) {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, locked: !o.locked } : o)));
  }

  function toggleObjectHidden(id: number) {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, hidden: !o.hidden } : o)));
  }

  function setObjectComment(id: number, comment: string) {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, comment } : o)));
  }

  /** The reviewer's own comment on an object -- never the annotator's note (F-02). */
  function setObjectReviewComment(id: number, review_comment: string) {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, review_comment } : o)));
  }

  /** Tapping the chosen reason again clears it. Counted for the Usage
   * page only when the review is submitted, per rejected object -- not
   * per tap, which counted replaced reasons and ones on objects later
   * accepted (F-18). */
  function setObjectRejectReason(id: number, reason: string) {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, reject_reason: o.reject_reason === reason ? undefined : reason } : o)));
  }

  function setObjectReviewStatus(id: number, review_status: "pending" | "accepted" | "rejected") {
    // an accepted object keeps no rejection reason (F-18)
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, review_status, ...(review_status === "rejected" ? {} : { reject_reason: undefined }) } : o)));
  }
  function setObjectAttributes(id: number, attributes: ObjectAnswers) {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, attributes: Object.keys(attributes).length ? attributes : undefined } : o)));
  }
  /** The per-object form of a label: saved with the label itself when it
   * was seeded from the Annotation Surface, else looked up by name in
   * the job's surface config (labels seeded before forms existed, and a
   * Review job, whose surface config carries the upstream Annotation
   * job's labels). */
  function fieldsOfLabel(label: SegLabel | null | undefined): ObjectField[] {
    if (!label) return [];
    if (label.fields && label.fields.length > 0) return label.fields;
    const wanted = label.name.trim().toLowerCase();
    return effectiveSurface?.labels.find((l) => l.name.trim().toLowerCase() === wanted)?.fields ?? [];
  }

  const activeObject = objects.find((o) => o.id === activeObjectId) ?? null;
  const activeLabel = activeObject ? labels.find((l) => l.id === activeObject.label_id) ?? null : null;
  const activeObjectName = activeLabel && activeObject ? `${activeLabel.name} ${activeObject.instance_number}` : null;

  /** Quick "new instance of whatever label I'm currently working in"
   * action -- a shortcut for createObject(activeLabel.id) so the user
   * doesn't have to scroll the Objects panel back up to that label's own
   * "+" button every time they want another nodule of the same kind.
   * A no-op with no active object (nothing to infer the label from). */
  function createObjectInActiveLabel() {
    if (!activeLabel) return;
    createObject(activeLabel.id);
  }

  // Repaints all three panes' overlays when a *label/object property* or
  // the overlay opacity changes -- these are React state, so a reactive
  // effect is simplest. Actual voxel edits (paint/erase/fill/undo/clear)
  // mutate maskVolumeRef directly, bypassing React state, and call
  // renderMaskOverlaySlice/renderAllPaneOverlays imperatively themselves
  // right after (see below) -- this effect would never see those, by
  // design.
  useEffect(() => {
    if (maskReady) renderAllPaneOverlays();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objects, labels, overlayOpacity, maskReady]);

  // ── Volume <-> plane-display coordinate mapping ──────────────────────
  // Every stroke/fill only ever touches the single slice its pane is
  // currently showing (zero thickness along that plane's fixed axis) --
  // matches how a 2D brush tool works in any segmentation app.

  function planeDims(pane: PaneKey): { width: number; height: number } {
    if (pane === "axial") return { width: columns, height: rows };
    if (pane === "sagittal") return { width: rows, height: numSlices };
    return { width: columns, height: numSlices }; // coronal
  }

  function maskIndex(x: number, y: number, z: number): number {
    return z * rows * columns + y * columns + x;
  }

  function currentIndex(pane: PaneKey): number {
    return pane === "axial" ? axialIndex : pane === "sagittal" ? (sagittalIndex ?? 0) : (coronalIndex ?? 0);
  }

  /** Maps a pane's own (index, px, py) -- its current slice plus a point
   * within that 2D slice -- to the shared volume's (x, y, z), i.e. the
   * inverse of planeDims' axis choice for that pane. Single source of
   * truth for that mapping, used by both mask read/write and the
   * Alt+click HU readout below. */
  function paneLocalToVolumeXYZ(pane: PaneKey, index: number, px: number, py: number): { x: number; y: number; z: number } {
    if (pane === "axial") return { x: px, y: py, z: index };
    if (pane === "sagittal") return { x: index, y: px, z: py };
    return { x: px, y: index, z: py }; // coronal
  }

  function readSliceValue(pane: PaneKey, index: number, px: number, py: number): number {
    const volume = maskVolumeRef.current;
    if (!volume) return 0;
    const { x, y, z } = paneLocalToVolumeXYZ(pane, index, px, py);
    return volume[maskIndex(x, y, z)];
  }

  function writeSliceValue(pane: PaneKey, index: number, px: number, py: number, value: number) {
    const volume = maskVolumeRef.current;
    if (!volume) return;
    const { x, y, z } = paneLocalToVolumeXYZ(pane, index, px, py);
    volume[maskIndex(x, y, z)] = value;
  }

  /** A voxel already owned by a *locked* object can't be painted, erased,
   * or filled over -- matches CVAT's "locked = can't edit" semantics.
   * Undo/redo intentionally bypass this (they restore prior truth, not a
   * fresh edit). */
  /** Locked AND hidden objects are left alone by every tool: a hidden
   * object can't be seen, so painting or erasing over it would destroy
   * it unnoticed (E-09). */
  function isVoxelProtected(existingValue: number): boolean {
    if (existingValue === 0) return false;
    const obj = objects.find((o) => o.id === existingValue);
    return Boolean(obj && (obj.locked || obj.hidden));
  }

  /** Renders one pane's overlay canvas from the shared volume's current
   * state at that pane's given slice index -- the single source of truth
   * for "what's drawn", covering both a freshly-loaded saved
   * segmentation and live edits made on any of the three panes. Each
   * voxel is colored by its owning object's label; hidden objects are
   * skipped entirely (display-only -- their voxel data is untouched). */
  function renderMaskOverlaySlice(pane: PaneKey, index: number) {
    const volume = maskVolumeRef.current;
    const canvas = overlayRefs[pane].current;
    if (!volume || !canvas || !rows || !columns || !numSlices) return;
    const objectsById = new Map(objects.map((o) => [o.id, o]));
    const labelsById = new Map(labels.map((l) => [l.id, l]));
    const { width, height } = planeDims(pane);
    const alpha = Math.round((overlayOpacity / 100) * 255);
    const imageData = new ImageData(width, height);
    const data = imageData.data;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const value = readSliceValue(pane, index, px, py);
        if (value === 0) continue;
        const obj = objectsById.get(value);
        if (!obj || obj.hidden) continue;
        const label = labelsById.get(obj.label_id);
        if (!label) continue;
        const { r, g, b } = hexToRgb(label.color);
        const i = (py * width + px) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = alpha;
      }
    }
    // Auto-contour's not-yet-committed preview, drawn on top in a
    // distinct color so it visibly reads as "pending" rather than part
    // of the real object -- only for the pane/slice it was computed on.
    // Reads the *Ref mirrors, not the state directly -- see their own
    // comment for why (this function is also called synchronously right
    // after the state is cleared, before React has applied that update).
    const currentAutoBox = autoBoxRef.current;
    const currentAutoHu = autoHuRef.current;
    const currentAutoPreviewMask = autoPreviewMaskRef.current;
    if (currentAutoBox && currentAutoHu && currentAutoPreviewMask && currentAutoBox.pane === pane && currentAutoBox.index === index) {
      for (let ly = 0; ly < currentAutoHu.height; ly++) {
        for (let lx = 0; lx < currentAutoHu.width; lx++) {
          if (!currentAutoPreviewMask[ly * currentAutoHu.width + lx]) continue;
          const px = currentAutoHu.x0 + lx;
          const py = currentAutoHu.y0 + ly;
          if (px < 0 || px >= width || py < 0 || py >= height) continue;
          const i = (py * width + px) * 4;
          data[i] = 217;
          data[i + 1] = 149;
          data[i + 2] = 33;
          data[i + 3] = 200;
        }
      }
    }

    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.putImageData(imageData, 0, 0);
  }

  function renderAllPaneOverlays() {
    renderMaskOverlaySlice("axial", axialIndex);
    renderMaskOverlaySlice("sagittal", sagittalIndex ?? 0);
    renderMaskOverlaySlice("coronal", coronalIndex ?? 0);
  }

  useEffect(() => {
    if (maskReady) renderMaskOverlaySlice("axial", axialIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maskReady, axialIndex]);
  useEffect(() => {
    if (maskReady && sagittalIndex !== null) renderMaskOverlaySlice("sagittal", sagittalIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maskReady, sagittalIndex]);
  useEffect(() => {
    if (maskReady && coronalIndex !== null) renderMaskOverlaySlice("coronal", coronalIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maskReady, coronalIndex]);

  // Repaints the auto-contour's target pane whenever the live preview
  // mask changes (i.e. the tolerance slider moves) -- Apply/Cancel
  // clear autoBox/autoHu and repaint explicitly themselves, since by
  // then this effect no longer knows which pane to repaint.
  useEffect(() => {
    if (maskReady && autoBox) renderMaskOverlaySlice(autoBox.pane, autoBox.index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maskReady, autoBox, autoPreviewMask]);

  // ── Freehand drawing: paint, erase, fill -- all three tools mutate
  // maskVolumeRef directly, generalized to whichever pane the pointer
  // event came from ────────────────────────────────────────────────────

  function canvasPoint(event: ReactPointerEvent<HTMLCanvasElement>, pane: PaneKey): { x: number; y: number } {
    const canvas = overlayRefs[pane].current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
  }

  function captureSlice(pane: PaneKey, index: number): Uint8Array {
    const { width, height } = planeDims(pane);
    const snap = new Uint8Array(width * height);
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) snap[py * width + px] = readSliceValue(pane, index, px, py);
    }
    return snap;
  }

  function restoreSlice(pane: PaneKey, index: number, slice: Uint8Array) {
    const { width, height } = planeDims(pane);
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) writeSliceValue(pane, index, px, py, slice[py * width + px]);
    }
  }

  function snapshotSliceForUndo(pane: PaneKey) {
    if (!maskVolumeRef.current || !rows || !columns || !numSlices) return;
    const index = currentIndex(pane);
    undoStackRef.current.push({ pane, index, slice: captureSlice(pane, index) });
    if (undoStackRef.current.length > HISTORY_LIMIT) undoStackRef.current.shift();
    redoStackRef.current = []; // a fresh edit invalidates any prior redo history
    maskDirtyRef.current = true; // every mask edit comes through here first
  }

  /** brushRadius is a *display*-space radius (local pre-transform pane
   * units, same paneSize-relative frame on every pane) so the same
   * slider value looks the same size everywhere -- not a native voxel
   * radius. Sagittal/coronal stretch their native aspect non-uniformly
   * to fill the square pane (see the pane JSX's own comment on why), so
   * a brush that's a true circle in native voxel space would display as
   * an ellipse there; stamping an ellipse in native space -- sized per
   * axis via that same stretch ratio -- is what makes it *display* as a
   * true circle on every pane, matching the (also display-space) cursor
   * ring in updateBrushCursor. */
  function stampCircle(pane: PaneKey, index: number, cx: number, cy: number, value: number) {
    const { width, height } = planeDims(pane);
    const rx = brushRadius * (width / paneSize);
    const ry = brushRadius * (height / paneSize);
    // Deliberately simple, MS-Paint-style pixel math: the brush is
    // centered on exactly the one native pixel under the cursor
    // (Math.floor(cx/cy) -- the pixel actually containing the click,
    // same convention as the single-voxel lookups elsewhere), and the
    // radius is rounded to a whole number of pixels once, up front --
    // not measured in continuous sub-pixel space. A 1:1, predictable
    // pixel footprint (radius 0 paints exactly the clicked pixel and
    // nothing else) was explicitly wanted over a geometrically
    // "perfect" but fussier sub-pixel-centered ellipse.
    const cxi = Math.floor(cx);
    const cyi = Math.floor(cy);
    const dxMax = Math.round(rx);
    const dyMax = Math.round(ry);
    for (let dy = -dyMax; dy <= dyMax; dy++) {
      const py = cyi + dy;
      if (py < 0 || py >= height) continue;
      for (let dx = -dxMax; dx <= dxMax; dx++) {
        const px = cxi + dx;
        if (px < 0 || px >= width) continue;
        if (dxMax > 0 && dyMax > 0 && (dx * dx) / (dxMax * dxMax) + (dy * dy) / (dyMax * dyMax) > 1) continue;
        if (isVoxelProtected(readSliceValue(pane, index, px, py))) {
          strokeBlockedByLockRef.current = true;
          continue;
        }
        writeSliceValue(pane, index, px, py, value);
      }
    }
  }

  function strokeSegment(pane: PaneKey, from: { x: number; y: number } | null, to: { x: number; y: number }) {
    const index = currentIndex(pane);
    const erasing = tool === "erase" || forceEraseRef.current;
    const value = erasing ? 0 : activeObjectId;
    if (value === null) return; // painting/filling needs an active object selected
    const start = from ?? to;
    const dist = Math.hypot(to.x - start.x, to.y - start.y);
    const steps = Math.max(1, Math.ceil(dist));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      stampCircle(pane, index, start.x + (to.x - start.x) * t, start.y + (to.y - start.y) * t, value);
    }
    renderMaskOverlaySlice(pane, index);
  }

  /** Scanline (span-based) flood fill starting at the clicked pixel,
   * filling contiguous "empty" (unowned) pixels of the active pane's
   * current 2D slice with the active object's id, until it hits an
   * already-drawn boundary (any object, locked or not -- fill only ever
   * spreads through background, so it can never cross into an existing
   * object) or the image edge -- i.e. click inside a freehand-drawn
   * outline to fill its interior. Operates on a 2D slice copied out of
   * the shared volume, then writes the result back. */
  function floodFillSlice(pane: PaneKey, startX: number, startY: number, fillValue: number) {
    if (!maskVolumeRef.current) return;
    const index = currentIndex(pane);
    const { width, height } = planeDims(pane);

    const isEmpty = (x: number, y: number) => readSliceValue(pane, index, x, y) === 0;
    const filled = scanlineFill(width, height, startX, startY, isEmpty);

    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        if (filled[py * width + px]) writeSliceValue(pane, index, px, py, fillValue);
      }
    }
    renderMaskOverlaySlice(pane, index);
  }

  /** Click a sequence of points around a shape; clicking back near the
   * first point (once at least 3 are placed) closes and fills the
   * interior with the active object -- an outline-then-fill workflow
   * that doesn't need the freehand brush to be pixel-accurate. */
  /** POLYGON_CLOSE_RADIUS_PX on screen, in the pane's voxel units. A fixed
   * 10 voxels was ~72 screen px at 9x zoom, so a small nodule's outline
   * closed itself on the 4th click (E-08). */
  function polygonCloseRadius(pane: PaneKey): number {
    const canvas = overlayRefs[pane].current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect || rect.width === 0) return POLYGON_CLOSE_RADIUS_PX;
    return POLYGON_CLOSE_RADIUS_PX * (canvas.width / rect.width);
  }

  function handlePolygonClick(pane: PaneKey, point: { x: number; y: number }) {
    if (polygonDraft && polygonDraft.pane === pane && polygonDraft.points.length >= 3) {
      const first = polygonDraft.points[0];
      if (Math.hypot(point.x - first.x, point.y - first.y) <= polygonCloseRadius(pane)) {
        commitPolygon(pane, polygonDraft.points);
        setPolygonDraft(null);
        setPolygonCursor(null);
        return;
      }
    }
    if (polygonDraft && polygonDraft.pane !== pane) return; // a polygon in progress on another pane -- ignore
    setPolygonDraft({ pane, points: [...(polygonDraft?.points ?? []), point] });
  }

  function commitPolygon(pane: PaneKey, points: { x: number; y: number }[]) {
    if (activeObjectId === null || points.length < 3) return;
    const index = currentIndex(pane);
    const { width, height } = planeDims(pane);
    snapshotSliceForUndo(pane);
    const mask = polygonMask(points, width, height);
    let blocked = false;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        if (!mask[py * width + px]) continue;
        if (isVoxelProtected(readSliceValue(pane, index, px, py))) {
          blocked = true;
          continue;
        }
        writeSliceValue(pane, index, px, py, activeObjectId);
      }
    }
    renderAllPaneOverlays();
    if (blocked) setError("This area belongs to a locked or hidden object -- unlock or show it first to edit it.");
  }

  /** Drag a box around a structure; on release, fetches that box's raw
   * HU values once (see autoHu/autoPreviewMask above) so the tolerance
   * slider can re-run the region grow instantly, client-side, with no
   * further network round trips. */
  function startAutoBox(pane: PaneKey, point: { x: number; y: number }) {
    autoDragRef.current = { pane, index: currentIndex(pane), x0: point.x, y0: point.y, x1: point.x, y1: point.y };
    setAutoBox(null);
    setAutoHu(null);
    setShowAutoSegmentedHistogram(false);
  }

  function updateAutoBox(pane: PaneKey, point: { x: number; y: number }) {
    const drag = autoDragRef.current;
    if (!drag || drag.pane !== pane) return;
    drag.x1 = point.x;
    drag.y1 = point.y;
    // panelClientX/Y aren't known until the drag ends (finishAutoBox) --
    // harmless placeholder here, since the panel itself only renders
    // once autoHu is populated, which never happens before that.
    setAutoBox({ ...drag, panelClientX: 0, panelClientY: 0 });
  }

  function finishAutoBox(panelClientX: number, panelClientY: number) {
    const drag = autoDragRef.current;
    autoDragRef.current = null;
    if (!drag || !seriesId) return;
    const x0 = Math.round(Math.min(drag.x0, drag.x1));
    const x1 = Math.round(Math.max(drag.x0, drag.x1));
    const y0 = Math.round(Math.min(drag.y0, drag.y1));
    const y1 = Math.round(Math.max(drag.y0, drag.y1));
    if (x1 - x0 < 2 || y1 - y0 < 2) {
      setAutoBox(null);
      setError("That box is too small -- drag out a larger area to auto-contour.");
      return;
    }
    setAutoBox({ pane: drag.pane, index: drag.index, x0, y0, x1, y1, panelClientX, panelClientY });
    setAutoLoading(true);
    fetchPlaneHU(seriesId, drag.pane, drag.index, x0, y0, x1, y1)
      .then(setAutoHu)
      .catch((err) => setError(errorText(err)))
      .finally(() => setAutoLoading(false));
  }

  function applyAutoContour() {
    if (!autoBox || !autoHu || !autoPreviewMask || activeObjectId === null) return;
    const { pane, index } = autoBox;
    snapshotSliceForUndo(pane);
    let blocked = false;
    for (let ly = 0; ly < autoHu.height; ly++) {
      for (let lx = 0; lx < autoHu.width; lx++) {
        if (!autoPreviewMask[ly * autoHu.width + lx]) continue;
        const px = autoHu.x0 + lx;
        const py = autoHu.y0 + ly;
        if (isVoxelProtected(readSliceValue(pane, index, px, py))) {
          blocked = true;
          continue;
        }
        writeSliceValue(pane, index, px, py, activeObjectId);
      }
    }
    autoBoxRef.current = null;
    autoHuRef.current = null;
    autoPreviewMaskRef.current = null;
    setAutoBox(null);
    setAutoHu(null);
    setShowAutoSegmentedHistogram(false);
    renderAllPaneOverlays();
    if (blocked) setError("This area belongs to a locked or hidden object -- unlock or show it first to edit it.");
  }

  // The keyboard handler is bound less often than the preview changes, so
  // Enter reaches applyAutoContour through this always-current reference.
  const applyAutoContourRef = useRef(applyAutoContour);
  applyAutoContourRef.current = applyAutoContour;

  function cancelAutoContour() {
    const pane = autoBox?.pane;
    const index = autoBox?.index;
    autoBoxRef.current = null;
    autoHuRef.current = null;
    autoPreviewMaskRef.current = null;
    setAutoBox(null);
    setAutoHu(null);
    setShowAutoSegmentedHistogram(false);
    if (pane !== undefined && index !== undefined) renderMaskOverlaySlice(pane, index);
  }

  function handlePanePointerDown(event: ReactPointerEvent<HTMLCanvasElement>, pane: PaneKey) {
    if (tab !== "annotate" || !maskReady) return;
    const point = canvasPoint(event, pane);
    if (event.altKey) {
      if (!seriesId) return;
      // Math.floor, not Math.round -- same single-voxel-lookup case as
      // stampCircle's own cxi/cyi (see its comment): the voxel actually
      // under a continuous point is found by flooring it, not rounding
      // to the nearest integer.
      const { x, y, z } = paneLocalToVolumeXYZ(pane, currentIndex(pane), Math.floor(point.x), Math.floor(point.y));
      showHuReadout(event.clientX, event.clientY, "…");
      fetchVoxelHU(seriesId, x, y, z)
        .then((hu) => showHuReadout(event.clientX, event.clientY, `${Math.round(hu)} HU`))
        .catch((err) => setError(errorText(err)));
      return;
    }
    setError(null);
    // the review surface views and decides; it never draws (F-13)
    if (reviewMode && tool !== "cursor") return;

    if (event.button === 2) {
      event.currentTarget.setPointerCapture(event.pointerId);
      rightClickRef.current = { pane, startClientX: event.clientX, startClientY: event.clientY, moved: false, point };
      return;
    }

    if (tool === "polygon") {
      handlePolygonClick(pane, point);
      return;
    }
    if (tool === "auto") {
      event.currentTarget.setPointerCapture(event.pointerId);
      startAutoBox(pane, point);
      return;
    }
    if (tool === "histogram") {
      event.currentTarget.setPointerCapture(event.pointerId);
      startRoiBox(pane, point);
      return;
    }

    const touch = event.pointerType === "touch";
    if (touch && touchRef.current[pane].count >= 2) return; // a second finger is a pinch, never a stroke
    forceEraseRef.current = false; // right-click (the only other source of force-erase) never reaches here -- see above
    if (tool === "fill") {
      if (activeObjectId === null) return;
      if (touch) {
        // Deferred to the release (see pendingTapRef) so a long-press
        // or double-tap doesn't also fill.
        pendingTapRef.current = { pane, kind: "fill", point, clientX: event.clientX, clientY: event.clientY };
        return;
      }
      snapshotSliceForUndo(pane);
      floodFillSlice(pane, point.x, point.y, activeObjectId);
      renderAllPaneOverlays();
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    strokeBlockedByLockRef.current = false;
    if (touch) {
      pendingTapRef.current = { pane, kind: "dot", point, clientX: event.clientX, clientY: event.clientY };
      return;
    }
    snapshotSliceForUndo(pane);
    drawingRef.current = true;
    lastPointRef.current = point;
    strokeSegment(pane, lastPointRef.current, lastPointRef.current);
  }

  /** The tap's deferred action, run on release unless a gesture claimed
   * the finger first -- see pendingTapRef. */
  function runPendingTap(kind: "dot" | "fill", pane: PaneKey, point: { x: number; y: number }) {
    if (!maskReady) return;
    if (kind === "fill") {
      if (activeObjectId === null) return;
      snapshotSliceForUndo(pane);
      floodFillSlice(pane, point.x, point.y, activeObjectId);
      renderAllPaneOverlays();
      return;
    }
    snapshotSliceForUndo(pane);
    strokeBlockedByLockRef.current = false;
    strokeSegment(pane, point, point);
    renderAllPaneOverlays();
    if (strokeBlockedByLockRef.current) setError("This area belongs to a locked or hidden object -- unlock or show it first to edit it.");
    strokeBlockedByLockRef.current = false;
  }

  function cancelPendingTap() {
    pendingTapRef.current = null;
    if (pendingTapTimerRef.current !== null) {
      window.clearTimeout(pendingTapTimerRef.current);
      pendingTapTimerRef.current = null;
    }
  }

  /** A touch finger that had a stroke/fill pending was released: a dot
   * (or the fill) unless a long-press already claimed it, held back
   * briefly for a possible double-tap. */
  function finishPendingTap(pane: PaneKey) {
    const pending = pendingTapRef.current;
    if (!pending || pending.pane !== pane) return;
    pendingTapRef.current = null;
    if (tapRef.current[pane].longPressActive) return;
    pendingTapTimerRef.current = window.setTimeout(() => {
      pendingTapTimerRef.current = null;
      runPendingTap(pending.kind, pending.pane, pending.point);
    }, TAP_ACTION_DELAY_MS);
  }

  function handlePanePointerMove(event: ReactPointerEvent<HTMLCanvasElement>, pane: PaneKey) {
    updateBrushCursor(event, pane);
    const pending = pendingTapRef.current;
    if (pending && pending.kind === "dot" && pending.pane === pane && event.pointerType === "touch") {
      // The finger moved: this is a stroke after all, starting from
      // where it first landed (so there's no gap).
      if (Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) < 6) return;
      pendingTapRef.current = null;
      snapshotSliceForUndo(pane);
      drawingRef.current = true;
      lastPointRef.current = pending.point;
      strokeSegment(pane, pending.point, pending.point);
    }
    if (tool === "polygon" && polygonDraft && polygonDraft.pane === pane) {
      setPolygonCursor(canvasPoint(event, pane));
    }
    if (tool === "auto" && autoDragRef.current) {
      updateAutoBox(pane, canvasPoint(event, pane));
    }
    if (tool === "histogram" && roiDragRef.current) {
      updateRoiBox(pane, canvasPoint(event, pane));
    }

    const right = rightClickRef.current;
    if (right && right.pane === pane) {
      const dragDistance = Math.hypot(event.clientX - right.startClientX, event.clientY - right.startClientY);
      if (!right.moved && dragDistance > RIGHT_CLICK_DRAG_THRESHOLD_PX) {
        // Confirmed a real drag, not a click -- only now does this turn
        // into the familiar force-erase stroke (starting from the
        // original down point, so the stroke doesn't have a gap). Not in a
        // job whose Surface has no Eraser (E-10): the drag just does nothing.
        right.moved = true;
        if (!eraseAllowed) return;
        snapshotSliceForUndo(pane);
        forceEraseRef.current = true;
        drawingRef.current = true;
        strokeBlockedByLockRef.current = false;
        lastPointRef.current = right.point;
        strokeSegment(pane, lastPointRef.current, right.point);
      }
      if (right.moved && eraseAllowed) {
        const point = canvasPoint(event, pane);
        strokeSegment(pane, lastPointRef.current, point);
        lastPointRef.current = point;
      }
      return;
    }

    if (!drawingRef.current) return;
    const point = canvasPoint(event, pane);
    strokeSegment(pane, lastPointRef.current, point);
    lastPointRef.current = point;
  }

  function handlePanePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === "touch" && pendingTapRef.current) finishPendingTap(pendingTapRef.current.pane);
    const right = rightClickRef.current;
    if (right) {
      rightClickRef.current = null;
      if (!right.moved) openCommentAt(right.pane, event.clientX, event.clientY);
    }
    if (autoDragRef.current) finishAutoBox(event.clientX, event.clientY);
    if (roiDragRef.current) finishRoiBox(event.clientX, event.clientY);
    if (drawingRef.current) {
      renderAllPaneOverlays();
      if (strokeBlockedByLockRef.current) setError("This area belongs to a locked or hidden object -- unlock or show it first to edit it.");
    }
    drawingRef.current = false;
    lastPointRef.current = null;
    forceEraseRef.current = false;
    strokeBlockedByLockRef.current = false;
  }

  // Shows a ring at the cursor matching the actual brush footprint.
  // brushRadius is a *display*-space radius (see stampCircle's comment),
  // so the ring is simply a `brushRadius*2`-diameter circle in the
  // wrapper's local, pre-transform units -- always a true circle on
  // every pane, matching what stampCircle now actually paints (an
  // ellipse in native voxel space on sagittal/coronal, sized so it
  // *displays* as this same circle). Only the ring's *position* needs
  // converting, via canvasPoint()'s zoom-correct native coordinates and
  // the same local-units ratio the canvas itself is displayed at --
  // using post-transform screen pixels directly here (e.g. from
  // canvas.getBoundingClientRect(), which already reflects the current
  // zoom) would double-apply the zoom, since this ring lives *inside*
  // the zoomed wrapper div and gets scaled again by its transform; that
  // was the original double-scaling bug this replaced. Mutates the DOM
  // directly via a ref instead of React state, since pointermove fires
  // far too often to push through a re-render.
  function updateBrushCursor(event: ReactPointerEvent<HTMLCanvasElement>, pane: PaneKey) {
    const preview = brushCursorRefs[pane].current;
    const canvas = overlayRefs[pane].current;
    if (!preview || !canvas) return;
    if (tab !== "annotate" || tool === "fill" || tool === "polygon" || tool === "auto" || tool === "histogram") {
      preview.style.display = "none";
      return;
    }
    const native = canvasPoint(event, pane);
    const localScaleX = paneSize / canvas.width;
    const localScaleY = paneSize / canvas.height;
    const diameter = brushRadius * 2;
    preview.style.display = "block";
    preview.style.width = `${diameter}px`;
    preview.style.height = `${diameter}px`;
    preview.style.left = `${native.x * localScaleX - diameter / 2}px`;
    preview.style.top = `${native.y * localScaleY - diameter / 2}px`;
    preview.style.borderColor = forceEraseRef.current || tool === "erase" ? "#f87171" : activeLabel?.color ?? "#60a5fa";
  }

  function hideBrushCursor(pane: PaneKey) {
    if (brushCursorRefs[pane].current) brushCursorRefs[pane].current!.style.display = "none";
  }

  /** In-progress polygon outline: committed points as a solid polyline,
   * a dashed segment out to the live cursor position, and a highlighted
   * first point (click near it to close). Points are in native
   * slice-pixel space (same as canvasPoint()'s output) -- converted to
   * this wrapper's local pre-transform units via planeDims, the same
   * conversion updateBrushCursor/showHuReadout already use, so this
   * overlay stays correctly placed under any zoom/pan. */
  function renderPolygonOverlay(pane: PaneKey) {
    if (!polygonDraft || polygonDraft.pane !== pane) return null;
    // The overlay is zoomed with the image; the points and lines keep
    // one screen size at any zoom (they used to grow with it).
    const k = 1 / zoom[pane].scale;
    const r0 = (coarse ? 5 : 3.5) * k;
    const r = (coarse ? 3 : 2) * k;
    const dims = planeDims(pane);
    const sx = paneSize / dims.width;
    const sy = paneSize / dims.height;
    const pts = polygonDraft.points.map((p) => `${p.x * sx},${p.y * sy}`).join(" ");
    const last = polygonDraft.points[polygonDraft.points.length - 1];
    return (
      <svg width={paneSize} height={paneSize} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}>
        <polyline points={pts} fill="none" stroke="#60a5fa" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
        {polygonCursor && (
          <line
            x1={last.x * sx}
            y1={last.y * sy}
            x2={polygonCursor.x * sx}
            y2={polygonCursor.y * sy}
            stroke="#60a5fa"
            strokeWidth={1}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {polygonDraft.points.map((p, i) => (
          <circle key={i} cx={p.x * sx} cy={p.y * sy} r={i === 0 ? r0 : r} fill={i === 0 ? "#fbbf24" : "#60a5fa"} data-testid="polygon-point" />
        ))}
      </svg>
    );
  }

  /** Where the other two planes cut this pane: one coloured line per
   * plane (PLANE_COLORS), in the zoomed wrapper so they follow the
   * image, but broken around their meeting point -- CROSSHAIR_GAP_PX of
   * screen space either side stays clear, because the middle is what
   * is being looked at. Display coordinates: the pane is a paneSize
   * square; a native index i of n sits at (i + 0.5) / n of it. */
  function renderCrosshair(pane: PaneKey, width: number, height: number, scale: number) {
    if (!showCrosshair || !rows || !columns || !numSlices) return null;
    const at = (i: number | null, n: number, size: number) => (((i ?? 0) + 0.5) / n) * size;
    // [plane drawn as a vertical line, its x] and [plane drawn horizontally, its y]
    const [vPlane, vx, hPlane, hy]: [PaneKey, number, PaneKey, number] =
      pane === "axial"
        ? ["sagittal", at(sagittalIndex, columns, width), "coronal", at(coronalIndex, rows, height)]
        : pane === "sagittal"
          ? ["coronal", at(coronalIndex, rows, width), "axial", at(axialIndex, numSlices, height)]
          : ["sagittal", at(sagittalIndex, columns, width), "axial", at(axialIndex, numSlices, height)];
    const gap = CROSSHAIR_GAP_PX / scale;
    const line = (x1: number, y1: number, x2: number, y2: number, color: string, key: string) =>
      (x2 - x1) ** 2 + (y2 - y1) ** 2 > 0 ? (
        <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={1} strokeOpacity={0.8} vectorEffect="non-scaling-stroke" />
      ) : null;
    return (
      <svg width={width} height={height} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }} data-testid={`crosshair-${pane}`} aria-hidden="true">
        {line(vx, 0, vx, Math.max(0, hy - gap), PLANE_COLORS[vPlane], "v1")}
        {line(vx, Math.min(height, hy + gap), vx, height, PLANE_COLORS[vPlane], "v2")}
        {line(0, hy, Math.max(0, vx - gap), hy, PLANE_COLORS[hPlane], "h1")}
        {line(Math.min(width, vx + gap), hy, width, hy, PLANE_COLORS[hPlane], "h2")}
      </svg>
    );
  }

  /** Just the auto-contour box's dashed outline -- content-space, lives
   * inside the pane's zoom-transformed wrapper (local units, same
   * convention as renderPolygonOverlay) so it visually tracks the
   * zoomed/panned image, same as the box someone actually drew. The
   * slider/Apply/Cancel *panel* is deliberately NOT here -- see
   * renderAutoContourPanel below and the huReadout state's own comment
   * for why chrome (text/buttons) can't live in this same subtree. */
  function renderAutoBoxOverlay(pane: PaneKey) {
    if (!autoBox || autoBox.pane !== pane) return null;
    const dims = planeDims(pane);
    const sx = paneSize / dims.width;
    const sy = paneSize / dims.height;
    const left = Math.min(autoBox.x0, autoBox.x1) * sx;
    const top = Math.min(autoBox.y0, autoBox.y1) * sy;
    const w = Math.abs(autoBox.x1 - autoBox.x0) * sx;
    const h = Math.abs(autoBox.y1 - autoBox.y0) * sy;
    return (
      <div style={{ position: "absolute", left, top, width: w, height: h, border: "1.5px dashed #d99521", pointerEvents: "none" }} />
    );
  }

  /** The histogram/ROI box's dashed outline -- same content-space
   * convention as renderAutoBoxOverlay, a distinct color (cyan) so it
   * doesn't read as the same tool while both exist in the codebase. */
  function renderRoiBoxOutline(pane: PaneKey) {
    if (!roiBox || roiBox.pane !== pane) return null;
    const dims = planeDims(pane);
    const sx = paneSize / dims.width;
    const sy = paneSize / dims.height;
    const left = Math.min(roiBox.x0, roiBox.x1) * sx;
    const top = Math.min(roiBox.y0, roiBox.y1) * sy;
    const w = Math.abs(roiBox.x1 - roiBox.x0) * sx;
    const h = Math.abs(roiBox.y1 - roiBox.y0) * sy;
    return (
      <div style={{ position: "absolute", left, top, width: w, height: h, border: "1.5px dashed #22d3ee", pointerEvents: "none" }} />
    );
  }

  /** Keeps a `position: fixed` popup on-screen regardless of where its
   * trigger point was -- e.g. the Objects-panel comment icon can sit
   * near the bottom of the sidebar, where an unclamped popup would
   * render mostly or entirely below the viewport. Approximates the
   * popup's own footprint via `boxWidth`/`boxHeight` (exact size isn't
   * known until it's laid out, so this only needs to be a reasonable
   * upper bound) and flips to the other side of the trigger point if it
   * would otherwise overflow that edge. */
  function clampPopupPosition(clientX: number, clientY: number, boxWidth: number, boxHeight: number, offset: number) {
    const left =
      clientX + offset + boxWidth > window.innerWidth ? Math.max(4, clientX - offset - boxWidth) : clientX + offset;
    const top =
      clientY + offset + boxHeight > window.innerHeight ? Math.max(4, clientY - offset - boxHeight) : clientY + offset;
    return { left, top };
  }

  /** The auto-contour tolerance-slider/Apply/Cancel panel -- rendered
   * once at the top level (see ViewerPage's return), position: fixed at
   * the viewport coordinates captured when the box-drag finished
   * (autoBox.panelClientX/Y), so it stays a normal, legible size
   * regardless of the pane's current zoom. */
  function renderAutoContourPanel() {
    if (!autoBox) return null;
    const { panelClientX, panelClientY } = autoBox;
    if (autoLoading && !autoHu) {
      const { left, top } = clampPopupPosition(panelClientX, panelClientY, 90, 30, 10);
      return (
        <div
          className="fixed z-30 rounded border border-[#444] bg-[#1a1a2e]/95 px-2 py-1 text-[11px] text-gray-400 shadow-lg"
          style={{ left, top }}
        >
          Loading…
        </div>
      );
    }
    if (!autoHu) return null;
    const { left, top } = clampPopupPosition(panelClientX, panelClientY, 210, 200, 10);
    return (
      <div
        className="fixed z-30 flex w-[210px] flex-col gap-1.5 rounded border border-[#444] bg-[#1a1a2e]/95 p-2 text-[11px] text-gray-200 shadow-lg"
        style={{ left, top }}
      >
        <div className="flex items-center justify-between">
          <span className="text-gray-400" title="The HU values the region may contain. Suggested from the box: everything denser than the lung around it, calcification included.">
            HU range
          </span>
          <span className="font-mono text-amber-300" data-testid="auto-range">
            {autoRange.low} … {autoRange.high >= HU_MAX ? "max" : autoRange.high}
          </span>
        </div>
        <label className="flex items-center gap-1.5">
          <span className="w-7 text-[10px] text-gray-500">from</span>
          <input
            type="range"
            min={HU_MIN}
            max={HU_MAX}
            step={10}
            value={autoRange.low}
            onChange={(e) => setAutoRange((r) => ({ ...r, low: Math.min(Number(e.target.value), r.high) }))}
            className="h-1 min-w-0 flex-1 accent-amber-500"
            aria-label="Lowest HU in the region"
            data-testid="auto-range-low"
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="w-7 text-[10px] text-gray-500">to</span>
          <input
            type="range"
            min={HU_MIN}
            max={HU_MAX}
            step={10}
            value={autoRange.high}
            onChange={(e) => setAutoRange((r) => ({ ...r, high: Math.max(Number(e.target.value), r.low) }))}
            className="h-1 min-w-0 flex-1 accent-amber-500"
            aria-label="Highest HU in the region"
            data-testid="auto-range-high"
          />
        </label>
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-1.5 text-[10px] text-gray-300" title="Also take whatever the region fully encloses -- a calcified core, an air bubble, a vessel seen end-on.">
            <input type="checkbox" checked={autoFillHoles} onChange={(e) => setAutoFillHoles(e.target.checked)} data-testid="auto-fill-holes" />
            fill holes
          </label>
          <button type="button" onClick={() => autoHu && setAutoRange(suggestRange(autoHu))} className="text-[10px] text-amber-300 hover:underline" title="Back to the range suggested from this box">
            suggest
          </button>
        </div>
        <div className="text-[10px] text-gray-500">{autoPreviewCount} px selected</div>
        <button
          onClick={() => setShowAutoSegmentedHistogram((prev) => !prev)}
          disabled={autoPreviewCount === 0}
          className="rounded border border-[#444] px-2 py-1 text-[11px] text-amber-300 hover:bg-[#2a2a3e] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {showAutoSegmentedHistogram ? "Hide histogram" : "Histogram"}
        </button>
        <div className="flex gap-1.5">
          <button onClick={applyAutoContour} className="flex-1 rounded bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-500">
            Apply
          </button>
          <button onClick={cancelAutoContour} className="flex-1 rounded border border-[#444] px-2 py-1 text-[11px] text-gray-300 hover:bg-[#2a2a3e]">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  /** The shared min/max/mean + bar-chart popup -- used by both the
   * standalone Histogram tool (every value in its dragged box) and the
   * Auto-contour panel's "Histogram" button (only the values the
   * region-grow actually selected). Top-level, position: fixed, same
   * reasoning as renderAutoContourPanel/renderHuTooltip. Stays open
   * until explicitly closed -- this is meant to sit alongside the image
   * while the values are read/compared, not a quick glance like the
   * auto-hiding HU tooltip. */
  function renderHuStatsPopup(stats: HuStats, left: number, top: number, title: string, titleColorClass: string, onClose: () => void) {
    // Plot area sits inset from the full SVG canvas, leaving room for the
    // Y-axis (voxel count) labels on the left and the X-axis (HU value)
    // labels underneath.
    const yAxisWidth = 28;
    const xAxisHeight = 14;
    const plotWidth = 216;
    const plotHeight = 56;
    const svgWidth = yAxisWidth + plotWidth;
    const svgHeight = plotHeight + xAxisHeight;
    const barWidth = plotWidth / stats.bins.length;
    const maxBinCount = Math.max(1, ...stats.bins);
    const midHu = (stats.min + stats.max) / 2;
    return (
      <div
        className="fixed z-30 flex w-[260px] flex-col gap-2 rounded border border-[#444] bg-[#1a1a2e]/95 p-2.5 text-[11px] text-gray-200 shadow-lg"
        style={{ left, top }}
      >
        <div className="flex items-center justify-between">
          <span className={`font-medium ${titleColorClass}`}>{title}</span>
          <button onClick={onClose} className="text-gray-500 hover:text-white" title="Close">
            <CloseIcon />
          </button>
        </div>
        <svg width={svgWidth} height={svgHeight} className="flex-shrink-0">
          {/* Y-axis: voxel count per bin, 0 at the bottom and the tallest bin's count at the top */}
          <text x={yAxisWidth - 4} y={8} textAnchor="end" fontSize={8} fill="#6b7280">
            {maxBinCount}
          </text>
          <text x={yAxisWidth - 4} y={plotHeight} textAnchor="end" fontSize={8} fill="#6b7280">
            0
          </text>
          <line x1={yAxisWidth} y1={0} x2={yAxisWidth} y2={plotHeight} stroke="#444" strokeWidth={1} />
          <line x1={yAxisWidth} y1={plotHeight} x2={svgWidth} y2={plotHeight} stroke="#444" strokeWidth={1} />
          {/* Bars */}
          {stats.bins.map((count, i) => {
            const h = (count / maxBinCount) * plotHeight;
            return (
              <rect
                key={i}
                x={yAxisWidth + i * barWidth}
                y={plotHeight - h}
                width={Math.max(1, barWidth - 1)}
                height={h}
                fill="#22d3ee"
              />
            );
          })}
          {/* X-axis: HU value at the left/middle/right edge of the sampled range */}
          <text x={yAxisWidth} y={svgHeight - 2} textAnchor="start" fontSize={8} fill="#6b7280">
            {Math.round(stats.min)}
          </text>
          <text x={yAxisWidth + plotWidth / 2} y={svgHeight - 2} textAnchor="middle" fontSize={8} fill="#6b7280">
            {Math.round(midHu)}
          </text>
          <text x={svgWidth} y={svgHeight - 2} textAnchor="end" fontSize={8} fill="#6b7280">
            {Math.round(stats.max)}
          </text>
        </svg>
        <div className="grid grid-cols-3 gap-1.5 text-center">
          <div>
            <div className="text-[9px] uppercase tracking-wide text-gray-500">Min</div>
            <div className="font-mono text-gray-200">{Math.round(stats.min)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wide text-gray-500">Mean</div>
            <div className="font-mono text-gray-200">{Math.round(stats.mean)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wide text-gray-500">Max</div>
            <div className="font-mono text-gray-200">{Math.round(stats.max)}</div>
          </div>
        </div>
        <div className="text-center text-[10px] text-gray-500">{stats.count} voxels</div>
      </div>
    );
  }

  /** The Histogram tool's own popup: every HU value inside the dragged box. */
  function renderHistogramPanel() {
    if (!roiBox) return null;
    const { panelClientX, panelClientY } = roiBox;
    if (roiLoading && !roiStats) {
      const { left, top } = clampPopupPosition(panelClientX, panelClientY, 90, 30, 10);
      return (
        <div className="fixed z-30 rounded border border-[#444] bg-[#1a1a2e]/95 px-2 py-1 text-[11px] text-gray-400 shadow-lg" style={{ left, top }}>
          Loading…
        </div>
      );
    }
    if (!roiStats) return null;
    const { left, top } = clampPopupPosition(panelClientX, panelClientY, 260, 210, 10);
    return renderHuStatsPopup(roiStats, left, top, "HU distribution", "text-cyan-300", closeRoiHistogram);
  }

  /** The Auto-contour panel's "Histogram" button: HU values for just the
   * pixels the region-grow selected, not the whole dragged box -- see
   * autoSegmentedStats. Positioned below the Auto-contour panel itself
   * (autoBox's own panelClientX/Y, offset down) rather than reusing
   * roiBox, so it doesn't also draw a second (redundant) box outline on
   * the pane the way opening the standalone Histogram tool would. */
  function renderAutoSegmentedHistogramPopup() {
    if (!showAutoSegmentedHistogram || !autoBox || !autoSegmentedStats) return null;
    const { left, top } = clampPopupPosition(autoBox.panelClientX, autoBox.panelClientY + 160, 260, 210, 10);
    return renderHuStatsPopup(autoSegmentedStats, left, top, "HU distribution (segmented)", "text-amber-300", () =>
      setShowAutoSegmentedHistogram(false)
    );
  }

  /** The Alt+click HU tooltip -- top-level, position: fixed, see the
   * huReadout state's own comment for why. */
  function renderHuTooltip() {
    if (!huReadout) return null;
    const left = Math.min(huReadout.clientX + 10, window.innerWidth - 90);
    return (
      <div
        className="pointer-events-none fixed z-30 rounded border border-amber-400/60 bg-black/85 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
        style={{ left, top: huReadout.clientY - 10, transform: "translateY(-100%)" }}
      >
        {huReadout.text}
      </div>
    );
  }

  /** Wipes the active object's paint on the hovered slice -- only that
   * object's, as the button's tooltip says; it used to wipe every
   * unlocked object on the slice (E-07). */
  function clearCurrentSlice(pane: PaneKey) {
    if (activeObjectId === null || isVoxelProtected(activeObjectId)) return;
    snapshotSliceForUndo(pane);
    const index = currentIndex(pane);
    const { width, height } = planeDims(pane);
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        if (readSliceValue(pane, index, px, py) === activeObjectId) writeSliceValue(pane, index, px, py, 0);
      }
    }
    renderAllPaneOverlays();
  }

  function undoLastMaskChange() {
    const entry = undoStackRef.current.pop();
    if (!entry || !maskVolumeRef.current) return;
    trackAction("undo");
    maskDirtyRef.current = true;
    redoStackRef.current.push({ ...entry, slice: captureSlice(entry.pane, entry.index) });
    if (redoStackRef.current.length > HISTORY_LIMIT) redoStackRef.current.shift();
    restoreSlice(entry.pane, entry.index, entry.slice);
    renderAllPaneOverlays();
  }

  const undoRef = useRef(undoLastMaskChange);
  undoRef.current = undoLastMaskChange;
  const redoRef = useRef(redoLastMaskChange);
  redoRef.current = redoLastMaskChange;

  function redoLastMaskChange() {
    const entry = redoStackRef.current.pop();
    if (!entry || !maskVolumeRef.current) return;
    trackAction("redo");
    maskDirtyRef.current = true;
    undoStackRef.current.push({ ...entry, slice: captureSlice(entry.pane, entry.index) });
    if (undoStackRef.current.length > HISTORY_LIMIT) undoStackRef.current.shift();
    restoreSlice(entry.pane, entry.index, entry.slice);
    renderAllPaneOverlays();
  }

  /** Pushes the case into the job's materialized "(annotated)" Dataset
   * right away, if it has one -- otherwise that list only refreshes
   * whenever someone next clicks Run on the board -- then re-reads the
   * job's status badge. The status itself is no longer nudged from
   * here: admin-service computes it from every case's real annotation
   * state on every read (compute_job_status), which is what makes it
   * correct even when the change happened elsewhere (a reviewer
   * rejecting a case while nobody has this job open). Best-effort:
   * called after a save/review that already succeeded, so a failure
   * here shouldn't read as that having failed. Shared by handleSave's
   * "Mark as Annotated" path and handleSubmitReview. */
  function advanceJobStatusAfterRun() {
    if (!jobId) return;
    runJob(jobId)
      .catch((err) => console.warn("Couldn't refresh the job's materialized dataset:", err))
      .finally(refreshJobStatus);
  }

  /** After "Mark as Annotated" / "Submit review": move on to the next
   * case in this job that still needs work, so a whole queue can be
   * worked through without going back to My Jobs between cases. Runs
   * a moment after the confirmation toast so it's still readable; does
   * nothing when there's no job, or nothing left -- then the toast says
   * so instead. */
  function advanceToNextOpenCase() {
    if (!jobId || !jobCases || jobCaseIndex < 0) return;
    // the counter and the arrows show the case as handed in / decided now,
    // not the list as it was when the viewer opened (D-09)
    fetchJobCases(jobId)
      .then(setJobCases)
      .catch(() => undefined);
    // Forward from here first, then wrap around to the start -- the queue
    // has no inherent order, so "next open case" shouldn't depend on
    // where in the list this one happened to sit.
    const candidates = [...jobCases.slice(jobCaseIndex + 1), ...jobCases.slice(0, jobCaseIndex)];
    const next = candidates.find(caseIsOpen);
    if (!next) {
      window.setTimeout(() => showSavedMessage("✓ Every case in this job is done"), 1500);
      return;
    }
    window.setTimeout(() => goToCase(next.id), 1400);
  }

  // The labels/objects as they are NOW, not as a callback captured them:
  // the move to the next case after a hand-in runs from a timer set before
  // the hand-in's objects were in state, and compared the old objects with
  // the saved ones -- "unsaved changes" right after handing in (K7).
  const labelsNowRef = useRef(labels);
  labelsNowRef.current = labels;
  const objectsNowRef = useRef(objects);
  objectsNowRef.current = objects;
  const maskReadyNowRef = useRef(maskReady);
  maskReadyNowRef.current = maskReady;
  function hasUnsavedWork(): boolean {
    if (!maskReadyNowRef.current || savedDefsRef.current === null) return false;
    return maskDirtyRef.current || JSON.stringify({ labels: labelsNowRef.current, objects: objectsNowRef.current }) !== savedDefsRef.current;
  }
  function markSaved(savedLabels: SegLabel[], savedObjects: SegObject[]) {
    maskDirtyRef.current = false;
    savedDefsRef.current = JSON.stringify({ labels: savedLabels, objects: savedObjects });
  }
  /** True when it's fine to leave: nothing unsaved, or the user said so. */
  function confirmLeavingUnsaved(): boolean {
    if (!hasUnsavedWork()) return true;
    return window.confirm("You have unsaved changes on this case. Leave without saving them?");
  }
  const hasUnsavedWorkRef = useRef(hasUnsavedWork);
  hasUnsavedWorkRef.current = hasUnsavedWork;
  useEffect(() => {
    // Reload / close tab / typing another address: the browser's own prompt.
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!hasUnsavedWorkRef.current()) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  function showSavedMessage(text: string) {
    if (savedMessageTimeoutRef.current) clearTimeout(savedMessageTimeoutRef.current);
    setSavedMessage(text);
    savedMessageTimeoutRef.current = setTimeout(() => setSavedMessage(null), 3000);
  }

  /** The handed-in version a save made in review mode reviews, so it
   * stays handed in (F-01); undefined for an annotator's save. */
  function reviewSaveOf(): string | undefined {
    return reviewMode && reviewState?.kind === "reviewable" ? reviewState.handedInId : undefined;
  }

  async function handleSave(status: "draft" | "submitted" = "draft") {
    const volume = maskVolumeRef.current;
    if (!volume || !seriesId || !studyId) return;
    setSaving(true);
    setError(null);
    try {
      const gzipBytes = await gzipUint8Array(volume);
      // A (re)submission is a fresh request for review: the verdicts of the
      // round just finished move to each object's previous_review, and the
      // new round starts from "pending" with no reviewer comments (F-05,
      // F-06; see lib/reviewRound.ts).
      const objectsToSave = status === "submitted" ? handInObjects(objects) : objects;
      if (status === "submitted") setObjects(objectsToSave);
      const saved = await saveSegmentationVolume(seriesId, studyId, gzipBytes, labels, objectsToSave, status, loadedVersionRef.current, reviewSaveOf());
      loadedVersionRef.current = saved.id;
      markSaved(labels, objectsToSave);
      trackAction(status === "submitted" ? "mark_annotated" : "save");
      refreshAnnotations();

      if (status === "submitted" && jobId) {
        advanceJobStatusAfterRun();
      } else if (jobId) {
        // A regular (draft) save can move a fresh "To do" job to "In
        // progress" -- the status is computed server-side, so just
        // re-read it.
        refreshJobStatus();
      }

      showSavedMessage(status === "submitted" ? "✓ Marked as annotated" : "✓ Saved");
      if (status === "submitted") {
        if (caseId) askRatingIfDue({ case_id: caseId, job_id: jobId, task: "annotate" });
        advanceToNextOpenCase();
      }
    } catch (err) {
      setError(saveErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** Review mode's equivalent of "Mark as Annotated": saves the
   * reviewer's object-by-object Accept/Reject + comments as a new
   * annotation version, then submits the *real* approve/reject
   * decision (Annotation.status) on that exact version -- reject wins
   * if any object was rejected, so a review that flags even one issue
   * sends the whole case back rather than silently approving. That's
   * the missing link that makes annotation_progress (and so the
   * job-status auto-advance above) actually see review work done
   * through this per-object flow, not just the pre-existing
   * admin-ui-only "approve/reject the whole annotation" action.
   * Refuses to run while any object is still undecided ("pending") --
   * submitting a review with open questions isn't a real decision. */
  /** `emptyDecision`: for a case handed in with no objects at all -- the
   * reviewer confirms "no findings" or sends it back as a missed finding.
   * Such a case could never be decided (F-12). */
  async function handleSubmitReview(emptyDecision?: "approve" | "reject") {
    const volume = maskVolumeRef.current;
    if (!volume || !seriesId || !studyId) return;
    const pending = reviewOrderedObjects.filter((o) => (o.review_status ?? "pending") === "pending");
    if (pending.length > 0) {
      setError(`${pending.length} object${pending.length === 1 ? "" : "s"} still need${pending.length === 1 ? "s" : ""} a decision before submitting the review.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const gzipBytes = await gzipUint8Array(volume);
      const saved = await saveSegmentationVolume(seriesId, studyId, gzipBytes, labels, objects, "draft", loadedVersionRef.current, reviewSaveOf());
      loadedVersionRef.current = saved.id;
      markSaved(labels, objects);
      const decision = emptyDecision ?? (reviewOrderedObjects.some((o) => o.review_status === "rejected") ? "reject" : "approve");
      // The per-object comments travel with the decision too (as the
      // AnnotationReview row's comment), so the annotator -- and the
      // Study page's review list -- can see *why* without opening the
      // viewer: "Nodule 1: boundary too generous; Nodule 3: not a nodule".
      // The object's form answers (see components/ObjectForm.tsx) go in
      // the same line: "Nodule 1 [Type: solid · Calcified]: boundary too generous".
      const comment = emptyDecision === "reject" ? "No objects: missed finding" : reviewCommentText(reviewOrderedObjects, labels);
      await submitAnnotationReview(saved.id, decision, comment || undefined);
      trackAction("submit_review");
      for (const o of reviewOrderedObjects) {
        if (o.review_status === "rejected" && o.reject_reason) trackAction("review.reject_reason", { reason: o.reject_reason, case_id: caseId ?? undefined, job_id: jobId ?? undefined });
      }
      refreshAnnotations();
      advanceJobStatusAfterRun();
      showSavedMessage(decision === "approve" ? "✓ Review approved" : "✕ Review rejected");
      if (caseId) askRatingIfDue({ case_id: caseId, job_id: jobId, task: "review" });
      advanceToNextOpenCase();
    } catch (err) {
      setError(saveErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // ── Per-pane wheel-zoom / drag-pan (cursor tool only) ────────────────────
  //
  // Wheel-zoom needs preventDefault() (to stop the page/container from
  // scrolling while zooming), but React attaches onWheel as a passive
  // listener, where preventDefault() is a no-op and logs a console
  // warning. Attaching the listener natively with { passive: false }
  // avoids that.

  const paneContainerRefs = {
    sagittal: useRef<HTMLDivElement>(null),
    coronal: useRef<HTMLDivElement>(null),
    axial: useRef<HTMLDivElement>(null),
  };

  useEffect(() => {
    const cleanups = PANE_ORDER.map((pane) => {
      const el = paneContainerRefs[pane].current;
      if (!el) return () => {};
      const listener = (event: WheelEvent) => handleWheel(event, pane, el);
      el.addEventListener("wheel", listener, { passive: false });
      return () => el.removeEventListener("wheel", listener);
    });
    return () => cleanups.forEach((cleanup) => cleanup());
    // Re-bound whenever panes mount or unmount (maximize/restore, hide/
    // show): bound once, a re-shown pane got no listener and ignored the
    // wheel until a reload (E-03).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePaneKeys.join(",")]);

  function handleWheel(event: WheelEvent, pane: PaneKey, container: HTMLElement) {
    event.preventDefault();

    // The plain wheel pages through slices, the way radiologists expect
    // of a DICOM viewer; Ctrl/Cmd+wheel zooms (radiologist feedback,
    // reversing the earlier zoom-first split). A trackpad pinch arrives
    // as a wheel event with ctrlKey set, so it zooms too.
    if (!(event.ctrlKey || event.metaKey)) {
      const dir = event.deltaY > 0 ? 1 : -1;
      if (pane === "axial") setAxialIndex((i) => Math.max(0, Math.min(numSlicesRef.current - 1, i + dir)));
      else if (pane === "sagittal") setSagittalIndex((i) => Math.max(0, Math.min(columnsRef.current - 1, (i ?? 0) + dir)));
      else setCoronalIndex((i) => Math.max(0, Math.min(rowsRef.current - 1, (i ?? 0) + dir)));
      return;
    }

    const rect = container.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    applyZoomStep(pane, event.deltaY > 0 ? -0.15 : 0.15, mx, my, rect.width, rect.height);
  }

  /** Shared by handleWheel and the Up/Down arrow-key zoom shortcut --
   * both anchor at the cursor position (a keydown event has no cursor
   * position of its own, so that caller reads it from lastPointerRef
   * instead, falling back to the pane's own center only if the mouse
   * has never moved over it yet) -- one zoom step of `delta` (matching
   * handleWheel's own per-notch magnitude), everything else identical. */
  function applyZoomStep(pane: PaneKey, delta: number, mx: number, my: number, rectWidth: number, rectHeight: number) {
    setZoom((prev) => {
      const z = prev[pane];
      const oldScale = z.scale;
      const newScale = Math.max(1, Math.min(15, oldScale + delta * oldScale));
      let panX = z.panX;
      let panY = z.panY;
      if (newScale === 1) {
        panX = 0;
        panY = 0;
      } else {
        // Keep the native-image point currently under the anchor (the
        // cursor for a wheel event, the pane's own center for a keyboard
        // step) fixed on screen as the scale changes: read that point in
        // this pane's own display-local space at the *old* scale/pan,
        // then solve for the pan that puts it back under the anchor at
        // the *new* scale. Uses the *measured* container center
        // (rectWidth/2, rectHeight/2), not paneSize/2 -- see
        // screenToDisplayLocal's comment for why that distinction is
        // what actually anchors this correctly. Reads paneSizeRef (not
        // the paneSize state directly) -- handleWheel's own listener
        // runs inside a mount-only effect, see that ref's own comment
        // for why.
        const size = paneSizeRef.current;
        const containerCenterX = rectWidth / 2;
        const containerCenterY = rectHeight / 2;
        const lx = screenToDisplayLocal(mx, containerCenterX, oldScale, z.panX, size);
        const ly = screenToDisplayLocal(my, containerCenterY, oldScale, z.panY, size);
        panX = mx - containerCenterX - newScale * (lx - size / 2);
        panY = my - containerCenterY - newScale * (ly - size / 2);
      }
      return { ...prev, [pane]: { scale: newScale, panX, panY } };
    });
  }

  function handlePaneMouseDown(event: ReactPointerEvent<HTMLDivElement>, pane: PaneKey) {
    if (tab !== "view") return;
    if (event.altKey) {
      handleAltClickInspectHU(event, pane);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      handleCtrlClickNavigate(event, pane);
      return;
    }
    if (zoom[pane].scale <= 1) return;
    // A second finger means a pinch/pan (handled by the capture-phase
    // touch handlers), not a one-finger drag.
    if (event.pointerType === "touch" && touchRef.current[pane].count >= 2) return;
    if (event.pointerType === "touch") event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pane, startX: event.clientX, startY: event.clientY, panX: zoom[pane].panX, panY: zoom[pane].panY };
  }

  // Screen-space -> this-pane's-own-display-space conversion for a wrapper
  // transformed with `translate(panX,panY) scale(scale)` and
  // `transform-origin: center center` (see the JSX below): the wrapper is
  // always a fixed paneSize x paneSize box, but its *container* -- the
  // thing `rect`/`containerCenter` describe, and what `screenPos` is
  // measured relative to -- is flex-centered ("items-center
  // justify-center") and can be a different size, since it's a flex-1
  // child stretching to fill whatever vertical space is left in the
  // column (label + slider row above/below it). The wrapper's own
  // transform-origin point (its geometric center, at local coordinate
  // paneSize/2) always lands on screen at the *container's* center --
  // that's what flex-centering means -- not at a hardcoded paneSize/2,
  // which only happens to be right if the container's rendered size is
  // exactly paneSize (not guaranteed, and in practice usually isn't for
  // the height, since the container fills whatever's left after the
  // fixed-height label/slider rows on a variable-height viewport --
  // this was the earlier zoom-drifts-off-cursor bug). Both handleWheel
  // and Ctrl-click navigation must pass the *measured* `rect.width/2` /
  // `rect.height/2` as `containerCenter`, not paneSize/2, for the anchor
  // point to land under the actual cursor -- and each passes its own
  // *current* paneSize explicitly (see the callers) rather than this
  // function closing over the state directly, since one of the two
  // callers runs inside a stale mount-only closure.
  function screenToDisplayLocal(screenPos: number, containerCenter: number, scale: number, pan: number, size: number): number {
    return size / 2 + (screenPos - containerCenter - pan) / scale;
  }

  /** Shared by Ctrl+click navigation and the Alt+click HU inspector below:
   * resolves a mousedown on a pane's wrapper div to the shared volume's
   * (x, y, zSlice) coordinate the click landed on, in the *display*
   * coordinate frame (so it already accounts for that pane's current
   * zoom/pan) -- see screenToDisplayLocal's own comment for why
   * `paneSize` must be passed explicitly rather than closed over. */
  function resolvePaneClickVolumeXYZ(
    event: { clientX: number; clientY: number },
    pane: PaneKey
  ): { x: number; y: number; z: number; dispX: number; dispY: number } | null {
    const container = paneContainerRefs[pane].current;
    if (!container || !columns || !rows || !numSlices) return null;
    const rect = container.getBoundingClientRect();
    const z = zoom[pane];
    const dispX = screenToDisplayLocal(event.clientX - rect.left, rect.width / 2, z.scale, z.panX, paneSize);
    const dispY = screenToDisplayLocal(event.clientY - rect.top, rect.height / 2, z.scale, z.panY, paneSize);

    const [nativeW, nativeH] =
      pane === "axial" ? [columns, rows] : pane === "sagittal" ? [rows, numSlices] : [columns, numSlices];
    // Math.floor, not Math.round -- same single-voxel-lookup case as
    // stampCircle's own cxi/cyi.
    const nativeX = Math.floor((dispX / paneSize) * nativeW);
    const nativeY = Math.floor((dispY / paneSize) * nativeH);

    let x: number;
    let y: number;
    let zSlice: number;
    if (pane === "axial") {
      x = nativeX;
      y = nativeY;
      zSlice = axialIndex;
    } else if (pane === "sagittal") {
      x = sagittalIndex ?? 0;
      y = nativeX; // sagittal's display width axis is Y (rows)
      zSlice = nativeY; // display height axis is Z (slices)
    } else {
      x = nativeX; // coronal's display width axis is X (columns)
      y = coronalIndex ?? 0;
      zSlice = nativeY; // display height axis is Z (slices)
    }
    return {
      x: Math.max(0, Math.min(columns - 1, x)),
      y: Math.max(0, Math.min(rows - 1, y)),
      z: Math.max(0, Math.min(numSlices - 1, zSlice)),
      dispX,
      dispY,
    };
  }

  /** Ctrl (or Cmd) + click on any pane: reads where the click landed in
   * that pane's own volume coordinates, then jumps *all three* panes'
   * slice indices to that shared (X, Y, Z) point -- i.e. "move every view
   * to this anatomical location" -- rather than the plain click-drag pan
   * or scroll-wheel zoom, which only ever affect the one pane under the
   * pointer. Whichever axis the clicked pane doesn't display (its own
   * current slice index) is left unchanged; the other two panes' slice
   * indices are updated to match the click. Doesn't touch zoom/pan --
   * each pane keeps whatever scale it already had. */
  function handleCtrlClickNavigate(event: { clientX: number; clientY: number }, pane: PaneKey) {
    const coords = resolvePaneClickVolumeXYZ(event, pane);
    if (!coords) return;
    setAxialIndex(coords.z);
    setSagittalIndex(coords.x);
    setCoronalIndex(coords.y);
  }

  /** Double-click an object in the Objects panel to jump all three panes
   * to it -- same "move every view to this point" mechanic as Ctrl+click
   * on the image (handleCtrlClickNavigate), just resolving the target
   * from the object's own voxels instead of a click.
   *
   * Each pane picks the slice *actually containing the most of the
   * object* along that pane's axis (its densest cross-section), not the
   * object's raw average position -- a plain 3D centroid can easily
   * land on a slice/row/column the object has zero voxels on at all
   * (an elongated, curved, or multi-part shape's average point isn't
   * necessarily a point *on* the object), which is exactly what made
   * jumps land on the wrong slice. One full-volume scan accumulates a
   * per-slice voxel count *and* an in-plane sum for all three axes at
   * once, so after the scan each pane's chosen slice already has its
   * own correct 2D center ready, no second pass needed. */
  function jumpToObject(objectId: number, opts?: { silent?: boolean }) {
    const volume = maskVolumeRef.current;
    if (!volume || !rows || !columns || !numSlices) return;

    const zCount = new Int32Array(numSlices);
    const xCount = new Int32Array(columns);
    const yCount = new Int32Array(rows);
    // Per-slice bounding box of the object's voxels, tracked alongside
    // the counts above in the same single pass over the volume --
    // jumpToObject used to only pan (see the git history for the
    // earlier centroid-only version), which does nothing useful for a
    // small object sitting far away in a zoomed-out pane: it slides
    // into the center but stays tiny, reading as "the view just
    // shifted" rather than "jumped to the object". These bounds are
    // what let it zoom in to actually frame the object too, not just
    // centroid-of-mass (a bounding box is what "does it fit in the
    // pane" needs -- the center of an irregular/concave shape's mass
    // can sit off from where its extent actually is).
    const zMinX = new Float64Array(numSlices).fill(Infinity);
    const zMaxX = new Float64Array(numSlices).fill(-Infinity);
    const zMinY = new Float64Array(numSlices).fill(Infinity);
    const zMaxY = new Float64Array(numSlices).fill(-Infinity);
    const xMinY = new Float64Array(columns).fill(Infinity);
    const xMaxY = new Float64Array(columns).fill(-Infinity);
    const xMinZ = new Float64Array(columns).fill(Infinity);
    const xMaxZ = new Float64Array(columns).fill(-Infinity);
    const yMinX = new Float64Array(rows).fill(Infinity);
    const yMaxX = new Float64Array(rows).fill(-Infinity);
    const yMinZ = new Float64Array(rows).fill(Infinity);
    const yMaxZ = new Float64Array(rows).fill(-Infinity);
    let total = 0;

    for (let z = 0; z < numSlices; z++) {
      const zBase = z * rows * columns;
      for (let y = 0; y < rows; y++) {
        const yBase = zBase + y * columns;
        for (let x = 0; x < columns; x++) {
          if (volume[yBase + x] !== objectId) continue;
          total++;
          zCount[z]++;
          if (x < zMinX[z]) zMinX[z] = x;
          if (x > zMaxX[z]) zMaxX[z] = x;
          if (y < zMinY[z]) zMinY[z] = y;
          if (y > zMaxY[z]) zMaxY[z] = y;
          xCount[x]++;
          if (y < xMinY[x]) xMinY[x] = y;
          if (y > xMaxY[x]) xMaxY[x] = y;
          if (z < xMinZ[x]) xMinZ[x] = z;
          if (z > xMaxZ[x]) xMaxZ[x] = z;
          yCount[y]++;
          if (x < yMinX[y]) yMinX[y] = x;
          if (x > yMaxX[y]) yMaxX[y] = x;
          if (z < yMinZ[y]) yMinZ[y] = z;
          if (z > yMaxZ[y]) yMaxZ[y] = z;
        }
      }
    }

    if (total === 0) {
      // The review navigator calls this for every object it steps to,
      // including ones an annotator never got around to painting --
      // that's a normal thing to encounter while reviewing, not
      // something worth an error banner every time.
      if (!opts?.silent) setError("This object has no painted voxels yet -- nothing to jump to.");
      return;
    }
    setError(null);

    const bestZ = argmaxInt32(zCount);
    const bestX = argmaxInt32(xCount);
    const bestY = argmaxInt32(yCount);
    setAxialIndex(bestZ);
    setSagittalIndex(bestX);
    setCoronalIndex(bestY);

    centerPanesOnBoxes({
      axial: { minX: zMinX[bestZ], maxX: zMaxX[bestZ], minY: zMinY[bestZ], maxY: zMaxY[bestZ], nativeW: columns, nativeH: rows },
      sagittal: { minX: xMinY[bestX], maxX: xMaxY[bestX], minY: xMinZ[bestX], maxY: xMaxZ[bestX], nativeW: rows, nativeH: numSlices },
      coronal: { minX: yMinX[bestY], maxX: yMaxX[bestY], minY: yMinZ[bestY], maxY: yMaxZ[bestY], nativeW: columns, nativeH: numSlices },
    });
  }

  function argmaxInt32(counts: Int32Array): number {
    let best = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
    return best;
  }

  // How much of the pane's own width/height the object's bounding box
  // should fill after a jump -- comfortably zoomed in without touching
  // the pane's edges. Same 1..15 range as the wheel-zoom handler.
  const JUMP_ZOOM_FILL_FRACTION = 0.18;
  const JUMP_ZOOM_MIN_SCALE = 1;
  const JUMP_ZOOM_MAX_SCALE = 15;
  // A bounding box narrower than this (in native pixels) is treated as
  // this wide instead -- otherwise a one-voxel-thin sliver of an object
  // on this particular slice would compute an enormous scale purely
  // from dividing by a near-zero width, not because the object is
  // actually that small in real terms (its other, fuller slices are
  // what bestZ/bestX/bestY are chosen for in the first place).
  const JUMP_ZOOM_MIN_NATIVE_EXTENT = 12;

  /** Pans AND zooms every pane so its given in-plane bounding box is
   * centered and comfortably framed in its viewport -- replaces the
   * previous pan-only centering, which left an object however tiny it
   * rendered at whatever zoom the reviewer happened to already be at,
   * reading as "the view just slid over" rather than "jumped to the
   * object" for anything small in a zoomed-out pane. Still inverts
   * screenToDisplayLocal's transform math for the pan (solving for the
   * pan that puts the target's display-local position at the
   * container's own center), now at the newly computed scale instead
   * of whatever scale was already set. */
  function centerPanesOnBoxes(
    targets: Record<PaneKey, { minX: number; maxX: number; minY: number; maxY: number; nativeW: number; nativeH: number }>
  ) {
    setZoom((prev) => {
      const next = { ...prev };
      for (const pane of PANE_ORDER) {
        const t = targets[pane];
        if (!t.nativeW || !t.nativeH) continue;
        const centerNativeX = (t.minX + t.maxX) / 2;
        const centerNativeY = (t.minY + t.maxY) / 2;
        const extentNativeX = Math.max(t.maxX - t.minX, JUMP_ZOOM_MIN_NATIVE_EXTENT);
        const extentNativeY = Math.max(t.maxY - t.minY, JUMP_ZOOM_MIN_NATIVE_EXTENT);
        const dispExtentX = (extentNativeX / t.nativeW) * paneSize;
        const dispExtentY = (extentNativeY / t.nativeH) * paneSize;
        const fitScale = Math.min((paneSize * JUMP_ZOOM_FILL_FRACTION) / dispExtentX, (paneSize * JUMP_ZOOM_FILL_FRACTION) / dispExtentY);
        const scale = Math.max(JUMP_ZOOM_MIN_SCALE, Math.min(JUMP_ZOOM_MAX_SCALE, fitScale));

        const dispX = (centerNativeX / t.nativeW) * paneSize;
        const dispY = (centerNativeY / t.nativeH) * paneSize;
        next[pane] = { scale, panX: (paneSize / 2 - dispX) * scale, panY: (paneSize / 2 - dispY) * scale };
      }
      return next;
    });
  }

  // ── Review mode: step through every object one at a time, accept or
  // reject each ──────────────────────────────────────────────────────
  // Same label-then-instance ordering as the Objects panel's own
  // grouping, so "Next"/"Prev" walks the list the way it's already
  // displayed elsewhere in the app.
  const reviewOrderedObjects = useMemo(
    () => labels.flatMap((label) => objects.filter((o) => o.label_id === label.id)),
    [labels, objects]
  );
  const [reviewIndex, setReviewIndex] = useState(0);
  // The object just rejected: its reason chips stay on the card after
  // the review has moved on to the next object, so tagging a reason
  // never costs a step back.
  const [lastRejectedId, setLastRejectedId] = useState<number | null>(null);
  const clampedReviewIndex = Math.max(0, Math.min(reviewIndex, reviewOrderedObjects.length - 1));
  const currentReviewObject = reviewOrderedObjects[clampedReviewIndex] ?? null;
  const reviewPendingCount = reviewOrderedObjects.filter((o) => (o.review_status ?? "pending") === "pending").length;
  // Why this case can't be reviewed (not handed in, or already decided), or null.
  const reviewBlocked = reviewMode ? reviewBlockedMessage(reviewState) : null;

  useEffect(() => {
    if (reviewMode && maskReady && currentReviewObject) jumpToObject(currentReviewObject.id, { silent: true });
    // Only re-jump when the *object being looked at* actually changes,
    // not on every accept/reject (which also changes `objects`, and
    // would otherwise re-trigger this and reset the pan/zoom mid-review).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewMode, maskReady, currentReviewObject?.id]);

  useEffect(() => {
    if (reviewMode && currentReviewObject) setActiveObjectId(currentReviewObject.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewMode, currentReviewObject?.id]);

  function goToPrevReviewObject() {
    setReviewIndex((i) => Math.max(0, i - 1));
  }

  function goToNextReviewObject() {
    setReviewIndex((i) => Math.min(reviewOrderedObjects.length - 1, i + 1));
  }

  /** Records the decision and moves on to the next object still undecided
   * (after this one, wrapping round) -- as the tour and the Accept/Reject
   * tooltips say, and as the tutorial does. It went to index + 1, often an
   * object already decided (G-06). */
  function decideCurrentReviewObject(status: "accepted" | "rejected") {
    if (!currentReviewObject) return;
    const decidedId = currentReviewObject.id;
    setObjectReviewStatus(decidedId, status);
    setLastRejectedId(status === "rejected" ? decidedId : null);
    const start = reviewOrderedObjects.findIndex((o) => o.id === decidedId);
    const next = nextUndecidedIndex(reviewOrderedObjects.map((o) => o.review_status), start);
    if (next !== null) setReviewIndex(next);
    else goToNextReviewObject();
  }

  /** The review-mode "editor card" -- a fixed-corner floating panel
   * (same dark chrome as the auto-contour/histogram popups, see
   * clampPopupPosition's comment for why these all render at the top
   * level rather than inside a pane) showing the object currently under
   * review plus Accept/Reject/Prev/Next. Reachable via reviewMode only. */
  /** Docked in the right sidebar (see ViewerPage's return, above
   * ReviewObjectsList) rather than floating over a pane -- a floating
   * placement near the object inevitably ended up covering either the
   * object itself or the slice slider beneath the pane; a fixed sidebar
   * slot never covers anything, at the cost of sitting a bit further
   * from the image. */
  function renderReviewCard() {
    if (!reviewMode) return null;
    if (reviewOrderedObjects.length === 0) {
      return (
        <div className="flex flex-col gap-2 text-[11px] text-gray-400" data-testid="empty-review">
          <p>The annotator handed this case in with no objects -- nothing to segment. Confirm that, or send it back.</p>
          <div className="flex gap-1.5">
            <button
              onClick={() => handleSubmitReview("approve")}
              disabled={saving || reviewBlocked !== null}
              className="rounded border border-emerald-600 bg-emerald-600/80 px-2 py-1 text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              Approve: no findings
            </button>
            <button
              onClick={() => handleSubmitReview("reject")}
              disabled={saving || reviewBlocked !== null}
              className="rounded border border-red-600 bg-red-600/70 px-2 py-1 text-white hover:bg-red-600 disabled:opacity-40"
            >
              Send back: missed finding
            </button>
          </div>
        </div>
      );
    }
    const obj = currentReviewObject;
    const label = obj ? labels.find((l) => l.id === obj.label_id) ?? null : null;
    const status = obj?.review_status ?? "pending";
    const statusStyle: Record<string, string> = {
      pending: "text-gray-400 border-[#444]",
      accepted: "text-emerald-400 border-emerald-600",
      rejected: "text-red-400 border-red-600",
    };
    return (
      <div>
        <div className="flex items-center justify-between text-[11px] text-gray-500">
          <span>
            {clampedReviewIndex + 1} / {reviewOrderedObjects.length}
          </span>
          <span className={`rounded border px-1.5 py-0.5 uppercase tracking-wide ${statusStyle[status]}`}>{status}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          {label && <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: label.color }} />}
          <span className="truncate text-sm font-medium text-gray-100">
            {label && obj ? `${label.name} ${obj.instance_number}` : "—"}
          </span>
        </div>
        {obj && (
          <div className="mt-1.5">
            <ObjectFormEditor fields={fieldsOfLabel(label)} answers={obj.attributes} onChange={(next) => setObjectAttributes(obj.id, next)} />
          </div>
        )}
        {obj?.comment && obj.comment.trim() && (
          <p className="mt-1.5 text-[11px] text-gray-400" data-testid="annotator-note">
            <span className="text-gray-500">Annotator&apos;s note:</span> {obj.comment}
          </p>
        )}
        {obj && previousReviewText(obj) && (
          <p className="mt-1 text-[11px] text-gray-400" data-testid="previous-review">
            <span className="text-gray-500">Last round:</span> {previousReviewText(obj)}
          </p>
        )}
        <textarea
          value={obj?.review_comment ?? ""}
          onChange={(e) => obj && setObjectReviewComment(obj.id, e.target.value)}
          title="Shown to the annotator next to this object when the case goes back to them"
          placeholder="Comment for the annotator…"
          data-testid="review-comment"
          rows={2}
          className="mt-1.5 w-full resize-none rounded border border-[#444] bg-[#2a2a3e] p-1.5 text-[11px] text-amber-200 placeholder:text-gray-500"
        />

        <div className="mt-3 flex items-center justify-between gap-1.5">
          <Tip title="Previous object" description="Step back to the previous object without changing any decision." side="left">
            <span className="flex">
              <button
                onClick={goToPrevReviewObject}
                disabled={clampedReviewIndex === 0}
                className="flex h-7 w-7 items-center justify-center rounded border border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-30"
                title="Previous object"
              >
                <ChevronLeftIcon />
              </button>
            </span>
          </Tip>
          <Tip title="Reject this object" description="Marks it rejected and moves to the next undecided object. Write what is wrong in the comment above -- the annotator sees it next to this object." side="left">
            <button
              onClick={() => decideCurrentReviewObject("rejected")}
              className="flex flex-1 items-center justify-center gap-1 rounded border border-red-600 bg-red-600/20 py-1.5 text-xs font-medium text-red-300 hover:bg-red-600/30"
            >
              <CloseIcon />
              Reject
            </button>
          </Tip>
          <Tip title="Accept this object" description="Marks it accepted and moves to the next undecided object." side="left">
            <button
              onClick={() => decideCurrentReviewObject("accepted")}
              className="flex flex-1 items-center justify-center gap-1 rounded border border-emerald-600 bg-emerald-600/20 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-600/30"
            >
              <CheckIcon />
              Accept
            </button>
          </Tip>
          <Tip title="Next object" description="Step to the next object without changing any decision." side="left">
            <span className="flex">
              <button
                onClick={goToNextReviewObject}
                disabled={clampedReviewIndex === reviewOrderedObjects.length - 1}
                className="flex h-7 w-7 items-center justify-center rounded border border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-30"
                title="Next object"
              >
                <ChevronRightIcon />
              </button>
            </span>
          </Tip>
        </div>
        {renderRejectReasons()}
      </div>
    );
  }

  /** "Why?" chips for the object just rejected (one tap, optional). */
  function renderRejectReasons() {
    const rejected = objects.find((o) => o.id === lastRejectedId && o.review_status === "rejected");
    if (!rejected) return null;
    const label = labels.find((l) => l.id === rejected.label_id);
    return (
      <div className="mt-2 rounded border border-red-900/60 bg-red-950/30 p-1.5" data-testid="reject-reasons">
        <p className="mb-1 text-[10px] text-red-200/80">
          Why was {label ? `${label.name} ${rejected.instance_number}` : "it"} rejected? <span className="text-gray-500">(optional)</span>
        </p>
        <div className="flex flex-wrap gap-1">
          {REJECT_REASONS.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setObjectRejectReason(rejected.id, r.key)}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${rejected.reject_reason === r.key ? "border-red-400 bg-red-600/30 text-red-100" : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"}`}
              data-testid={`reject-reason-${r.key}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  /** Shows the Alt+click HU tooltip at a viewport position, and
   * schedules it to auto-hide -- see the huReadout state's own comment
   * for why this is viewport (clientX/clientY), not pane-local, coords. */
  function showHuReadout(clientX: number, clientY: number, text: string) {
    if (huReadoutTimeoutRef.current) clearTimeout(huReadoutTimeoutRef.current);
    setHuReadout({ clientX, clientY, text });
    huReadoutTimeoutRef.current = setTimeout(() => setHuReadout(null), 4000);
  }

  /** Alt+click on any pane while in the View tool: looks up the
   * Hounsfield-unit value at that voxel and shows it as a floating
   * tooltip pinned to the clicked point. Read-only -- doesn't touch
   * zoom/pan/navigation, unlike the plain-click/Ctrl+click handlers this
   * sits alongside in handlePaneMouseDown. */
  function handleAltClickInspectHU(event: { clientX: number; clientY: number }, pane: PaneKey) {
    const coords = resolvePaneClickVolumeXYZ(event, pane);
    if (!coords || !seriesId) return;
    const { x, y, z } = coords;
    showHuReadout(event.clientX, event.clientY, "…");
    fetchVoxelHU(seriesId, x, y, z)
      .then((hu) => showHuReadout(event.clientX, event.clientY, `${Math.round(hu)} HU`))
      .catch((err) => setError(errorText(err)));
  }

  /** Opens the comment popup for whatever object is under (clientX,
   * clientY) on the given pane -- shared by the View tool's right-click
   * (handlePaneContextMenu, below) and a plain (non-dragged) right-click
   * while an Annotate tool is active (handlePanePointerUp) -- see
   * rightClickRef's own comment. Right-clicking background (id 0) does
   * nothing, silently. */
  function openCommentAt(pane: PaneKey, clientX: number, clientY: number) {
    const coords = resolvePaneClickVolumeXYZ({ clientX, clientY }, pane);
    const volume = maskVolumeRef.current;
    if (!coords || !volume) return;
    const objectId = volume[maskIndex(coords.x, coords.y, coords.z)];
    if (objectId === 0) return;
    setFormRequest((prev) => ({ objectId, nonce: (prev?.nonce ?? 0) + 1 }));
    if (compact) setPanelOpen(true);
  }

  /** Right-click a painted voxel, in the View tool, to open the comment
   * popup (openCommentAt above) -- the Annotate-tool equivalent lives in
   * handlePanePointerDown/Move/Up instead, since there right-click is
   * also overloaded with force-erase-on-drag and needs pointer events
   * (not just this contextmenu event) to tell a click from a drag.
   * `preventDefault` here (a `contextmenu` listener, not `mousedown`) is
   * what actually suppresses the browser's own menu. */
  function handlePaneContextMenu(event: ReactMouseEvent<HTMLDivElement>, pane: PaneKey) {
    event.preventDefault();
    if (tab !== "view") return;
    // A mouse right button is handled by the window/level drag: a click
    // without a drag opens the comment on release (endWindowDrag).
    if (windowDragRef.current || performance.now() < suppressContextMenuUntilRef.current) return;
    openCommentAt(pane, event.clientX, event.clientY);
  }

  // ── Mouse window/level drag ─────────────────────────────────────────
  // Up/down moves the level (window centre), left/right the width --
  // the gesture radiologists window with. Right button with the Cursor
  // tool (a right *click* still opens a comment), middle button with
  // any tool (the right button erases while drawing). Registered in the
  // capture phase so a drawing tool never sees the drag.

  /** Ctrl/Cmd+click jumps every pane to that point with any tool, not
   * just the Cursor: a navigation gesture, never a drawing one, so it is
   * taken in the capture phase before a tool can start a stroke. */
  function startCtrlNavigate(event: ReactPointerEvent<HTMLDivElement>, pane: PaneKey): boolean {
    if (event.pointerType === "touch" || event.button !== 0) return false;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
    event.preventDefault();
    event.stopPropagation();
    handleCtrlClickNavigate(event, pane);
    return true;
  }

  function startWindowDrag(event: ReactPointerEvent<HTMLDivElement>, pane: PaneKey): boolean {
    if (event.pointerType !== "mouse") return false;
    if (!(event.button === 1 || (event.button === 2 && tab === "view"))) return false;
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    event.preventDefault(); // no middle-button autoscroll
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    windowDragRef.current = { pane, pointerId: event.pointerId, button: event.button, x0: event.clientX, y0: event.clientY, c0: windowCenter, w0: windowWidth, moved: false };
    return true;
  }

  function moveWindowDrag(event: ReactPointerEvent<HTMLDivElement>): boolean {
    const drag = windowDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return false;
    event.stopPropagation();
    const dx = event.clientX - drag.x0;
    const dy = event.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < WINDOW_DRAG_THRESHOLD_PX) return true;
    if (!drag.moved) trackAction("window.drag");
    drag.moved = true;
    const perPx = Math.max(0.5, drag.w0 * WINDOW_DRAG_HU_PER_PX);
    setWindowCenter(Math.round(Math.max(-1000, Math.min(1000, drag.c0 + dy * perPx))));
    setWindowWidth(Math.round(Math.max(1, Math.min(4000, drag.w0 + dx * perPx * 1.5))));
    return true;
  }

  function endWindowDrag(event: ReactPointerEvent<HTMLDivElement>): boolean {
    const drag = windowDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return false;
    event.stopPropagation();
    windowDragRef.current = null;
    // the contextmenu event of this same press must not open a second comment
    suppressContextMenuUntilRef.current = performance.now() + 400;
    if (!drag.moved && drag.button === 2 && event.type === "pointerup") openCommentAt(drag.pane, event.clientX, event.clientY);
    return true;
  }

  // Tracked on every pane mousemove (not just while dragging) so the
  // Up/Down arrow-key zoom shortcut below can anchor at "wherever the
  // mouse currently is" the same way wheel-zoom anchors at the cursor --
  // a keydown event has no cursor position of its own to read.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  function handlePaneMouseMove(event: ReactMouseEvent<HTMLDivElement>) {
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    setZoom((prev) => ({ ...prev, [drag.pane]: { ...prev[drag.pane], panX: drag.panX + dx, panY: drag.panY + dy } }));
  }

  function handlePaneMouseUp() {
    dragRef.current = null;
  }

  function handlePaneDoubleClick(pane: PaneKey) {
    if (tab !== "view") return;
    setZoom((prev) => ({ ...prev, [pane]: IDLE_ZOOM }));
  }

  // ── Touch gestures on a pane (see lib/touch.ts) ─────────────────────
  // Registered in the capture phase on the pane container, so they see
  // every touch pointer before the overlay canvas's own stroke handlers
  // do -- and can stop those from ever seeing the second finger.

  /** Whatever one finger had started is abandoned when a second lands:
   * the stroke is undone (its slice snapshot is on the undo stack), a
   * box drag or pan is cancelled, a pending tap is dropped. */
  function abortOneFingerInteraction(pane: PaneKey) {
    cancelPendingTap();
    if (drawingRef.current) {
      drawingRef.current = false;
      lastPointRef.current = null;
      forceEraseRef.current = false;
      strokeBlockedByLockRef.current = false;
      const entry = undoStackRef.current.pop();
      if (entry) restoreSlice(entry.pane, entry.index, entry.slice);
      renderAllPaneOverlays();
    }
    if (autoDragRef.current) cancelAutoContour();
    if (roiDragRef.current) {
      roiDragRef.current = null;
      setRoiBox(null);
    }
    if (dragRef.current?.pane === pane) dragRef.current = null;
  }

  function handleTouchDownCapture(event: ReactPointerEvent<HTMLDivElement>, pane: PaneKey) {
    if (event.pointerType !== "touch") return;
    const tracker = touchRef.current[pane];
    tracker.down(event.pointerId, event.clientX, event.clientY);
    tapRef.current[pane].down(event.pointerId, event.clientX, event.clientY, tracker.count, tracker.center());
    if (tracker.count === 2) {
      abortOneFingerInteraction(pane);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function handleTouchMoveCapture(event: ReactPointerEvent<HTMLDivElement>, pane: PaneKey) {
    if (event.pointerType !== "touch") return;
    tapRef.current[pane].move(event.pointerId, event.clientX, event.clientY);
    const pinch = touchRef.current[pane].move(event.pointerId, event.clientX, event.clientY);
    if (!pinch) return;
    // Two fingers: this move is the pinch/pan's, not a stroke's.
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    applyPinch(pane, pinch.factor, pinch.cx - rect.left, pinch.cy - rect.top, pinch.dx, pinch.dy, rect.width, rect.height);
  }

  function handleTouchUpCapture(event: ReactPointerEvent<HTMLDivElement>, pane: PaneKey) {
    if (event.pointerType !== "touch") return;
    const tracker = touchRef.current[pane];
    const countBefore = tracker.count;
    tapRef.current[pane].up(event.pointerId, event.clientX, event.clientY, countBefore);
    tracker.up(event.pointerId);
    if (countBefore >= 2) event.stopPropagation(); // part of a pinch: nothing for the canvas to finish
  }

  /** Pinch: scale by `factor` keeping the point between the fingers
   * fixed on screen, then shift by how far that midpoint moved -- the
   * same anchor math as applyZoomStep, multiplicative instead of a
   * fixed step. */
  function applyPinch(pane: PaneKey, factor: number, mx: number, my: number, dx: number, dy: number, rectWidth: number, rectHeight: number) {
    setZoom((prev) => {
      const z = prev[pane];
      const oldScale = z.scale;
      const newScale = Math.max(1, Math.min(15, oldScale * factor));
      if (newScale === 1) return { ...prev, [pane]: IDLE_ZOOM };
      const size = paneSizeRef.current;
      const containerCenterX = rectWidth / 2;
      const containerCenterY = rectHeight / 2;
      const lx = screenToDisplayLocal(mx, containerCenterX, oldScale, z.panX, size);
      const ly = screenToDisplayLocal(my, containerCenterY, oldScale, z.panY, size);
      return {
        ...prev,
        [pane]: { scale: newScale, panX: mx - containerCenterX - newScale * (lx - size / 2) + dx, panY: my - containerCenterY - newScale * (ly - size / 2) + dy },
      };
    });
  }

  gestureHandlerRef.current = (gesture, pane, x, y) => {
    if (gesture === "long-press") {
      // = Alt+click. Whatever the finger was about to do is dropped
      // (an in-progress stroke can't be: it needed a move to start).
      cancelPendingTap();
      if (autoDragRef.current) cancelAutoContour();
      if (roiDragRef.current) {
        roiDragRef.current = null;
        setRoiBox(null);
      }
      handleAltClickInspectHU({ clientX: x, clientY: y }, pane);
    } else if (gesture === "double-tap") {
      // = double-click: reset this pane's zoom -- and not the two dots
      // the taps would have been.
      cancelPendingTap();
      setZoom((prev) => ({ ...prev, [pane]: IDLE_ZOOM }));
    } else if (gesture === "two-finger-tap") {
      handleCtrlClickNavigate({ clientX: x, clientY: y }, pane); // = Ctrl+click
    }
  };

  // ── Keyboard: arrow keys navigate the last-hovered pane ──────────────────

  const hoveredPaneRef = useRef<PaneKey>("axial");

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const active = document.activeElement;
      const typing = active instanceof HTMLElement && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");

      // Ctrl+Z / Cmd+Z: undo. Ctrl+Shift+Z (or Ctrl+Y): redo. Only
      // meaningful in Annotate mode; skipped while a form field is
      // focused so it doesn't fight a browser text-undo the user is
      // actually after.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        if (typing || tab !== "annotate" || reviewMode) return;
        event.preventDefault();
        // through refs: this handler is bound less often than the slice
        // indices change, and the stale copy redrew the wrong slice (E-02)
        if (event.shiftKey) redoRef.current();
        else undoRef.current();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        if (typing || tab !== "annotate") return;
        event.preventDefault();
        redoRef.current();
        return;
      }

      // Escape closes the comment popup even while its own textarea is
      // focused (unlike the polygon/auto-contour cases below, which are
      // deliberately skipped while typing so Escape doesn't fight a
      // browser text-edit undo) -- there's no such conflict here, and
      // "Escape closes the text box you're in" is the expected behavior.
      // Escape: cancel an in-progress polygon or a pending (not yet
      // applied) auto-contour box, without touching the volume.
      if (event.key === "Escape" && !typing) {
        if (polygonDraft) {
          setPolygonDraft(null);
          setPolygonCursor(null);
          return;
        }
        if (autoBox) {
          cancelAutoContour();
          return;
        }
        if (roiBox) {
          closeRoiHistogram();
          return;
        }
      }
      // Enter: apply a pending auto-contour preview.
      if (event.key === "Enter" && !typing && autoBox && autoHu) {
        event.preventDefault();
        // the latest render's version: its preview mask and active object (E-01)
        applyAutoContourRef.current();
        return;
      }

      // N: quick "new instance of the currently active label" -- see the
      // header button of the same name for the click-driven equivalent.
      if (event.key.toLowerCase() === "c" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        setShowCrosshair((v) => !v);
        return;
      }
      if (event.key.toLowerCase() === "n" && !typing && !event.ctrlKey && !event.metaKey && activeLabel && !reviewMode) {
        event.preventDefault();
        createObjectInActiveLabel();
        return;
      }

      // WASD: pan the last-hovered pane -- only meaningful once zoomed
      // in (at scale 1 the whole image already fits the pane, nothing
      // to pan to), same as mouse-drag panning already requires. Unlike
      // mouse-drag panning, not restricted to the cursor tool: a
      // drag gesture is ambiguous with painting in Annotate mode (so
      // that one's tool-gated), but a WASD keypress never is, and being
      // able to nudge the view without switching tools while zoomed in
      // mid-paint is exactly when this is most useful. Fixed screen-
      // pixel step regardless of current zoom, since panX/panY apply
      // *after* the scale transform (`translate(...) scale(...)`), so a
      // constant step always feels the same size on screen.
      const wasdKey = event.key.toLowerCase();
      if (["w", "a", "s", "d"].includes(wasdKey) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (typing) return;
        const pane = hoveredPaneRef.current ?? "coronal";
        if (zoomRef.current[pane].scale > 1) {
          event.preventDefault();
          // "Camera" convention, not direct-drag: W/Up reveals more of
          // what's above (the image itself moves down), matching what
          // the person actually expected here -- the opposite of a
          // literal drag-the-image-up feel.
          const PAN_STEP_PX = 40;
          const dx = wasdKey === "a" ? PAN_STEP_PX : wasdKey === "d" ? -PAN_STEP_PX : 0;
          const dy = wasdKey === "w" ? PAN_STEP_PX : wasdKey === "s" ? -PAN_STEP_PX : 0;
          setZoom((prev) => ({ ...prev, [pane]: { ...prev[pane], panX: prev[pane].panX + dx, panY: prev[pane].panY + dy } }));
        }
        return;
      }

      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      if (typing) return;
      event.preventDefault();
      const pane = hoveredPaneRef.current;
      // Left/Right step slices; Up/Down step zoom -- the keyboard's
      // counterparts of the wheel (slices) and Ctrl+wheel (zoom).
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const dir = event.key === "ArrowLeft" ? -1 : 1;
        if (pane === "axial") setAxialIndex((i) => Math.max(0, Math.min(numSlices - 1, i + dir)));
        else if (pane === "sagittal") setSagittalIndex((i) => Math.max(0, Math.min(columns - 1, (i ?? 0) + dir)));
        else setCoronalIndex((i) => Math.max(0, Math.min(rows - 1, (i ?? 0) + dir)));
        return;
      }
      const zoomPane = pane ?? "coronal"; // matches the slice-stepping branch's own null fallback above
      const container = paneContainerRefs[zoomPane].current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      // Anchor at wherever the mouse actually is over the pane (same as
      // wheel-zoom), falling back to the pane's own center only for the
      // edge case of zooming via keyboard before any mousemove has ever
      // been recorded.
      const pointer = lastPointerRef.current;
      const mx = pointer ? pointer.x - rect.left : rect.width / 2;
      const my = pointer ? pointer.y - rect.top : rect.height / 2;
      applyZoomStep(zoomPane, event.key === "ArrowUp" ? 0.15 : -0.15, mx, my, rect.width, rect.height);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numSlices, columns, rows, tab, polygonDraft, autoBox, autoHu, activeLabel, objects, roiBox, reviewMode]);

  if (!routeInstanceId) return null;

  // "Original" means the file's own window/level (what it actually
  // loaded with, from its DICOM metadata) when it has one, not just the
  // hardcoded 40/400 fallback used before any metadata arrives -- see
  // the metadata-fetch effect above, which snaps windowCenter/
  // windowWidth to these same values on first load whenever they're
  // still untouched. Backs the Sharpness section's "Reset to original"
  // button.
  const originalWindowCenter = metadata?.window_center ?? DEFAULT_WINDOW_CENTER;
  const originalWindowWidth = metadata?.window_width ?? DEFAULT_WINDOW_WIDTH;
  const isOriginalImageAdjustment =
    windowCenter === originalWindowCenter && windowWidth === originalWindowWidth && sharpness === 0;

  const sliceStripPx = coarse ? SLICE_STRIP_PX.touch : SLICE_STRIP_PX.mouse;
  const paneConfig: Record<PaneKey, { index: number; max: number; setIndex: (n: number) => void; nativeW: number; nativeH: number }> = {
    sagittal: { index: sagittalIndex ?? 0, max: Math.max(columns - 1, 0), setIndex: setSagittalIndex, nativeW: columns, nativeH: numSlices },
    coronal: { index: coronalIndex ?? 0, max: Math.max(rows - 1, 0), setIndex: setCoronalIndex, nativeW: rows, nativeH: numSlices },
    axial: { index: axialIndex, max: Math.max(numSlices - 1, 0), setIndex: setAxialIndex, nativeW: columns, nativeH: rows },
  };

  return (
    <div ref={viewerRootRef} className="flex h-screen flex-col bg-[#1a1a2e] text-gray-200">
      {/* One exact linear grey-level map per pane: the instant window
          preview (see windowFilterFor). sRGB, not the default linearRGB,
          or the map would bend. */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          {PANE_ORDER.map((pane) => {
            const { slope, intercept } = windowFilterParams(pane);
            return (
              <filter key={pane} id={`vl-window-${pane}`} colorInterpolationFilters="sRGB">
                <feComponentTransfer>
                  <feFuncR type="linear" slope={slope} intercept={intercept} />
                  <feFuncG type="linear" slope={slope} intercept={intercept} />
                  <feFuncB type="linear" slope={slope} intercept={intercept} />
                </feComponentTransfer>
              </filter>
            );
          })}
        </defs>
      </svg>
      <header className="flex flex-shrink-0 flex-wrap items-center justify-between gap-y-1.5 border-b border-[#333] bg-[#15152a] px-4 py-2">
        {/* Both groups wrap on their own too (a portrait tablet is narrower
            than either), and no control's label may break mid-phrase. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <Tip title="Back" description="Return to the case page in your job list. Save first -- leaving does not save.">
            <a
              href={withViewAs(returnUrl ?? "/", viewAs)}
              onClick={(e) => {
                if (!confirmLeavingUnsaved()) e.preventDefault();
              }}
              data-guide="back"
              className="whitespace-nowrap rounded border border-[#444] px-3 py-1 text-xs text-gray-300 hover:bg-[#2a2a3e]"
            >
              {returnUrl ? "← Back" : "← Back to picker"}
            </a>
          </Tip>
          <h1 className="text-sm font-semibold text-gray-100">{reviewMode ? "Review" : "Viewer"}</h1>
          {platformAdmin && <ViewAsTabs value={viewAs} onChange={changeViewAs} />}
          {jobId && jobStatus && (
            <Tip
              title="Job status"
              description="The status of your whole job (every case in it), as shown on your job list. It follows the cases by itself: In progress once any case is started or sent back, Done once every case is annotated (Review: once every submitted case is decided)."
            >
              <span
                data-guide="job-status"
                className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${(JOB_STATUS_STYLE[jobStatus] ?? JOB_STATUS_STYLE.todo).className}`}
              >
                {(JOB_STATUS_STYLE[jobStatus] ?? JOB_STATUS_STYLE.todo).label}
              </span>
            </Tip>
          )}
          {jobCases && openQueue && jobCases.length > 0 && (
            <div className="flex items-center gap-1 border-l border-[#333] pl-3" data-guide="case-nav">
              <Tip title="Previous open case" description={reviewMode ? "Go to the previous case still awaiting a decision. Save your work first." : "Go to the previous case that still needs annotating (rejected ones included). Save your work first."}>
                <span className="flex">
                  <button
                    type="button"
                    data-testid="case-prev"
                    onClick={() => openQueueIndex > 0 && goToCase(openQueue[openQueueIndex - 1].id)}
                    disabled={openQueueIndex <= 0 || caseNavPending}
                    className="rounded border border-[#444] px-2 py-1 text-xs text-gray-300 hover:bg-[#2a2a3e] disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    ←
                  </button>
                </span>
              </Tip>
              <Tip
                title="Open cases"
                description={`${jobCases.length} case${jobCases.length === 1 ? "" : "s"} in this job; the arrows only visit the ones still ${reviewMode ? "awaiting a decision" : "to annotate (rejected ones included)"}.`}
              >
                <span className="whitespace-nowrap px-1 text-xs text-gray-400" data-testid="case-counter">
                  {openQueueIndex >= 0
                    ? `Case ${openQueueIndex + 1} of ${openQueue.length} open${currentCaseDone ? (reviewMode ? " · decided" : " · handed in") : ""}`
                    : `${openQueue.length} of ${jobCases.length} cases open`}
                </span>
              </Tip>
              <Tip title="Next open case" description={reviewMode ? "Go to the next case still awaiting a decision. Save your work first." : "Go to the next case that still needs annotating (rejected ones included). Save your work first."}>
                <span className="flex">
                  <button
                    type="button"
                    data-testid="case-next"
                    onClick={() => openQueueIndex >= 0 && openQueueIndex < openQueue.length - 1 && goToCase(openQueue[openQueueIndex + 1].id)}
                    disabled={openQueueIndex < 0 || openQueueIndex >= openQueue.length - 1 || caseNavPending}
                    className="rounded border border-[#444] px-2 py-1 text-xs text-gray-300 hover:bg-[#2a2a3e] disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    →
                  </button>
                </span>
              </Tip>
            </div>
          )}
          {caseId && (
            <div className="relative border-l border-[#333] pl-3" data-guide="documents">
              <Tip title="Documents" description="The reports and notes attached to this case. Open one to read it in a side panel next to the images.">
                <button
                  type="button"
                  onClick={toggleDocuments}
                  className="whitespace-nowrap rounded border border-[#444] px-3 py-1 text-xs text-gray-300 hover:bg-[#2a2a3e]"
                >
                  Documents{documents && documents.length > 0 ? ` (${documents.length})` : ""}
                </button>
              </Tip>
              {documentsOpen && (
                <div className="absolute left-3 top-full z-20 mt-1 w-72 rounded border border-[#444] bg-[#20203a] p-2 shadow-lg">
                  {documents === null ? (
                    <p className="px-2 py-1 text-xs text-gray-400">Loading…</p>
                  ) : documents.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-gray-400">No documents for this case.</p>
                  ) : (
                    <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                      {documents.map((doc) => (
                        <li key={doc.id}>
                          <button
                            type="button"
                            onClick={() => doc.has_file && openDocument(doc)}
                            disabled={!doc.has_file}
                            title={doc.has_file ? "Open in the side panel" : "No file attached to this document"}
                            className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-[#2a2a3e] disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <span className="truncate text-xs text-gray-100">{doc.title}</span>
                            <span className="text-[11px] text-gray-500">
                              {doc.type}
                              {doc.date ? ` · ${doc.date}` : ""}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!reviewMode && (
            <>
              <Tip
                title={activeLabel ? `New ${activeLabel.name} instance` : "New instance"}
                description={
                  activeLabel
                    ? `Adds another ${activeLabel.name} and makes it the active object, ready to draw into.`
                    : "Select an object first -- the new instance gets that object's label."
                }
                shortcut="N"
              >
                <span className="flex" data-guide="new-instance">
                  <button
                    data-testid="new-instance-button"
                    onClick={createObjectInActiveLabel}
                    disabled={!activeLabel}
                    className="flex items-center gap-1.5 rounded border border-[#444] bg-[#2a2a3e] px-2 py-1 text-xs text-gray-300 transition-colors hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {activeLabel && <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: activeLabel.color }} />}
                    <PlusIcon />
                    New instance
                  </button>
                </span>
              </Tip>
              <div className="flex items-center gap-0.5 rounded border border-[#444] bg-[#2a2a3e] p-0.5">
                {allowedPaneKeys.map((pane) => (
                  <Tip
                    key={pane}
                    title={`${paneVisible[pane] ? "Hide" : "Show"} the ${pane === "three_d" ? "3D" : PANE_LABELS[pane]} pane`}
                    description="Show or hide this pane. Hiding gives the others more room; nothing is lost."
                  >
                    <button
                      onClick={() => togglePaneVisible(pane)}
                      className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
                        paneVisible[pane] ? "text-gray-300 hover:bg-[#333]" : "text-gray-600 hover:bg-[#333] hover:text-gray-400"
                      }`}
                    >
                      <EyeIcon visible={paneVisible[pane]} />
                    </button>
                  </Tip>
                ))}
              </div>
            </>
          )}
          {/* Its own amber, labeled styling rather than the neutral-gray
              IconButton every other header control uses -- the one
              button that gets someone unstuck should read as a distinct
              call-to-action at a glance, not blend in as one more icon.
              Same treatment as TutorialPage's own Tutorial button. */}
          {compact && (
            <Tip title="Panel" description="Open the side panel: objects, appearance, window/level and saved versions. It closes again with the ✕ at its top.">
              <button
                type="button"
                onClick={() => setPanelOpen((v) => !v)}
                data-testid="panel-toggle"
                aria-expanded={panelOpen}
                className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors ${panelOpen ? "border-blue-500 bg-blue-500/20 text-blue-300" : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"}`}
              >
                Panel
              </button>
            </Tip>
          )}
          <Tip title="Tutorial" description="Replay the guided tour of this screen -- what each part does and how a case is worked.">
            <span className="flex">
              <button
                onClick={startTour}
                aria-label="Tutorial"
                className="flex items-center gap-1.5 rounded-md border border-amber-400/60 bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-300 shadow-sm shadow-amber-500/20 transition-colors hover:bg-amber-500/25"
              >
                <HelpIcon />
                Tutorial
              </button>
            </span>
          </Tip>
          <IconButton
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            description="Use the whole screen for the viewer. Esc leaves fullscreen."
            onClick={toggleFullscreen}
          >
            {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
          </IconButton>
          {!reviewMode && (
            <div className="flex items-center gap-2" data-guide="undo-redo">
              <IconButton title="Undo" description="Take back the last paint, erase, fill or polygon." shortcut="Ctrl+Z" onClick={undoLastMaskChange} disabled={!maskReady}>
                <UndoIcon />
              </IconButton>
              <IconButton title="Redo" description="Put back what you just undid." shortcut="Ctrl+Shift+Z" onClick={redoLastMaskChange} disabled={!maskReady}>
                <RedoIcon />
              </IconButton>
            </div>
          )}
          <Tip
            title="Save a draft"
            description={
              reviewMode
                ? "Store your decisions and comments so far without submitting the review yet."
                : "Store the current drawing as a draft on this case. Save often; you can keep editing afterwards."
            }
          >
            <span className="flex" data-guide="save">
              <button
                onClick={() => handleSave("draft")}
                disabled={saving || !studyId || !maskReady || reviewBlocked !== null || readOnlyLocked}
                className="rounded border border-blue-500 bg-blue-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </span>
          </Tip>
          {!reviewMode && (
            <Tip
              title="Mark as Annotated"
              description="Save and hand this case in: it shows as Annotated and appears in the reviewer's job as awaiting review. If they reject it, it comes back to you with their comments."
            >
              <span className="flex" data-guide="mark-annotated">
                <button
                  onClick={() => handleSave("submitted")}
                  disabled={saving || !studyId || !maskReady || readOnlyLocked}
                  className="rounded border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Mark as Annotated
                </button>
              </span>
            </Tip>
          )}
          {reviewMode && (
            <Tip
              title="Submit review"
              description={
                reviewPendingCount > 0
                  ? `${reviewPendingCount} object${reviewPendingCount === 1 ? "" : "s"} still need${reviewPendingCount === 1 ? "s" : ""} a decision before you can submit.`
                  : "Decide the whole case from the objects' decisions: one rejected object rejects the case (it goes back to the annotator with your comments); all accepted approves it."
              }
            >
              <span className="flex" data-guide="submit-review">
                <button
                  onClick={() => handleSubmitReview()}
                  disabled={saving || !studyId || !maskReady || readOnlyLocked || reviewBlocked !== null || reviewOrderedObjects.length === 0 || reviewPendingCount > 0}
                  className="rounded border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Submit review
                </button>
              </span>
            </Tip>
          )}
          {savedMessage && <span className="text-xs text-emerald-400">{savedMessage}</span>}
        </div>
      </header>
      {error && <div className="flex-shrink-0 bg-red-900/60 px-4 py-1.5 text-xs text-red-200">{error}</div>}
      {mixedSizes && (
        <div className="flex-shrink-0 bg-amber-900/60 px-4 py-1.5 text-xs text-amber-100" data-testid="mixed-sizes">
          {mixedSizes}
        </div>
      )}
      {surfaceFailed && (
        <div className="flex-shrink-0 bg-amber-900/60 px-4 py-1.5 text-xs text-amber-100" data-testid="job-settings-failed">
          This job's settings couldn't be loaded, so the viewer stays read-only -- reload the page to try again.
        </div>
      )}
      {maskLoadFailed && (
        <div className="flex-shrink-0 bg-amber-900/60 px-4 py-1.5 text-xs text-amber-100" data-testid="mask-load-failed">
          The saved segmentation couldn't be loaded, so the viewer stays read-only -- reload the page to try again.
        </div>
      )}
      {reviewBlocked && maskReady && (
        <div className="flex-shrink-0 bg-amber-900/60 px-4 py-1.5 text-xs text-amber-100" data-testid="review-blocked">
          {reviewBlocked}
        </div>
      )}
      {!studyId && (
        <div className="flex-shrink-0 bg-red-900/60 px-4 py-1.5 text-xs text-red-200">
          No studyId in the URL -- annotations can't be saved without it.
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {!reviewMode && (
          <IconToolbar tool={tool} onSelect={selectTool} canDraw={activeObjectId !== null && !readOnlyLocked} allowedTools={readOnlyLocked ? [] : (effectiveSurface?.tools ?? null)} />
        )}

        {/* `safe center`: centred when the panes fit, top-aligned (and
            scrollable) when they don't -- plain `center` would push the
            first row's top above the visible area with no way to reach it. */}
        {/* When the 3D view is alone the row must NOT wrap: a wrapped
            row's line is only as tall as its content, so the pane's
            `self-stretch` would have nothing to stretch to and the
            canvas would keep its default height in a half-empty row. */}
        <div
          ref={paneRowRef}
          data-guide="panes"
          className={`flex min-w-0 flex-1 bg-black ${
            only3d ? "" : "flex-wrap items-start justify-center gap-px overflow-auto [align-content:safe_center]"
          }`}
        >
          {PANE_ORDER.map((pane) => {
            if (!visiblePaneKeys.includes(pane)) return null;
            const cfg = paneConfig[pane];
            const z = zoom[pane];
            // Every pane fills the same fixed square box, stretched
            // ("object-fit: fill", not "contain") rather than sized to its
            // native pixel aspect ratio. Sagittal/coronal reconstructions
            // here have no slice-thickness/pixel-spacing correction (never
            // persisted anywhere in the main platform's DB), so the
            // "slice count" axis has far fewer native pixels than the
            // in-plane axes -- contain-fitting that raw aspect makes those
            // two planes render as a thin squashed strip. Stretching to
            // fill is the same fallback plain viewers use when spacing is
            // unknown, and incidentally looks closer to anatomically
            // normal than preserving the (already-wrong) native aspect.
            const displayWidth = paneSize;
            const displayHeight = paneSize;

            return (
              <div key={pane} className="flex flex-shrink-0 flex-col bg-black" style={{ width: paneSize + sliceStripPx }}>
                <div className="flex flex-shrink-0 items-center justify-center gap-1.5 bg-[#111] py-1">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: PLANE_COLORS[pane] }} aria-hidden="true" />
                  <span className="text-center text-[11px] uppercase tracking-wider text-gray-400">{PANE_LABELS[pane]}</span>
                  {slab.thickness > 1 && (
                    <span className="rounded bg-[#2a2a3e] px-1 font-mono text-[10px] text-amber-300" title={`${SLAB_LABEL[slab.mode]} of ${slab.thickness} slices`} data-testid={`pane-${pane}-slab`}>
                      {slab.mode === "avg" ? "AVG" : SLAB_LABEL[slab.mode].toUpperCase()} {slab.thickness}
                    </span>
                  )}
                  <button
                    onClick={() => toggleMaximized(pane)}
                    className="text-gray-500 hover:text-white"
                    title={maximizedPane === pane ? "Restore" : "Maximize"}
                    data-testid={`pane-${pane}-maximize`}
                  >
                    {maximizedPane === pane ? <FullscreenExitIcon /> : <FullscreenIcon />}
                  </button>
                  <button
                    onClick={() => togglePaneVisible(pane)}
                    className="text-gray-500 hover:text-white"
                    title="Hide this pane"
                    data-testid={`pane-${pane}-hide`}
                  >
                    <EyeIcon visible={true} />
                  </button>
                </div>
                <div className="flex min-h-0 flex-1">
                <div
                  ref={paneContainerRefs[pane]}
                  // names the pane for usage tracking: a click here is placed
                  // on this pane in a recorded screen, whichever panes were on
                  data-testid={`pane-${pane}`}
                  className="relative flex flex-1 items-center justify-center overflow-hidden bg-black"
                  style={{
                    // The browser must not scroll/zoom the page on a
                    // touch drag here -- every finger is ours.
                    touchAction: "none",
                    cursor:
                      tab === "view" && z.scale > 1
                        ? "grab"
                        : tab === "annotate" && (tool === "fill" || tool === "polygon" || tool === "auto" || tool === "histogram")
                          ? "crosshair"
                          : "default",
                  }}
                  onPointerDownCapture={(e) => {
                    if (!startCtrlNavigate(e, pane) && !startWindowDrag(e, pane)) handleTouchDownCapture(e, pane);
                  }}
                  onPointerMoveCapture={(e) => {
                    if (!moveWindowDrag(e)) handleTouchMoveCapture(e, pane);
                  }}
                  onPointerUpCapture={(e) => {
                    if (!endWindowDrag(e)) handleTouchUpCapture(e, pane);
                  }}
                  onPointerCancelCapture={(e) => {
                    if (!endWindowDrag(e)) handleTouchUpCapture(e, pane);
                  }}
                  // Pointer events, not mouse events: a touch drag never
                  // produces mousemove, so the View tool's pan needs these.
                  onPointerDown={(e) => handlePaneMouseDown(e, pane)}
                  onPointerMove={handlePaneMouseMove}
                  onPointerUp={handlePaneMouseUp}
                  onPointerCancel={handlePaneMouseUp}
                  onPointerLeave={handlePaneMouseUp}
                  onDoubleClick={() => handlePaneDoubleClick(pane)}
                  onPointerEnter={() => (hoveredPaneRef.current = pane)}
                  onContextMenu={(e) => handlePaneContextMenu(e, pane)}
                >
                  {volumeUnavailable && (pane === "sagittal" || pane === "coronal") ? (
                    <p className="max-w-[80%] text-center text-xs leading-relaxed text-gray-500">
                      3D reconstruction isn&apos;t available for this series -- it looks like a scout/localizer
                      series, not consecutive axial slices. View it slice by slice on the Axial pane instead.
                    </p>
                  ) : (
                  <div
                    style={{
                      position: "relative",
                      width: displayWidth,
                      height: displayHeight,
                      transform: `translate(${z.panX}px, ${z.panY}px) scale(${z.scale})`,
                      transformOrigin: "center center",
                    }}
                  >
                    <canvas ref={imageCanvasRefs[pane]} style={{ width: displayWidth, height: displayHeight, display: "block", filter: windowFilterFor(pane) }} data-testid={`pane-${pane}-image`} />
                    <canvas
                      ref={overlayRefs[pane]}
                      style={{
                        width: displayWidth,
                        height: displayHeight,
                        position: "absolute",
                        top: 0,
                        left: 0,
                        // The overlay's native resolution (columns x rows,
                        // one pixel per voxel) is stretched up to
                        // displayWidth/Height -- without this, the
                        // browser's default smooth scaling blends
                        // neighboring voxels' colors together at the
                        // boundary, which reads as a blurry/anti-aliased
                        // edge. A segmentation mask has no partial
                        // membership, so every voxel should render as a
                        // hard-edged block of its exact color or nothing.
                        imageRendering: "pixelated",
                        touchAction: "none",
                        pointerEvents: tab === "annotate" ? "auto" : "none",
                        cursor:
                          tab === "annotate" && tool !== "fill" && tool !== "polygon" && tool !== "auto" && tool !== "histogram"
                            ? "none"
                            : undefined,
                      }}
                      onPointerDown={(e) => handlePanePointerDown(e, pane)}
                      onPointerMove={(e) => handlePanePointerMove(e, pane)}
                      onPointerUp={(e) => handlePanePointerUp(e)}
                      onPointerCancel={(e) => handlePanePointerUp(e)}
                      onPointerLeave={(e) => {
                        handlePanePointerUp(e);
                        hideBrushCursor(pane);
                      }}
                      onContextMenu={(e) => e.preventDefault()}
                    />
                    <div
                      ref={brushCursorRefs[pane]}
                      style={{ display: "none", position: "absolute", borderRadius: "9999px", border: "1.5px solid #60a5fa", pointerEvents: "none" }}
                    />
                    {renderCrosshair(pane, displayWidth, displayHeight, z.scale)}
                    {renderPolygonOverlay(pane)}
                    {renderAutoBoxOverlay(pane)}
                    {renderRoiBoxOutline(pane)}
                  </div>
                  )}
                </div>
                {/* The slice control stands along the image's right edge,
                    first slice at the top (the same top-to-bottom order the
                    other panes' crosshair lines move in). */}
                <div className="flex flex-shrink-0 flex-col border-l border-[#333] bg-[#15152a]" style={{ width: sliceStripPx }}>
                  <SliceControl
                    index={cfg.index}
                    max={cfg.max}
                    onChange={cfg.setIndex}
                    label={PANE_LABELS[pane]}
                    accentClass="accent-blue-500"
                    orientation="vertical"
                    counter={<SliceNumber index={cfg.index} />}
                  />
                </div>
                </div>
              </div>
            );
          })}

          {visiblePaneKeys.includes("three_d") && (
            // On its own (siblings hidden, or maximized) the 3D view
            // takes the whole row instead of sitting in a paneSize
            // square with black bars either side: unlike the MPR panes
            // it renders a free camera, not a square image, so there's
            // nothing to keep square. Alongside other panes it stays
            // paneSize so the row still lines up.
            <div
              className={`flex flex-col bg-black ${only3d ? "min-w-0 flex-1 self-stretch" : "flex-shrink-0"}`}
              style={only3d ? undefined : { width: paneSize }}
            >
              <div className="flex flex-shrink-0 items-center justify-center gap-1.5 bg-[#111] py-1">
                <span className="text-center text-[11px] uppercase tracking-wider text-gray-400">3D</span>
                <button
                  onClick={() => toggleMaximized("three_d")}
                  className="text-gray-500 hover:text-white"
                  title={maximizedPane === "three_d" ? "Restore" : "Maximize"}
                >
                  {maximizedPane === "three_d" ? <FullscreenExitIcon /> : <FullscreenIcon />}
                </button>
                <button onClick={() => togglePaneVisible("three_d")} className="text-gray-500 hover:text-white" title="Hide this pane">
                  <EyeIcon visible={true} />
                </button>
              </div>
              <div className="relative min-h-0 flex-1 overflow-hidden bg-black" style={only3d ? undefined : { height: paneSize }}>
                <Viewer3D
                  maskVolume={maskVolumeRef.current}
                  rows={rows}
                  columns={columns}
                  numSlices={numSlices}
                  labels={labels}
                  objects={objects}
                  refreshKey={0}
                  seriesId={seriesId}
                />
              </div>
            </div>
          )}
        </div>

        {(!compact || panelOpen) && (
        <aside
          data-testid="side-panel"
          className={`flex w-72 flex-shrink-0 flex-col gap-4 overflow-y-auto border-l border-[#333] bg-[#1e1e2e] p-3 text-sm ${
            compact ? "absolute inset-y-0 right-0 z-30 max-w-[85vw] shadow-2xl" : ""
          }`}
        >
          {compact && (
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className="flex items-center justify-between rounded border border-[#444] px-2.5 py-1.5 text-xs text-gray-300 hover:bg-[#2a2a3e]"
            >
              <span>Side panel</span>
              <span aria-hidden="true">✕</span>
            </button>
          )}
          {reviewMode && (
            <Section title="Review" guide="review-card" help="The current object and its decision. Accept or Reject each object; a comment explains a rejection to the annotator.">
              {renderReviewCard()}
            </Section>
          )}
          {reviewMode ? (
            <ReviewObjectsList
              labels={labels}
              orderedObjects={reviewOrderedObjects}
              currentObjectId={currentReviewObject?.id ?? null}
              onSelect={(id) => setReviewIndex(reviewOrderedObjects.findIndex((o) => o.id === id))}
            />
          ) : (
            <ObjectsPanel
              labels={labels}
              objects={objects}
              activeObjectId={activeObjectId}
              onAddLabel={addLabel}
              onRecolorLabel={recolorLabel}
              onDeleteLabel={deleteLabel}
              onCreateObject={createObject}
              onSelectObject={setActiveObjectId}
              onJumpToObject={jumpToObject}
              onToggleLock={toggleObjectLock}
              onToggleHidden={toggleObjectHidden}
              onDeleteObject={deleteObject}
              onSetComment={setObjectComment}
              onSetAttributes={setObjectAttributes}
              fieldsOf={fieldsOfLabel}
              openRequest={formRequest}
            />
          )}

          <Section title="Appearance" guide="appearance" help="How strongly the coloured annotation overlay is drawn over the scan, and the crosshair showing where the other planes cut. Display only -- nothing about the annotation changes.">
            <SliderRow label="Overlay opacity" help="0% hides the annotation, 100% covers the scan completely." value={overlayOpacity} min={0} max={100} onChange={setOverlayOpacity} suffix="%" />
            <label className="mt-2 flex items-center gap-2 text-[11px] text-gray-300" title="Coloured lines where the other two planes cut each pane, left open in the middle so they never cover the point you are looking at. Shortcut: C">
              <input type="checkbox" checked={showCrosshair} onChange={(e) => setShowCrosshair(e.target.checked)} data-testid="crosshair-toggle" />
              Crosshair <span className="text-gray-500">(C)</span>
            </label>
          </Section>

          <Section title="Window / level" guide="window" help="The greyscale mapping of Hounsfield units: pick the preset for the tissue you're looking at, fine-tune with the sliders, or drag on the image with the right mouse button (Cursor tool) or the middle button (any tool): up/down moves the level, left/right the width. Display only.">
            <div className="mb-3 flex flex-wrap gap-1.5">
              {WINDOW_PRESETS.map((preset) => (
                <Tip key={preset.label} title={`${preset.label} window`} description={`${PRESET_HELP[preset.label] ?? ""} Center ${preset.center}, width ${preset.width}.`} side="left">
                  <button
                    onClick={() => {
                      trackAction(`window.${preset.label.toLowerCase().replace(/\s+/g, "-")}`);
                      setWindowCenter(preset.center);
                      setWindowWidth(preset.width);
                    }}
                    className={`rounded border px-2 py-1 text-[11px] transition-colors ${
                      windowCenter === preset.center && windowWidth === preset.width
                        ? "border-blue-500 bg-blue-500/20 text-blue-300"
                        : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"
                    }`}
                  >
                    {preset.label}
                  </button>
                </Tip>
              ))}
            </div>
            <SliderRow label="Center" help="The HU value shown as mid-grey (window level)." value={windowCenter} min={-1000} max={1000} onChange={setWindowCenter} />
            <SliderRow label="Width" help="The HU range from black to white (window width): narrow = more contrast." value={windowWidth} min={1} max={4000} onChange={setWindowWidth} />
          </Section>

          <Section title="Slab" guide="slab" help="Makes each pane a thick slice: several neighbouring slices averaged, or their brightest (MIP) or darkest (MinIP) voxel. Display only -- drawing still lands on the centre slice.">
            <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label="Slab thickness">
              {SLAB_THICKNESSES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    trackAction(`slab.${t}`);
                    setSlab((prev) => ({ ...prev, thickness: t }));
                  }}
                  disabled={t > 1 && volumeUnavailable !== null}
                  className={`rounded border px-2 py-1 font-mono text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    slab.thickness === t ? "border-blue-500 bg-blue-500/20 text-blue-300" : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"
                  }`}
                  aria-pressed={slab.thickness === t}
                  data-testid={`slab-thickness-${t}`}
                  title={t === 1 ? "A single slice" : `${t} slices`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="flex gap-1" role="group" aria-label="Slab projection">
              {(Object.keys(SLAB_LABEL) as SlabMode[]).map((m) => (
                <Tip key={m} title={SLAB_LABEL[m]} description={SLAB_HELP[m]} side="left">
                  <button
                    type="button"
                    onClick={() => {
                      trackAction(`slab.${m}`);
                      setSlab((prev) => ({ mode: m, thickness: prev.thickness > 1 ? prev.thickness : 5 }));
                    }}
                    disabled={volumeUnavailable !== null}
                    className={`flex-1 rounded border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      slab.thickness > 1 && slab.mode === m ? "border-blue-500 bg-blue-500/20 text-blue-300" : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"
                    }`}
                    aria-pressed={slab.thickness > 1 && slab.mode === m}
                    data-testid={`slab-mode-${m}`}
                  >
                    {SLAB_LABEL[m]}
                  </button>
                </Tip>
              ))}
            </div>
          </Section>

          <Section title="Sharpness" guide="sharpness" help="Enhances edges in the displayed image to make boundaries easier to follow. Display only.">
            <SliderRow label="Edge enhancement" help="0 is the original image; higher values sharpen boundaries." value={sharpness} min={0} max={5} step={0.1} onChange={setSharpness} />
          </Section>

          <Tip title="Reset to original" description="Back to the scan's own window/level and an unsharpened image." side="left">
            <span className="mb-3 flex">
              <button
                type="button"
                onClick={() => {
                  setWindowCenter(originalWindowCenter);
                  setWindowWidth(originalWindowWidth);
                  setSharpness(0);
                  setSlab({ thickness: 1, mode: "avg" });
                }}
                disabled={isOriginalImageAdjustment && slab.thickness === 1}
                className="rounded border border-[#444] px-2 py-1 text-[11px] text-gray-300 hover:bg-[#2a2a3e] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Reset to original
              </button>
            </span>
          </Tip>

          {!reviewMode && (
            <Section title="Draw" guide="draw" help="Settings for the Paint and Eraser tools, and a quick way to wipe one slice of the active object.">
              {tool !== "fill" && <SliderRow label="Brush size" help="Radius of the Paint and Eraser brush, in screen pixels." value={brushRadius} min={1} max={30} onChange={setBrushRadius} suffix="px" />}
              {eraseAllowed && (
              <Tip title="Clear hovered slice" description="Wipes the active object's paint on the slice under the mouse only. Undo brings it back." side="left">
                <span className="mt-1 flex">
                  <button
                    onClick={() => clearCurrentSlice(hoveredPaneRef.current)}
                    disabled={!maskReady || activeObjectId === null}
                    className="rounded border border-[#444] bg-[#2a2a3e] px-3 py-1.5 text-[11px] text-gray-300 transition-colors hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Clear hovered slice
                  </button>
                </span>
              </Tip>
              )}
            </Section>
          )}

          <Section title="Saved versions" help="Every annotation saved on this series, with its status: draft, submitted (awaiting review), approved or rejected.">
            <div className="mb-2 flex gap-1.5">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="flex-1 rounded border border-[#444] bg-[#2a2a3e] px-1.5 py-1 text-[11px] text-gray-300"
              >
                <option value="all">All statuses</option>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="flex-1 rounded border border-[#444] bg-[#2a2a3e] px-1.5 py-1 text-[11px] text-gray-300"
              >
                <option value="all">All types</option>
                {annotationTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            {filteredAnnotations.length === 0 ? (
              <p className="text-[11px] text-gray-500">
                {annotations.length === 0 ? "None yet." : "No annotations match the filters."}
              </p>
            ) : (
              <ul data-testid="saved-versions-scroll" className="flex max-h-40 flex-col gap-1 overflow-y-auto overscroll-contain">
                {filteredAnnotations.map((a) => (
                  <li key={a.id} className="flex items-center justify-between text-[11px] text-gray-400">
                    <span>
                      {a.type_name ?? "unknown type"} · {a.id.slice(0, 8)}…
                    </span>
                    <span className="rounded bg-[#2a2a3e] px-1.5 py-0.5 text-[10px] text-gray-300">{a.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </aside>
        )}
      </div>

      <div data-guide="footer" className="flex flex-shrink-0 items-center justify-between gap-3 bg-black/60 px-3 py-1 text-[11px] text-gray-500">
        <span className="truncate">
          {coarse
            ? tab === "view"
              ? "View · Pinch=Zoom · Two-finger drag=Pan · Arrows/slider=Slice · Long-press=HU value · Double-tap=Reset · Two-finger tap=Jump all planes"
              : `${TOOL_TOUCH_HINT[tool]} · Pinch=Zoom · Two-finger drag=Pan · Long-press=HU value · Two-finger tap=Jump all planes`
            : tab === "view"
            ? "View · Scroll=Slice · Ctrl/Cmd+Scroll=Zoom · Right/middle-drag=Window · Drag=Pan (zoomed) · Ctrl/Cmd+click=Jump all planes · Alt+click=HU value · Double-click=Reset"
            : tool === "fill"
              ? "Fill · Click inside a closed outline on any pane · Right-click (no drag)=Comment · Scroll=Slice · Middle-drag=Window · Ctrl/Cmd+click=Jump all planes"
              : tool === "polygon"
                ? "Polygon · Click to place points · Click the first (yellow) point to close · Esc=Cancel · Right-click (no drag)=Comment · Scroll=Slice · Middle-drag=Window · Ctrl/Cmd+click=Jump all planes"
                : tool === "auto"
                  ? "Auto · Drag a box around a structure · Adjust the HU range · Enter=Apply · Esc=Cancel · Right-click (no drag)=Comment · Scroll=Slice · Middle-drag=Window · Ctrl/Cmd+click=Jump all planes"
                  : tool === "histogram"
                    ? "Histogram · Drag a box to see its HU distribution · Esc=Close · Right-click (no drag)=Comment · Scroll=Slice · Middle-drag=Window · Ctrl/Cmd+click=Jump all planes"
                    : `${tool === "erase" ? "Eraser" : "Paint"} · Drag=Draw${eraseAllowed ? " · Right-click drag=Erase" : ""} · Right-click (no drag)=Comment · Scroll=Slice · Middle-drag=Window · Ctrl/Cmd+click=Jump all planes`}
        </span>
        <span className="flex-shrink-0 whitespace-nowrap">{activeObjectName ? `Active: ${activeObjectName}` : tab === "annotate" ? "No object selected" : ""}</span>
      </div>

      <GuideTour steps={reviewMode ? REVIEW_STEPS : ANNOTATE_STEPS} open={guide.open} onClose={guide.close} />
      {renderHuTooltip()}
      {renderAutoContourPanel()}
      {renderHistogramPanel()}
      {renderAutoSegmentedHistogramPopup()}

      {openDoc && <DocumentPanel doc={openDoc} onClose={() => setOpenDoc(null)} compact={compact} coarse={coarse} />}
    </div>
  );
}

/** A failed save, in words: a 409 means someone saved a newer version of
 * this series after it was opened here (see loadedVersionRef). */
function saveErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409 && /newer version/i.test(err.body)) {
    return "Someone else saved a newer version of this series while you were working. Your changes were not saved -- reload to see their version before drawing again.";
  }
  if (err instanceof ApiError) {
    // the service's own reason, in words -- not "API error 403: {...}" (F-11)
    let detail = err.body;
    try {
      const parsed = JSON.parse(err.body);
      if (typeof parsed?.detail === "string") detail = parsed.detail;
    } catch {
      // plain text already
    }
    if (err.status === 403 && /insufficient study role/i.test(detail)) return "You don't have the role this needs in this study -- only its reviewers can review, only its annotators can annotate.";
    return detail || errorText(err);
  }
  return errorText(err);
}

// ── Objects sidebar (CVAT-style) ───────────────────────────────────────

// ── Review mode's sidebar: a read-only version of the Objects list --
// no add/lock/hide/delete/comment-edit affordances (a reviewer doesn't
// edit the annotator's work here, only accepts/rejects it via the
// floating review card), just click-to-jump plus each object's review
// status as a small colored dot. ──────────────────────────────────────

const REVIEW_STATUS_DOT: Record<string, string> = {
  pending: "bg-gray-500",
  accepted: "bg-emerald-500",
  rejected: "bg-red-500",
};

function ReviewObjectsList({
  labels,
  orderedObjects,
  currentObjectId,
  onSelect,
}: {
  labels: SegLabel[];
  orderedObjects: SegObject[];
  currentObjectId: number | null;
  onSelect: (id: number) => void;
}) {
  const labelsById = new Map(labels.map((l) => [l.id, l]));

  return (
    <Section title="Objects" guide="review-objects" help="Every object of this annotation. Grey dot = not decided, green = accepted, red = rejected. Click one to jump to it.">
      {orderedObjects.length === 0 && <p className="text-[11px] text-gray-500">No objects to review yet.</p>}
      {/* Fixed height: many nodules scroll here instead of pushing the
          rest of the sidebar down, so the screen keeps one layout. */}
      <ul data-testid="review-objects-scroll" className={`flex flex-col overflow-y-auto overscroll-contain ${LIST_MAX_H}`}>
        {orderedObjects.map((obj) => {
          const label = labelsById.get(obj.label_id);
          return (
            <li
              key={obj.id}
              onClick={() => onSelect(obj.id)}
              className={`flex cursor-pointer select-none items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors ${
                obj.id === currentObjectId ? "bg-blue-500/20 text-blue-200" : "text-gray-400 hover:bg-[#2a2a3e]"
              }`}
            >
              <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: label?.color ?? "#666" }} />
              <span className="flex-1 truncate" title={previousReviewText(obj) ? `Last round: ${previousReviewText(obj)}` : undefined}>
                {label?.name ?? "?"} {obj.instance_number}
              </span>
              {isNewThisRound(obj, orderedObjects) && (
                <span className="rounded bg-sky-900/60 px-1 text-[9px] uppercase text-sky-200" data-testid={`new-object-${obj.id}`}>
                  new
                </span>
              )}
              <span
                className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${REVIEW_STATUS_DOT[obj.review_status ?? "pending"]}`}
                title={obj.review_status ?? "pending"}
              />
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function ObjectsPanel({
  labels,
  objects,
  activeObjectId,
  onAddLabel,
  onRecolorLabel,
  onDeleteLabel,
  onCreateObject,
  onSelectObject,
  onJumpToObject,
  onToggleLock,
  onToggleHidden,
  onDeleteObject,
  onSetComment,
  onSetAttributes,
  fieldsOf,
  openRequest,
}: {
  labels: SegLabel[];
  objects: SegObject[];
  activeObjectId: number | null;
  onAddLabel: (name: string) => void;
  onRecolorLabel: (id: number, color: string) => void;
  onDeleteLabel: (id: number) => void;
  onCreateObject: (labelId: number) => void;
  onSelectObject: (id: number) => void;
  onJumpToObject: (id: number) => void;
  onToggleLock: (id: number) => void;
  onToggleHidden: (id: number) => void;
  onDeleteObject: (id: number) => void;
  onSetComment: (id: number, comment: string) => void;
  onSetAttributes: (id: number, attributes: ObjectAnswers) => void;
  /** The label's per-object form definition (empty = comment only). */
  fieldsOf: (label: SegLabel) => ObjectField[];
  /** Open (and scroll to) this object's form tab -- a right-click on the
   * pane; the nonce distinguishes repeat requests for the same object. */
  openRequest: { objectId: number; nonce: number } | null;
}) {
  const [newLabelName, setNewLabelName] = useState("");
  // Which objects have their form + comment tab open. Every instance
  // carries the tab (not a popup) so the form reads as part of the row.
  const [openForms, setOpenForms] = useState<Set<number>>(() => new Set());
  function toggleForm(id: number) {
    setOpenForms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  useEffect(() => {
    if (!openRequest) return;
    setOpenForms((prev) => new Set(prev).add(openRequest.objectId));
    // After the row expands: bring it into view.
    const timer = setTimeout(() => {
      document.querySelector(`[data-testid="object-${openRequest.objectId}"]`)?.scrollIntoView({ block: "nearest" });
    }, 50);
    return () => clearTimeout(timer);
  }, [openRequest]);

  return (
    <Section title="Objects" guide="objects" help="A label is a kind of structure; an object is one instance of it. Click an object to draw into it; + adds an instance; eye hides, lock protects, bin deletes.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onAddLabel(newLabelName);
          setNewLabelName("");
        }}
        className="mb-2 flex gap-1.5"
      >
        <input
          value={newLabelName}
          onChange={(e) => setNewLabelName(e.target.value)}
          placeholder="New label…"
          className="flex-1 rounded border border-[#444] bg-[#2a2a3e] px-2 py-1 text-[11px] text-gray-200 placeholder:text-gray-500"
        />
        <Tip title="Add label" description="Creates a new kind of structure with the name typed on the left, in the next free colour." side="left">
          <button type="submit" className="rounded border border-[#444] bg-[#2a2a3e] px-2 text-gray-300 hover:bg-[#333]">
            <PlusIcon />
          </button>
        </Tip>
      </form>

      {labels.length === 0 && <p className="text-[11px] text-gray-500">No labels yet -- add one above.</p>}

      <div data-testid="objects-scroll" className={`flex flex-col gap-2 overflow-y-auto overscroll-contain ${LIST_MAX_H}`}>
        {labels.map((label) => {
          const labelObjects = objects.filter((o) => o.label_id === label.id);
          return (
            <div key={label.id} data-testid={`label-${label.id}`} className="rounded border border-[#333]">
              <div className="flex items-center gap-1.5 bg-[#252538] px-2 py-1.5">
                <input
                  type="color"
                  value={label.color}
                  onChange={(e) => onRecolorLabel(label.id, e.target.value)}
                  className="h-4 w-4 flex-shrink-0 cursor-pointer rounded border-none bg-transparent p-0"
                  title="Change color"
                />
                <span className="flex-1 truncate text-[11px] font-medium text-gray-200">{label.name}</span>
                <Tip title={`New ${label.name} instance`} description="Adds another object of this label and selects it for drawing." side="left">
                  <button data-testid={`add-object-${label.id}`} onClick={() => onCreateObject(label.id)} className="text-gray-400 hover:text-white">
                    <PlusIcon />
                  </button>
                </Tip>
                <Tip title="Delete label" description="Removes this label and every object drawn under it." side="left">
                  <button onClick={() => onDeleteLabel(label.id)} className="text-gray-400 hover:text-red-400">
                    <TrashIcon />
                  </button>
                </Tip>
              </div>
              {labelObjects.length > 0 && (
                <ul className="flex flex-col">
                  {labelObjects.map((obj) => {
                    const formOpen = openForms.has(obj.id);
                    const filled = Boolean((obj.comment && obj.comment.trim()) || formatAnswers(obj.attributes));
                    return (
                    <li key={obj.id} className="flex flex-col">
                    <div
                      data-testid={`object-${obj.id}`}
                      onClick={() => onSelectObject(obj.id)}
                      onMouseDown={(e) => {
                        // Suppress the browser's default double-click
                        // text-selection so it doesn't visibly compete
                        // with (or get mistaken for) the pane-jump below.
                        if (e.detail > 1) e.preventDefault();
                      }}
                      onDoubleClick={() => {
                        onSelectObject(obj.id);
                        onJumpToObject(obj.id);
                      }}
                      title="Click to select · double-click to jump all panes here"
                      className={`flex cursor-pointer select-none items-center gap-1.5 px-2 py-1 text-[11px] transition-colors ${
                        obj.id === activeObjectId ? "bg-blue-500/20 text-blue-200" : "text-gray-400 hover:bg-[#2a2a3e]"
                      }`}
                    >
                      <span
                        className="h-2 w-2 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: label.color, opacity: obj.hidden ? 0.3 : 1 }}
                      />
                      <span className="flex-1 truncate">
                        {label.name} {obj.instance_number}
                      </span>
                      {obj.review_status === "rejected" && (
                        <span
                          className="rounded bg-red-900/60 px-1 text-[9px] text-red-200"
                          title={obj.review_comment ? `Reviewer: ${obj.review_comment}` : "Rejected by the reviewer"}
                          data-testid={`rejected-${obj.id}`}
                        >
                          {rejectReasonLabel(obj.reject_reason)?.toLowerCase() ?? "rejected"}
                        </span>
                      )}
                      <ObjectFormTab open={formOpen} filled={filled} onToggle={() => toggleForm(obj.id)} testId={`form-toggle-${obj.id}`} />
                      <button
                        data-testid={`hide-${obj.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleHidden(obj.id);
                        }}
                        className="text-gray-500 hover:text-white"
                        title={obj.hidden ? "Show" : "Hide"}
                      >
                        <EyeIcon visible={!obj.hidden} />
                      </button>
                      <button
                        data-testid={`lock-${obj.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleLock(obj.id);
                        }}
                        className="text-gray-500 hover:text-white"
                        title={obj.locked ? "Unlock" : "Lock"}
                      >
                        <LockIcon locked={obj.locked} />
                      </button>
                      <button
                        data-testid={`delete-${obj.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteObject(obj.id);
                        }}
                        className="text-gray-500 hover:text-red-400"
                        title="Delete"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                    {formOpen && (
                      <div className="flex flex-col gap-1.5 border-t border-[#333] bg-[#1b1b2f] px-2 py-1.5" data-testid={`object-form-${obj.id}`}>
                        <ObjectFormEditor fields={fieldsOf(label)} answers={obj.attributes} onChange={(next) => onSetAttributes(obj.id, next)} />
                        <textarea
                          value={obj.comment ?? ""}
                          onChange={(e) => onSetComment(obj.id, e.target.value)}
                          placeholder="Comment…"
                          rows={2}
                          data-testid={`comment-${obj.id}`}
                          className="w-full resize-none rounded border border-[#444] bg-[#2a2a3e] p-1.5 text-[11px] text-gray-200 placeholder:text-gray-500"
                        />
                        {reviewedNote(obj)}
                      </div>
                    )}
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** Under an object's form: the reviewer's verdict on it, if any --
 * what came back with a rejected case. The answers themselves are the
 * shared form above (the reviewer edits the same fields). */
function reviewedNote(obj: SegObject) {
  const status = obj.review_status;
  if (!status || status === "pending") return null;
  const reason = status === "rejected" ? rejectReasonLabel(obj.reject_reason)?.toLowerCase() : undefined;
  return (
    <p className={`text-[10px] ${status === "accepted" ? "text-emerald-400" : "text-red-400"}`}>
      Reviewer: {status}
      {reason ? ` (${reason})` : ""}
      {obj.review_comment ? ` -- ${obj.review_comment}` : ""}
    </p>
  );
}

// ── Left icon toolbar (CVAT-style) ──────────────────────────────────────

/** What each tool does, in one or two sentences -- the hover description
 * on the toolbar and the wording the guided tour reuses. */
/** The footer's one-line reminder per tool on a touch screen -- the
 * mouse version (below the return in the JSX) talks about scroll wheels
 * and right-clicks a tablet doesn't have. */
const TOOL_TOUCH_HINT: Record<DrawTool, string> = {
  cursor: "View",
  paint: "Paint · Drag=Draw · Tap=Dot",
  erase: "Eraser · Drag=Erase",
  fill: "Fill · Tap inside a closed outline",
  polygon: "Polygon · Tap to place points · Tap the first (yellow) point to close",
  auto: "Auto · Drag a box · Adjust the HU range · Apply",
  histogram: "Histogram · Drag a box",
};

const TOOL_HELP: Record<DrawTool, string> = {
  cursor: "Navigate only: scroll to change slice, Ctrl+scroll to zoom, right- or middle-drag to window (up/down = level, left/right = width), drag to pan when zoomed, double-click to reset. Nothing is drawn.",
  paint: "Brush into the active object. Drag to paint; right-click and drag to erase; Brush size is in the Draw panel.",
  erase: "Remove paint from any object under the brush, regardless of which object is active.",
  fill: "Click inside a closed outline on the current slice to fill the whole enclosed area into the active object.",
  polygon: "Click to place points around a structure; click the first (yellow) point to close and fill it. Esc cancels.",
  auto: "Drag a box around a structure; the viewer segments it by intensity, starting from a HU range suggested from the box (calcification included). Adjust the range, then Enter to apply or Esc to cancel.",
  histogram: "Drag a box to see the distribution of Hounsfield values inside it. A measurement only -- it draws nothing.",
};

function IconToolbar({
  tool,
  onSelect,
  canDraw,
  allowedTools,
}: {
  tool: DrawTool;
  onSelect: (tool: DrawTool) => void;
  canDraw: boolean;
  // A Surface card's tool restriction for this job, or null if
  // unrestricted. "cursor" is pure navigation and is never gated, even
  // when set -- it's excluded from every job's allowed-tools list on
  // the admin-ui side too (see WorkflowPropertiesPanel's SURFACE_TOOL_OPTIONS).
  allowedTools: string[] | null;
}) {
  const allButtons: { tool: DrawTool; label: string; icon: ReactNode; requiresObject?: boolean }[] = [
    { tool: "cursor", label: "Cursor · Pan/zoom", icon: <CursorIcon /> },
    { tool: "paint", label: "Paint", icon: <BrushIcon />, requiresObject: true },
    { tool: "erase", label: "Eraser", icon: <EraserIcon /> },
    { tool: "fill", label: "Fill", icon: <BucketIcon />, requiresObject: true },
    { tool: "polygon", label: "Polygon · Click points, close the loop", icon: <PolygonIcon />, requiresObject: true },
    { tool: "auto", label: "Auto · Drag a box, HU threshold", icon: <AutoContourIcon />, requiresObject: true },
    { tool: "histogram", label: "Histogram · Drag a box, HU distribution", icon: <HistogramIcon /> },
  ];
  const buttons = allowedTools
    ? allButtons.filter((b) => b.tool === "cursor" || allowedTools.includes(b.tool))
    : allButtons;
  const coarse = useCoarsePointer();
  return (
    <div data-guide="toolbar" className={`flex flex-shrink-0 flex-col items-center gap-1 border-r border-[#333] bg-[#15152a] py-2 ${coarse ? "w-14" : "w-12"}`}>
      {buttons.map((b) => {
        const disabled = b.requiresObject && !canDraw;
        return (
          <Tip
            key={b.tool}
            title={b.label.split(" · ")[0]}
            description={disabled ? `${TOOL_HELP[b.tool]} Select an object first to use it.` : TOOL_HELP[b.tool]}
            side="right"
          >
            <span className="flex" data-guide={`tool-${b.tool}`}>
              <button
                data-testid={`tool-${b.tool}`}
                onClick={() => onSelect(b.tool)}
                disabled={disabled}
                className={`flex items-center justify-center rounded transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${coarse ? "h-11 w-11" : "h-9 w-9"} ${
                  tool === b.tool ? "bg-blue-500/25 text-blue-300" : "text-gray-400 hover:bg-[#2a2a3e] hover:text-gray-200"
                }`}
              >
                {b.icon}
              </button>
            </span>
          </Tip>
        );
      })}
    </div>
  );
}

function IconButton({
  onClick,
  disabled,
  title,
  description,
  shortcut,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  description?: string;
  shortcut?: string;
  children: ReactNode;
}) {
  return (
    <Tip title={title} description={description} shortcut={shortcut}>
      <span className="flex">
        <button
          onClick={onClick}
          disabled={disabled}
          aria-label={title}
          className="flex h-7 w-7 items-center justify-center rounded border border-[#444] bg-[#2a2a3e] text-gray-300 transition-colors hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {children}
        </button>
      </span>
    </Tip>
  );
}

/** A titled block of the side panel. `help` adds a small "?" after the
 * title whose hover explains the whole section; `guide` names it as a
 * stop of the guided tour. */
/** Height of the sidebar's growing lists (objects, review objects): a
 * fixed box that scrolls, so a case with many nodules has the same
 * sidebar layout as a case with one. */
const LIST_MAX_H = "max-h-72";

function Section({ title, help, guide, children }: { title: string; help?: string; guide?: string; children: ReactNode }) {
  return (
    <div className="border-b border-[#333] pb-3" data-guide={guide}>
      <div className="mb-2 flex items-center gap-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{title}</p>
        {help && (
          <Tip title={title} description={help} side="left" tapToggle>
            <span className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-[#444] text-[9px] leading-none text-gray-500 hover:border-gray-400 hover:text-gray-300">
              ?
            </span>
          </Tip>
        )}
      </div>
      {children}
    </div>
  );
}

function SliderRow({
  label,
  help,
  value,
  min,
  max,
  step,
  onChange,
  suffix,
}: {
  label: string;
  help?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
  suffix?: string;
}) {
  return (
    <div className="mb-2">
      <div className="mb-1 flex justify-between text-[11px] text-gray-400">
        {help ? (
          <Tip title={label} description={help} side="left" tapToggle>
            <span className="cursor-help border-b border-dotted border-gray-600">{label}</span>
          </Tip>
        ) : (
          <span>{label}</span>
        )}
        <span>
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-500"
      />
    </div>
  );
}

// ── Small inline SVG icons (no external icon library) ───────────────────

function CursorIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 3l14 8-6 1.5L11 19z" strokeLinejoin="round" />
    </svg>
  );
}

function BrushIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 20c0-3 2-4 4-4s3 1 3 3-1 3-3 3-4-1-4-2z" strokeLinejoin="round" />
      <path d="M9 15 18 6a2 2 0 0 1 3 3l-9 9" strokeLinejoin="round" />
    </svg>
  );
}

function EraserIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M17 3 21 7 9 19H5v-4z" strokeLinejoin="round" />
      <path d="M13 7 17 11" />
    </svg>
  );
}

function BucketIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 11 12 4l9 7-9 7z" strokeLinejoin="round" />
      <path d="M7 12l6 6" />
      <path d="M19 16c0 2-1.5 3-1.5 3s-1.5-1-1.5-3 1.5-3 1.5-3 1.5 1 1.5 3z" />
    </svg>
  );
}

function PolygonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3 20 9l-3 10H7L4 9z" strokeLinejoin="round" />
      <circle cx="12" cy="3" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="20" cy="9" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="17" cy="19" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="7" cy="19" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="4" cy="9" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function AutoContourIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" strokeDasharray="3 2.5" />
      <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" strokeLinejoin="round" />
    </svg>
  );
}

function HistogramIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" strokeDasharray="3 2.5" />
      <path d="M7 16v-3M10.5 16V9M14 16v-5M17.5 16v-2" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M12 4v16M4 12h16" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


function EyeIcon({ visible }: { visible: boolean }) {
  if (!visible) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 3l18 18" strokeLinecap="round" />
        <path d="M10.6 5.2A10.7 10.7 0 0 1 12 5c6 0 10 7 10 7a15 15 0 0 1-3.2 3.7M6.6 6.6A15 15 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 3.4-.6" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      {locked ? <path d="M8 11V8a4 4 0 0 1 8 0v3" /> : <path d="M8 11V8a4 4 0 0 1 7-2.6" />}
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 7 3 11l4 4" strokeLinejoin="round" />
      <path d="M3 11h11a6 6 0 0 1 0 12h-2" strokeLinecap="round" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M17 7 21 11l-4 4" strokeLinejoin="round" />
      <path d="M21 11H10a6 6 0 0 0 0 12h2" strokeLinecap="round" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.5-2.5 2-2.5 3.5" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FullscreenExitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 4v4a1 1 0 0 1-1 1H4M15 4v4a1 1 0 0 0 1 1h4M4 15h4a1 1 0 0 1 1 1v4M20 15h-4a1 1 0 0 0-1 1v4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
