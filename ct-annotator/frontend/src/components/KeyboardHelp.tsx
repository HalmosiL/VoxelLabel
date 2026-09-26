import { useEffect } from "react";

import { isHelpKey, keymapFor } from "../lib/keymap";

/** Every shortcut and gesture, grouped (lib/keymap.ts) -- opened with "?"
 * or the header's keyboard button; Esc, "?" again or a click outside
 * closes it. On a touch screen the touch way is shown beside each. */
export default function KeyboardHelp({
  mode,
  touch,
  where = "viewer",
  onClose,
}: {
  mode: "annotate" | "review";
  touch: boolean;
  where?: "viewer" | "tutorial";
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || isHelpKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-help-title"
        data-testid="keyboard-help"
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-gray-600 bg-gray-900 p-5 text-sm text-gray-200 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="keyboard-help-title" className="text-base font-semibold text-gray-100">
            Keys and gestures
          </h2>
          <button type="button" onClick={onClose} className="text-xs text-gray-400 hover:text-gray-200">
            Close (Esc)
          </button>
        </div>
        <div className="mt-3 grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {keymapFor(mode, where).map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{group.title}</h3>
              <dl className="flex flex-col gap-1.5">
                {group.entries.map((entry) => (
                  <div key={entry.what} className="flex items-start gap-3">
                    <dt className="flex w-36 flex-shrink-0 flex-wrap gap-1">
                      {entry.keys.map((k) => (
                        <kbd key={k} className="rounded border border-gray-600 bg-gray-800 px-1.5 py-0.5 font-mono text-[11px] text-gray-100">
                          {k}
                        </kbd>
                      ))}
                    </dt>
                    <dd className="text-xs leading-5 text-gray-300">
                      {entry.what}
                      {touch && entry.touch && <span className="block text-gray-500">Touch: {entry.touch}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
