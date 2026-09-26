import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { undoAnnotationStep } from "../api/annotatorApi";
import { errorText } from "../lib/errorText";
import { announceUndone, clearUndo, currentUndo, subscribeUndo, UndoOffer } from "../lib/undoStore";
import { trackAction } from "../usage/tracker";

/** "Case 0709 handed in · Undo (8 s)" -- shown for a few seconds after a
 * hand-in or a review decision, across the move to the next case (it is
 * mounted once, above the routes). Undo asks the server to take the step
 * back and opens that case again. */
export default function UndoToast() {
  const navigate = useNavigate();
  const [offer, setOffer] = useState<UndoOffer | null>(() => currentUndo());
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => subscribeUndo(() => { setOffer(currentUndo()); setResult(null); }), []);
  useEffect(() => {
    if (!offer) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (!currentUndo()) setOffer(null);
    }, 250);
    return () => window.clearInterval(timer);
  }, [offer]);
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(null), 4000);
    return () => window.clearTimeout(timer);
  }, [result]);

  async function undo(step: UndoOffer) {
    setBusy(true);
    try {
      await undoAnnotationStep(step.annotationId);
      trackAction("undo_step");
      announceUndone(step.annotationId);
      clearUndo();
      setResult({ ok: true, text: `Taken back -- the case is ${step.undoneMessage}.` });
      navigate(step.backTo);
    } catch (err) {
      clearUndo();
      setResult({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!offer && !result) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      {offer ? (
        <div role="status" data-testid="undo-toast" className="pointer-events-auto flex items-center gap-3 rounded-lg border border-gray-600 bg-gray-800 px-4 py-2.5 text-sm text-gray-100 shadow-lg">
          <span>{offer.message}</span>
          <button
            type="button"
            data-testid="undo-button"
            onClick={() => undo(offer)}
            disabled={busy}
            className="rounded border border-gray-500 px-2.5 py-1 text-xs font-medium text-gray-100 hover:bg-gray-700 disabled:opacity-50"
          >
            {busy ? "Taking back…" : `Undo (${Math.max(1, Math.ceil((offer.expiresAt - now) / 1000))} s)`}
          </button>
        </div>
      ) : result ? (
        <div role="status" data-testid="undo-result" className={`pointer-events-auto rounded-lg border px-4 py-2.5 text-sm shadow-lg ${result.ok ? "border-emerald-700 bg-emerald-950 text-emerald-100" : "border-red-700 bg-red-950 text-red-100"}`}>
          {result.text}
        </div>
      ) : null}
    </div>
  );
}
