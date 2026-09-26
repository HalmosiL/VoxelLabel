import { ReactNode, useEffect, useRef } from "react";

/** The viewer's modal "last look" before a step that goes to someone else
 * (a hand-in, a review decision): what is about to happen, then Confirm
 * (focused, so Enter goes through) or Keep working (also Escape, or a
 * click outside). */
export default function ConfirmDialog({
  title,
  subtitle,
  children,
  confirmLabel,
  busyLabel,
  tone = "emerald",
  busy,
  onConfirm,
  onCancel,
  testId,
  confirmTestId,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  tone?: "emerald" | "rose";
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId: string;
  confirmTestId: string;
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

  const toneClass = tone === "rose" ? "border-rose-600 bg-rose-600 hover:bg-rose-700" : "border-emerald-600 bg-emerald-600 hover:bg-emerald-700";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        data-testid={testId}
        className="w-full max-w-md rounded-lg border border-gray-600 bg-gray-900 p-5 text-sm text-gray-200 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={`${testId}-title`} className="text-base font-semibold text-gray-100">
          {title}
        </h2>
        {subtitle && <p className="mt-1 text-xs text-gray-400">{subtitle}</p>}
        {children}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded border border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-gray-800">
            Keep working
          </button>
          <button
            ref={confirmRef}
            type="button"
            data-testid={confirmTestId}
            onClick={onConfirm}
            disabled={busy}
            className={`rounded border px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${toneClass}`}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
