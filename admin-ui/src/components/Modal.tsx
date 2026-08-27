import { ReactNode } from "react";
import { createPortal } from "react-dom";

export default function Modal({
  title,
  onClose,
  children,
  maxWidthClassName = "max-w-md",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  // Every existing caller is a short form, so max-w-md stays the
  // default; a modal with more to show (e.g. LlmChatModal's transcript)
  // can ask for more room without affecting anyone else.
  maxWidthClassName?: string;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4" onClick={onClose}>
      <div
        className={`w-full ${maxWidthClassName} rounded-2xl bg-white p-6 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="section-title">{title}</h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
