/**
 * In-page preview of one clinical document (a report, a referral, a
 * scanned letter) beside the images, so an annotator can read it while
 * working instead of downloading it or leaving the viewer.
 *
 * Renders by content type, in the page itself rather than an <iframe>:
 * a PDF page by page onto canvases via PDF.js (an <iframe> of a PDF
 * shows only the first page on iPadOS, and Android tablets offer a
 * download instead), plain text as text, an image as an image. Anything
 * else gets an "open in a new tab" fallback.
 *
 * The bytes come from the caller's `load` -- the real viewer fetches
 * them through its backend with the bearer token, the tutorial reads a
 * bundled practice report -- so this component never knows about
 * authentication or URLs.
 *
 * Geometry: a fixed panel on the right edge, resizable by dragging its
 * left edge (a finger-wide handle under a coarse pointer). On a compact
 * layout it opens at half the screen and a Half/Full toggle switches
 * between reading alongside the panes and reading comfortably.
 */
import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

import Tip from "./Tip";

export interface DocumentSource {
  title: string;
  load: () => Promise<{ bytes: ArrayBuffer; contentType: string }>;
}

type Loaded =
  | { kind: "pdf"; pdf: PdfDocument; pageCount: number }
  | { kind: "text"; text: string }
  | { kind: "image"; url: string }
  | { kind: "other"; url: string; contentType: string };

// Only the slice of PDF.js this component touches -- the library is
// loaded on demand (see loadPdfJs), so its own types aren't imported
// at module level either.
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void> | void;
}
interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): { promise: Promise<void> };
}

const MIN_WIDTH = 300;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

/** PDF.js is ~400 KB and only needed once someone opens a PDF, so it's
 * a separate chunk fetched on first use (never on page load, never in
 * tests). The legacy build for wider Safari support -- iPads are the
 * main audience of this preview. */
async function loadPdfJs() {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

function kindOf(contentType: string, bytes: ArrayBuffer): "pdf" | "text" | "image" | "other" {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "application/pdf") return "pdf";
  // A PDF uploaded with a generic type still starts with its magic bytes.
  const head = new Uint8Array(bytes.slice(0, 5));
  if (String.fromCharCode(...head) === "%PDF-") return "pdf";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/") || type === "application/json") return "text";
  return "other";
}

