import { ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useCoarsePointer } from "../lib/touch";
import { trackAction } from "../usage/tracker";

/** One stop of a guided tour. `target` names a `data-guide="..."`
 * attribute on the page; the tour spotlights that element and docks the
 * assistant's card next to it. A step without a target (or whose target
 * isn't on screen right now) is shown centred / skipped respectively. */
export interface GuideStep {
  target?: string;
  title: string;
  body: ReactNode;
  /** Path under /guide/ in the public folder, e.g. "viewer-toolbar.png". */
  image?: string;
  /** Preferred side of the target for the card; flips when out of room. */
  placement?: "right" | "left" | "bottom" | "top";
  /** A short "try it" hint rendered under the body. */
  tip?: string;
  /** On a touch screen (coarse pointer): the body and tip to show instead,
   * naming the gestures a tablet actually has -- the mouse/keyboard text
   * sent tablet users to scroll, right-drag and press keys (G-08). */
  touchBody?: ReactNode;
  touchTip?: string;
}

const CARD_WIDTH = 380;
const GAP = 14;
const PAD = 6;

/** The assistant-led walkthrough: a dimmed page with a cut-out spotlight
 * over the current step's element, and a card where the guide explains
 * it. Keyboard: → / Enter next, ← back, Esc closes. The overlay blocks
 * the page underneath while open so a click can't wander off mid-tour;
 * the Tutorial button brings it back any time. */
