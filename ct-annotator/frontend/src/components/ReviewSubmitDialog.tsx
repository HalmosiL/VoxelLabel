import ConfirmDialog from "./ConfirmDialog";

/** The last look before "Submit review" goes through: the decision it
 * makes (one rejected object sends the whole case back), how many objects
 * were accepted, and each rejection with what the annotator will read. */
export default function ReviewSubmitDialog({
  caseTitle,
  accepted,
  rejected,
  busy,
  onConfirm,
  onCancel,
}: {
  caseTitle: string | null;
  accepted: number;
  rejected: { id: number | null; name: string; text: string }[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const approve = rejected.length === 0;
  const what = caseTitle ?? "this case";
  return (
    <ConfirmDialog
      title={approve ? `Approve ${what}?` : `Send ${what} back to the annotator?`}
      subtitle={
        approve
          ? "The case is done. You can take the decision back for a few seconds afterwards."
          : "One rejected object sends the whole case back. You can take the decision back for a few seconds afterwards."
      }
      confirmLabel={approve ? "Approve" : "Send back"}
      busyLabel="Submitting…"
      tone={approve ? "emerald" : "rose"}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
      testId="review-submit-dialog"
      confirmTestId="review-submit-confirm"
    >
      <p className="mt-3 text-xs text-gray-300" data-testid="review-submit-counts">
        {accepted} accepted · {rejected.length} rejected
      </p>
      {rejected.length > 0 && (
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded border border-rose-800/60 bg-rose-950/40 p-2.5 text-xs text-rose-100">
          {rejected.map((r) => (
            <li key={r.id ?? r.name}>
              <span className="font-medium">{r.name}</span> -- {r.text}
            </li>
          ))}
        </ul>
      )}
    </ConfirmDialog>
  );
}
