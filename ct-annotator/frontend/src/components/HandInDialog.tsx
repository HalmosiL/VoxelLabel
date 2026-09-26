import { HandInSummary, sliceSpanText } from "../lib/handInSummary";
import ConfirmDialog from "./ConfirmDialog";

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
  const { rows, empty, unanswered, sentBack } = summary;
  const warnings: string[] = [];
  if (rows.length === 0) warnings.push("There are no objects on this case: it is handed in as \"no findings\".");
  if (empty.length) warnings.push(`${empty.map((r) => r.name).join(", ")} ${empty.length === 1 ? "has" : "have"} nothing painted.`);
  for (const r of unanswered) warnings.push(`${r.name}: ${r.unanswered.join(", ")} not answered.`);
  if (sentBack.length) warnings.push(`Sent back last round: ${sentBack.map((r) => r.name).join(", ")} -- make sure your changes address the reviewer's comments.`);

  return (
    <ConfirmDialog
      title={`Hand in ${caseTitle ?? "this case"}?`}
      subtitle="It goes to the reviewer. You can take it back for a few seconds afterwards."
      confirmLabel="Hand in"
      busyLabel="Handing in…"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
      testId="handin-dialog"
      confirmTestId="handin-confirm"
    >
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
    </ConfirmDialog>
  );
}
