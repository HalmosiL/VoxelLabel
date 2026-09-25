import { ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { trackAction } from "../usage/tracker";

/** One stop of a guided tour. `target` names a `data-guide="..."`
 * attribute on the page; the tour spotlights that element and docks the
 * assistant's card next to it. A step without a target is shown centred;
 * one whose target isn't on the page right now is skipped. */
export interface GuideStep {
  target?: string;
  title: string;
  body: ReactNode;
  /** File under public/guide/, e.g. "workbench-jobs.png". */
  image?: string;
  placement?: "right" | "left" | "bottom" | "top";
  tip?: string;
}

const CARD_WIDTH = 380;
const GAP = 14;
const PAD = 6;

/** The assistant-led walkthrough (light-theme twin of the viewer's): a
 * dimmed page with a cut-out spotlight over the current step's element
 * and a card where the guide explains it. → / Enter next, ← back, Esc
 * closes. The page underneath stays inert while the tour is open. */
/** The data-guide targets a step can really point at: on the page and not
 * parked off screen sideways -- the compact layout's closed
 * sidebar drawer sits at x = -256, and its steps were shown with the
 * spotlight off screen (G-20). Vertically off screen is fine: the tour
 * scrolls a target into view. */
function onScreenTargets(): string {
  return Array.from(document.querySelectorAll("[data-guide]"))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      // only a target measurably parked sideways is dropped (an unmeasured one -- no layout -- stays)
      return !(r.width > 0 && (r.right <= 0 || r.left >= window.innerWidth));
    })
    .map((el) => el.getAttribute("data-guide") ?? "")
    .filter(Boolean)
    .sort()
    .join("|");
}

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
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  // the card's real height, for placing it (G-21)
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(420);

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
    const targets = onScreenTargets();
    setPresent(targets);
  }, [open]);

  const step = visibleSteps[Math.min(index, visibleSteps.length - 1)];
  const isLast = index >= visibleSteps.length - 1;

  const measure = useCallback(() => {
    setViewport({ w: window.innerWidth, h: window.innerHeight });
    const height = cardRef.current?.offsetHeight;
    if (height) setCardHeight((prev) => (prev === height ? prev : height));
    const targets = onScreenTargets();
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

  const cardStyle = placeCard(rect, step.placement, viewport, cardHeight);

  return createPortal(
    <div className="fixed inset-0 z-[60]" data-guide-overlay="">
      {rect ? (
        <div
          className="pointer-events-none fixed rounded-xl ring-2 ring-brand-500 transition-all duration-200"
          style={{
            left: rect.left - PAD,
            top: rect.top - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.55)",
          }}
        />
      ) : (
        <div className="fixed inset-0 bg-slate-900/60" />
      )}
      <div className="fixed inset-0" onClick={(e) => e.stopPropagation()} />

      <div
        ref={cardRef}
        role="dialog"
        aria-label={`${assistantName}: ${step.title}`}
        className="fixed flex flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white text-gray-800 shadow-2xl"
        style={{ width: CARD_WIDTH, maxHeight: viewport.h - 16, ...cardStyle }}
      >
        <div className="flex flex-shrink-0 items-center gap-2.5 border-b border-gray-100 bg-gray-50/80 px-4 py-2.5">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm">
            <SparkIcon />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-gray-900">{assistantName}</p>
            <p className="text-[10px] text-gray-400">
              Step {index + 1} of {visibleSteps.length}
            </p>
          </div>
          <button onClick={skip} className="rounded px-1.5 py-0.5 text-[11px] text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Close the tour (Esc)">
            Skip tour
          </button>
        </div>

        {step.image && (
          <img
            src={guideImageSrc(step.image)}
            alt=""
            className="max-h-44 w-full border-b border-gray-100 bg-gray-100 object-cover object-top"
            onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
          />
        )}

        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">{step.title}</h2>
          <div className="text-[12px] leading-relaxed text-gray-600 [&_p+p]:mt-1.5 [&_b]:text-gray-900 [&_kbd]:rounded [&_kbd]:border [&_kbd]:border-gray-300 [&_kbd]:bg-gray-50 [&_kbd]:px-1 [&_kbd]:font-mono [&_kbd]:text-[10px]">
            {typeof step.body === "string" ? <p>{step.body}</p> : step.body}
          </div>
          {step.tip && (
            <p className="rounded-md border border-brand-100 bg-brand-50 px-2.5 py-1.5 text-[11px] text-brand-800">
              <span className="font-semibold">Try it:</span> {step.tip}
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-gray-100 px-4 py-2.5">
          <div className="flex items-center gap-1">
            {visibleSteps.map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all ${i === index ? "w-4 bg-brand-500" : "w-1.5 bg-gray-200"}`} />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={back} disabled={index === 0} className="btn-secondary btn-sm disabled:opacity-40">
              Back
            </button>
            <button onClick={next} className="btn-primary btn-sm" data-guide-next="">
              {isLast ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** A tour picture under public/guide/, below the app's base path -- an
 * absolute "/guide/..." broke every picture under a sub-path (G-13). */
export function guideImageSrc(image: string): string {
  return `${import.meta.env.BASE_URL}guide/${image}`;
}

/** Where the card goes: beside the target on the first side where the
 * card's real height fits (measured once rendered -- a picture makes it
 * taller than the old fixed 420 px estimate, and on a tablet the Next row
 * ended up off screen, G-21), clamped into the viewport. */
export function placeCard(
  rect: DOMRect | null,
  preferred: GuideStep["placement"],
  vp: { w: number; h: number },
  cardH = 420
): { left: number; top: number } {
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
