import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

import GuideTour, { GuideStep } from "./GuideTour";

interface Registered {
  key: string;
  steps: GuideStep[];
}

interface GuideValue {
  /** Called by the page currently on screen with its own tour.
   * `autoOpen` (default true) controls whether the tour opens itself
   * the first time this key is seen -- the workbench pages (My Jobs,
   * Job, Case) want that; the rest of the admin UI's pages only want
   * to be found through the Tutorial button, never sprung on someone
   * who was just clicking around. */
  register: (key: string, steps: GuideStep[], autoOpen?: boolean) => () => void;
  /** Open the current page's tour (the header's Tutorial button). */
  start: () => void;
  /** Whether the current page has a tour at all. */
  available: boolean;
}

const GuideContext = createContext<GuideValue | null>(null);

function seenKey(key: string) {
  return `vl.guide.${key}.seen`;
}
function readSeen(key: string) {
  try {
    return window.localStorage.getItem(seenKey(key)) === "1";
  } catch {
    return false;
  }
}
function writeSeen(key: string) {
  try {
    window.localStorage.setItem(seenKey(key), "1");
  } catch {
    /* ignore */
  }
}

/** Owns the one GuideTour of the workbench: each page registers its
 * steps while mounted (useRegisterGuide), the tour opens by itself the
 * first time a person sees that page and any time from the Tutorial
 * button. Lives in WorkbenchLayout, so the full admin UI never shows it. */
export function GuideProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Registered | null>(null);
  const [open, setOpen] = useState(false);

  const register = useCallback((key: string, steps: GuideStep[], autoOpen = true) => {
    setCurrent({ key, steps });
    if (autoOpen && !readSeen(key)) setOpen(true);
    return () => {
      setCurrent((c) => (c?.key === key ? null : c));
      setOpen(false);
    };
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    if (current) writeSeen(current.key);
  }, [current]);

  const value = useMemo<GuideValue>(
    () => ({ register, start: () => setOpen(true), available: current !== null }),
    [register, current]
  );

  return (
    <GuideContext.Provider value={value}>
      {children}
      {current && <GuideTour steps={current.steps} open={open} onClose={close} />}
    </GuideContext.Provider>
  );
}

export function useGuideControls(): GuideValue {
  const v = useContext(GuideContext);
  if (!v) throw new Error("useGuideControls must be used inside <GuideProvider>");
  return v;
}

/** A page hands its tour to the provider once its content is on screen
 * (`ready`), so the spotlight has real elements to point at. Outside a
 * GuideProvider (the full admin UI) this is a no-op.
 *
 * `autoOpen` (default true): whether this tour is allowed to open
 * itself on a first, never-seen visit. The workbench pages (My Jobs,
 * Job, Case) rely on that to actually teach a new annotator/reviewer.
 * The rest of the admin UI's page tours pass `false` -- someone
 * managing studies or users doesn't want a tour popping up over their
 * work; it's there only for whoever clicks Tutorial. */
export function useRegisterGuide(key: string, steps: GuideStep[], ready: boolean, autoOpen = true) {
  // Only the stable register function is a dependency -- the context
  // value itself changes on every registration, which would re-run this
  // effect and re-register forever.
  const register = useContext(GuideContext)?.register;
  useEffect(() => {
    if (!register || !ready) return;
    return register(key, steps, autoOpen);
    // steps are module constants; re-registering on every render would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, key, ready, autoOpen]);
}