export default function GuideTour({
  steps,
  open,
  onClose,
  assistantName = "VoxelLabel Guide",
}: {
  steps: GuideStep[];
  open: boolean;
  onClose: () => void;
  assistantName?: string;
}) {
  const [index, setIndex] = useState(0);
  const coarse = useCoarsePointer();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });

  // Only steps whose target exists on this page right now count -- a
  // job without documents, or a surface with no 3D pane, just has fewer
  // stops.
  // Which targets are on the page right now -- re-checked by the same
  // poll that keeps the spotlight aligned, so an element that only
  // appears after data loads (a series list, a reviewer comment) still
  // gets its step instead of being dropped at open time.
  const [present, setPresent] = useState<string>("");
  const visibleSteps = useMemo(() => {
    if (!open) return steps;
    const set = new Set(present.split("|"));
    return steps.filter((s) => !s.target || set.has(s.target));
  }, [steps, open, present]);

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  // Take the first inventory of targets synchronously when the tour
  // opens, so the first render already has the right step count.
  useLayoutEffect(() => {
    if (!open) return;
    const targets = Array.from(document.querySelectorAll("[data-guide]"))
      .map((el) => el.getAttribute("data-guide") ?? "")
      .filter(Boolean)
      .sort()
      .join("|");
    setPresent(targets);
  }, [open]);

  const step = visibleSteps[Math.min(index, visibleSteps.length - 1)];
  const body = coarse && step?.touchBody ? step.touchBody : step?.body;
  const tip = coarse && step?.touchBody ? step.touchTip : step?.tip;
  const isLast = index >= visibleSteps.length - 1;

  const measure = useCallback(() => {
    setViewport({ w: window.innerWidth, h: window.innerHeight });
    const targets = Array.from(document.querySelectorAll("[data-guide]"))
      .map((el) => el.getAttribute("data-guide") ?? "")
      .filter(Boolean)
      .sort()
      .join("|");
    setPresent((prev) => (prev === targets ? prev : targets));
    if (!step?.target) {
      setRect(null);
      return;
    }
    const el = document.querySelector(`[data-guide="${step.target}"]`) as HTMLElement | null;
    if (!el) {
      setRect(null);
      return;
    }
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    setRect(el.getBoundingClientRect());
  }, [step]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    // Layout can shift after images load / panels animate; a slow poll
    // keeps the spotlight glued to its element without a ResizeObserver
    // per target.
    const poll = window.setInterval(measure, 500);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.clearInterval(poll);
    };
  }, [open, measure]);

  // Tutorial funnel for the Usage page: opened, finished, or left at
  // which step. The tracker drops these while recording is off.
  useEffect(() => {
    if (open) trackAction("guide.open", { steps: visibleSteps.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [open]);
  const skip = useCallback(() => {
    trackAction("guide.skip", { step: index, steps: visibleSteps.length });
    onClose();
  }, [index, visibleSteps.length, onClose]);
  const next = useCallback(() => {
    if (isLast) {
      trackAction("guide.finish", { steps: visibleSteps.length });
      onClose();
    } else setIndex((i) => i + 1);
  }, [isLast, onClose, visibleSteps.length]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") skip();
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") back();
      else return;
      e.preventDefault();
      e.stopPropagation();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, next, back, skip]);

  if (!open || !step) return null;

  const cardStyle = placeCard(rect, step.placement, viewport);

  return createPortal(
    <div className="fixed inset-0 z-[60]" data-guide-overlay="">
      {rect ? (
        <div
          className="pointer-events-none fixed rounded-lg ring-2 ring-sky-400/90 transition-all duration-200"
          style={{
            left: rect.left - PAD,
            top: rect.top - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgba(8, 8, 20, 0.72)",
          }}
        />
      ) : (
        <div className="fixed inset-0 bg-[#080814]/80" />
      )}
      {/* Click-catcher so the page underneath stays inert while the tour is open. */}
      <div className="fixed inset-0" onClick={(e) => e.stopPropagation()} />

      <div
        role="dialog"
        aria-label={`${assistantName}: ${step.title}`}
        className="fixed flex flex-col overflow-hidden rounded-xl border border-[#3d3d5c] bg-[#1e1e2e] text-gray-200 shadow-2xl"
        style={{ width: CARD_WIDTH, ...cardStyle }}
      >
        <div className="flex items-center gap-2.5 border-b border-[#2f2f48] bg-[#23233a] px-4 py-2.5">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-indigo-600 text-white shadow-inner">
            <SparkIcon />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-gray-100">{assistantName}</p>
            <p className="text-[10px] text-gray-500">
              Step {index + 1} of {visibleSteps.length}
            </p>
          </div>
          <button onClick={skip} className="rounded px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-[#2a2a3e] hover:text-gray-200" title="Close the tour (Esc)">
            Skip tour
          </button>
        </div>

        {step.image && (
          <img
            src={`/guide/${step.image}`}
            alt=""
            className="max-h-44 w-full border-b border-[#2f2f48] bg-black object-cover object-top"
            onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
          />
        )}

        <div className="flex flex-col gap-2 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-50">{step.title}</h2>
          <div className="text-[12px] leading-relaxed text-gray-300 [&_p+p]:mt-1.5 [&_b]:text-gray-100 [&_kbd]:rounded [&_kbd]:border [&_kbd]:border-[#4a4a6a] [&_kbd]:bg-[#2a2a3e] [&_kbd]:px-1 [&_kbd]:font-mono [&_kbd]:text-[10px]">
            {typeof body === "string" ? <p>{body}</p> : body}
          </div>
          {tip && (
            <p className="rounded-md border border-sky-900/60 bg-sky-950/40 px-2.5 py-1.5 text-[11px] text-sky-200">
              <span className="font-semibold">Try it:</span> {tip}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[#2f2f48] px-4 py-2.5">
          <div className="flex items-center gap-1">
            {visibleSteps.map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all ${i === index ? "w-4 bg-sky-400" : "w-1.5 bg-[#3d3d5c]"}`} />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={back}
              disabled={index === 0}
              className="rounded border border-[#444] px-2.5 py-1 text-[11px] text-gray-300 hover:bg-[#2a2a3e] disabled:cursor-not-allowed disabled:opacity-30"
            >
              Back
            </button>
            <button onClick={next} className="rounded border border-sky-500 bg-sky-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-sky-600" data-guide-next="">
              {isLast ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Picks where the card goes: next to the spotlight on the preferred
 * side if there's room, otherwise the first side that fits, otherwise
 * centred. Returns fixed-position CSS. */
function placeCard(rect: DOMRect | null, preferred: GuideStep["placement"], vp: { w: number; h: number }): { left: number; top: number } {
  const cardH = 420; // generous estimate; the card is clamped into the viewport anyway
  if (!rect) return { left: Math.max(8, (vp.w - CARD_WIDTH) / 2), top: Math.max(8, (vp.h - cardH) / 2) };
  const order: NonNullable<GuideStep["placement"]>[] = [preferred ?? "right", "right", "bottom", "left", "top"];
  const fits = {
    right: rect.right + GAP + CARD_WIDTH <= vp.w,
    left: rect.left - GAP - CARD_WIDTH >= 0,
    bottom: rect.bottom + GAP + cardH <= vp.h,
    top: rect.top - GAP - cardH >= 0,
  };
  const side = order.find((s) => fits[s]) ?? "right";
  let left: number;
  let top: number;
  switch (side) {
    case "right":
      left = rect.right + GAP;
      top = rect.top;
      break;
    case "left":
      left = rect.left - GAP - CARD_WIDTH;
      top = rect.top;
      break;
    case "bottom":
      left = rect.left;
      top = rect.bottom + GAP;
      break;
    default:
      left = rect.left;
      top = rect.top - GAP - cardH;
  }
  left = Math.max(8, Math.min(left, vp.w - CARD_WIDTH - 8));
  top = Math.max(8, Math.min(top, vp.h - Math.min(cardH, vp.h - 16) - 8));
  return { left, top };
}

function SparkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10 2l1.8 4.7L16.5 8.5l-4.7 1.8L10 15l-1.8-4.7L3.5 8.5l4.7-1.8L10 2zm6 9l.9 2.3 2.3.9-2.3.9L16 17.4l-.9-2.3-2.3-.9 2.3-.9L16 11zM4 12l.7 1.8 1.8.7-1.8.7L4 17l-.7-1.8-1.8-.7 1.8-.7L4 12z" />
    </svg>
  );
}
