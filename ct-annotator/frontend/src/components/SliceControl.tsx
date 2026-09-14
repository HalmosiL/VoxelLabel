import { useEffect, useRef, type ReactNode } from "react";

/** A pane's slice control: one arrow each way for exact single-slice
 * steps, the slider between them for jumping further, and the page's
 * own counter after it.
 *
 * The arrows exist because a finger can't hit one slice on a slider
 * that spans 256 of them across ~300px -- the mouse equivalents
 * (Ctrl+scroll, the arrow keys) have no touch counterpart. Held down,
 * an arrow repeats, so walking a whole stack doesn't mean 256 taps.
 */
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 90;

export default function SliceControl({
  index,
  max,
  onChange,
  accentClass,
  counter,
  guide,
  label,
}: {
  index: number;
  max: number;
  onChange: (next: number) => void;
  /** The slider's accent colour class -- each surface has its own hue. */
  accentClass: string;
  /** The page's own "which slice" readout, rendered after the arrows. */
  counter: ReactNode;
  /** Optional data-guide anchor for the guided tour. */
  guide?: string;
  /** Pane name, for the buttons' accessible labels. */
  label: string;
}) {
  // The repeat callback runs from a timer, so it reads the current
  // values through a ref rather than the closure it was created in.
  const stateRef = useRef({ index, max, onChange });
  stateRef.current = { index, max, onChange };
  const timers = useRef<{ start?: number; repeat?: number }>({});
  // A pointer already stepped on pointerdown (so the press feels
  // immediate); the click that follows must not step a second time.
  // Keyboard activation has no pointerdown and steps on click.
  const steppedByPointer = useRef(false);

  function step(dir: number) {
    const s = stateRef.current;
    const next = Math.max(0, Math.min(s.max, s.index + dir));
    if (next !== s.index) s.onChange(next);
  }
  function stopRepeat() {
    if (timers.current.start !== undefined) window.clearTimeout(timers.current.start);
    if (timers.current.repeat !== undefined) window.clearInterval(timers.current.repeat);
    timers.current = {};
  }
  function pressStart(dir: number) {
    steppedByPointer.current = true;
    step(dir);
    stopRepeat();
    timers.current.start = window.setTimeout(() => {
      timers.current.repeat = window.setInterval(() => step(dir), REPEAT_EVERY_MS);
    }, REPEAT_DELAY_MS);
  }
  useEffect(() => stopRepeat, []);

  const arrow = (dir: -1 | 1) => {
    const disabled = dir < 0 ? index <= 0 : index >= max;
    return (
      <button
        type="button"
        aria-label={dir < 0 ? `Previous ${label} slice` : `Next ${label} slice`}
        data-testid={dir < 0 ? "slice-prev" : "slice-next"}
        disabled={disabled}
        onPointerDown={(e) => {
          // Left button / any touch or pen contact only.
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          pressStart(dir);
        }}
        onPointerUp={stopRepeat}
        onPointerCancel={stopRepeat}
        onLostPointerCapture={stopRepeat}
        onClick={() => {
          if (steppedByPointer.current) {
            steppedByPointer.current = false;
            return;
          }
          step(dir);
        }}
        className="flex h-6 w-6 flex-shrink-0 touch-none select-none items-center justify-center rounded border border-[#444] bg-[#2a2a3e] text-gray-300 transition-colors hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ChevronIcon dir={dir} />
      </button>
    );
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5" data-guide={guide}>
      {arrow(-1)}
      <input
        type="range"
        min={0}
        max={max}
        value={index}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`${label} slice`}
        className={`h-1 min-w-0 flex-1 ${accentClass}`}
      />
      {arrow(1)}
      {counter}
    </div>
  );
}

function ChevronIcon({ dir }: { dir: -1 | 1 }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      {dir < 0 ? (
        <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L9.06 10l3.71 3.71a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.08.02z" clipRule="evenodd" />
      ) : (
        <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L10.94 10 7.23 6.29a.75.75 0 111.06-1.06l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.08-.02z" clipRule="evenodd" />
      )}
    </svg>
  );
}
