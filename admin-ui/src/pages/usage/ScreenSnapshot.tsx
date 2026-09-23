import { ReactNode, useEffect, useRef, useState } from "react";

import { getUsageSnapshotDocument, UsageSnapshotMeta } from "../../api/adminApi";

/** A recorded screen drawn as it was: its HTML (images replaced by grey
 * placeholders when it was recorded) in a sandboxed iframe -- no
 * scripts, no same-origin access, no pointer events -- laid out at the
 * recorded window size and scaled down to fit. `children` (an SVG of
 * clicks or a pointer path, in the same aspect) sit on top. A snapshot
 * recorded with the case images shows them unless `images` is false --
 * then they are drawn as the same grey blocks as everywhere else. */
export default function ScreenSnapshot({ snapshot, children, dim = 0.15, images = true }: { snapshot: UsageSnapshotMeta; children?: ReactNode; dim?: number; images?: boolean }) {
  const [vw, vh] = snapshot.viewport;
  const box = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  // The document on show and the viewport it was recorded at. When the
  // snapshot changes (a replay crossing into a new structure) the old
  // screen stays up until the new one has loaded -- no flash of
  // "Loading" mid-replay.
  const [shown, setShown] = useState<{ doc: string; viewport: [number, number] } | null>(null);
  const [failed, setFailed] = useState(false);
  const doc = shown?.doc ?? null;

  useEffect(() => {
    let live = true;
    setFailed(false);
    getUsageSnapshotDocument(snapshot.id)
      .then((d) => live && setShown({ doc: d, viewport: [vw, vh] }))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [snapshot.id, vw, vh]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setBoxW(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  return (
    <div ref={box} className="relative w-full overflow-hidden rounded border border-gray-200 bg-gray-50" style={{ aspectRatio: `${vw} / ${vh}` }} data-testid="usage-screen-snapshot">
      {shown && boxW > 0 && (
        <iframe
          title="Recorded screen"
          srcDoc={images ? shown.doc : withoutImages(shown.doc)}
          sandbox=""
          tabIndex={-1}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
          style={{ width: shown.viewport[0], height: shown.viewport[1], transform: `scale(${boxW / shown.viewport[0]})` }}
          data-testid="usage-screen-snapshot-frame"
        />
      )}
      {!doc && !failed && <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">Loading the screen…</div>}
      {failed && !doc && <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">The recorded screen could not be loaded.</div>}
      {dim > 0 && <div className="pointer-events-none absolute inset-0 bg-white" style={{ opacity: dim }} />}
      <div className="absolute inset-0">{children}</div>
    </div>
  );
}

// Hides the recorded case images in place: the picture moves out of its
// box, the box keeps the grey placeholder look.
const HIDE_IMAGES =
  "<style>img[data-vl-shot]{object-position:-100000px -100000px!important;background:repeating-linear-gradient(45deg,#9ca3af33,#9ca3af33 6px,#9ca3af22 6px,#9ca3af22 12px)!important;outline:1px dashed #9ca3af;outline-offset:-1px}</style>";

export function withoutImages(doc: string): string {
  const head = doc.search(/<\/head\s*>/i);
  return head >= 0 ? doc.slice(0, head) + HIDE_IMAGES + doc.slice(head) : HIDE_IMAGES + doc;
}
