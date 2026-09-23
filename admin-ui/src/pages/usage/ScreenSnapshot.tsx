import { ReactNode, useEffect, useRef, useState } from "react";

import { getUsageSnapshotDocument, UsageSnapshotMeta } from "../../api/adminApi";

/** A recorded screen drawn as it was: its HTML (images replaced by grey
 * placeholders when it was recorded) in a sandboxed iframe -- no
 * scripts, no same-origin access, no pointer events -- laid out at the
 * recorded window size and scaled down to fit. `children` (an SVG of
 * clicks or a pointer path, in the same aspect) sit on top. */
export default function ScreenSnapshot({ snapshot, children, dim = 0.15 }: { snapshot: UsageSnapshotMeta; children?: ReactNode; dim?: number }) {
  const [vw, vh] = snapshot.viewport;
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [doc, setDoc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setDoc(null);
    setFailed(false);
    getUsageSnapshotDocument(snapshot.id)
      .then((d) => live && setDoc(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [snapshot.id]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / vw);
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [vw]);

  return (
    <div ref={box} className="relative w-full overflow-hidden rounded border border-gray-200 bg-gray-50" style={{ aspectRatio: `${vw} / ${vh}` }} data-testid="usage-screen-snapshot">
      {doc && scale > 0 && (
        <iframe
          title="Recorded screen"
          srcDoc={doc}
          sandbox=""
          tabIndex={-1}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
          style={{ width: vw, height: vh, transform: `scale(${scale})` }}
          data-testid="usage-screen-snapshot-frame"
        />
      )}
      {!doc && !failed && <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">Loading the screen…</div>}
      {failed && <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">The recorded screen could not be loaded.</div>}
      {dim > 0 && <div className="pointer-events-none absolute inset-0 bg-white" style={{ opacity: dim }} />}
      <div className="absolute inset-0">{children}</div>
    </div>
  );
}
