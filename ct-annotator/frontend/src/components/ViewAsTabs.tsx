import { VIEW_AS_OPTIONS, ViewAs } from "../viewAs";

/** The admin-only "View as" tabs, dark-themed for the viewer's chrome.
 * Same four roles and meaning as admin-ui's switcher. */
export default function ViewAsTabs({ value, onChange }: { value: ViewAs; onChange: (v: ViewAs) => void }) {
  return (
    <div className="flex items-center gap-2" data-testid="view-as">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">View as</span>
      <div className="flex rounded border border-[#444] bg-[#20203a] p-0.5" role="tablist" aria-label="View the viewer as a role">
        {VIEW_AS_OPTIONS.map((o) => (
          <button
            key={o.value}
            role="tab"
            aria-selected={value === o.value}
            onClick={() => onChange(o.value)}
            className={`whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
              value === o.value ? "bg-[#2a2a3e] text-sky-300" : "text-gray-500 hover:text-gray-200"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
