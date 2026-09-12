import { useEffect, useState } from "react";

/** React to a CSS media query (re-renders when it flips). */
export function useMediaQuery(query: string): boolean {
  const read = () => (typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Below Tailwind's `lg` (1024px): a tablet in portrait, a phone, a
 * narrow window -- the sidebar becomes a drawer, side panels overlay. */
export const useCompactLayout = (): boolean => useMediaQuery("(max-width: 1023px)");

/** A finger, not a mouse: bigger targets, nothing hover-only. */
export const useCoarsePointer = (): boolean => useMediaQuery("(pointer: coarse)");
