import { cloneElement, ReactElement, ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Where the tooltip sits relative to the wrapped control. */
export type TipSide = "top" | "bottom" | "left" | "right";

/** A rich hover tooltip: a bold title, a one- or two-sentence description
 * of what the control does, and an optional keyboard shortcut -- shown in
 * a portal so it is never clipped by a scrolling panel. Wraps a single
 * element and attaches mouse/focus handlers to it; keyboard users get it
 * on focus too. Replaces the browser's bare `title` attribute on every
 * control a doctor uses (those are unstyled, slow to appear and can only
 * hold one line).
 *
 * Touch: there is no hover, so a long-press on the control shows the
 * tip (and keeps it up a moment after release to be read); an element
 * that does nothing else on tap (the "?" help marks, slider labels) can
 * pass `tapToggle` so a plain tap toggles it too. Mouse-compat events a
 * browser synthesizes after a touch are ignored, or the release would
 * hide what the long-press just showed. */
export default function Tip({
  title,
  description,
  shortcut,
  side = "bottom",
  disabled = false,
  tapToggle = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  shortcut?: string;
  side?: TipSide;
  /** Suppress the tooltip (e.g. while a guided tour owns the screen). */
  disabled?: boolean;
  /** A tap toggles the tip -- for non-interactive controls only. */
  tapToggle?: boolean;
  children: ReactElement;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const lastPointerWasTouch = useRef(false);
  const longPressShown = useRef(false);

  function clearTimers() {
    if (showTimer.current) window.clearTimeout(showTimer.current);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  }
  function show(el: HTMLElement, delay: number) {
    clearTimers();
    showTimer.current = window.setTimeout(() => setAnchor(el.getBoundingClientRect()), delay);
  }
  function hide() {
    clearTimers();
    setAnchor(null);
  }
  function hideLater(ms: number) {
    clearTimers();
    hideTimer.current = window.setTimeout(() => setAnchor(null), ms);
  }

  useEffect(() => hide, []);

  const child = cloneElement(children, {
    onMouseEnter: (e: MouseEvent) => {
      children.props.onMouseEnter?.(e);
      if (!lastPointerWasTouch.current) show(e.currentTarget as HTMLElement, 250);
    },
    onMouseLeave: (e: MouseEvent) => {
      children.props.onMouseLeave?.(e);
      if (!lastPointerWasTouch.current) hide();
    },
    onFocus: (e: FocusEvent) => {
      children.props.onFocus?.(e);
      if (!lastPointerWasTouch.current) show(e.currentTarget as HTMLElement, 250);
    },
    onBlur: (e: FocusEvent) => {
      children.props.onBlur?.(e);
      hide();
    },
    onMouseDown: (e: MouseEvent) => {
      children.props.onMouseDown?.(e);
      if (!lastPointerWasTouch.current) hide();
    },
    onPointerDown: (e: PointerEvent) => {
      children.props.onPointerDown?.(e);
      lastPointerWasTouch.current = e.pointerType === "touch";
      if (e.pointerType !== "touch") return;
      longPressShown.current = false;
      const el = e.currentTarget as HTMLElement;
      clearTimers();
      showTimer.current = window.setTimeout(() => {
        longPressShown.current = true;
        setAnchor(el.getBoundingClientRect());
      }, 450);
    },
    onPointerUp: (e: PointerEvent) => {
      children.props.onPointerUp?.(e);
      if (e.pointerType !== "touch") return;
      if (longPressShown.current) hideLater(1800);
      else clearTimers();
    },
    onPointerCancel: (e: PointerEvent) => {
      children.props.onPointerCancel?.(e);
      if (e.pointerType === "touch") hide();
    },
    onContextMenu: (e: MouseEvent) => {
      children.props.onContextMenu?.(e);
      // A long-press is this tip's own gesture on touch, not the
      // browser's context menu.
      if (lastPointerWasTouch.current) e.preventDefault();
    },
    onClick: (e: MouseEvent) => {
      children.props.onClick?.(e);
      if (!tapToggle || !lastPointerWasTouch.current || longPressShown.current) return;
      if (anchor) hide();
      else {
        clearTimers();
        setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
        hideLater(4000);
      }
    },
  });

  return (
    <>
      {child}
      {anchor && !disabled && createPortal(<TipBubble anchor={anchor} side={side} title={title} description={description} shortcut={shortcut} />, document.body)}
    </>
  );
}

const GAP = 8;
const BUBBLE_WIDTH = 240;

function TipBubble({
  anchor,
  side,
  title,
  description,
  shortcut,
}: {
  anchor: DOMRect;
  side: TipSide;
  title: string;
  description?: ReactNode;
  shortcut?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Position after the first paint (we need the bubble's own size), and
  // flip to the opposite side when the preferred one would leave the
  // viewport.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let s = side;
    if (s === "bottom" && anchor.bottom + GAP + h > vh) s = "top";
    if (s === "top" && anchor.top - GAP - h < 0) s = "bottom";
    if (s === "right" && anchor.right + GAP + w > vw) s = "left";
    if (s === "left" && anchor.left - GAP - w < 0) s = "right";
    let left: number;
    let top: number;
    if (s === "bottom" || s === "top") {
      left = anchor.left + anchor.width / 2 - w / 2;
      top = s === "bottom" ? anchor.bottom + GAP : anchor.top - GAP - h;
    } else {
      top = anchor.top + anchor.height / 2 - h / 2;
      left = s === "right" ? anchor.right + GAP : anchor.left - GAP - w;
    }
    left = Math.max(8, Math.min(left, vw - w - 8));
    top = Math.max(8, Math.min(top, vh - h - 8));
    setPos({ left, top });
  }, [anchor, side]);

  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[70] rounded-md border border-[#3d3d5c] bg-[#20203a]/95 px-3 py-2 text-left shadow-xl backdrop-blur-sm"
      style={{ width: BUBBLE_WIDTH, left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden" }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold text-gray-100">{title}</p>
        {shortcut && (
          <kbd className="flex-shrink-0 rounded border border-[#4a4a6a] bg-[#2a2a3e] px-1 font-mono text-[10px] text-gray-300">{shortcut}</kbd>
        )}
      </div>
      {description && <p className="mt-1 text-[11px] leading-relaxed text-gray-400">{description}</p>}
    </div>
  );
}