export default function DocumentPanel({
  doc,
  onClose,
  compact,
  coarse,
}: {
  doc: DocumentSource;
  onClose: () => void;
  /** Side panel is a drawer (narrow screen): open at half width, offer Half/Full. */
  compact: boolean;
  /** Touch screen: wider drag handle, bigger controls. */
  coarse: boolean;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomIndex, setZoomIndex] = useState(3); // ZOOM_STEPS[3] === 1 -> fit to the panel's width
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(() => (compact ? Math.round(window.innerWidth / 2) : 480));
  const [full, setFull] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  // Load (and decode) once per document; revoke blob URLs / destroy the
  // PDF worker's document when it changes or the panel closes.
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    setPage(1);
    doc
      .load()
      .then(async ({ bytes, contentType }) => {
        const kind = kindOf(contentType, bytes);
        if (kind === "pdf") {
          const pdfjs = await loadPdfJs();
          const pdf = (await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise) as unknown as PdfDocument;
          if (cancelled) {
            pdf.destroy();
            return;
          }
          setLoaded({ kind, pdf, pageCount: pdf.numPages });
          return;
        }
        if (kind === "text") {
          if (!cancelled) setLoaded({ kind, text: new TextDecoder().decode(bytes) });
          return;
        }
        const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
        objectUrlRef.current = url;
        if (!cancelled) setLoaded(kind === "image" ? { kind, url } : { kind: "other", url, contentType });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    };
  }, [doc]);
  useEffect(() => {
    if (loaded?.kind !== "pdf") return;
    const pdf = loaded.pdf;
    return () => {
      pdf.destroy();
    };
  }, [loaded]);

  // Drag-to-resize on the left edge. Pointer capture keeps the move/up
  // events on the handle even once the pointer leaves its thin strip.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  function handleResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width };
  }
  function handleResizeMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    // Anchored to the right edge: dragging left (negative delta) grows it.
    setWidth(Math.min(window.innerWidth - 80, Math.max(MIN_WIDTH, drag.startWidth + (drag.startX - event.clientX))));
    setFull(false);
  }
  function handleResizeEnd() {
    dragRef.current = null;
  }

  // Which page is in view, for the counter: the page under the middle
  // of the scroll area -- not the one at its top edge, since the last
  // page can never reach the top when it's shorter than the area.
  function handleScroll() {
    const el = scrollRef.current;
    if (!el || loaded?.kind !== "pdf") return;
    const pages = Array.from(el.querySelectorAll<HTMLElement>("[data-pdf-page]"));
    const middle = el.scrollTop + el.clientHeight / 2;
    let current = pages.findIndex((p) => p.offsetTop + p.offsetHeight > middle);
    if (current < 0) current = pages.length - 1;
    if (current >= 0) setPage(current + 1);
  }
  function jumpTo(n: number) {
    const el = scrollRef.current;
    if (!el || loaded?.kind !== "pdf") return;
    const target = Math.max(1, Math.min(loaded.pageCount, n));
    const pageEl = el.querySelector<HTMLElement>(`[data-pdf-page="${target}"]`);
    if (pageEl) el.scrollTo({ top: pageEl.offsetTop - 4 });
    setPage(target);
  }

  const zoom = ZOOM_STEPS[zoomIndex];
  const panelWidth = full ? window.innerWidth : width;
  const btn = `rounded border border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-40 ${
    coarse ? "min-h-[2.25rem] min-w-[2.25rem] px-2.5 text-sm" : "px-2 py-1 text-xs"
  }`;

  return (
    <div
      data-testid="document-panel"
      className="fixed inset-y-0 right-0 z-40 flex max-w-[100vw]"
      style={{ width: panelWidth }}
    >
      <div
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        title="Drag to resize"
        data-testid="document-panel-resize"
        className={`flex-shrink-0 cursor-col-resize touch-none bg-[#333] hover:bg-brand-500/70 active:bg-brand-500 ${coarse ? "w-3" : "w-1.5"}`}
      />
      <div className="flex min-w-0 flex-1 flex-col border-l border-[#333] bg-[#15152a] shadow-2xl">
        <div className="flex flex-shrink-0 flex-col gap-1 border-b border-[#333] px-3 py-1.5">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-100" title={doc.title}>
              {doc.title}
            </h2>
            {compact && (
              <Tip title={full ? "Half width" : "Full width"} description="Read it next to the images, or use the whole screen for the document.">
                <button type="button" onClick={() => setFull((v) => !v)} className={btn} data-testid="document-panel-width">
                  {full ? "Half" : "Full"}
                </button>
              </Tip>
            )}
            <button type="button" onClick={onClose} title="Close" aria-label="Close document" className={btn} data-testid="document-panel-close">
              ✕
            </button>
          </div>
          {loaded?.kind === "pdf" && (
            <div className="flex flex-wrap items-center gap-1" data-testid="pdf-controls">
              <button type="button" onClick={() => jumpTo(page - 1)} disabled={page <= 1} className={btn} aria-label="Previous page">
                ‹
              </button>
              <span className="whitespace-nowrap px-1 text-xs tabular-nums text-gray-400" data-testid="pdf-page-counter">
                {page} / {loaded.pageCount}
              </span>
              <button type="button" onClick={() => jumpTo(page + 1)} disabled={page >= loaded.pageCount} className={btn} aria-label="Next page">
                ›
              </button>
              <span className="w-2" />
              <button type="button" onClick={() => setZoomIndex((i) => Math.max(0, i - 1))} disabled={zoomIndex === 0} className={btn} aria-label="Zoom out">
                −
              </button>
              <button type="button" onClick={() => setZoomIndex(3)} className={btn} title="Fit to width">
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
                disabled={zoomIndex === ZOOM_STEPS.length - 1}
                className={btn}
                aria-label="Zoom in"
              >
                +
              </button>
            </div>
          )}
        </div>

        <div ref={scrollRef} onScroll={handleScroll} className="relative min-h-0 flex-1 overflow-auto bg-[#0f0f1c]" style={{ touchAction: "pan-x pan-y" }}>
          {error ? (
            <p className="p-4 text-sm text-red-300">Couldn't open this document: {error}</p>
          ) : !loaded ? (
            <p className="p-4 text-sm text-gray-400">Loading…</p>
          ) : loaded.kind === "pdf" ? (
            <PdfPages pdf={loaded.pdf} pageCount={loaded.pageCount} zoom={zoom} panelWidth={panelWidth} onRendered={handleScroll} />
          ) : loaded.kind === "text" ? (
            <pre className="whitespace-pre-wrap break-words p-4 font-sans text-sm leading-relaxed text-gray-100">{loaded.text}</pre>
          ) : loaded.kind === "image" ? (
            <img src={loaded.url} alt={doc.title} className="mx-auto block max-w-full p-2" />
          ) : (
            <div className="flex flex-col items-start gap-3 p-4 text-sm text-gray-300">
              <p>
                No in-page preview for this file type ({loaded.contentType || "unknown"}).
              </p>
              <a href={loaded.url} target="_blank" rel="noreferrer" className={btn}>
                Open in a new tab
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Every page of the PDF, top to bottom, each drawn onto its own canvas
 * at the device's pixel ratio (so text stays crisp on a Retina tablet)
 * and shown at `zoom` times the panel's width. Pages render in order,
 * one at a time, so a long report shows its first page right away. */
function PdfPages({
  pdf,
  pageCount,
  zoom,
  panelWidth,
  onRendered,
}: {
  pdf: PdfDocument;
  pageCount: number;
  zoom: number;
  panelWidth: number;
  /** Every page laid out at the current size -- the parent re-reads
   * which page is in view (a zoom changes every page's height). */
  onRendered: () => void;
}) {
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  // Width available for a page: the panel minus the resize handle,
  // the page gutter and a little breathing room.
  const pageWidth = Math.max(120, Math.floor((panelWidth - 28) * zoom));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let n = 1; n <= pageCount; n++) {
        if (cancelled) return;
        const canvas = canvasRefs.current[n - 1];
        if (!canvas) continue;
        const pdfPage = await pdf.getPage(n);
        if (cancelled) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = pageWidth / base.width;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const viewport = pdfPage.getViewport({ scale: scale * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${pageWidth}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
      }
      if (!cancelled) onRendered();
    })().catch((err) => console.warn("PDF page render failed:", err));
    return () => {
      cancelled = true;
    };
    // onRendered is a plain function of the parent's render; re-running
    // on its identity would redraw every page on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pageCount, pageWidth]);

  return (
    // `relative` on the scroll container above: the page elements' offsetTop
    // (what the counter and page jumps read) must be measured from it,
    // not from the fixed panel root behind it.
    // min-w-full + w-max: centred while the pages are narrower than
    // the panel, and as wide as the pages once zoomed past it -- so the
    // panel scrolls sideways to the page's left edge instead of a
    // centred overflow clipping it off.
    <div className="flex w-max min-w-full flex-col items-center gap-2 p-2">
      {Array.from({ length: pageCount }, (_, i) => (
        <canvas
          key={i}
          data-pdf-page={i + 1}
          ref={(el) => {
            canvasRefs.current[i] = el;
          }}
          className="max-w-none bg-white shadow"
          style={{ width: pageWidth }}
        />
      ))}
    </div>
  );
}
