/** Fullscreen for the viewer surfaces, done on the whole document.
 *
 * Fullscreening the viewer's own root element (the first version) only
 * shows that element's subtree -- everything the pages render through
 * a portal into document.body (the guided tour, tooltips, the HU
 * readout, popups) simply vanished while fullscreen. The document
 * element has no such problem, and the viewer already fills it.
 *
 * Safari (iPad) still spells parts of the API with a webkit prefix. */

const DECLINED_KEY = "ct.fullscreenDeclined";

type WebkitDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export function fullscreenElement(): Element | null {
  const d = document as WebkitDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/** The whole page full screen -- or just `target` (the 3D view's own). */
export async function enterFullscreen(target?: Element): Promise<boolean> {
  const el = (target ?? document.documentElement) as WebkitElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    else return false;
    return true;
  } catch {
    // Refused (no user gesture, a browser that only fullscreens video,
    // an iframe without the permission) -- the page just stays as is.
    return false;
  }
}

export async function exitFullscreen(): Promise<void> {
  const d = document as WebkitDocument;
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else if (d.webkitExitFullscreen) await d.webkitExitFullscreen();
  } catch {
    // Already out -- nothing to do.
  }
}

/** Both spellings of the change event. */
export function onFullscreenChange(handler: () => void): () => void {
  document.addEventListener("fullscreenchange", handler);
  document.addEventListener("webkitfullscreenchange", handler);
  return () => {
    document.removeEventListener("fullscreenchange", handler);
    document.removeEventListener("webkitfullscreenchange", handler);
  };
}

/** A touch screen goes fullscreen by itself on the first touch (the
 * browser only allows it from a user gesture, so not on load); someone
 * who then leaves fullscreen has said no -- remembered for the tab so
 * the next touch doesn't drag them back in. */
export function fullscreenDeclined(): boolean {
  try {
    return sessionStorage.getItem(DECLINED_KEY) === "1";
  } catch {
    return false;
  }
}
export function rememberFullscreenDeclined(): void {
  try {
    sessionStorage.setItem(DECLINED_KEY, "1");
  } catch {
    // Private mode etc.: it'll just ask again next time.
  }
}
