import { useNavigate } from "react-router-dom";

import { useMe, VIEW_AS_OPTIONS, ViewAs } from "../auth/MeContext";

/** A real global admin's permanent "View as" rail: a slim sidebar pinned
 * to the far left of the whole app (mounted once, above every route --
 * see App.tsx), so it looks and sits in the same place regardless of
 * which layout the current page uses (the full admin sidebar, the
 * reduced workbench top bar, or the workflow board's own header). Renders
 * nothing for anyone but a real global admin -- see MeContext.viewAs. */
export default function AdminViewAsRail() {
  const { canSwitchView, viewAs, setViewAs } = useMe();
  const navigate = useNavigate();
  if (!canSwitchView) return null;

  function choose(role: ViewAs) {
    if (role === viewAs) return;
    const reduced = (r: ViewAs) => r === "annotator" || r === "reviewer";
    setViewAs(role);
    // Only move when the layout actually changes: a reduced role has
    // just My Jobs, and coming back from one starts on Studies. Admin
    // <-> data manager stays on the current page.
    if (reduced(role)) navigate("/my-jobs");
    else if (reduced(viewAs)) navigate("/studies");
  }

  return (
    <div
      data-testid="view-as"
      className="flex h-screen w-36 flex-shrink-0 flex-col gap-1 border-r border-gray-200/70 bg-white/95 px-2.5 py-4 backdrop-blur-sm"
    >
      <p className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">View as</p>
      <div className="flex flex-col gap-1" role="tablist" aria-label="View the UI as a role">
        {VIEW_AS_OPTIONS.map((o) => (
          <button
            key={o.value}
            role="tab"
            aria-selected={viewAs === o.value}
            onClick={() => choose(o.value)}
            className={`rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
              viewAs === o.value
                ? "bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200"
                : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="mt-auto px-1 pt-2 text-[10px] leading-relaxed text-gray-400">
        Admin-only preview. Your account stays signed in -- this only changes what the UI shows.
      </p>
    </div>
  );
}
