/**
 * Per-object attribute form: the fields a study attaches to a label on
 * its Annotation Surface card (admin-ui's workflow board) -- e.g. for
 * "Nodule": Type = solid / sub-solid / ground-glass, Calcified,
 * Confidence 1-5. Every instance of that label gets the form, opened
 * from the small tab next to it in the Objects list, together with its
 * free-text comment; the review card shows the same form.
 *
 * Definition travels on the label (`SegLabel.fields`, seeded from the
 * surface config); answers live on the object (`SegObject.attributes`,
 * field name -> true | option | number) so they're saved with the
 * annotation, seen by the reviewer, and folded into the review's
 * comment text.
 */
export type ObjectFieldKind = "check" | "choice" | "scale";

export interface ObjectField {
  name: string;
  kind: ObjectFieldKind;
  /** choice: the options to pick one of. */
  options?: string[];
  /** scale: the range (inclusive) and step; defaults 1..5 by 1. */
  min?: number;
  max?: number;
  step?: number;
}

export type ObjectAnswers = Record<string, string | boolean | number>;

/** The usable fields of a definition: named, and (for a choice) with
 * at least one option. Duplicated names keep their first occurrence. */
export function usableFields(fields: ObjectField[] | undefined): ObjectField[] {
  if (!fields) return [];
  const seen = new Set<string>();
  const out: ObjectField[] = [];
  for (const field of fields) {
    const name = field.name.trim();
    if (!name || seen.has(name)) continue;
    if (field.kind === "choice" && !(field.options ?? []).some((o) => o.trim())) continue;
    seen.add(name);
    out.push({ ...field, name });
  }
  return out;
}

export function scaleBounds(field: ObjectField): { min: number; max: number; step: number } {
  const min = Number.isFinite(field.min) ? (field.min as number) : 1;
  const max = Number.isFinite(field.max) && (field.max as number) > min ? (field.max as number) : min + 4;
  const step = Number.isFinite(field.step) && (field.step as number) > 0 ? (field.step as number) : 1;
  return { min, max, step };
}

export function answerEntries(answers: ObjectAnswers | undefined): [string, string | number | true][] {
  if (!answers) return [];
  return Object.entries(answers).filter(
    (e): e is [string, string | number | true] => e[1] === true || typeof e[1] === "number" || (typeof e[1] === "string" && e[1] !== ""),
  );
}

/** "Type: solid · Calcified · Confidence: 4" -- one short line for the
 * review comment and the object list. Unticked checks and empty
 * choices are left out. */
export function formatAnswers(answers: ObjectAnswers | undefined): string {
  return answerEntries(answers)
    .map(([name, value]) => (value === true ? name : `${name}: ${value}`))
    .join(" · ");
}

/** One control per field. `onChange` gets the whole answers object back
 * (a cleared answer is removed, never stored as false / ""). */
export function ObjectFormEditor({
  fields,
  answers,
  onChange,
  accent = "blue",
}: {
  fields: ObjectField[];
  answers: ObjectAnswers | undefined;
  onChange: (next: ObjectAnswers) => void;
  accent?: "blue" | "amber";
}) {
  const usable = usableFields(fields);
  if (usable.length === 0) return null;
  const current = answers ?? {};
  function set(name: string, value: string | boolean | number | null) {
    const next = { ...current };
    if (value === null || value === false || value === "") delete next[name];
    else next[name] = value;
    onChange(next);
  }
  const on = accent === "amber" ? "border-amber-500 bg-amber-500/20 text-amber-200" : "border-blue-500 bg-blue-500/20 text-blue-200";
  const accentClass = accent === "amber" ? "accent-amber-500" : "accent-blue-500";
  return (
    <div className="flex flex-col gap-1.5" data-testid="attr-form">
      {usable.map((field) => {
        if (field.kind === "check") {
          return (
            <label key={field.name} className="flex cursor-pointer items-center gap-2 text-[11px] text-gray-200">
              <input
                type="checkbox"
                checked={current[field.name] === true}
                onChange={(e) => set(field.name, e.target.checked)}
                className={`h-4 w-4 ${accentClass}`}
                data-testid={`field-check-${field.name}`}
              />
              {field.name}
            </label>
          );
        }
        if (field.kind === "scale") {
          const { min, max, step } = scaleBounds(field);
          const raw = current[field.name];
          const value = typeof raw === "number" ? raw : null;
          return (
            <div key={field.name} className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-500">
                <span>{field.name}</span>
                <span className="normal-case tracking-normal text-gray-300" data-testid={`field-scale-value-${field.name}`}>
                  {value === null ? "—" : value}
                  <span className="text-gray-600">
                    {" "}
                    / {max}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={value ?? min}
                  onChange={(e) => set(field.name, Number(e.target.value))}
                  aria-label={field.name}
                  data-testid={`field-scale-${field.name}`}
                  className={`min-w-0 flex-1 ${accentClass}`}
                />
                {value !== null && (
                  <button
                    type="button"
                    onClick={() => set(field.name, null)}
                    className="text-[10px] text-gray-500 hover:text-gray-300"
                    title="Clear"
                    aria-label={`Clear ${field.name}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          );
        }
        return (
          <div key={field.name} className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-gray-500">{field.name}</span>
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={field.name}>
              {(field.options ?? []).filter((o) => o.trim()).map((option) => {
                const selected = current[field.name] === option;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => set(field.name, selected ? null : option)}
                    data-testid={`field-choice-${field.name}-${option}`}
                    className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                      selected ? on : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"
                    }`}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The answers as small chips (the reviewer's reading of an object,
 * the object list's summary). */
export function AnswerChips({ answers }: { answers: ObjectAnswers | undefined }) {
  const entries = answerEntries(answers);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" data-testid="attr-answers">
      {entries.map(([name, value]) => (
        <span key={name} className="rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">
          {value === true ? name : `${name}: ${value}`}
        </span>
      ))}
    </div>
  );
}

/** The small tab next to an object in the Objects list that opens its
 * form + comment. Amber once the object carries anything, so a filled
 * form is visible at a glance even when collapsed. */
export function ObjectFormTab({ open, filled, onToggle, testId }: { open: boolean; filled: boolean; onToggle: () => void; testId?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-expanded={open}
      data-testid={testId}
      title={open ? "Close the form" : "Open the form and comment"}
      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded transition-colors ${
        filled ? "text-amber-400 hover:text-amber-300" : "text-gray-500 hover:text-white"
      }`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 120ms" }}>
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}
