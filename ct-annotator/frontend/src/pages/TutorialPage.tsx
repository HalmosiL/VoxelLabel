import { type CSSProperties, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import DocumentPanel, { DocumentSource } from "../components/DocumentPanel";
import { ObjectAnswers, ObjectField, ObjectFormEditor, ObjectFormTab, formatAnswers } from "../components/ObjectForm";
import SliceControl from "../components/SliceControl";
import SliceNumber from "../components/SliceNumber";
import Viewer3D from "../components/Viewer3D";
import Tip from "../components/Tip";
import KeyboardHelp from "../components/KeyboardHelp";
import { isHelpKey } from "../lib/keymap";
import { enterFullscreen, exitFullscreen, fullscreenDeclined, fullscreenElement, onFullscreenChange, rememberFullscreenDeclined } from "../lib/fullscreen";
import { TAP_ACTION_DELAY_MS, TapDetector, TapGesture, TouchTracker, useCoarsePointer, useCompactLayout } from "../lib/touch";
import { ADMIN_UI_URL } from "../config";
import GuideTour from "../guide/GuideTour";
import { ANNOTATE_STEPS, REVIEW_STEPS, tutorialSteps } from "../guide/viewerSteps";
import {
  axialMaskView,
  axialView,
  coronalMaskView,
  coronalView,
  floodFillMask,
  loadTutorialVolume,
  type PaneKey,
  paneDims,
  regionHistogram,
  renderPlane,
  sagittalMaskView,
  sagittalView,
  slabView,
  TARGET_SLICE,
  TARGET_X,
  TARGET_Y,
  TUTORIAL_SIZE,
  TUTORIAL_SLICES,
  writeCoronalMaskView,
  writeSagittalMaskView,
} from "../lib/tutorialSlice";
import { scanlineFill } from "../lib/scanlineFill";
import { growRegion, HU_MAX, HU_MIN, suggestRange } from "../lib/autoContour";
import type { SlabMode } from "../api/annotatorApi";

type DrawTool = "cursor" | "paint" | "erase" | "fill" | "polygon" | "auto" | "histogram";
type Phase = "annotate" | "review" | "done";

interface TutLabel {
  id: number;
  name: string;
  color: string;
  fields?: ObjectField[];
}
interface TutObject {
  id: number;
  labelId: number;
  instanceNumber: number;
  hidden: boolean;
  locked: boolean;
  comment: string;
  reviewStatus: "pending" | "accepted" | "rejected";
  attributes?: ObjectAnswers;
}

const PALETTE = ["#f87171", "#60a5fa", "#34d399", "#fbbf24", "#c084fc"];
const PANE_ORDER: PaneKey[] = ["sagittal", "coronal", "axial"];
const PANE_LABELS: Record<PaneKey, string> = { sagittal: "Sagittal", coronal: "Coronal", axial: "Axial" };
/** The MPR panes plus the 3D view -- what can be shown, hidden or
 * maximized, same set as the real viewer's. */
type VisiblePaneKey = PaneKey | "three_d";
const ALL_PANE_KEYS: VisiblePaneKey[] = [...PANE_ORDER, "three_d"];
const ASSET_BASE = `${import.meta.env.BASE_URL}tutorial-data`;
/** The practice case's one document -- a synthetic chest CT report,
 * bundled with the app, so the Documents button and the in-page preview
 * work here exactly as they do on a real case (where the list comes
 * from the case's clinical data items). */
const PRACTICE_DOCUMENTS: { id: string; title: string; type: string; date: string; source: DocumentSource }[] = [
  {
    id: "practice-report",
    title: "Chest CT report (practice case)",
    type: "radiology report",
    date: "2026-01-15",
    source: {
      title: "Chest CT report (practice case)",
      load: async () => {
        const response = await fetch(`${ASSET_BASE}/practice-report.pdf`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { bytes: await response.arrayBuffer(), contentType: "application/pdf" };
      },
    },
  },
];
/** The practice label's per-object form -- what a study's Annotation
 * Surface card attaches to a label for a real job (components/ObjectForm.tsx). */
const PRACTICE_FIELDS: ObjectField[] = [
  { name: "Type", kind: "choice", options: ["solid", "sub-solid", "ground-glass"] },
  { name: "Calcified", kind: "check" },
  { name: "Confidence", kind: "scale", min: 1, max: 5 },
];
const PRACTICE_LABEL: TutLabel = { id: 1, name: "Structure", color: PALETTE[0], fields: PRACTICE_FIELDS };
/** What a save in the practice case records -- the same statuses the
 * real viewer's "Saved versions" list shows, minus the server. */
interface PracticeVersion {
  n: number;
  status: "draft" | "submitted";
  at: string;
}
const IDLE_ZOOM = { scale: 1, panX: 0, panY: 0 };
const DEFAULT_PANE_SIZE = 420; // fallback before the ResizeObserver below measures the real available space
const PRESET_HELP: Record<string, string> = {
  "Soft tissue": "General-purpose view of organs and soft tissue.",
  Lung: "Wide window for lung parenchyma and vessels.",
  Bone: "Wide, bright window for cortical and trabecular bone.",
  Brain: "Narrow window for subtle grey/white-matter contrast.",
};
const WINDOW_PRESETS: { label: string; center: number; width: number }[] = [
  { label: "Soft tissue", center: 40, width: 400 },
  { label: "Lung", center: -600, width: 1500 },
  { label: "Bone", center: 300, width: 1500 },
  { label: "Brain", center: 40, width: 80 },
];
const DEFAULT_CENTER = 40;
const DEFAULT_WIDTH = 400;
// The same crosshair, slice strip, mouse window/level and slab settings
// as the real viewer (see ViewerPage.tsx's constants of the same names).
const PLANE_COLORS: Record<PaneKey, string> = { sagittal: "#f59e0b", coronal: "#22c55e", axial: "#38bdf8" };
const CROSSHAIR_GAP_PX = 16;
const SLICE_STRIP_PX = { mouse: 26, touch: 40 };
const WINDOW_DRAG_HU_PER_PX = 1 / 300;
const WINDOW_DRAG_THRESHOLD_PX = 4;
const SLAB_THICKNESSES = [1, 3, 5, 9, 15, 25];
const SLAB_LABEL: Record<SlabMode, string> = { avg: "Average", mip: "MIP", minip: "MinIP" };
const SLAB_HELP: Record<SlabMode, string> = {
  avg: "The mean of the slices: less noise, like a thicker reconstruction.",
  mip: "Maximum intensity projection: the brightest voxel through the slab -- vessels and nodules stand out against the lung.",
  minip: "Minimum intensity projection: the darkest voxel through the slab -- airways and air trapping.",
};

const TOOL_HELP: Record<DrawTool, string> = {
  cursor: "Navigate only: scroll to change slice, Ctrl+scroll to zoom, right-drag to window (up/down level, left/right width), drag to pan when zoomed. Nothing is drawn.",
  paint: "Brush into the active object. Drag to paint; right-drag to erase.",
  erase: "Remove paint from any object under the brush.",
  fill: "Click inside a closed outline to fill it into the active object -- paint or Polygon the boundary first.",
  polygon: "Click to place points; click the first (yellow) point again to close and fill.",
  auto: "Drag a box; the tool segments by brightness inside it, from a HU range suggested from the box (calcification included). Adjust the range, then Enter to apply or Esc to cancel.",
  histogram: "Drag a box to see the real brightness distribution inside it. Draws nothing.",
};

// The mask covers the WHOLE practice volume (one object-id byte per
// voxel, laid out exactly like the CT volume itself -- see
// axialMaskView's own comment), not just one slice -- so paint made on
// any pane, at any slice, stays there and shows up correctly from every
// other pane and slice too, the same as the real viewer.
function emptyMask(): Uint8Array {
  return new Uint8Array(TUTORIAL_SIZE * TUTORIAL_SIZE * TUTORIAL_SLICES);
}

/** The Annotate phase starts with one instance of the "Structure" label
 * already created and active -- ready to draw into immediately, rather
 * than making the very first thing a newcomer does be "find the + button
 * and click it" before they can try any tool at all. */
function defaultAnnotateObject(): TutObject {
  return { id: 1, labelId: 1, instanceNumber: 1, hidden: false, locked: false, comment: "", reviewStatus: "pending" };
}

// Operates on one pane's own flat 2D view of the mask (width x height --
// see paneDims: square for axial, TUTORIAL_SIZE x TUTORIAL_SLICES for a
// sagittal/coronal reconstruction), not the 3D volume directly.
// `isProtected(v)`: voxels of a locked or hidden object are left alone,
// by the brush and the eraser alike -- as in the real viewer (G-03).
function stampCircle(
  mask: Uint8Array, width: number, height: number, cx: number, cy: number, r: number, value: number,
  isProtected: (v: number) => boolean = () => false
) {
  for (let y = Math.max(0, cy - r); y <= Math.min(height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(width - 1, cx + r); x++) {
      const i = y * width + x;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && !isProtected(mask[i])) mask[i] = value;
    }
  }
}

/** A permanent, self-contained practice job built on the exact same
 * mechanics as the real annotation surface (see ViewerPage.tsx): three
 * MPR panes each with their own slice control, real pan/zoom on the
 * axial pane, the same header controls in the same order, the same
 * sidebar sections. It runs on a real chest CT already loaded on this
 * platform (lib/tutorialSlice.ts) but never touches the backend --
 * Save/Mark/Submit only ever change this page's own local state, so
 * nothing here is ever saved for real, seen by anyone else, or tied to
 * a real study/case. It exists so the guided tour has somewhere to
 * actually run: a brand-new account can open this and try every tool
 * before their first real case, without needing a job assigned yet. */
export default function TutorialPage() {
  const [searchParams] = useSearchParams();
  const startMode = searchParams.get("mode") === "review" ? "review" : "annotate";

  const [runId, setRunId] = useState(0); // bump to fully reset the page
  const [phase, setPhase] = useState<Phase>(startMode);
  const [guideOpen, setGuideOpen] = useState(false);
  // Tablet: see ViewerPage.tsx's same trio -- touch gestures + bigger
  // targets, and the side panel as a drawer below ~1100px.
  const coarse = useCoarsePointer();
  // "?": every key and gesture, as in the real viewer (lib/keymap.ts)
  const [keysOpen, setKeysOpen] = useState(false);
  const closeKeys = useMemo(() => () => setKeysOpen(false), []);
  const compact = useCompactLayout();
  const [panelOpen, setPanelOpen] = useState(false);
  // The tour needs the side panel open on a compact layout (its stops
  // live there) -- same as ViewerPage.tsx.
  const panelBeforeTourRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!compact) return;
    if (guideOpen) {
      if (panelBeforeTourRef.current === null) panelBeforeTourRef.current = panelOpen;
      setPanelOpen(true);
    } else if (panelBeforeTourRef.current !== null) {
      setPanelOpen(panelBeforeTourRef.current);
      panelBeforeTourRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideOpen, compact]);
  function startTour() {
    if (compact) {
      panelBeforeTourRef.current = panelOpen;
      setPanelOpen(true);
    }
    setGuideOpen(true);
  }
  const [volumeLoaded, setVolumeLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // the practice scan's download (bytes so far / total) and retries (G-14)
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [axialIndex, setAxialIndex] = useState(startMode === "review" ? TARGET_SLICE : 10);
  const [sagittalIndex, setSagittalIndex] = useState(Math.round(TARGET_X));
  const [coronalIndex, setCoronalIndex] = useState(Math.round(TARGET_Y));
  const [windowCenter, setWindowCenter] = useState(DEFAULT_CENTER);
  const [windowWidth, setWindowWidth] = useState(DEFAULT_WIDTH);
  const [sharpness, setSharpness] = useState(0);
  const [slab, setSlab] = useState<{ thickness: number; mode: SlabMode }>({ thickness: 1, mode: "avg" });
  // Shares the real viewer's remembered choice (same storage key).
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
  const windowDragRef = useRef<{ pointerId: number; x0: number; y0: number; c0: number; w0: number; moved: boolean } | null>(null);
  const [overlayOpacity, setOverlayOpacity] = useState(70);
  const [brushRadius, setBrushRadius] = useState(10);
  const [tool, setTool] = useState<DrawTool>("cursor");
  const [labels, setLabels] = useState<TutLabel[]>([PRACTICE_LABEL]);
  // Which objects have their form + comment tab open in the Objects list.
  const [openForms, setOpenForms] = useState<Set<number>>(() => new Set());
  function toggleForm(id: number) {
    setOpenForms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // Landing straight in Review seeds its own two objects (see the effect
  // below) -- starting Annotate with one already gets in that seeding's
  // way, so only the normal Annotate entry pre-creates it here.
  const [objects, setObjects] = useState<TutObject[]>(startMode === "review" ? [] : [defaultAnnotateObject()]);
  const [activeObjectId, setActiveObjectId] = useState<number | null>(startMode === "review" ? null : 1);
  const [newLabelName, setNewLabelName] = useState("");
  const [maskVersion, setMaskVersion] = useState(0);
  const [reviewIndex, setReviewIndex] = useState(0);
  // panelClientX/Y: where the Apply/Cancel chrome renders -- the
  // viewport position captured from the pointer event itself (tracks
  // live during the drag, then stays wherever the user released),
  // NOT a fixed corner of the pane. Matches the real viewer's own
  // renderAutoContourPanel/renderHistogramPanel (autoBox.panelClientX/Y
  // via clampPopupPosition) -- an earlier version of this page pinned
  // this panel to the pane's top-right corner instead, which reads as
  // disconnected from the box you actually just drew, especially once
  // zoomed (the corner is far from the box; the real viewer's approach
  // keeps the chrome right next to your cursor instead).
  const [autoPanel, setAutoPanel] = useState<{
    // the HU range the region may contain -- suggested from the box while
    // it's being dragged (see lib/autoContour), then the user's to adjust
    range: { low: number; high: number };
    fillHoles: boolean;
    box: [number, number, number, number];
    pane: PaneKey;
    panelClientX: number;
    panelClientY: number;
  } | null>(null);
  const [histogram, setHistogram] = useState<ReturnType<typeof regionHistogram> | null>(null);
  const [histogramPane, setHistogramPane] = useState<PaneKey>("axial");
  const [histogramPanelPos, setHistogramPanelPos] = useState({ x: 0, y: 0 });
  // A dashed rectangle tracking the histogram box WHILE it's being
  // dragged -- unlike Auto (whose box IS autoPanel.box, already live
  // because applyAuto/setAutoPanel run on every move), Histogram has no
  // other live state during the drag itself (its stats only land in
  // `histogram` once, at pointerup), so this is the only place that
  // drag is visible at all. Matches the real viewer's own dashed-box
  // feedback for both tools (renderAutoBoxOverlay/renderRoiBoxOutline).
  const [histogramDragBox, setHistogramDragBox] = useState<{ pane: PaneKey; box: [number, number, number, number] } | null>(null);
  const [paneVisible, setPaneVisible] = useState<Record<VisiblePaneKey, boolean>>({ sagittal: true, coronal: true, axial: true, three_d: false });
  // Maximizing overrides paneVisible entirely (see visiblePaneKeys) so
  // exactly one pane renders full width; toggling it off returns to
  // whatever paneVisible already had -- the real viewer's own scheme.
  const [maximizedPane, setMaximizedPane] = useState<VisiblePaneKey | null>(null);
  function togglePaneVisible(pane: VisiblePaneKey) {
    setPaneVisible((prev) => ({ ...prev, [pane]: !prev[pane] }));
  }
  function toggleMaximized(pane: VisiblePaneKey) {
    setMaximizedPane((prev) => (prev === pane ? null : pane));
  }
  const [savedVersions, setSavedVersions] = useState<PracticeVersion[]>([]);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [openDoc, setOpenDoc] = useState<DocumentSource | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Record<PaneKey, { scale: number; panX: number; panY: number }>>({
    sagittal: IDLE_ZOOM,
    coronal: IDLE_ZOOM,
    axial: IDLE_ZOOM,
  });
  const [huReadout, setHuReadout] = useState<{ x: number; y: number; text: string } | null>(null);
  const [historyLen, setHistoryLen] = useState(0);
  const [redoLen, setRedoLen] = useState(0);

  const nextObjectId = useRef(startMode === "review" ? 1 : 2);
  const nextLabelId = useRef(2);
  const maskRef = useRef<Uint8Array>(emptyMask());
  const volumeRef = useRef<Int16Array | null>(null);
  const autoBaseRef = useRef<Uint8Array | null>(null);
  const historyRef = useRef<{ mask: Uint8Array; axialIndex: number }[]>([]);
  const redoRef = useRef<{ mask: Uint8Array; axialIndex: number }[]>([]);
  const drawingRef = useRef(false);
  const erasingRef = useRef(false);
  const rightClickRef = useRef<{ pane: PaneKey; clientX: number; clientY: number; point: { x: number; y: number }; moved: boolean } | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ pane: PaneKey; x: number; y: number } | null>(null);
  // Which pane a paint/erase stroke started on -- tracked separately
  // from hoveredPaneRef (which follows plain mouseenter, for keyboard
  // shortcuts) because once setPointerCapture redirects pointermove to
  // the pane that received pointerdown, that's the only pane relevant
  // to the stroke regardless of where the cursor visually strays.
  const drawPaneRef = useRef<PaneKey>("axial");
  // ── Touch (tablet) -- the same machinery as ViewerPage.tsx, see
  // lib/touch.ts for the gesture vocabulary. ────────────────────────────
  const gestureHandlerRef = useRef<(gesture: TapGesture, pane: PaneKey, x: number, y: number) => void>(() => {});
  const touchRef = useRef<Record<PaneKey, TouchTracker>>({ sagittal: new TouchTracker(), coronal: new TouchTracker(), axial: new TouchTracker() });
  const tapRef = useRef<Record<PaneKey, TapDetector>>({
    sagittal: new TapDetector((g, x, y) => gestureHandlerRef.current(g, "sagittal", x, y)),
    coronal: new TapDetector((g, x, y) => gestureHandlerRef.current(g, "coronal", x, y)),
    axial: new TapDetector((g, x, y) => gestureHandlerRef.current(g, "axial", x, y)),
  });
  const pendingTapRef = useRef<{ pane: PaneKey; kind: "dot" | "fill"; point: { x: number; y: number }; clientX: number; clientY: number } | null>(null);
  const pendingTapTimerRef = useRef<number | null>(null);
  const panStartRef = useRef<{ pane: PaneKey; clientX: number; clientY: number; panX: number; panY: number } | null>(null);
  // The pane the mouse most recently entered -- arrow-key slice
  // stepping, arrow-key zoom and WASD panning all act on this one, the
  // same "keyboard follows the mouse" convention the real viewer uses.
  const hoveredPaneRef = useRef<PaneKey>("axial");
  const polygonPointsRef = useRef<{ x: number; y: number }[]>([]);
  // Which pane the in-progress polygon draft belongs to -- a polygon
  // spans several clicks (down events only, no drag), so this has to
  // outlive any single pointer event the way dragStartRef's own `pane`
  // does for auto/histogram's single drag.
  const polygonPaneRef = useRef<PaneKey>("axial");
  // the slice the open outline was started on -- it belongs there, as in the viewer (K4)
  const polygonIndexRef = useRef(0);
  const [polygonDraftVersion, setPolygonDraftVersion] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sagittalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const coronalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const savedMessageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewerRootRef = useRef<HTMLDivElement | null>(null);

  // A fixed pane pixel size, measured the same way the real viewer does
  // it (ResizeObserver on the row, not CSS percentage/aspect-square
  // sizing) -- this page's earlier CSS-only sizing was simpler but made
  // the drag-box overlays (autoPanel/histogramDragBox below) drift out
  // of alignment once a pane was zoomed, because a percentage position
  // and the canvas's actual stretched pixel size aren't provably the
  // same number at every zoom level the way a shared, explicit pixel
  // size is. volumeLoaded is in the deps below because this ref is null
  // until the "loading…" early return stops firing -- without it, the
  // observer would attach to nothing and paneSize would be stuck at the
  // DEFAULT_PANE_SIZE fallback forever.
  const paneRowRef = useRef<HTMLDivElement | null>(null);
  const [paneSize, setPaneSize] = useState(DEFAULT_PANE_SIZE);
  // Review is MPR-only, like the real viewer's review surface: no 3D
  // toggle there, whatever was on before.
  const reviewModeNow = phase === "review";
  const allowedPaneKeys: VisiblePaneKey[] = ALL_PANE_KEYS.filter((p) => !reviewModeNow || p !== "three_d");
  const visiblePaneKeys: VisiblePaneKey[] = maximizedPane ? [maximizedPane] : allowedPaneKeys.filter((p) => paneVisible[p]);
  // The 3D view alone on screen gets the whole row instead of a square
  // (it renders a free camera, not a square image).
  const only3d = visiblePaneKeys.length === 1 && visiblePaneKeys[0] === "three_d";
  // Hiding a pane unmounts its canvas; showing it again gives it a
  // fresh, blank one, and the draw effects below only re-run on data
  // changes -- so they key on this too (the real viewer's own
  // paneMountKey does the same).
  const paneMountKey = visiblePaneKeys.join("|");

  useEffect(() => {
    const el = paneRowRef.current;
    if (!el) return;
    // Rough vertical chrome budget per pane: label row + slider row
    // below it (see the "panes"/"pane-sliders" blocks) -- not worth
    // measuring exactly for this estimate.
    // Taller under a coarse pointer: the touch stylesheet's range input
    // is a 2rem control, and on a compact layout each pane carries its
    // own slider (see the row below).
    // Just the label row now: each pane's slice control stands along its
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
      // Same as ViewerPage.tsx's own pane row: one row of `count`
      // panes, or -- when the row is narrow and tall (a portrait
      // tablet), where three side by side would be ~240px strips -- a
      // two-column grid, whichever gives the bigger pane. Floored with
      // the gaps accounted for, or a fractional overshoot of a pixel or
      // two is exactly what makes flex-wrap break a pane onto its own row.
      const fit = (space: number, n: number) => Math.floor((space - GAP * (n - 1)) / n);
      const single = Math.min(fit(rect.width, count) - STRIP, rect.height - CHROME_HEIGHT);
      const cols = 2;
      const wrapped = count > 1 && rect.width < 900 ? Math.min(fit(rect.width, cols) - STRIP, fit(rect.height, Math.ceil(count / cols)) - CHROME_HEIGHT) : 0;
      setPaneSize(Math.max(160, Math.max(single, wrapped)));
    }
    recompute();
    const resizeObserver = new ResizeObserver(recompute);
    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  }, [visiblePaneKeys.length, volumeLoaded]);

  // Whole-document fullscreen + first-touch auto-fullscreen on a touch
  // screen -- the same as ViewerPage.tsx, see lib/fullscreen.ts.
  const autoFullscreenRef = useRef(false);
  useEffect(() => {
    function handleFullscreenChange() {
      const active = fullscreenElement() !== null;
      setIsFullscreen(active);
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

  function showSavedMessage(text: string) {
    setSavedMessage(text);
    if (savedMessageTimeoutRef.current) clearTimeout(savedMessageTimeoutRef.current);
    savedMessageTimeoutRef.current = setTimeout(() => setSavedMessage(null), 2500);
  }

  // The whole real CT volume loads once and lives in volumeRef -- the
  // MPR views below are then just cheap reads out of it, not fetches.
  useEffect(() => {
    let cancelled = false;
    loadTutorialVolume((loaded, total) => !cancelled && setLoadProgress({ loaded, total }))
      .then((vol) => {
        if (cancelled) return;
        volumeRef.current = vol;
        setVolumeLoaded(true);
      })
      .catch((err) => !cancelled && setLoadError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const labelsById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  const activeObject = objects.find((o) => o.id === activeObjectId) ?? null;
  const activeLabel = activeObject ? (labelsById.get(activeObject.labelId) ?? null) : null;
  const canDraw = activeObject !== null && !activeObject.locked;

  function colorForObjectId(id: number): string | null {
    const obj = objects.find((o) => o.id === id);
    if (!obj || obj.hidden) return null;
    return labelsById.get(obj.labelId)?.color ?? null;
  }

  function pushHistory() {
    historyRef.current.push({ mask: maskRef.current.slice(), axialIndex });
    if (historyRef.current.length > 30) historyRef.current.shift();
    redoRef.current = [];
    setHistoryLen(historyRef.current.length);
    setRedoLen(0);
  }
  function undo() {
    const prev = historyRef.current.pop();
    if (!prev) return;
    redoRef.current.push({ mask: maskRef.current.slice(), axialIndex });
    maskRef.current = prev.mask;
    setAxialIndex(prev.axialIndex);
    setMaskVersion((v) => v + 1);
    setHistoryLen(historyRef.current.length);
    setRedoLen(redoRef.current.length);
  }
  function redo() {
    const next = redoRef.current.pop();
    if (!next) return;
    historyRef.current.push({ mask: maskRef.current.slice(), axialIndex });
    maskRef.current = next.mask;
    setAxialIndex(next.axialIndex);
    setMaskVersion((v) => v + 1);
    setHistoryLen(historyRef.current.length);
    setRedoLen(redoRef.current.length);
  }

  // ── Redraw the axial (drawing) pane whenever anything affecting its
  // pixels changes ──────────────────────────────────────────────────
  useEffect(() => {
    if (!volumeLoaded || !volumeRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const hu = slab.thickness > 1 ? slabView(volumeRef.current, "axial", axialIndex, slab.thickness, slab.mode) : axialView(volumeRef.current, axialIndex);
    renderPlane(ctx, hu, TUTORIAL_SIZE, TUTORIAL_SIZE, axialMaskView(maskRef.current, axialIndex), colorForObjectId, windowCenter, windowWidth, sharpness, overlayOpacity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumeLoaded, axialIndex, windowCenter, windowWidth, sharpness, overlayOpacity, maskVersion, objects, labels, slab, paneMountKey]);

  // ── Real sagittal/coronal reconstructions, recomputed whenever their
  // own index or the window settings change -- genuine voxels from the
  // same real volume the axial pane reads, gathered along the other two
  // axes (see sagittalView/coronalView), each independently scrollable
  // exactly like the real viewer's own MPR panes. Painted the same
  // object-color overlay as the axial pane (mask + colorForObjectId +
  // overlayOpacity, not the read-only null/null/0 an earlier version of
  // this page passed here) because these two panes are real drawing
  // surfaces too, not just navigation. ──────────────────────────────────
  useEffect(() => {
    if (!volumeLoaded || !volumeRef.current) return;
    const canvas = sagittalCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const hu = slab.thickness > 1 ? slabView(volumeRef.current, "sagittal", sagittalIndex, slab.thickness, slab.mode) : sagittalView(volumeRef.current, sagittalIndex);
    renderPlane(ctx, hu, TUTORIAL_SIZE, TUTORIAL_SLICES, sagittalMaskView(maskRef.current, sagittalIndex), colorForObjectId, windowCenter, windowWidth, sharpness, overlayOpacity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumeLoaded, sagittalIndex, windowCenter, windowWidth, sharpness, overlayOpacity, maskVersion, objects, labels, slab, paneMountKey]);
  useEffect(() => {
    if (!volumeLoaded || !volumeRef.current) return;
    const canvas = coronalCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const hu = slab.thickness > 1 ? slabView(volumeRef.current, "coronal", coronalIndex, slab.thickness, slab.mode) : coronalView(volumeRef.current, coronalIndex);
    renderPlane(ctx, hu, TUTORIAL_SIZE, TUTORIAL_SLICES, coronalMaskView(maskRef.current, coronalIndex), colorForObjectId, windowCenter, windowWidth, sharpness, overlayOpacity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumeLoaded, coronalIndex, windowCenter, windowWidth, sharpness, overlayOpacity, maskVersion, objects, labels, slab, paneMountKey]);

  /** The polygon in progress as an SVG over the pane (like the real
   * viewer's renderPolygonOverlay): zoomed with the image, but its points
   * and lines keep one small screen size at any zoom -- drawn into the
   * canvas they grew with the zoom, and stretched on sagittal/coronal. */
  function renderPolygonOverlay(pane: PaneKey) {
    const pts = polygonPointsRef.current;
    if (tool !== "polygon" || polygonPaneRef.current !== pane || pts.length === 0 || currentPaneIndex(pane) !== polygonIndexRef.current) return null;
    const { width, height } = paneDims(pane);
    const sx = paneSize / width;
    const sy = paneSize / height;
    const k = 1 / zoom[pane].scale;
    const color = activeLabel?.color ?? "#60a5fa";
    return (
      <svg width={paneSize} height={paneSize} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }} data-polygon-version={polygonDraftVersion}>
        <polyline points={pts.map((p) => `${p.x * sx},${p.y * sy}`).join(" ")} fill="none" stroke={color} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x * sx} cy={p.y * sy} r={(i === 0 ? (coarse ? 5 : 3.5) : coarse ? 3 : 2) * k} fill={i === 0 ? "#fbbf24" : color} data-testid="polygon-point" />
        ))}
      </svg>
    );
  }

  /** Where the other two planes cut this pane, broken around their
   * meeting point -- the real viewer's renderCrosshair, on the practice
   * volume's own dimensions (sagittal: width = y, height = z; coronal:
   * width = x, height = z). */
  function renderCrosshair(pane: PaneKey) {
    if (!showCrosshair) return null;
    const at = (i: number, n: number) => ((i + 0.5) / n) * paneSize;
    const [vPlane, vx, hPlane, hy]: [PaneKey, number, PaneKey, number] =
      pane === "axial"
        ? ["sagittal", at(sagittalIndex, TUTORIAL_SIZE), "coronal", at(coronalIndex, TUTORIAL_SIZE)]
        : pane === "sagittal"
          ? ["coronal", at(coronalIndex, TUTORIAL_SIZE), "axial", at(axialIndex, TUTORIAL_SLICES)]
          : ["sagittal", at(sagittalIndex, TUTORIAL_SIZE), "axial", at(axialIndex, TUTORIAL_SLICES)];
    const gap = CROSSHAIR_GAP_PX / zoom[pane].scale;
    const size = paneSize;
    const line = (x1: number, y1: number, x2: number, y2: number, color: string, key: string) =>
      (x2 - x1) ** 2 + (y2 - y1) ** 2 > 0 ? <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={1} strokeOpacity={0.8} vectorEffect="non-scaling-stroke" /> : null;
    return (
      <svg width={size} height={size} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }} data-testid={`crosshair-${pane}`} aria-hidden="true">
        {line(vx, 0, vx, Math.max(0, hy - gap), PLANE_COLORS[vPlane], "v1")}
        {line(vx, Math.min(size, hy + gap), vx, size, PLANE_COLORS[vPlane], "v2")}
        {line(0, hy, Math.max(0, vx - gap), hy, PLANE_COLORS[hPlane], "h1")}
        {line(Math.min(size, vx + gap), hy, size, hy, PLANE_COLORS[hPlane], "h2")}
      </svg>
    );
  }

  // ── Mouse window/level drag -- the real viewer's gesture: right button
  // with the Cursor tool, middle button with any tool; up/down moves the
  // level, left/right the width. Rendering here is client-side, so the
  // picture follows at once. Registered in the pane row's capture phase
  // so a drawing tool never sees the drag. ─────────────────────────────
  function startWindowDrag(e: ReactPointerEvent<HTMLDivElement>): boolean {
    if (e.pointerType !== "mouse" || !paneFromEvent(e)) return false;
    if (!(e.button === 1 || (e.button === 2 && tool === "cursor"))) return false;
    if (e.altKey || e.ctrlKey || e.metaKey) return false;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    windowDragRef.current = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, c0: windowCenter, w0: windowWidth, moved: false };
    return true;
  }
  function moveWindowDrag(e: ReactPointerEvent<HTMLDivElement>): boolean {
    const drag = windowDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return false;
    e.stopPropagation();
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < WINDOW_DRAG_THRESHOLD_PX) return true;
    drag.moved = true;
    const perPx = Math.max(0.5, drag.w0 * WINDOW_DRAG_HU_PER_PX);
    setWindowCenter(Math.round(Math.max(-1000, Math.min(1000, drag.c0 + dy * perPx))));
    setWindowWidth(Math.round(Math.max(1, Math.min(4000, drag.w0 + dx * perPx * 1.5))));
    return true;
  }
  function endWindowDrag(e: ReactPointerEvent<HTMLDivElement>): boolean {
    const drag = windowDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return false;
    e.stopPropagation();
    windowDragRef.current = null;
    return true;
  }

  // ── Reopen the guide automatically at the start of each phase, once
  // there is actually an image on screen for it to point at ───────────
  useEffect(() => {
    if (!volumeLoaded) return;
    setGuideOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, runId, volumeLoaded]);

  // ── Seed a ready-made annotation when landing straight in Review ─────
  useEffect(() => {
    if (!volumeLoaded || !volumeRef.current || startMode !== "review" || objects.length > 0) return;
    const goodId = nextObjectId.current++;
    const wrongId = nextObjectId.current++;
    setObjects([
      { id: goodId, labelId: 1, instanceNumber: 1, hidden: false, locked: false, comment: "", reviewStatus: "pending" },
      { id: wrongId, labelId: 1, instanceNumber: 2, hidden: false, locked: false, comment: "", reviewStatus: "pending" },
    ]);
    const mask = axialMaskView(maskRef.current, TARGET_SLICE);
    const hu = axialView(volumeRef.current, TARGET_SLICE);
    floodFillMask(hu, mask, TUTORIAL_SIZE, TUTORIAL_SIZE, Math.round(TARGET_X), Math.round(TARGET_Y), goodId, 180);
    // The second object is a plausible-looking but wrong mark, clearly on
    // plain lung tissue -- something for a reviewer to actually catch.
    stampCircle(mask, TUTORIAL_SIZE, TUTORIAL_SIZE, Math.round(TARGET_X - 60), Math.round(TARGET_Y + 45), 10, wrongId);
    setMaskVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, volumeLoaded]);

  function zoomStep(pane: PaneKey, delta: number) {
    setZoom((z) => {
      const cur = z[pane];
      const scale = Math.max(1, Math.min(5, cur.scale + delta));
      return { ...z, [pane]: scale === 1 ? IDLE_ZOOM : { ...cur, scale } };
    });
  }

  // Cursor-anchored zoom: (dx, dy) is the mouse's offset from the
  // pane's *transformed* center, i.e. `d = c * scale` for the content
  // point c under it (the wrapper is `translate(pan) scale(s)` about
  // its center). Keeping that point fixed after scaling to s' means
  // pan' = pan + d * (1 - s'/s).
  function zoomAt(pane: PaneKey, delta: number, dx: number, dy: number) {
    setZoom((z) => {
      const cur = z[pane];
      const next = Math.max(1, Math.min(5, cur.scale + delta));
      if (next === 1) return { ...z, [pane]: IDLE_ZOOM };
      const k = 1 - next / cur.scale;
      return { ...z, [pane]: { scale: next, panX: cur.panX + dx * k, panY: cur.panY + dy * k } };
    });
  }

  // One slice forward/back on a pane -- shared by the wheel and the
  // Left/Right arrow keys, with each pane's own index range.
  function stepPaneIndex(pane: PaneKey, dir: number) {
    if (pane === "axial") setAxialIndex((i) => Math.max(0, Math.min(TUTORIAL_SLICES - 1, i + dir)));
    else if (pane === "sagittal") setSagittalIndex((i) => Math.max(0, Math.min(TUTORIAL_SIZE - 1, i + dir)));
    else setCoronalIndex((i) => Math.max(0, Math.min(TUTORIAL_SIZE - 1, i + dir)));
  }

  // Ctrl+click on any pane: move every pane to that point, the same
  // "jump all views here" mechanic as the real viewer's Ctrl+click.
  // Each pane's local axes map back to the volume differently -- see
  // sagittalView/coronalView for the layout each one is built with.
  function jumpAllPanesTo(pane: PaneKey, x: number, y: number) {
    const inPlane = (v: number) => Math.max(0, Math.min(TUTORIAL_SIZE - 1, Math.round(v)));
    const slice = (v: number) => Math.max(0, Math.min(TUTORIAL_SLICES - 1, Math.round(v)));
    if (pane === "axial") {
      setSagittalIndex(inPlane(x));
      setCoronalIndex(inPlane(y));
    } else if (pane === "sagittal") {
      setCoronalIndex(inPlane(x));
      setAxialIndex(slice(y));
    } else {
      setSagittalIndex(inPlane(x));
      setAxialIndex(slice(y));
    }
  }

  // ── Wheel on every pane, matching the real viewer's handleWheel: a
  // plain scroll steps that pane's slice with any tool active (the
  // wheel is never a drawing gesture, so it can't fight one),
  // Ctrl/Cmd+scroll zooms instead. Zoom is anchored at the cursor -- the point
  // under the mouse stays put while everything scales around it (see
  // zoomAt). Native listeners (not React's onWheel) so preventDefault
  // actually stops the page from scrolling, same reason the real viewer
  // does it this way. ─────────────────────────────────────────────────
  useEffect(() => {
    const targets: [PaneKey, HTMLCanvasElement | null][] = [
      ["sagittal", sagittalCanvasRef.current],
      ["coronal", coronalCanvasRef.current],
      ["axial", canvasRef.current],
    ];
    const cleanups: (() => void)[] = [];
    for (const [pane, el] of targets) {
      if (!el) continue;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        if (!(e.ctrlKey || e.metaKey)) {
          stepPaneIndex(pane, e.deltaY > 0 ? 1 : -1);
          return;
        }
        const rect = el.getBoundingClientRect();
        zoomAt(pane, e.deltaY < 0 ? 0.2 : -0.2, e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2));
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      cleanups.push(() => el.removeEventListener("wheel", onWheel));
    }
    return () => cleanups.forEach((c) => c());
    // volumeLoaded: the canvases don't exist until the "loading…" early
    // return stops firing, so this has to re-run right after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumeLoaded]);

  // ── Pointer handling -- every pane (Sagittal/Coronal/Axial) is a real
  // drawing surface, matching the real viewer's own
  // handlePanePointerDown: one shared handler parameterized by which
  // pane fired it, not an axial-only handler plus a separate nav-only
  // one for the other two (that split -- an earlier version of this
  // page -- was itself the bug behind "I can select a tool but can't
  // use it": paint/fill/auto/histogram/polygon simply had no code path
  // on the sagittal/coronal canvases at all). ─────────────────────────
  function currentPaneIndex(pane: PaneKey): number {
    return pane === "axial" ? axialIndex : pane === "sagittal" ? sagittalIndex : coronalIndex;
  }
  function paneHuView(pane: PaneKey): Int16Array {
    if (!volumeRef.current) return new Int16Array(0);
    if (pane === "axial") return axialView(volumeRef.current, axialIndex);
    if (pane === "sagittal") return sagittalView(volumeRef.current, sagittalIndex);
    return coronalView(volumeRef.current, coronalIndex);
  }
  // Runs `fn` against a flat 2D view of the mask for one pane's current
  // slice, then commits any edits back into the shared 3D mask volume.
  // The axial case is a live subarray (see axialMaskView) so the
  // "commit" is a no-op there; sagittal/coronal need an explicit
  // gather-edit-scatter since their voxels aren't contiguous.
  // Locked or hidden objects' voxels: no tool writes over them (G-03).
  const protectedIds = new Set(objects.filter((o) => o.locked || o.hidden).map((o) => o.id));
  const isProtected = (v: number) => v !== 0 && protectedIds.has(v);

  function withPaneMask(pane: PaneKey, fn: (view: Uint8Array, width: number, height: number) => void) {
    const { width, height } = paneDims(pane);
    const index = currentPaneIndex(pane);
    if (pane === "axial") {
      fn(axialMaskView(maskRef.current, index), width, height);
      return;
    }
    const view = pane === "sagittal" ? sagittalMaskView(maskRef.current, index) : coronalMaskView(maskRef.current, index);
    fn(view, width, height);
    if (pane === "sagittal") writeSagittalMaskView(maskRef.current, index, view);
    else writeCoronalMaskView(maskRef.current, index, view);
  }
  /** Same fill as the real viewer's floodFillSlice: grow through unpainted
   * pixels from the point, stopping at any paint -- so a closed outline
   * (brush or Polygon) gets its interior filled. Not brightness-based
   * (that's what Auto is for). A click that fills nothing (on paint)
   * leaves the undo/redo history alone: it used to clear Redo and leave
   * Undo counting one step too many (G-18). */
  function fillAt(pane: PaneKey, x: number, y: number, objectId: number) {
    let filled: Uint8Array | null = null;
    withPaneMask(pane, (view, width, height) => {
      filled = scanlineFill(width, height, x, y, (px, py) => view[py * width + px] === 0);
    });
    const region = filled as Uint8Array | null;
    if (!region || !region.some((v) => v)) return;
    pushHistory();
    withPaneMask(pane, (view) => {
      for (let i = 0; i < region.length; i++) if (region[i]) view[i] = objectId;
    });
    setMaskVersion((v) => v + 1);
  }
  function toCanvasXY(e: ReactPointerEvent<HTMLCanvasElement>, pane: PaneKey): { x: number; y: number } {
    const { width, height } = paneDims(pane);
    const rect = e.currentTarget.getBoundingClientRect();
    // Independent x/y scale factors, not one shared one: every pane
    // renders into the same fixed paneSize x paneSize square, but only
    // the axial plane's own bitmap is actually square (SIZE x SIZE) -- a
    // sagittal/coronal reconstruction is SIZE x SLICES, so its vertical
    // scale differs from its horizontal one.
    return { x: ((e.clientX - rect.left) * width) / rect.width, y: ((e.clientY - rect.top) * height) / rect.height };
  }

  function handlePanePointerDown(e: ReactPointerEvent<HTMLCanvasElement>, pane: PaneKey) {
    hoveredPaneRef.current = pane;
    const touch = e.pointerType === "touch";
    if (touch && touchRef.current[pane].count >= 2) return; // a second finger is a pinch, never a stroke
    // Alt+click reads the HU value under the cursor regardless of which
    // tool is active (and during Review too) -- matching the real
    // viewer, where this check runs before any tool branching, not
    // nested inside the Cursor tool's own case the way an earlier
    // version of this page had it (so Alt+click silently did nothing
    // whenever Paint/Histogram/anything else was selected).
    if (e.altKey) {
      const { x, y } = toCanvasXY(e, pane);
      const { width } = paneDims(pane);
      const hu = paneHuView(pane)[Math.round(y) * width + Math.round(x)] ?? 0;
      setHuReadout({ x: e.clientX, y: e.clientY, text: `${Math.round(hu)} HU` });
      window.setTimeout(() => setHuReadout(null), 3000);
      return;
    }
    // Ctrl/Cmd+click: jump every pane to this point, with any tool --
    // like Alt+click above, a navigation gesture, not a drawing one.
    if (e.ctrlKey || e.metaKey) {
      const { x, y } = toCanvasXY(e, pane);
      jumpAllPanesTo(pane, x, y);
      return;
    }
    if (tool === "cursor") {
      if (zoom[pane].scale > 1) {
        e.currentTarget.setPointerCapture(e.pointerId);
        panStartRef.current = { pane, clientX: e.clientX, clientY: e.clientY, panX: zoom[pane].panX, panY: zoom[pane].panY };
      }
      return;
    }
    if (phase !== "annotate") return;
    const { x, y } = toCanvasXY(e, pane);
    if (e.button === 2) {
      // Right button, like the real viewer: a click without dragging opens
      // the object's form under the pointer; a drag erases (Paint/Eraser
      // only). It used to erase, fill or add a point at once (G-04).
      e.currentTarget.setPointerCapture(e.pointerId);
      rightClickRef.current = { pane, clientX: e.clientX, clientY: e.clientY, point: { x, y }, moved: false };
      return;
    }
    if (tool === "paint" || tool === "erase") {
      if (tool === "paint" && !canDraw) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drawPaneRef.current = pane;
      erasingRef.current = tool === "erase" || e.button === 2;
      if (touch) {
        // No dot yet: a finger that then moves is a stroke (started
        // from here in handlePanePointerMove), one that doesn't is a
        // tap -- see pendingTapRef in ViewerPage.tsx.
        pendingTapRef.current = { pane, kind: "dot", point: { x, y }, clientX: e.clientX, clientY: e.clientY };
        return;
      }
      pushHistory();
      drawingRef.current = true;
      lastPointRef.current = { x, y };
      withPaneMask(pane, (view, width, height) => stampCircle(view, width, height, Math.round(x), Math.round(y), brushRadius, erasingRef.current ? 0 : (activeObjectId ?? 0), isProtected));
      setMaskVersion((v) => v + 1);
    } else if (tool === "fill") {
      if (!canDraw || !activeObjectId) return;
      if (touch) {
        pendingTapRef.current = { pane, kind: "fill", point: { x, y }, clientX: e.clientX, clientY: e.clientY };
        return;
      }
      fillAt(pane, x, y, activeObjectId);
    } else if (tool === "polygon") {
      if (!canDraw) return;
      const pts = polygonPointsRef.current;
      // a polygon lives on one pane and one slice: clicks elsewhere are ignored, as in the viewer (G-02, K4)
      if (pts.length > 0 && pane !== polygonPaneRef.current) return;
      if (pts.length > 0 && currentPaneIndex(pane) !== polygonIndexRef.current) return;
      // 8 screen px whatever the zoom (24 on touch: a fingertip), as in the viewer
      const rect = e.currentTarget.getBoundingClientRect();
      const px = coarse ? 24 : 8;
      const closeRadius = rect.width > 0 ? px * (e.currentTarget.width / rect.width) : px;
      if (pts.length >= 3 && Math.hypot(x - pts[0].x, y - pts[0].y) < closeRadius) {
        closePolygon(pane);
      } else {
        if (pts.length === 0) {
          polygonPaneRef.current = pane;
          polygonIndexRef.current = currentPaneIndex(pane);
        }
        pts.push({ x, y });
        setPolygonDraftVersion((v) => v + 1);
      }
    } else if (tool === "auto" || tool === "histogram") {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragStartRef.current = { pane, x, y };
      if (tool === "auto") autoBaseRef.current = maskRef.current.slice();
    }
  }

  function handlePanePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const right = rightClickRef.current;
    if (right && !right.moved && Math.hypot(e.clientX - right.clientX, e.clientY - right.clientY) > 6) {
      right.moved = true;
      if (tool === "paint" || tool === "erase") {
        pushHistory();
        drawPaneRef.current = right.pane;
        erasingRef.current = true;
        drawingRef.current = true;
        lastPointRef.current = right.point;
        withPaneMask(right.pane, (view, width, height) => stampCircle(view, width, height, Math.round(right.point.x), Math.round(right.point.y), brushRadius, 0, isProtected));
      }
    }
    if (panStartRef.current) {
      const start = panStartRef.current;
      setZoom((z) => ({ ...z, [start.pane]: { ...z[start.pane], panX: start.panX + (e.clientX - start.clientX), panY: start.panY + (e.clientY - start.clientY) } }));
      return;
    }
    if (phase !== "annotate") return;
    const pending = pendingTapRef.current;
    if (pending && pending.kind === "dot" && e.pointerType === "touch") {
      if (Math.hypot(e.clientX - pending.clientX, e.clientY - pending.clientY) < 6) return;
      // Moved: a stroke after all, from where the finger first landed.
      pendingTapRef.current = null;
      pushHistory();
      drawingRef.current = true;
      lastPointRef.current = pending.point;
      withPaneMask(pending.pane, (view, width, height) =>
        stampCircle(view, width, height, Math.round(pending.point.x), Math.round(pending.point.y), brushRadius, erasingRef.current ? 0 : (activeObjectId ?? 0), isProtected)
      );
    }
    if (drawingRef.current && (tool === "paint" || tool === "erase")) {
      // Which pane the stroke started on (set at pointerdown), not
      // whatever mouseenter last reported -- once setPointerCapture
      // redirects this move event to the pane that received
      // pointerdown, that's the only pane relevant to the stroke
      // regardless of where the cursor visually strays meanwhile.
      const pane = drawPaneRef.current;
      const { x, y } = toCanvasXY(e, pane);
      const last = lastPointRef.current ?? { x, y };
      const steps = Math.max(1, Math.round(Math.hypot(x - last.x, y - last.y) / 2));
      withPaneMask(pane, (view, width, height) => {
        for (let i = 1; i <= steps; i++) {
          const px = last.x + ((x - last.x) * i) / steps;
          const py = last.y + ((y - last.y) * i) / steps;
          stampCircle(view, width, height, Math.round(px), Math.round(py), brushRadius, erasingRef.current ? 0 : (activeObjectId ?? 0), isProtected);
        }
      });
      lastPointRef.current = { x, y };
      setMaskVersion((v) => v + 1);
    } else if (dragStartRef.current && tool === "auto") {
      const start = dragStartRef.current;
      const { x, y } = toCanvasXY(e, start.pane);
      const box: [number, number, number, number] = [Math.min(start.x, x), Math.min(start.y, y), Math.max(start.x, x), Math.max(start.y, y)];
      // while the box is being drawn, the range follows what it holds
      const range = suggestRange(autoPatch(start.pane, box));
      const fillHoles = autoPanel?.fillHoles ?? true;
      applyAuto(start.pane, box, range, fillHoles);
      setAutoPanel({ range, fillHoles, box, pane: start.pane, panelClientX: e.clientX, panelClientY: e.clientY });
    } else if (dragStartRef.current && tool === "histogram") {
      const start = dragStartRef.current;
      const { x, y } = toCanvasXY(e, start.pane);
      const box: [number, number, number, number] = [Math.min(start.x, x), Math.min(start.y, y), Math.max(start.x, x), Math.max(start.y, y)];
      setHistogramDragBox({ pane: start.pane, box });
    }
  }

  // Keeps a position:fixed popup on-screen regardless of where its
  // trigger point was, flipping to the other side of that point if it
  // would otherwise overflow the viewport edge -- identical to
  // ViewerPage.tsx's own clampPopupPosition.
  function clampPopupPosition(clientX: number, clientY: number, boxWidth: number, boxHeight: number, offset: number) {
    const left = clientX + offset + boxWidth > window.innerWidth ? Math.max(4, clientX - offset - boxWidth) : clientX + offset;
    const top = clientY + offset + boxHeight > window.innerHeight ? Math.max(4, clientY - offset - boxHeight) : clientY + offset;
    return { left, top };
  }

  // Pixel position/size for a drag-box overlay -- sx/sy convert content
  // coordinates (0..width, 0..height) to the pane's actual paneSize x
  // paneSize rendered pixels, the exact same math ViewerPage.tsx's own
  // renderAutoBoxOverlay/renderRoiBoxOutline use.
  function boxOverlayStyle(pane: PaneKey, box: [number, number, number, number]): CSSProperties {
    const { width, height } = paneDims(pane);
    const sx = paneSize / width;
    const sy = paneSize / height;
    return {
      left: box[0] * sx,
      top: box[1] * sy,
      width: (box[2] - box[0]) * sx,
      height: (box[3] - box[1]) * sy,
    };
  }

  /** The box's own HU values, as the patch lib/autoContour works on. */
  function autoPatch(pane: PaneKey, box: [number, number, number, number]) {
    const hu = paneHuView(pane);
    const { width } = paneDims(pane);
    const x0 = Math.round(box[0]);
    const y0 = Math.round(box[1]);
    const w = Math.max(1, Math.round(box[2]) - x0 + 1);
    const h = Math.max(1, Math.round(box[3]) - y0 + 1);
    const data = new Int16Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = hu[(y0 + y) * width + x0 + x] ?? HU_MIN;
    return { data, width: w, height: h, x0, y0 };
  }

  /** The real viewer's Auto: a HU range (not "centre ± tolerance", which a
   * calcified core throws off), grown from the in-range pixel nearest the
   * box centre, holes filled when asked -- see lib/autoContour. */
  function applyAuto(pane: PaneKey, box: [number, number, number, number], range: { low: number; high: number }, fillHoles: boolean) {
    if (!activeObjectId || !autoBaseRef.current || !volumeRef.current) return;
    maskRef.current.set(autoBaseRef.current);
    const patch = autoPatch(pane, box);
    const region = growRegion(patch, range, { fillHoles });
    withPaneMask(pane, (view, width) => {
      for (let y = 0; y < patch.height; y++) {
        for (let x = 0; x < patch.width; x++) {
          if (!region[y * patch.width + x]) continue;
          const i = (patch.y0 + y) * width + patch.x0 + x;
          if (view[i] === 0) view[i] = activeObjectId;
        }
      }
    });
    setMaskVersion((v) => v + 1);
  }

  /** Right-click without drag: open the form of the object under the pointer. */
  function openFormAt(pane: PaneKey, point: { x: number; y: number }) {
    let value = 0;
    withPaneMask(pane, (view, width) => {
      value = view[Math.round(point.y) * width + Math.round(point.x)] ?? 0;
    });
    if (!value || !objects.some((o) => o.id === value)) return;
    setActiveObjectId(value);
    setOpenForms((prev) => new Set(prev).add(value));
  }

  function handlePanePointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    const right = rightClickRef.current;
    rightClickRef.current = null;
    if (right && !right.moved) openFormAt(right.pane, right.point);
    if (e.pointerType === "touch" && pendingTapRef.current) finishPendingTap(pendingTapRef.current.pane);
    if (panStartRef.current) {
      panStartRef.current = null;
      return;
    }
    if (phase !== "annotate") return;
    if (drawingRef.current) {
      drawingRef.current = false;
      lastPointRef.current = null;
    } else if (dragStartRef.current && tool === "histogram" && volumeRef.current) {
      const start = dragStartRef.current;
      const { x, y } = toCanvasXY(e, start.pane);
      const { width, height } = paneDims(start.pane);
      if (Math.hypot(x - start.x, y - start.y) > 4) {
        setHistogram(regionHistogram(paneHuView(start.pane), width, height, Math.round(start.x), Math.round(start.y), Math.round(x), Math.round(y)));
        setHistogramPane(start.pane);
        setHistogramPanelPos({ x: e.clientX, y: e.clientY });
      }
      setHistogramDragBox(null);
      dragStartRef.current = null;
    } else if (dragStartRef.current && tool === "auto") {
      dragStartRef.current = null;
      if (!autoPanel) autoBaseRef.current = null; // a plain click with no drag: nothing to keep open
    }
  }

  // ── Touch gestures (tablet) -- see ViewerPage.tsx for the same set ──

  function canvasFor(pane: PaneKey): HTMLCanvasElement | null {
    return pane === "axial" ? canvasRef.current : pane === "sagittal" ? sagittalCanvasRef.current : coronalCanvasRef.current;
  }
  /** toCanvasXY for a viewport point that didn't come from a canvas event. */
  function clientToCanvasXY(pane: PaneKey, clientX: number, clientY: number): { x: number; y: number } | null {
    const el = canvasFor(pane);
    if (!el) return null;
    const { width, height } = paneDims(pane);
    const rect = el.getBoundingClientRect();
    return { x: ((clientX - rect.left) * width) / rect.width, y: ((clientY - rect.top) * height) / rect.height };
  }

  function runPendingTap(kind: "dot" | "fill", pane: PaneKey, point: { x: number; y: number }) {
    if (phase !== "annotate") return;
    if (kind === "fill") {
      if (!canDraw || !activeObjectId) return;
      fillAt(pane, point.x, point.y, activeObjectId);
      return;
    }
    pushHistory();
    withPaneMask(pane, (view, width, height) =>
      stampCircle(view, width, height, Math.round(point.x), Math.round(point.y), brushRadius, erasingRef.current ? 0 : (activeObjectId ?? 0), isProtected)
    );
    setMaskVersion((v) => v + 1);
  }
  function cancelPendingTap() {
    pendingTapRef.current = null;
    if (pendingTapTimerRef.current !== null) {
      window.clearTimeout(pendingTapTimerRef.current);
      pendingTapTimerRef.current = null;
    }
  }
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
  /** A second finger landed: whatever the first one started is undone. */
  function abortOneFingerInteraction() {
    cancelPendingTap();
    if (drawingRef.current) {
      drawingRef.current = false;
      lastPointRef.current = null;
      const prev = historyRef.current.pop();
      if (prev) {
        maskRef.current = prev.mask;
        setMaskVersion((v) => v + 1);
        setHistoryLen(historyRef.current.length);
      }
    }
    if (dragStartRef.current) {
      dragStartRef.current = null;
      setHistogramDragBox(null);
      if (!autoPanel) autoBaseRef.current = null;
    }
    panStartRef.current = null;
  }
  function paneFromEvent(e: ReactPointerEvent<HTMLDivElement>): PaneKey | null {
    const el = (e.target as HTMLElement | null)?.closest?.("[data-pane]");
    return (el?.getAttribute("data-pane") as PaneKey | null) ?? null;
  }
  // Registered in the capture phase on the pane row, so every touch
  // pointer is seen (and a pinch's moves stopped) before the canvas's
  // own stroke handlers run.
  function handleTouchDownCapture(e: ReactPointerEvent<HTMLDivElement>) {
    const pane = paneFromEvent(e);
    if (e.pointerType !== "touch" || !pane) return;
    const tracker = touchRef.current[pane];
    tracker.down(e.pointerId, e.clientX, e.clientY);
    tapRef.current[pane].down(e.pointerId, e.clientX, e.clientY, tracker.count, tracker.center());
    if (tracker.count === 2) {
      abortOneFingerInteraction();
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }
  function handleTouchMoveCapture(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerType !== "touch") return;
    for (const pane of PANE_ORDER) {
      const tracker = touchRef.current[pane];
      tapRef.current[pane].move(e.pointerId, e.clientX, e.clientY);
      const pinch = tracker.move(e.pointerId, e.clientX, e.clientY);
      if (!pinch) continue;
      e.stopPropagation();
      pinchZoom(pane, pinch.factor, pinch.cx, pinch.cy, pinch.dx, pinch.dy);
      return;
    }
  }
  function handleTouchUpCapture(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerType !== "touch") return;
    for (const pane of PANE_ORDER) {
      const tracker = touchRef.current[pane];
      const countBefore = tracker.count;
      if (countBefore === 0) continue;
      tapRef.current[pane].up(e.pointerId, e.clientX, e.clientY, countBefore);
      tracker.up(e.pointerId);
      if (tracker.count === countBefore) continue; // this pointer wasn't on that pane
      if (countBefore >= 2) e.stopPropagation();
      return;
    }
  }
  /** Pinch: zoomAt's anchor math with a multiplicative factor, plus the
   * midpoint's own movement as a pan. */
  function pinchZoom(pane: PaneKey, factor: number, clientX: number, clientY: number, dx: number, dy: number) {
    const el = canvasFor(pane);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ax = clientX - (rect.left + rect.width / 2);
    const ay = clientY - (rect.top + rect.height / 2);
    setZoom((z) => {
      const cur = z[pane];
      const next = Math.max(1, Math.min(5, cur.scale * factor));
      if (next === 1) return { ...z, [pane]: IDLE_ZOOM };
      const k = 1 - next / cur.scale;
      return { ...z, [pane]: { scale: next, panX: cur.panX + ax * k + dx, panY: cur.panY + ay * k + dy } };
    });
  }
  gestureHandlerRef.current = (gesture, pane, x, y) => {
    const c = clientToCanvasXY(pane, x, y);
    if (!c) return;
    if (gesture === "long-press") {
      cancelPendingTap();
      dragStartRef.current = null;
      setHistogramDragBox(null);
      const { width } = paneDims(pane);
      const hu = paneHuView(pane)[Math.round(c.y) * width + Math.round(c.x)] ?? 0;
      setHuReadout({ x, y, text: `${Math.round(hu)} HU` });
      window.setTimeout(() => setHuReadout(null), 3000);
    } else if (gesture === "double-tap") {
      cancelPendingTap();
      setZoom((z) => ({ ...z, [pane]: IDLE_ZOOM }));
    } else if (gesture === "two-finger-tap") {
      jumpAllPanesTo(pane, c.x, c.y);
    }
  };

  const closeOpenPolygonRef = useRef(() => {});
  closeOpenPolygonRef.current = () => {
    if (currentPaneIndex(polygonPaneRef.current) === polygonIndexRef.current) closePolygon(polygonPaneRef.current);
  };

  function closePolygon(pane: PaneKey) {
    const pts = polygonPointsRef.current;
    if (pts.length < 3 || !activeObjectId) {
      polygonPointsRef.current = [];
      setPolygonDraftVersion((v) => v + 1);
      return;
    }
    pushHistory();
    const { width, height } = paneDims(pane);
    const off = document.createElement("canvas");
    off.width = width;
    off.height = height;
    const octx = off.getContext("2d")!;
    octx.fillStyle = "#fff";
    octx.beginPath();
    octx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) octx.lineTo(p.x, p.y);
    octx.closePath();
    octx.fill();
    const data = octx.getImageData(0, 0, width, height).data;
    withPaneMask(pane, (view) => {
      for (let i = 0; i < width * height; i++) {
        if (data[i * 4 + 3] > 0 && !isProtected(view[i])) view[i] = activeObjectId;
      }
    });
    polygonPointsRef.current = [];
    setPolygonDraftVersion((v) => v + 1);
    setMaskVersion((v) => v + 1);
  }

  function cancelAuto() {
    if (autoBaseRef.current) maskRef.current.set(autoBaseRef.current);
    autoBaseRef.current = null;
    setAutoPanel(null);
    setMaskVersion((v) => v + 1);
  }
  /** Keeps the previewed Auto region as one undoable step: the snapshot is
   * the mask from before the preview, so Undo takes back exactly the
   * region (it was never on the history, G-01). */
  function commitAuto() {
    if (autoBaseRef.current) {
      historyRef.current.push({ mask: autoBaseRef.current, axialIndex });
      if (historyRef.current.length > 30) historyRef.current.shift();
      redoRef.current = [];
      setHistoryLen(historyRef.current.length);
      setRedoLen(0);
    }
    autoBaseRef.current = null;
    setAutoPanel(null);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const active = document.activeElement;
      const typing = active instanceof HTMLElement && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (isHelpKey(e) && !typing) {
        e.preventDefault();
        setKeysOpen(true);
        return;
      }

      if (e.key === "Escape") {
        if (autoPanel) cancelAuto();
        if (polygonPointsRef.current.length > 0) {
          polygonPointsRef.current = [];
          setPolygonDraftVersion((v) => v + 1);
        }
        setHistogram(null);
        setHistogramDragBox(null);
        return;
      }
      if (e.key === "Enter" && autoPanel) {
        commitAuto();
        return;
      }
      if (e.key === "Enter" && !typing && polygonPointsRef.current.length >= 3) {
        closeOpenPolygonRef.current(); // on its own slice only, as the bar's button
        return;
      }

      // Ctrl+Z / Cmd+Z undo, Ctrl+Shift+Z / Ctrl+Y redo -- same shortcuts
      // as the real viewer, only meaningful while annotating.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing && phase === "annotate") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y" && !typing && phase === "annotate") {
        e.preventDefault();
        redo();
        return;
      }

      // N: new instance of the active label -- same shortcut as the
      // header button.
      if (e.key.toLowerCase() === "n" && !typing && !e.ctrlKey && !e.metaKey && activeLabel && phase !== "review") {
        e.preventDefault();
        createObject(activeLabel.id);
        return;
      }

      // WASD: pan the last-hovered pane, only once zoomed in there --
      // works regardless of which tool is active (unlike mouse-drag
      // panning, which the Cursor tool owns on the axial pane so it
      // doesn't fight painting).
      const wasdKey = e.key.toLowerCase();
      if (["w", "a", "s", "d"].includes(wasdKey) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (typing) return;
        const pane = hoveredPaneRef.current;
        if (zoom[pane].scale > 1) {
          e.preventDefault();
          const PAN_STEP_PX = 40;
          const dx = wasdKey === "a" ? PAN_STEP_PX : wasdKey === "d" ? -PAN_STEP_PX : 0;
          const dy = wasdKey === "w" ? PAN_STEP_PX : wasdKey === "s" ? -PAN_STEP_PX : 0;
          setZoom((z) => ({ ...z, [pane]: { ...z[pane], panX: z[pane].panX + dx, panY: z[pane].panY + dy } }));
        }
        return;
      }

      if (e.key.toLowerCase() === "c" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setShowCrosshair((v) => !v);
        return;
      }

      // Arrow keys act on the last-hovered pane: Left/Right step its
      // slice, Up/Down zoom it -- same split the real viewer uses.
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) || typing) return;
      e.preventDefault();
      const pane = hoveredPaneRef.current;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        if (pane === "axial") setAxialIndex((i) => Math.max(0, Math.min(TUTORIAL_SLICES - 1, i + dir)));
        else if (pane === "sagittal") setSagittalIndex((i) => Math.max(0, Math.min(TUTORIAL_SIZE - 1, i + dir)));
        else setCoronalIndex((i) => Math.max(0, Math.min(TUTORIAL_SIZE - 1, i + dir)));
        return;
      }
      zoomStep(pane, e.key === "ArrowUp" ? 0.15 : -0.15);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPanel, zoom, phase, activeLabel]);

  // ── Label/object actions ──────────────────────────────────────────────
  function addLabel(name: string) {
    if (!name.trim()) return;
    const id = nextLabelId.current++;
    setLabels((prev) => [...prev, { id, name: name.trim(), color: PALETTE[prev.length % PALETTE.length] }]);
  }
  function createObject(labelId: number) {
    const id = nextObjectId.current++;
    const instanceNumber = objects.filter((o) => o.labelId === labelId).length + 1;
    setObjects((prev) => [...prev, { id, labelId, instanceNumber, hidden: false, locked: false, comment: "", reviewStatus: "pending" }]);
    setActiveObjectId(id);
  }
  /** Same as the viewer: asks first, and removes the object's voxels from
   * the mask AND from every undo/redo snapshot, so Undo can't bring the
   * painting back with no object owning it (G-19). */
  function deleteObject(id: number) {
    const obj = objects.find((o) => o.id === id);
    const name = obj ? `${labels.find((l) => l.id === obj.labelId)?.name ?? "Object"} ${obj.instanceNumber}` : "this object";
    if (!window.confirm(`Delete ${name}? Its painting is removed, and this can't be undone.`)) return;
    for (const mask of [maskRef.current, ...historyRef.current.map((h) => h.mask), ...redoRef.current.map((h) => h.mask)]) {
      for (let i = 0; i < mask.length; i++) if (mask[i] === id) mask[i] = 0;
    }
    setObjects((prev) => prev.filter((o) => o.id !== id));
    if (activeObjectId === id) setActiveObjectId(null);
    setMaskVersion((v) => v + 1);
  }
  function toggleObjectLock(id: number) {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, locked: !o.locked } : o)));
  }

  /** Double-click an object row: move every pane to it -- each pane to
   * the slice holding the most of that object along its own axis (its
   * densest cross-section), never a plain centroid, which can land on a
   * slice the object has no voxels on at all. Same rule as the real
   * viewer's jumpToObject, in one pass over the mask volume. */
  function jumpToObject(objectId: number) {
    const mask = maskRef.current;
    const n = TUTORIAL_SIZE;
    const zCount = new Int32Array(TUTORIAL_SLICES);
    const yCount = new Int32Array(n);
    const xCount = new Int32Array(n);
    let total = 0;
    for (let z = 0; z < TUTORIAL_SLICES; z++) {
      const zBase = z * n * n;
      for (let y = 0; y < n; y++) {
        const rowBase = zBase + y * n;
        for (let x = 0; x < n; x++) {
          if (mask[rowBase + x] === objectId) {
            zCount[z]++;
            yCount[y]++;
            xCount[x]++;
            total++;
          }
        }
      }
    }
    if (total === 0) return;
    const argmax = (counts: Int32Array) => {
      let best = 0;
      for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
      return best;
    };
    setAxialIndex(argmax(zCount));
    setSagittalIndex(argmax(xCount));
    setCoronalIndex(argmax(yCount));
  }

  /** The Draw section's "Clear hovered slice": wipes the active object's
   * paint on the current slice of whichever pane the mouse last entered
   * -- that pane's own slice, not always the axial one, now that every
   * pane is a drawing surface. */
  function clearHoveredSlice() {
    if (!activeObjectId) return;
    pushHistory();
    let cleared = 0;
    withPaneMask(hoveredPaneRef.current, (view) => {
      for (let i = 0; i < view.length; i++) {
        if (view[i] === activeObjectId) {
          view[i] = 0;
          cleared++;
        }
      }
    });
    if (cleared === 0) {
      historyRef.current.pop();
      setHistoryLen(historyRef.current.length);
      return;
    }
    setMaskVersion((v) => v + 1);
  }

  function deleteLabel(labelId: number) {
    const doomed = objects.filter((o) => o.labelId === labelId).map((o) => o.id);
    if (doomed.length > 0) {
      pushHistory();
      const mask = maskRef.current;
      for (let i = 0; i < mask.length; i++) if (doomed.includes(mask[i])) mask[i] = 0;
      setMaskVersion((v) => v + 1);
    }
    setLabels((prev) => prev.filter((l) => l.id !== labelId));
    setObjects((prev) => prev.filter((o) => o.labelId !== labelId));
    if (doomed.includes(activeObjectId ?? -1)) setActiveObjectId(null);
  }

  const hasAnyPaint = useMemo(() => maskRef.current.some((v) => v !== 0), [maskVersion]);
  const originalAdjustment = windowCenter === DEFAULT_CENTER && windowWidth === DEFAULT_WIDTH && sharpness === 0;

  function recordVersion(status: PracticeVersion["status"]) {
    setSavedVersions((prev) => [...prev, { n: prev.length + 1, status, at: new Date().toLocaleTimeString() }]);
  }
  function saveDraft() {
    recordVersion("draft");
    showSavedMessage("Saved (practice) ✓");
  }
  function markAnnotated() {
    recordVersion("submitted");
    showSavedMessage("Saved (practice) ✓");
    setObjects((prev) => prev.map((o) => ({ ...o, reviewStatus: "pending" as const })));
    setReviewIndex(0);
    // Review is look-and-decide only: back to the Cursor tool so drag
    // pans and the panes behave exactly as the review tour describes,
    // whatever tool was last selected while annotating.
    setTool("cursor");
    setAutoPanel(null);
    setHistogram(null);
    setPhase("review");
  }

  // ── Review phase ───────────────────────────────────────────────────
  const reviewObjects = useMemo(() => labels.flatMap((l) => objects.filter((o) => o.labelId === l.id)), [labels, objects]);
  const clampedReviewIndex = Math.max(0, Math.min(reviewIndex, reviewObjects.length - 1));
  // Review: the panes follow the object on the card, as the tour says and
  // the viewer does (G-05).
  const reviewObjectId = phase === "review" ? reviewObjects[clampedReviewIndex]?.id : undefined;
  useEffect(() => {
    if (reviewObjectId !== undefined) jumpToObject(reviewObjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewObjectId]);
  const currentReviewObject = reviewObjects[clampedReviewIndex] ?? null;
  const reviewPending = reviewObjects.filter((o) => o.reviewStatus === "pending").length;

  function decide(status: "accepted" | "rejected") {
    if (!currentReviewObject) return;
    setObjects((prev) => prev.map((o) => (o.id === currentReviewObject.id ? { ...o, reviewStatus: status } : o)));
    // as in the viewer: a rejection stays on its object, where its comment is written
    if (status === "rejected") return;
    const nextPending = reviewObjects.findIndex((o, i) => i > clampedReviewIndex && o.reviewStatus === "pending");
    if (nextPending >= 0) setReviewIndex(nextPending);
    else if (clampedReviewIndex < reviewObjects.length - 1) setReviewIndex(clampedReviewIndex + 1);
  }

  const approvedCount = reviewObjects.filter((o) => o.reviewStatus === "accepted").length;
  const rejectedCount = reviewObjects.filter((o) => o.reviewStatus === "rejected").length;
  // as in the viewer, a rejection needs a comment for the annotator
  const rejectedWithoutComment = reviewObjects.filter((o) => o.reviewStatus === "rejected" && !(o.comment ?? "").trim()).length;

  function replay() {
    maskRef.current = emptyMask();
    historyRef.current = [];
    redoRef.current = [];
    setHistoryLen(0);
    setRedoLen(0);
    setLabels([PRACTICE_LABEL]);
    setOpenForms(new Set());
    nextLabelId.current = 2;
    // Replay always lands back in Annotate (see setPhase below), so it
    // gets the same pre-seeded instance a fresh Annotate entry does.
    setObjects([defaultAnnotateObject()]);
    nextObjectId.current = 2;
    setActiveObjectId(1);
    setAxialIndex(10);
    setSagittalIndex(Math.round(TARGET_X));
    setCoronalIndex(Math.round(TARGET_Y));
    setWindowCenter(DEFAULT_CENTER);
    setWindowWidth(DEFAULT_WIDTH);
    setSharpness(0);
    setZoom({ sagittal: IDLE_ZOOM, coronal: IDLE_ZOOM, axial: IDLE_ZOOM });
    setTool("cursor");
    setMaskVersion((v) => v + 1);
    setSavedVersions([]);
    setMaximizedPane(null);
    setOpenDoc(null);
    // the display the run started with, too -- a slab, hidden panes, opacity,
    // brush size, an open histogram or Auto panel and half a polygon all
    // survived a replay (G-16). The crosshair and the pane size are the
    // user's own preferences and stay.
    setSlab({ thickness: 1, mode: "avg" });
    setPaneVisible({ sagittal: true, coronal: true, axial: true, three_d: false });
    setOverlayOpacity(70);
    setBrushRadius(10);
    setHistogram(null);
    setHistogramDragBox(null);
    setAutoPanel(null);
    setHuReadout(null);
    polygonPointsRef.current = [];
    setPolygonDraftVersion((v) => v + 1);
    setPhase("annotate");
    setRunId((v) => v + 1);
  }

  const reviewMode = phase === "review";
  // The Tutorial runs the SAME tour as the real viewer (ANNOTATE_STEPS/
  // REVIEW_STEPS), not a separately maintained copy -- one script to
  // keep accurate instead of two drifting apart. Steps whose target
  // doesn't exist on this simplified page (job-status, case-nav,
  // documents: this practice job has no multi-case list or attached
  // documents) are silently skipped by GuideTour itself, not something
  // this page needs to work around.
  const guideSteps = useMemo(() => tutorialSteps(reviewMode ? REVIEW_STEPS : ANNOTATE_STEPS), [reviewMode]);

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-[#1a1a2e] px-6 text-center text-gray-200">
        <p className="text-sm text-red-300" data-testid="tutorial-load-error">
          The practice scan couldn&apos;t be loaded. Check your connection and try again.
        </p>
        <p className="text-[11px] text-gray-500">{loadError}</p>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="tutorial-load-retry"
            onClick={() => {
              setLoadError(null);
              setLoadProgress(null);
              setLoadAttempt((n) => n + 1);
            }}
            className="rounded bg-amber-500 px-3 py-1.5 text-xs font-medium text-[#1a1a2e] hover:bg-amber-400"
          >
            Try again
          </button>
          <a href={`${ADMIN_UI_URL}/my-jobs`} className="rounded border border-[#444] px-3 py-1.5 text-xs text-gray-300 hover:bg-[#2a2a3e]">
            ← Back to My Jobs
          </a>
        </div>
      </div>
    );
  }

  if (!volumeLoaded) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-[#1a1a2e] text-gray-400">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-600 border-t-amber-400" />
        <p className="text-xs" data-testid="tutorial-loading">
          Loading the practice scan…
          {loadProgress && loadProgress.total > 0 && (
            <>
              {" "}
              {Math.round((loadProgress.loaded / loadProgress.total) * 100)}% ({(loadProgress.loaded / 1e6).toFixed(1)} of {(loadProgress.total / 1e6).toFixed(1)} MB)
            </>
          )}
        </p>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-5 bg-[#1a1a2e] px-6 text-center text-gray-200">
        <span className="text-4xl">🎉</span>
        <h1 className="text-xl font-semibold text-gray-50">Tutorial complete</h1>
        <p className="max-w-md text-sm text-gray-400">
          You reviewed {reviewObjects.length} object{reviewObjects.length === 1 ? "" : "s"}: {approvedCount} accepted,{" "}
          {rejectedCount} rejected. That's the whole loop a real case goes through -- you're ready for your real jobs.
        </p>
        <div className="flex gap-3">
          <button onClick={replay} className="rounded border border-[#444] bg-[#2a2a3e] px-4 py-2 text-sm text-gray-200 hover:bg-[#333]">
            Replay the tutorial
          </button>
          <a href={`${ADMIN_UI_URL}/my-jobs`} className="rounded border border-amber-500 bg-amber-500 px-4 py-2 text-sm font-medium text-[#1a1a2e] hover:bg-amber-400">
            Back to My Jobs
          </a>
        </div>
      </div>
    );
  }

  const paneConfig: Record<PaneKey, { index: number; max: number; setIndex: (n: number) => void }> = {
    sagittal: { index: sagittalIndex, max: TUTORIAL_SIZE - 1, setIndex: setSagittalIndex },
    coronal: { index: coronalIndex, max: TUTORIAL_SIZE - 1, setIndex: setCoronalIndex },
    axial: { index: axialIndex, max: TUTORIAL_SLICES - 1, setIndex: setAxialIndex },
  };

  return (
    <div ref={viewerRootRef} className="flex h-screen flex-col bg-[#1a1a2e] text-gray-200">
      <header className="flex flex-shrink-0 flex-wrap items-center justify-between gap-y-1.5 border-b-2 border-amber-500/70 bg-[#15152a] px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <Tip title="Back to My Jobs" description="Leaves the tutorial. It's always there in your job list -- come back any time.">
            <a href={`${ADMIN_UI_URL}/my-jobs`} data-guide="back" className="whitespace-nowrap rounded border border-[#444] px-3 py-1 text-xs text-gray-300 hover:bg-[#2a2a3e]">
              ← Back
            </a>
          </Tip>
          <h1 className="flex items-center gap-2 text-sm font-semibold text-gray-100">
            Tutorial · {reviewMode ? "Review" : "Annotate"}
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300">Practice</span>
          </h1>
          <div className="relative border-l border-[#333] pl-3" data-guide="documents">
            <Tip title="Documents" description="The reports and notes attached to this case. Open one to read it in a side panel next to the images.">
              <button type="button" onClick={() => setDocumentsOpen((v) => !v)} className="whitespace-nowrap rounded border border-[#444] px-3 py-1 text-xs text-gray-300 hover:bg-[#2a2a3e]">
                Documents ({PRACTICE_DOCUMENTS.length})
              </button>
            </Tip>
            {documentsOpen && (
              <div className="absolute left-3 top-full z-20 mt-1 w-72 rounded border border-[#444] bg-[#20203a] p-2 shadow-lg">
                <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                  {PRACTICE_DOCUMENTS.map((doc) => (
                    <li key={doc.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenDoc(doc.source);
                          setDocumentsOpen(false);
                        }}
                        title="Open in the side panel"
                        className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-[#2a2a3e]"
                      >
                        <span className="truncate text-xs text-gray-100">{doc.title}</span>
                        <span className="text-[11px] text-gray-500">
                          {doc.type} · {doc.date}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!reviewMode && (
            <>
              <Tip
                title={activeLabel ? `New ${activeLabel.name} instance` : "New instance"}
                description={activeLabel ? `Adds another ${activeLabel.name} and makes it the active object, ready to draw into.` : "Select an object first -- the new instance gets that object's label."}
                shortcut="N"
              >
                <span className="flex" data-guide="new-instance">
                  <button
                    onClick={() => activeLabel && createObject(activeLabel.id)}
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
                  <Tip key={pane} title={`${paneVisible[pane] ? "Hide" : "Show"} the ${pane === "three_d" ? "3D" : PANE_LABELS[pane]} pane`} description="Show or hide this pane. Hiding gives the others more room; nothing is lost.">
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
          {/* Deliberately its own styling, not the shared neutral-gray
              IconButton every other header control uses -- this is the
              one button that gets someone unstuck, so it should read as
              a distinct, inviting call-to-action (amber, labeled) at a
              glance, not blend into the row as just another icon. */}
          {compact && (
            <Tip title="Panel" description="Open the side panel: objects, appearance, window/level and saved versions. It closes again with the ✕ at its top.">
              <button
                type="button"
                onClick={() => setPanelOpen((v) => !v)}
                data-testid="panel-toggle"
                aria-expanded={panelOpen}
                className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors ${panelOpen ? "border-amber-500 bg-amber-500/20 text-amber-300" : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"}`}
              >
                Panel
              </button>
            </Tip>
          )}
          <Tip title="Tutorial" description="Replay the guide for this phase.">
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
          <IconButton title={isFullscreen ? "Exit fullscreen" : "Fullscreen"} description="Use the whole screen for the tutorial. Esc leaves fullscreen." onClick={toggleFullscreen}>
            {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
          </IconButton>
          {!reviewMode && (
            <div className="flex items-center gap-2" data-guide="undo-redo">
              <IconButton title="Undo" description="Take back the last paint, erase, fill or polygon." shortcut="Ctrl+Z" onClick={undo} disabled={historyLen === 0}>
                <UndoIcon />
              </IconButton>
              <IconButton title="Redo" description="Put back what you just undid." shortcut="Ctrl+Shift+Z" onClick={redo} disabled={redoLen === 0}>
                <RedoIcon />
              </IconButton>
            </div>
          )}
          {!reviewMode && (
            <Tip title="Save a draft" description="Store the current drawing so you can keep editing later. Practice only -- nothing leaves this page.">
              <span className="flex" data-guide="save">
                <button onClick={saveDraft} disabled={!hasAnyPaint} className="rounded border border-blue-500 bg-blue-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50">
                  Save
                </button>
              </span>
            </Tip>
          )}
          {!reviewMode && (
            <Tip title="Mark as Practice-Annotated" description="Move to the Review phase of this same practice job with what you've drawn.">
              <span className="flex" data-guide="mark-annotated">
                <button onClick={markAnnotated} disabled={!hasAnyPaint} className="rounded border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
                  Mark as Practice-Annotated
                </button>
              </span>
            </Tip>
          )}
          {reviewMode && (
            <Tip
              title="Submit review"
              description={
                reviewPending > 0
                  ? `${reviewPending} object${reviewPending === 1 ? "" : "s"} still need a decision.`
                  : rejectedWithoutComment > 0
                    ? "Each rejected object needs a comment for the annotator first."
                    : "Finish the tutorial."
              }
            >
              <span className="flex" data-guide="submit-review">
                <button onClick={() => setPhase("done")} disabled={reviewPending > 0 || rejectedWithoutComment > 0} className="rounded border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
                  Submit review
                </button>
              </span>
            </Tip>
          )}
          {savedMessage && <span className="text-xs text-emerald-400">{savedMessage}</span>}
        </div>
      </header>
      {tool === "polygon" && polygonPointsRef.current.length > 0 && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 bg-sky-900/60 px-4 py-1.5 text-xs text-sky-100" data-testid="polygon-open">
          <span>
            Open outline on the {polygonPaneRef.current} pane, slice {polygonIndexRef.current + 1} -- it isn&apos;t part of your practice annotation until it&apos;s closed.
          </span>
          {currentPaneIndex(polygonPaneRef.current) !== polygonIndexRef.current && (
            <button
              type="button"
              onClick={() => {
                const i = polygonIndexRef.current;
                if (polygonPaneRef.current === "axial") setAxialIndex(i);
                else if (polygonPaneRef.current === "sagittal") setSagittalIndex(i);
                else setCoronalIndex(i);
              }}
              className="rounded border border-sky-400/60 px-2 py-0.5 hover:bg-sky-800"
              data-testid="polygon-goto"
            >
              Go to slice {polygonIndexRef.current + 1}
            </button>
          )}
          <button
            type="button"
            onClick={() => closePolygon(polygonPaneRef.current)}
            disabled={polygonPointsRef.current.length < 3 || currentPaneIndex(polygonPaneRef.current) !== polygonIndexRef.current}
            className="rounded bg-sky-600 px-2 py-0.5 font-medium text-white hover:bg-sky-500 disabled:opacity-40"
            data-testid="polygon-close"
          >
            Close shape (Enter)
          </button>
          <button
            type="button"
            onClick={() => {
              polygonPointsRef.current = [];
              setPolygonDraftVersion((v) => v + 1);
            }}
            className="rounded border border-sky-400/60 px-2 py-0.5 hover:bg-sky-800"
            data-testid="polygon-drop"
          >
            Drop (Esc)
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {!reviewMode && (
          <div data-guide="toolbar" className={`flex flex-shrink-0 flex-col items-center gap-1 border-r border-[#333] bg-[#15152a] py-2 ${coarse ? "w-14" : "w-12"}`}>
            {(
              [
                { t: "cursor", icon: <CursorIcon /> },
                { t: "paint", icon: <BrushIcon />, needsObj: true },
                { t: "erase", icon: <EraserIcon /> },
                { t: "fill", icon: <BucketIcon />, needsObj: true },
                { t: "polygon", icon: <PolygonIcon />, needsObj: true },
                { t: "auto", icon: <AutoContourIcon />, needsObj: true },
                { t: "histogram", icon: <HistogramIcon /> },
              ] as { t: DrawTool; icon: JSX.Element; needsObj?: boolean }[]
            ).map(({ t, icon, needsObj }) => {
              const disabled = Boolean(needsObj) && !canDraw;
              return (
                <Tip key={t} title={t[0].toUpperCase() + t.slice(1)} description={disabled ? `${TOOL_HELP[t]} Select an object first.` : TOOL_HELP[t]} side="right">
                  <span className="flex" data-guide={`tool-${t}`}>
                    <button
                      // The zoom stays as it is, like the real viewer:
                      // Ctrl+wheel zooms with every tool now.
                      onClick={() => setTool(t)}
                      disabled={disabled}
                      className={`flex items-center justify-center rounded transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${coarse ? "h-11 w-11" : "h-9 w-9"} ${
                        tool === t ? "bg-amber-500/25 text-amber-300" : "text-gray-400 hover:bg-[#2a2a3e] hover:text-gray-200"
                      }`}
                    >
                      {icon}
                    </button>
                  </span>
                </Tip>
              );
            })}
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {/* A fixed, JS-measured pane pixel size (paneSize) -- matches
              ViewerPage.tsx's own pane row exactly (ResizeObserver, same
              CHROME_HEIGHT estimate, same Math.max(160, ...) floor). See
              paneSize's own declaration for why this replaced an
              earlier, simpler CSS percentage/aspect-square approach:
              that one made the Auto/Histogram drag-box overlays drift
              out of alignment with the image once a pane was zoomed. */}
          {/* Two rows, not one, matching the real viewer's own layout:
              the images (each vertically centred within this row's
              height) above, and every pane's own slider in a second,
              fixed-height row directly below -- rather than each
              pane's slider following its own image, which reads oddly
              once the image is much shorter than the row (see the
              pane-height comment on PaneBox). */}
          {/* flex-wrap + `align-content: safe center`: on a narrow row
              the panes form a two-column grid (see paneSize's own
              recompute) instead of three thin strips; `safe` keeps the
              first row reachable when the grid is taller than the row. */}
          <div
            ref={paneRowRef}
            data-guide="panes"
            className={`flex min-h-0 min-w-0 flex-1 bg-black ${only3d ? "" : "flex-wrap items-start justify-center gap-px overflow-auto [align-content:safe_center]"}`}
            onPointerDownCapture={(e) => {
              if (!startWindowDrag(e)) handleTouchDownCapture(e);
            }}
            onPointerMoveCapture={(e) => {
              if (!moveWindowDrag(e)) handleTouchMoveCapture(e);
            }}
            onPointerUpCapture={(e) => {
              if (!endWindowDrag(e)) handleTouchUpCapture(e);
            }}
            onPointerCancelCapture={(e) => {
              if (!endWindowDrag(e)) handleTouchUpCapture(e);
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {PANE_ORDER.map((pane) => {
              if (!visiblePaneKeys.includes(pane)) return null;
              return (
                <PaneBox
                  key={pane}
                  label={PANE_LABELS[pane]}
                  size={paneSize}
                  maximized={maximizedPane === pane}
                  onMaximize={() => toggleMaximized(pane)}
                  onHide={() => togglePaneVisible(pane)}
                  color={PLANE_COLORS[pane]}
                  badge={slab.thickness > 1 ? `${slab.mode === "avg" ? "AVG" : SLAB_LABEL[slab.mode].toUpperCase()} ${slab.thickness}` : undefined}
                  stripWidth={coarse ? SLICE_STRIP_PX.touch : SLICE_STRIP_PX.mouse}
                  slider={<PaneSlider cfg={paneConfig[pane]} label={PANE_LABELS[pane]} guide="pane-sliders" />}
                >
                  {/* The canvas and its drag-box overlay(s) share ONE
                      zoom/pan transform on a common wrapper, rather than
                      each carrying its own copy of it -- two elements
                      transformed "the same way" but around their OWN,
                      different-sized boxes don't actually end up in the
                      same place (each element's transform-origin
                      defaults to ITS OWN center, and the drag box is a
                      smaller, off-center rectangle within the pane), so
                      a zoomed drag-box previously drifted away from the
                      region it was drawn over. A shared wrapper, sized
                      in the exact same pixels as the canvas (not a CSS
                      percentage of it), fixes that at the source --
                      matches ViewerPage.tsx's own pane wrapper div
                      exactly (position:relative, width/height:paneSize,
                      transform, transformOrigin: center center). */}
                  <div
                    data-pane={pane}
                    style={{
                      position: "relative",
                      width: paneSize,
                      height: paneSize,
                      transform: `translate(${zoom[pane].panX}px, ${zoom[pane].panY}px) scale(${zoom[pane].scale})`,
                      transformOrigin: "center center",
                      touchAction: "none",
                    }}
                  >
                    {pane === "axial" ? (
                      <canvas
                        ref={canvasRef}
                        width={TUTORIAL_SIZE}
                        height={TUTORIAL_SIZE}
                        style={{
                          width: paneSize,
                          height: paneSize,
                          display: "block",
                          cursor: reviewMode ? "default" : tool === "cursor" ? (zoom.axial.scale > 1 ? "grab" : "default") : "crosshair",
                        }}
                        onPointerDown={(e) => handlePanePointerDown(e, "axial")}
                        onPointerMove={handlePanePointerMove}
                        onPointerUp={handlePanePointerUp}
                        onPointerCancel={handlePanePointerUp}
                        onMouseEnter={() => (hoveredPaneRef.current = "axial")}
                        onDoubleClick={() => tool === "cursor" && setZoom((z) => ({ ...z, axial: IDLE_ZOOM }))}
                        onContextMenu={(e) => e.preventDefault()}
                      />
                    ) : (
                      <canvas
                        ref={pane === "sagittal" ? sagittalCanvasRef : coronalCanvasRef}
                        width={TUTORIAL_SIZE}
                        height={TUTORIAL_SLICES}
                        style={{
                          width: paneSize,
                          height: paneSize,
                          display: "block",
                          cursor: reviewMode ? "default" : tool === "cursor" ? (zoom[pane].scale > 1 ? "grab" : "default") : "crosshair",
                        }}
                        onPointerDown={(e) => handlePanePointerDown(e, pane)}
                        onPointerMove={handlePanePointerMove}
                        onPointerUp={handlePanePointerUp}
                        onPointerCancel={handlePanePointerUp}
                        onMouseEnter={() => (hoveredPaneRef.current = pane)}
                        onDoubleClick={() => tool === "cursor" && setZoom((z) => ({ ...z, [pane]: IDLE_ZOOM }))}
                        onContextMenu={(e) => e.preventDefault()}
                      />
                    )}
                    {/* Pixel math (sx/sy = paneSize / content dims), not
                        percentages -- exactly ViewerPage.tsx's own
                        renderAutoBoxOverlay/renderRoiBoxOutline. */}
                    {renderCrosshair(pane)}
                    {renderPolygonOverlay(pane)}
                    {autoPanel && autoPanel.pane === pane && (
                      <div
                        className="pointer-events-none absolute border-[1.5px] border-dashed border-amber-500"
                        style={boxOverlayStyle(pane, autoPanel.box)}
                      />
                    )}
                    {histogramDragBox && histogramDragBox.pane === pane && (
                      <div
                        className="pointer-events-none absolute border-[1.5px] border-dashed border-cyan-400"
                        style={boxOverlayStyle(pane, histogramDragBox.box)}
                      />
                    )}
                  </div>
                  {autoPanel && autoPanel.pane === pane && (
                    <div
                      className="fixed z-30 flex w-52 flex-col gap-2 rounded border border-[#444] bg-[#20203a] p-2.5 shadow-lg"
                      style={clampPopupPosition(autoPanel.panelClientX, autoPanel.panelClientY, 208, 190, 12)}
                    >
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-gray-300" title="The HU values the region may contain. Suggested from the box: everything denser than the lung around it, calcification included.">
                          HU range
                        </span>
                        <span className="font-mono text-amber-300" data-testid="auto-range">
                          {autoPanel.range.low} … {autoPanel.range.high >= HU_MAX ? "max" : autoPanel.range.high}
                        </span>
                      </div>
                      {(["low", "high"] as const).map((end) => (
                        <label key={end} className="flex items-center gap-1.5">
                          <span className="w-7 text-[10px] text-gray-500">{end === "low" ? "from" : "to"}</span>
                          <input
                            type="range"
                            min={HU_MIN}
                            max={HU_MAX}
                            step={10}
                            value={autoPanel.range[end]}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              const range = end === "low" ? { ...autoPanel.range, low: Math.min(v, autoPanel.range.high) } : { ...autoPanel.range, high: Math.max(v, autoPanel.range.low) };
                              applyAuto(autoPanel.pane, autoPanel.box, range, autoPanel.fillHoles);
                              setAutoPanel({ ...autoPanel, range });
                            }}
                            className="min-w-0 flex-1 accent-amber-500"
                            aria-label={end === "low" ? "Lowest HU in the region" : "Highest HU in the region"}
                            data-testid={`auto-range-${end}`}
                          />
                        </label>
                      ))}
                      <label className="flex items-center gap-1.5 text-[10px] text-gray-300" title="Also take whatever the region fully encloses -- a calcified core, an air bubble, a vessel seen end-on.">
                        <input
                          type="checkbox"
                          checked={autoPanel.fillHoles}
                          onChange={(e) => {
                            applyAuto(autoPanel.pane, autoPanel.box, autoPanel.range, e.target.checked);
                            setAutoPanel({ ...autoPanel, fillHoles: e.target.checked });
                          }}
                          data-testid="auto-fill-holes"
                        />
                        fill holes
                      </label>
                      <div className="flex justify-end gap-1.5">
                        <button onClick={cancelAuto} className="rounded border border-[#444] px-2 py-0.5 text-[11px] text-gray-300 hover:bg-[#2a2a3e]">
                          Cancel (Esc)
                        </button>
                        <button onClick={commitAuto} className="rounded border border-emerald-600 bg-emerald-600/20 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-600/30">
                          Apply (Enter)
                        </button>
                      </div>
                    </div>
                  )}
                  {histogram && histogramPane === pane && (
                    <div
                      className="fixed z-30 flex w-52 flex-col gap-1.5 rounded border border-[#444] bg-[#20203a] p-2.5 shadow-lg"
                      style={clampPopupPosition(histogramPanelPos.x, histogramPanelPos.y, 208, 150, 12)}
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-[11px] text-gray-300">Brightness in the box</p>
                        <button onClick={() => setHistogram(null)} className="text-gray-400 hover:text-white">
                          <CloseIcon />
                        </button>
                      </div>
                      <div className="flex h-16 items-end gap-0.5">
                        {histogram.buckets.map((b, i) => (
                          <div key={i} className="flex-1 rounded-sm bg-amber-400" style={{ height: `${(b / Math.max(...histogram.buckets, 1)) * 100}%` }} />
                        ))}
                      </div>
                      <p className="text-[10px] text-gray-500">
                        min {Math.round(histogram.min)} · mean {Math.round(histogram.mean)} · max {Math.round(histogram.max)} HU
                      </p>
                    </div>
                  )}
                </PaneBox>
              );
            })}
            {visiblePaneKeys.includes("three_d") && (
              // Same as the real viewer: alongside the MPR panes a
              // paneSize square, alone the whole row.
              <div className={`flex flex-col bg-black ${only3d ? "min-w-0 flex-1 self-stretch" : "flex-shrink-0"}`} style={only3d ? undefined : { width: paneSize }}>
                <PaneHeader label="3D" maximized={maximizedPane === "three_d"} onMaximize={() => toggleMaximized("three_d")} onHide={() => togglePaneVisible("three_d")} />
                <div className="relative min-h-0 flex-1 overflow-hidden bg-black" style={only3d ? undefined : { height: paneSize }}>
                  <Viewer3D
                    maskVolume={maskRef.current}
                    rows={TUTORIAL_SIZE}
                    columns={TUTORIAL_SIZE}
                    numSlices={TUTORIAL_SLICES}
                    labels={labels}
                    objects={objects.map((o) => ({ id: o.id, label_id: o.labelId, hidden: o.hidden }))}
                    refreshKey={maskVersion}
                    seriesId={null}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-shrink-0 items-center justify-between bg-black/60 px-3 py-1 text-[11px] text-gray-500" data-guide="footer">
            <span className="truncate">
              {coarse
                ? reviewMode
                  ? "Review · look, decide, comment -- nothing here draws · Pinch=Zoom · Long-press=HU value · Two-finger tap=Jump all planes"
                  : `${TOOL_HELP[tool]} · Pinch=Zoom · Two-finger drag=Pan · Long-press=HU value · Double-tap=Reset · Two-finger tap=Jump all planes`
                : reviewMode
                  ? "Review · look, decide, comment -- nothing here draws · Scroll=Slice · Ctrl+Scroll=Zoom · Right/middle-drag=Window · Alt+click=HU value · ?=All keys"
                  : `${TOOL_HELP[tool]} · Scroll=Slice · Ctrl+Scroll=Zoom · ${tool === "cursor" ? "Right" : "Middle"}-drag=Window · Ctrl+click=Jump all planes · Alt+click=HU value · ?=All keys`}
            </span>
            <span className="flex-shrink-0 whitespace-nowrap">{activeLabel && activeObject ? `Active: ${activeLabel.name} ${activeObject.instanceNumber}` : ""}</span>
          </div>
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
          {reviewMode ? (
            <>
              <SidebarSection title="Review" guide="review-card">
                {currentReviewObject ? (
                  <ReviewCard
                    object={currentReviewObject}
                    label={labelsById.get(currentReviewObject.labelId) ?? null}
                    index={clampedReviewIndex}
                    total={reviewObjects.length}
                    onComment={(text) => setObjects((prev) => prev.map((o) => (o.id === currentReviewObject.id ? { ...o, comment: text } : o)))}
                    formFields={labelsById.get(currentReviewObject.labelId)?.fields ?? []}
                    onForm={(next) => setObjects((prev) => prev.map((o) => (o.id === currentReviewObject.id ? { ...o, attributes: next } : o)))}
                    onDecide={decide}
                    onPrev={() => setReviewIndex(Math.max(0, clampedReviewIndex - 1))}
                    onNext={() => setReviewIndex(Math.min(reviewObjects.length - 1, clampedReviewIndex + 1))}
                  />
                ) : (
                  <p className="text-[11px] text-gray-500">No objects to review.</p>
                )}
              </SidebarSection>
              <SidebarSection title="Objects" guide="review-objects">
                <ul className="flex flex-col">
                  {reviewObjects.map((o) => {
                    const label = labelsById.get(o.labelId);
                    const dot = o.reviewStatus === "accepted" ? "bg-emerald-500" : o.reviewStatus === "rejected" ? "bg-red-500" : "bg-gray-500";
                    return (
                      <li
                        key={o.id}
                        onClick={() => setReviewIndex(reviewObjects.findIndex((x) => x.id === o.id))}
                        className={`flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors ${
                          o.id === currentReviewObject?.id ? "bg-amber-500/20 text-amber-200" : "text-gray-400 hover:bg-[#2a2a3e]"
                        }`}
                      >
                        <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: label?.color ?? "#666" }} />
                        <span className="flex-1 truncate">
                          {label?.name ?? "?"} {o.instanceNumber}
                        </span>
                        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dot}`} />
                      </li>
                    );
                  })}
                </ul>
              </SidebarSection>
            </>
          ) : (
            <SidebarSection title="Objects" guide="objects" help="A label is a kind of structure; an object is one instance of it. Click an object to draw into it; + adds an instance; eye hides, bin deletes.">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addLabel(newLabelName);
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
                <button type="submit" className="rounded border border-[#444] bg-[#2a2a3e] px-2 text-gray-300 hover:bg-[#333]" title="Add label">
                  <PlusIcon />
                </button>
              </form>
              <div className="flex flex-col gap-2">
                {labels.map((label) => {
                  const labelObjects = objects.filter((o) => o.labelId === label.id);
                  return (
                    <div key={label.id} className="rounded border border-[#333]">
                      <div className="flex items-center gap-1.5 bg-[#252538] px-2 py-1.5">
                        <span className="h-3.5 w-3.5 flex-shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
                        <span className="flex-1 truncate text-[11px] font-medium text-gray-200">{label.name}</span>
                        <Tip title={`New ${label.name} instance`} description="Adds an object of this label and selects it." side="left">
                          <button onClick={() => createObject(label.id)} aria-label={`New ${label.name} instance`} className="text-gray-400 hover:text-white">
                            <PlusIcon />
                          </button>
                        </Tip>
                        <button onClick={() => deleteLabel(label.id)} className="text-gray-400 hover:text-red-400" title="Delete label">
                          <TrashIcon />
                        </button>
                      </div>
                      {labelObjects.length > 0 && (
                        <ul className="flex flex-col">
                          {labelObjects.map((obj) => {
                            const formOpen = openForms.has(obj.id);
                            const filled = Boolean(obj.comment.trim() || formatAnswers(obj.attributes));
                            return (
                            <li key={obj.id} className="flex flex-col">
                            <div
                              data-testid={`object-${obj.id}`}
                              onClick={() => setActiveObjectId(obj.id)}
                              onMouseDown={(e) => {
                                // Suppress the browser's double-click text
                                // selection so it doesn't compete with the
                                // pane-jump below.
                                if (e.detail > 1) e.preventDefault();
                              }}
                              onDoubleClick={() => {
                                setActiveObjectId(obj.id);
                                jumpToObject(obj.id);
                              }}
                              title="Click to select · double-click to jump all panes here"
                              className={`flex cursor-pointer select-none items-center gap-1.5 px-2 py-1 text-[11px] transition-colors ${
                                obj.id === activeObjectId ? "bg-amber-500/20 text-amber-200" : "text-gray-400 hover:bg-[#2a2a3e]"
                              }`}
                            >
                              <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: label.color, opacity: obj.hidden ? 0.3 : 1 }} />
                              <span className="flex-1 truncate">
                                {label.name} {obj.instanceNumber}
                              </span>
                              <ObjectFormTab open={formOpen} filled={filled} onToggle={() => toggleForm(obj.id)} testId={`form-toggle-${obj.id}`} />
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setObjects((prev) => prev.map((o) => (o.id === obj.id ? { ...o, hidden: !o.hidden } : o)));
                                }}
                                className="text-gray-500 hover:text-white"
                                title={obj.hidden ? "Show" : "Hide"}
                              >
                                <EyeIcon visible={!obj.hidden} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleObjectLock(obj.id);
                                }}
                                className={obj.locked ? "text-amber-400 hover:text-white" : "text-gray-500 hover:text-white"}
                                title={obj.locked ? "Unlock" : "Lock (protects it from accidental edits)"}
                              >
                                <LockIcon locked={obj.locked} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteObject(obj.id);
                                }}
                                className="text-gray-500 hover:text-red-400"
                                title="Delete"
                              >
                                <TrashIcon />
                              </button>
                            </div>
                            {formOpen && (
                              <div className="flex flex-col gap-1.5 border-t border-[#333] bg-[#1b1b2f] px-2 py-1.5" data-testid={`object-form-${obj.id}`}>
                                <ObjectFormEditor
                                  fields={label.fields ?? []}
                                  answers={obj.attributes}
                                  onChange={(next) => setObjects((prev) => prev.map((o) => (o.id === obj.id ? { ...o, attributes: next } : o)))}
                                  accent="amber"
                                />
                                <textarea
                                  value={obj.comment}
                                  onChange={(e) => setObjects((prev) => prev.map((o) => (o.id === obj.id ? { ...o, comment: e.target.value } : o)))}
                                  placeholder="Comment…"
                                  rows={2}
                                  data-testid={`comment-${obj.id}`}
                                  className="w-full resize-none rounded border border-[#444] bg-[#2a2a3e] p-1.5 text-[11px] text-gray-200 placeholder:text-gray-500"
                                />
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
            </SidebarSection>
          )}

          <SidebarSection title="Appearance" guide="appearance" help="How strongly the coloured annotation overlay is drawn over the scan. Display only -- nothing about the annotation changes.">
            <SliderRow
              label="Overlay opacity"
              help="0% hides the annotation, 100% covers the scan completely."
              value={overlayOpacity}
              min={0}
              max={100}
              onChange={setOverlayOpacity}
              suffix="%"
            />
            <label className="mt-2 flex items-center gap-2 text-[11px] text-gray-300" title="Coloured lines where the other two planes cut each pane, left open in the middle so they never cover the point you are looking at. Shortcut: C">
              <input type="checkbox" checked={showCrosshair} onChange={(e) => setShowCrosshair(e.target.checked)} data-testid="crosshair-toggle" />
              Crosshair <span className="text-gray-500">(C)</span>
            </label>
          </SidebarSection>

          <SidebarSection title="Window / level" guide="window" help="The greyscale mapping of Hounsfield units: pick the preset for the tissue you're looking at, fine-tune with the sliders, or drag on the image with the right mouse button (Cursor tool) or the middle button (any tool): up/down moves the level, left/right the width. Display only.">
            <div className="mb-3 flex flex-wrap gap-1.5">
              {WINDOW_PRESETS.map((preset) => (
                <Tip key={preset.label} title={`${preset.label} window`} description={`${PRESET_HELP[preset.label] ?? ""} Center ${preset.center}, width ${preset.width}.`} side="left">
                  <button
                    onClick={() => {
                      setWindowCenter(preset.center);
                      setWindowWidth(preset.width);
                    }}
                    className={`rounded border px-2 py-1 text-[11px] transition-colors ${
                      windowCenter === preset.center && windowWidth === preset.width ? "border-amber-500 bg-amber-500/20 text-amber-300" : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"
                    }`}
                  >
                    {preset.label}
                  </button>
                </Tip>
              ))}
            </div>
            <SliderRow label="Center" help="The HU value shown as mid-grey (window level)." value={windowCenter} min={-1000} max={1000} onChange={setWindowCenter} />
            <SliderRow label="Width" help="The HU range from black to white (window width): narrow = more contrast." value={windowWidth} min={1} max={4000} onChange={setWindowWidth} />
          </SidebarSection>

          <SidebarSection title="Slab" guide="slab" help="Makes each pane a thick slice: several neighbouring slices averaged, or their brightest (MIP) or darkest (MinIP) voxel. Display only -- drawing still lands on the centre slice.">
            <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label="Slab thickness">
              {SLAB_THICKNESSES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSlab((prev) => ({ ...prev, thickness: t }))}
                  className={`rounded border px-2 py-1 font-mono text-[11px] transition-colors ${
                    slab.thickness === t ? "border-amber-500 bg-amber-500/20 text-amber-300" : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"
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
                    onClick={() => setSlab((prev) => ({ mode: m, thickness: prev.thickness > 1 ? prev.thickness : 5 }))}
                    className={`flex-1 rounded border px-2 py-1 text-[11px] transition-colors ${
                      slab.thickness > 1 && slab.mode === m ? "border-amber-500 bg-amber-500/20 text-amber-300" : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"
                    }`}
                    aria-pressed={slab.thickness > 1 && slab.mode === m}
                    data-testid={`slab-mode-${m}`}
                  >
                    {SLAB_LABEL[m]}
                  </button>
                </Tip>
              ))}
            </div>
          </SidebarSection>

          <SidebarSection title="Sharpness" guide="sharpness" help="Enhances edges in the displayed image to make boundaries easier to follow. Display only.">
            <SliderRow label="Edge enhancement" help="0 is the original image; higher values sharpen boundaries." value={sharpness} min={0} max={5} step={0.1} onChange={setSharpness} />
          </SidebarSection>

          <Tip title="Reset to original" description="Back to the scan's own window/level and an unsharpened image." side="left">
            <span className="mb-1 flex">
              <button
                onClick={() => {
                  setWindowCenter(DEFAULT_CENTER);
                  setWindowWidth(DEFAULT_WIDTH);
                  setSharpness(0);
                  setSlab({ thickness: 1, mode: "avg" });
                }}
                disabled={originalAdjustment && slab.thickness === 1}
                className="rounded border border-[#444] px-2 py-1 text-[11px] text-gray-300 hover:bg-[#2a2a3e] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Reset to original
              </button>
            </span>
          </Tip>

          {!reviewMode && (
            <SidebarSection title="Draw" guide="draw" help="Settings for the Paint and Eraser tools, and a quick way to wipe one slice of the active object.">
              <SliderRow label="Brush size" help="Radius of the Paint and Eraser brush, in screen pixels." value={brushRadius} min={2} max={30} onChange={setBrushRadius} suffix="px" />
              <Tip title="Clear hovered slice" description="Wipes the active object's paint on the slice under the mouse only (whichever pane you last hovered). Undo brings it back." side="left">
                <span className="flex">
                  <button
                    onClick={clearHoveredSlice}
                    disabled={!activeObjectId || !hasAnyPaint}
                    className="mt-1 rounded border border-[#444] bg-[#2a2a3e] px-3 py-1.5 text-[11px] text-gray-300 transition-colors hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Clear hovered slice
                  </button>
                </span>
              </Tip>
            </SidebarSection>
          )}
          <SidebarSection title="Saved versions" help="Every save of this practice case, with its status: draft, or submitted (after Mark as Practice-Annotated). Practice only -- nothing leaves this page.">
            {savedVersions.length === 0 ? (
              <p className="text-[11px] text-gray-500">None yet.</p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="saved-versions">
                {savedVersions.map((v) => (
                  <li key={v.n} className="flex items-center justify-between text-[11px] text-gray-400">
                    <span>
                      Practice · version {v.n} · {v.at}
                    </span>
                    <span className="rounded bg-[#2a2a3e] px-1.5 py-0.5 text-[10px] text-gray-300">{v.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </SidebarSection>
        </aside>
        )}
      </div>

      {huReadout && (
        <div className="pointer-events-none fixed z-50 rounded bg-black/85 px-2 py-1 text-xs text-amber-200" style={{ left: huReadout.x + 10, top: huReadout.y + 10 }}>
          {huReadout.text}
        </div>
      )}

      {openDoc && <DocumentPanel doc={openDoc} onClose={() => setOpenDoc(null)} compact={compact} coarse={coarse} />}

      <GuideTour key={`${phase}-${runId}`} steps={guideSteps} open={guideOpen} onClose={() => setGuideOpen(false)} />
      {keysOpen && <KeyboardHelp mode={phase === "review" ? "review" : "annotate"} touch={coarse} onClose={closeKeys} />}
    </div>
  );
}

/** One pane's slice control -- rendered inside the pane on a compact
 * layout and in the shared row below the panes otherwise. */
/** A pane's slice control, standing along its right edge like the real
 * viewer's (SliceControl's vertical variant). */
function PaneSlider({ cfg, guide, label }: { cfg: { index: number; max: number; setIndex: (n: number) => void }; guide?: string; label: string }) {
  return (
    <SliceControl
      index={cfg.index}
      max={cfg.max}
      onChange={cfg.setIndex}
      label={label}
      guide={guide}
      accentClass="accent-amber-500"
      orientation="vertical"
      counter={<SliceNumber index={cfg.index} className="text-gray-500" />}
    />
  );
}

/** A pane's label row with the same Maximize/Restore and Hide buttons
 * the real viewer's panes carry. */
function PaneHeader({ label, maximized, onMaximize, onHide, color, badge }: { label: string; maximized: boolean; onMaximize: () => void; onHide: () => void; color?: string; badge?: string }) {
  return (
    <div className="flex flex-shrink-0 items-center justify-center gap-1.5 bg-[#111] py-1">
      {color && <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />}
      <span className="text-center text-[11px] uppercase tracking-wider text-gray-400">{label}</span>
      {badge && (
        <span className="rounded bg-[#2a2a3e] px-1 font-mono text-[10px] text-amber-300" data-testid="pane-slab">
          {badge}
        </span>
      )}
      <button onClick={onMaximize} className="text-gray-500 hover:text-white" title={maximized ? "Restore" : "Maximize"} data-testid="pane-maximize">
        {maximized ? <FullscreenExitIcon /> : <FullscreenIcon />}
      </button>
      <button onClick={onHide} className="text-gray-500 hover:text-white" title="Hide this pane" data-testid="pane-hide">
        <EyeIcon visible={true} />
      </button>
    </div>
  );
}

function PaneBox({
  label,
  size,
  slider,
  stripWidth,
  color,
  badge,
  maximized,
  onMaximize,
  onHide,
  children,
}: {
  label: string;
  size: number;
  slider?: React.ReactNode;
  stripWidth: number;
  color?: string;
  badge?: string;
  maximized: boolean;
  onMaximize: () => void;
  onHide: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-shrink-0 flex-col bg-black" style={{ width: size + stripWidth }}>
      <PaneHeader label={label} maximized={maximized} onMaximize={onMaximize} onHide={onHide} color={color} badge={badge} />
      <div className="flex min-h-0 flex-1">
      {/* A fixed size x size box, centred in whatever vertical space
          this pane got -- matches the real viewer's own pane container
          exactly (see ViewerPage.tsx's "flex flex-1 items-center
          justify-center overflow-hidden" pane div), which is also what
          keeps the drag-box overlays (children here) sharing the exact
          same pixel coordinate space as the canvas instead of a CSS
          percentage that could drift from it once zoomed. */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">{children}</div>
      {/* The slice control along the image's right edge, first slice at
          the top -- the same as the real viewer. */}
      <div className="flex flex-shrink-0 flex-col border-l border-[#333] bg-[#15152a]" style={{ width: stripWidth }}>
        {slider}
      </div>
      </div>
    </div>
  );
}

function SidebarSection({ title, help, guide, children }: { title: string; help?: string; guide?: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[#333] pb-3" data-guide={guide}>
      <div className="mb-2 flex items-center gap-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{title}</p>
        {help && (
          <Tip title={title} description={help} side="left" tapToggle>
            <span className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-[#444] text-[9px] leading-none text-gray-500 hover:border-gray-400 hover:text-gray-300">?</span>
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
      <input type="range" min={min} max={max} step={step ?? 1} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-amber-500" />
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
  children: React.ReactNode;
}) {
  return (
    <Tip title={title} description={description} shortcut={shortcut}>
      <span className="flex">
        <button onClick={onClick} disabled={disabled} aria-label={title} className="flex h-7 w-7 items-center justify-center rounded border border-[#444] bg-[#2a2a3e] text-gray-300 transition-colors hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-40">
          {children}
        </button>
      </span>
    </Tip>
  );
}

function ReviewCard({
  object,
  label,
  index,
  total,
  onComment,
  formFields,
  onForm,
  onDecide,
  onPrev,
  onNext,
}: {
  object: TutObject;
  label: TutLabel | null;
  index: number;
  total: number;
  onComment: (text: string) => void;
  formFields: ObjectField[];
  onForm: (next: ObjectAnswers) => void;
  onDecide: (status: "accepted" | "rejected") => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const statusStyle: Record<string, string> = {
    pending: "text-gray-400 border-[#444]",
    accepted: "text-emerald-400 border-emerald-600",
    rejected: "text-red-400 border-red-600",
  };
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-gray-500">
        <span>
          {index + 1} / {total}
        </span>
        <span className={`rounded border px-1.5 py-0.5 uppercase tracking-wide ${statusStyle[object.reviewStatus]}`}>{object.reviewStatus}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        {label && <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: label.color }} />}
        <span className="truncate text-sm font-medium text-gray-100">
          {label ? `${label.name} ${object.instanceNumber}` : "—"}
        </span>
      </div>
      <div className="mt-1.5">
        <ObjectFormEditor fields={formFields} answers={object.attributes} onChange={onForm} accent="amber" />
      </div>
      <textarea
        value={object.comment}
        onChange={(e) => onComment(e.target.value)}
        placeholder="Comment for the annotator…"
        rows={2}
        className="mt-1.5 w-full resize-none rounded border border-[#444] bg-[#2a2a3e] p-1.5 text-[11px] text-amber-200 placeholder:text-gray-500"
      />
      <div className="mt-3 flex items-center justify-between gap-1.5">
        <button onClick={onPrev} disabled={index === 0} className="flex h-7 w-7 items-center justify-center rounded border border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-30">
          <ChevronLeftIcon />
        </button>
        <button onClick={() => onDecide("rejected")} className="flex flex-1 items-center justify-center gap-1 rounded border border-red-600 bg-red-600/20 py-1.5 text-xs font-medium text-red-300 hover:bg-red-600/30">
          <CloseIcon />
          Reject
        </button>
        <button onClick={() => onDecide("accepted")} className="flex flex-1 items-center justify-center gap-1 rounded border border-emerald-600 bg-emerald-600/20 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-600/30">
          <CheckIcon />
          Accept
        </button>
        <button onClick={onNext} disabled={index === total - 1} className="flex h-7 w-7 items-center justify-center rounded border border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-30">
          <ChevronRightIcon />
        </button>
      </div>
    </div>
  );
}

// ── Small inline SVG icons (matching the real viewer's set) ──────────────

function EyeIcon({ visible }: { visible: boolean }) {
  return visible ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M6.5 6.7C4 8.3 2 12 2 12s4 7 10 7c1.6 0 3-.4 4.3-1.1M9.9 5.2A9.4 9.4 0 0 1 12 5c6 0 10 7 10 7a15.6 15.6 0 0 1-2.1 2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
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

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      {locked ? <path d="M8 11V8a4 4 0 0 1 8 0v3" /> : <path d="M8 11V8a4 4 0 0 1 7-2.6" />}
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
