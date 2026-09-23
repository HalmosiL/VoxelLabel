import { useEffect, useRef, useState } from "react";

/** One part of the page (a replay, a heatmap) shown full screen with the
 * browser's Fullscreen API; Escape or the button brings it back. */
export function useFullscreen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const onChange = () => setActive(ref.current !== null && document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  function toggle() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void ref.current?.requestFullscreen?.().catch(() => undefined);
  }
  const supported = typeof document !== "undefined" && Boolean(document.fullscreenEnabled);
  return { ref, active, toggle, supported };
}

/** Width that lets a screen of this aspect fit the full-screen height,
 * leaving `reserve` px for the controls above it. */
export function fitWidth(viewport: [number, number], reserve: number): string {
  return `min(100%, calc((100vh - ${reserve}px) * ${(viewport[0] / Math.max(viewport[1], 1)).toFixed(4)}))`;
}

export function FullscreenButton({ active, onClick, testId }: { active: boolean; onClick: () => void; testId: string }) {
  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={onClick} aria-pressed={active} title={active ? "Leave full screen (Esc)" : "Show full screen"} data-testid={testId}>
      {active ? "✕ Exit full screen" : "⛶ Full screen"}
    </button>
  );
}
