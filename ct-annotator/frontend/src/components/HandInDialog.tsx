import { useEffect, useRef } from "react";

import { HandInSummary, sliceSpanText } from "../lib/handInSummary";

/** The last look before "Mark as Annotated" goes through: what is being
 * handed in (each object and its slices) and what looks unfinished. It
 * only warns -- an empty object or an open question may be on purpose. */
export default function HandInDialog({
  summary,
  caseTitle,
  busy,
  onConfirm,
  onCancel,
}: {
  summary: HandInSummary;
  caseTitle: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const { rows, empty, unanswered, sentBack } = summary;
  const warnings: string[] = [];
  if (rows.length === 0) warnings.push("There are no objects on this case: it is handed in as \"no findings\".");
  if (empty.length) warnings.push(`${empty.map((r) => r.name).join(", ")} ${empty.length === 1 ? "has" : "have"} nothing painted.`);
  for (const r of unanswered) warnings.push(`${r.name}: ${r.unanswered.join(", ")} not answered.`);
  if (sentBack.length) warnings.push(`Sent back last round: ${sentBack.map((r) => r.name).join(", ")} -- make sure your changes address the reviewer's comments.`);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="handin-title"
        data-testid="handin-dialog"
        className="w-full max-w-md rounded-lg border border-gray-600 bg-gray-900 p-5 text-sm text-gray-200 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="handin-title" className="text-base font-semibold text-gray-100">
          Hand in {caseTitle ?? "this case"}?
        </h2>
        <p className="mt-1 text-xs text-gray-400">It goes to the reviewer. You can take it back for a few seconds afterwards.</p>

        {rows.length > 0 && (
          <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto" data-testid="handin-objects">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
                <span className="font-medium text-gray-100">{r.name}</span>
                <span className={`ml-auto text-xs tabular-nums ${r.voxels === 0 ? "text-amber-300" : "text-gray-400"}`}>{sliceSpanText(r)}</span>
              </li>
            ))}
          </ul>
        )}

        {warnings.length > 0 && (
          <ul className="mt-3 space-y-1 rounded border border-amber-700/60 bg-amber-950/40 p-2.5 text-xs text-amber-200" data-testid="handin-warnings">
            {warnings.map((w) => (
              <li key={w}>⚠ {w}</li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded border border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-gray-800">
            Keep working
          </button>
          <button
            ref={confirmRef}
            type="button"
            data-testid="handin-confirm"
            onClick={onConfirm}
            disabled={busy}
            className="rounded border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? "Handing in…" : "Hand in"}
          </button>
        </div>
      </div>
    </div>
  );
}
