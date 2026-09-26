/** Every shortcut and gesture the viewer (and the tutorial) knows, in one
 * place -- what the "?" help shows (components/KeyboardHelp.tsx). The
 * footer's one-line hint only fits a few; nothing listed them all (UX:
 * "keyboard map"). Keep in step with ViewerPage's keydown handler. */

export interface KeyEntry {
  /** each alternative, e.g. ["Ctrl+Z"] or ["←", "→"] */
  keys: string[];
  what: string;
  /** the touch-screen way to do it, when there is one */
  touch?: string;
  /** only where it applies; both when omitted */
  mode?: "annotate" | "review";
  /** the real viewer only (the tutorial has no such tool) */
  viewerOnly?: boolean;
}

export interface KeyGroup {
  title: string;
  entries: KeyEntry[];
}

export const KEYMAP: KeyGroup[] = [
  {
    title: "Moving through the scan",
    entries: [
      { keys: ["Scroll", "←", "→"], what: "Previous / next slice of the pane under the pointer", touch: "Arrows or slider beside the pane" },
      { keys: ["Ctrl+Scroll", "↑", "↓"], what: "Zoom in / out where the pointer is", touch: "Pinch" },
      { keys: ["Drag", "W A S D"], what: "Move the image around once zoomed in", touch: "Two-finger drag" },
      { keys: ["Double-click"], what: "Reset the pane's zoom", touch: "Double-tap" },
      { keys: ["Ctrl+click"], what: "Jump every pane to this point", touch: "Two-finger tap" },
      { keys: ["C"], what: "Crosshair on / off" },
    ],
  },
  {
    title: "Looking closer",
    entries: [
      { keys: ["Right-drag", "Middle-drag"], what: "Window / level: sideways for width, up and down for level (with a drawing tool: middle-drag)" },
      { keys: ["Alt+click"], what: "The HU value at this point", touch: "Long-press" },
      { keys: ["M"], what: "Ruler: drag on a pane to measure in mm; Esc clears the line", viewerOnly: true },
      { keys: ["O"], what: "Draw the annotation filled or as an outline" },
      { keys: ["G"], what: "Round 2 of a review: the last round's outline on / off", mode: "review", viewerOnly: true },
      { keys: ["Space (hold)"], what: "Hide the annotation while held, to see the scan under it" },
    ],
  },
  {
    title: "Drawing",
    entries: [
      { keys: ["N"], what: "New object of the selected label", mode: "annotate" },
      { keys: ["Ctrl+Z"], what: "Undo the last paint, erase, fill or outline", mode: "annotate" },
      { keys: ["Ctrl+Shift+Z", "Ctrl+Y"], what: "Redo", mode: "annotate" },
      { keys: ["Right-drag"], what: "Erase while painting (when the surface allows erasing)", mode: "annotate" },
      { keys: ["Enter"], what: "Close the open outline / apply the auto-contour preview", mode: "annotate" },
      { keys: ["Esc"], what: "Drop the open outline / cancel the auto-contour box", mode: "annotate" },
      { keys: ["Right-click"], what: "Leave a comment at this point", mode: "annotate" },
    ],
  },
  {
    title: "3D view",
    entries: [
      { keys: ["Click"], what: "Start flying (then: pick the point in the middle)", touch: "Tap: pick that point", viewerOnly: true },
      { keys: ["Mouse"], what: "Look around while flying", touch: "Drag", viewerOnly: true },
      { keys: ["W A S D"], what: "Fly forward, back, left, right", touch: "The on-screen stick", viewerOnly: true },
      { keys: ["Space", "Shift"], what: "Fly up / down", viewerOnly: true },
      { keys: ["Wheel"], what: "Flying speed (orbiting: zoom)", viewerOnly: true },
      { keys: ["R"], what: "Back in front of the patient", viewerOnly: true },
      { keys: ["Esc"], what: "Let go of the mouse", viewerOnly: true },
    ],
  },
  {
    title: "Help",
    entries: [{ keys: ["?"], what: "This list" }],
  },
];

/** The groups for one mode: entries of the other mode left out, empty
 * groups dropped. */
export function keymapFor(mode: "annotate" | "review", where: "viewer" | "tutorial" = "viewer"): KeyGroup[] {
  return KEYMAP.map((g) => ({ ...g, entries: g.entries.filter((e) => (!e.mode || e.mode === mode) && (!e.viewerOnly || where === "viewer")) })).filter(
    (g) => g.entries.length > 0,
  );
}

/** "?" (Shift+/ on most layouts), not while typing, not with Ctrl/Alt. */
export function isHelpKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey;
}
