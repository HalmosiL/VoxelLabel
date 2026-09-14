import { useCallback, useEffect, useState } from "react";

/** Per-tour "already seen" flag, so a tour opens by itself exactly once
 * for a person and can still be replayed from the Tutorial button.
 * localStorage may be unavailable (private window, blocked storage) --
 * every access is guarded and the tour then simply shows again. */
function storageKey(key: string) {
  return `vl.guide.${key}.seen`;
}

function readSeen(key: string): boolean {
  try {
    return window.localStorage.getItem(storageKey(key)) === "1";
  } catch {
    return false;
  }
}

function writeSeen(key: string) {
  try {
    window.localStorage.setItem(storageKey(key), "1");
  } catch {
    /* ignore */
  }
}

export function useGuide(key: string, autoStartWhen: boolean) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => readSeen(key));

  useEffect(() => {
    setSeen(readSeen(key));
  }, [key]);

  useEffect(() => {
    if (autoStartWhen && !seen) setOpen(true);
  }, [autoStartWhen, seen]);

  const start = useCallback(() => setOpen(true), []);
  const close = useCallback(() => {
    setOpen(false);
    writeSeen(key);
    setSeen(true);
  }, [key]);

  return { open, seen, start, close };
}
