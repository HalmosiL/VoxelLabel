/**
 * The editor for one label's per-object form (see ct-annotator's
 * components/ObjectForm.tsx for how the viewer renders it): a dialog
 * with the fields on the left -- name, kind (tick / pick one / scale),
 * the kind's own settings, reorder and delete -- and a live preview on
 * the right of exactly what an annotator will see under an instance of
 * this label. Edits are a local draft until Save.
 */
import { FormEvent, KeyboardEvent, ReactNode, useState } from "react";

import Modal from "../Modal";
import { TrashIcon } from "../icons";

export type LabelFieldKind = "check" | "choice" | "scale";

export interface LabelField {
  name: string;
  kind: LabelFieldKind;
  options?: string[];
  min?: number;
  max?: number;
}

const KIND_META: Record<LabelFieldKind, { label: string; blurb: string }> = {
  check: { label: "Tick", blurb: "A yes / no flag, e.g. Calcified." },
  choice: { label: "Pick one", blurb: "One of a few options, e.g. Type: solid, sub-solid, ground-glass." },
  scale: { label: "Scale", blurb: "A number on a range, e.g. Confidence 1-5." },
};

function blankField(kind: LabelFieldKind): LabelField {
  if (kind === "choice") return { name: "", kind, options: [] };
  if (kind === "scale") return { name: "", kind, min: 1, max: 5 };
  return { name: "", kind };
}

/** Why a field can't be saved yet, or null when it's fine. */
export function fieldProblem(field: LabelField, all: LabelField[]): string | null {
  const name = field.name.trim();
  if (!name) return "Give the field a name.";
  if (all.filter((f) => f.name.trim().toLowerCase() === name.toLowerCase()).length > 1) return "Another field has this name.";
  if (field.kind === "choice" && (field.options ?? []).filter((o) => o.trim()).length < 2) return "Add at least two options.";
  if (field.kind === "scale") {
    const min = field.min ?? 1;
    const max = field.max ?? 5;
    if (!Number.isFinite(min) || !Number.isFinite(max)) return "From and To must be numbers.";
    if (max <= min) return "To must be greater than From.";
  }
  return null;
}

export default function LabelFormModal({
  labelName,
  color,
  fields,
  onSave,
  onClose,
  title,
  intro,
}: {
  labelName: string;
  color: string;
  fields: LabelField[];
  onSave: (fields: LabelField[]) => void;
  onClose: () => void;
  /** instead of "<label> · form" (the case questions use the same editor) */
  title?: string;
  intro?: ReactNode;
}) {
  const [draft, setDraft] = useState<LabelField[]>(() => fields.map((f) => ({ ...f, options: f.options ? [...f.options] : f.options })));
  const problems = draft.map((f) => fieldProblem(f, draft));
  const canSave = problems.every((p) => p === null);

  function update(index: number, patch: Partial<LabelField>) {
    setDraft((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }
  function setKind(index: number, kind: LabelFieldKind) {
    setDraft((prev) =>
      prev.map((f, i) => {
        if (i !== index || f.kind === kind) return f;
        // Keep the name, start the kind's own settings fresh.
        return { ...blankField(kind), name: f.name };
      })
    );
  }
  function move(index: number, delta: -1 | 1) {
    setDraft((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  function remove(index: number) {
    setDraft((prev) => prev.filter((_, i) => i !== index));
  }
  function add(kind: LabelFieldKind) {
    setDraft((prev) => [...prev, blankField(kind)]);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    onSave(
      draft.map((f) => ({
        ...f,
        name: f.name.trim(),
        ...(f.kind === "choice" ? { options: (f.options ?? []).map((o) => o.trim()).filter(Boolean) } : {}),
      }))
    );
  }

  return (
    <Modal title={title ?? `${labelName} · form`} onClose={onClose} maxWidthClassName="max-w-4xl">
      <form onSubmit={submit} className="flex flex-col gap-4" data-testid="label-form-modal">
        <p className="hint">
          {intro ?? (
            <>
              What an annotator fills in for every <b>{labelName}</b> instance, next to its comment -- and what the
              reviewer sees on the review card.
            </>
          )}{" "}
          The preview on the right is exactly how it looks in the viewer.
        </p>

        <div className="grid gap-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {/* ── Fields ── */}
          <div className="flex min-w-0 flex-col gap-3">
            {draft.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-300 p-5 text-center text-sm text-gray-500">
                No fields yet -- add the first one below.
              </div>
            )}
            {draft.map((field, i) => (
              <div key={i} className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm" data-testid="form-field">
                <div className="flex items-center gap-2">
                  <span className="w-6 text-center text-xs font-semibold text-gray-400">{i + 1}</span>
                  <input
                    className="input min-w-0 flex-1"
                    value={field.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    placeholder={field.kind === "check" ? "e.g. Calcified" : field.kind === "scale" ? "e.g. Confidence" : "e.g. Type"}
                    aria-label="Field name"
                    autoFocus={!field.name}
                  />
                  <div className="flex overflow-hidden rounded-lg border border-gray-200" role="radiogroup" aria-label="Kind">
                    {(Object.keys(KIND_META) as LabelFieldKind[]).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        role="radio"
                        aria-checked={field.kind === kind}
                        onClick={() => setKind(i, kind)}
                        className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                          field.kind === kind ? "bg-brand-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
                        }`}
                      >
                        {KIND_META[kind].label}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-shrink-0 items-center">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30" title="Move up" aria-label="Move up">
                      ↑
                    </button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === draft.length - 1} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30" title="Move down" aria-label="Move down">
                      ↓
                    </button>
                    <button type="button" onClick={() => remove(i)} className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" title="Remove this field" aria-label="Remove this field">
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div className="mt-2 pl-8">
                  {field.kind === "check" && <p className="text-xs text-gray-500">{KIND_META.check.blurb} Shown as a checkbox.</p>}
                  {field.kind === "choice" && <OptionsEditor options={field.options ?? []} onChange={(options) => update(i, { options })} />}
                  {field.kind === "scale" && (
                    <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
                      From
                      <input type="number" className="input w-20" value={field.min ?? 1} onChange={(e) => update(i, { min: Number(e.target.value) })} aria-label="Scale minimum" />
                      to
                      <input type="number" className="input w-20" value={field.max ?? 5} onChange={(e) => update(i, { max: Number(e.target.value) })} aria-label="Scale maximum" />
                      <span className="text-xs text-gray-400">whole numbers, one step at a time</span>
                    </div>
                  )}
                  {problems[i] && (
                    <p className="mt-1.5 text-xs text-amber-700" data-testid="field-problem">
                      {problems[i]}
                    </p>
                  )}
                </div>
              </div>
            ))}

            <div className="grid gap-2 sm:grid-cols-3">
              {(Object.keys(KIND_META) as LabelFieldKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => add(kind)}
                  className="rounded-xl border border-gray-200 p-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-50"
                  data-testid={`add-${kind}`}
                >
                  <span className="block text-sm font-semibold text-gray-800">+ {KIND_META[kind].label}</span>
                  <span className="mt-0.5 block text-xs text-gray-500">{KIND_META[kind].blurb}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── Preview ── */}
          <div className="min-w-0">
            <span className="label">Preview -- as the annotator sees it</span>
            <FormPreview labelName={labelName} color={color} fields={draft} />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-4">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!canSave} title={canSave ? undefined : "Fix the highlighted fields first"}>
            Save form
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The options of a pick-one field as removable chips plus an input:
 * Enter, comma or the Add button adds; paste "a, b, c" adds three. */
function OptionsEditor({ options, onChange }: { options: string[]; onChange: (next: string[]) => void }) {
  const [text, setText] = useState("");
  function commit() {
    const parts = text.split(",").map((o) => o.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...options];
    for (const p of parts) if (!next.some((o) => o.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next);
    setText("");
  }
  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && text === "" && options.length > 0) {
      onChange(options.slice(0, -1));
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5" data-testid="options">
        {options.map((option, i) => (
          <span key={i} className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 py-0.5 pl-2.5 pr-1 text-xs text-brand-800">
            {option}
            <button
              type="button"
              onClick={() => onChange(options.filter((_, j) => j !== i))}
              className="flex h-4 w-4 items-center justify-center rounded-full text-brand-500 hover:bg-brand-200 hover:text-brand-900"
              aria-label={`Remove ${option}`}
            >
              ×
            </button>
          </span>
        ))}
        <span className="flex min-w-[12rem] flex-1 items-center gap-1.5">
          <input
            className="input min-w-0 flex-1 py-1 text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onBlur={commit}
            placeholder={options.length ? "Another option…" : "Type an option and press Enter (e.g. solid)"}
            aria-label="New option"
          />
          <button type="button" onClick={commit} className="btn-secondary btn-sm flex-shrink-0" disabled={!text.trim()}>
            Add
          </button>
        </span>
      </div>
      <p className="text-xs text-gray-400">Enter or comma adds an option; × removes one. The annotator picks exactly one.</p>
    </div>
  );
}

/** A faithful, non-interactive mock of ct-annotator's object row with
 * its form tab open (same dark palette and control shapes). */
function FormPreview({ labelName, color, fields }: { labelName: string; color: string; fields: LabelField[] }) {
  const usable = fields.filter((f) => f.name.trim());
  return (
    <div className="mt-1 overflow-hidden rounded-xl border border-[#333] bg-[#1e1e2e] text-[11px] text-gray-300" data-testid="form-preview">
      <div className="flex items-center gap-1.5 bg-[#252538] px-2 py-1.5">
        <span className="h-3.5 w-3.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="flex-1 truncate font-medium text-gray-200">{labelName || "Label"}</span>
        <span className="text-gray-500">+</span>
      </div>
      <div className="flex items-center gap-1.5 bg-blue-500/20 px-2 py-1 text-blue-200">
        <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="flex-1 truncate">{labelName || "Label"} 1</span>
        <span className="text-amber-400">▴</span>
        <span className="text-gray-500">👁</span>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-[#333] bg-[#1b1b2f] px-2 py-1.5">
        {usable.length === 0 && <p className="text-gray-500">(no fields yet -- only the comment box)</p>}
        {usable.map((field, i) =>
          field.kind === "check" ? (
            <label key={i} className="flex items-center gap-2 text-gray-200">
              <span className="inline-block h-4 w-4 rounded-sm border border-gray-500 bg-[#2a2a3e]" />
              {field.name}
            </label>
          ) : field.kind === "scale" ? (
            <div key={i} className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-500">
                <span>{field.name}</span>
                <span className="normal-case tracking-normal text-gray-300">
                  — <span className="text-gray-600">/ {field.max ?? 5}</span>
                </span>
              </div>
              <div className="relative h-4">
                <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-[#3a3a55]" />
                <div className="absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-blue-500" />
              </div>
            </div>
          ) : (
            <div key={i} className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-gray-500">{field.name}</span>
              <div className="flex flex-wrap gap-1">
                {(field.options ?? []).filter((o) => o.trim()).map((option, j) => (
                  <span
                    key={j}
                    className={`rounded border px-2 py-0.5 ${j === 0 ? "border-blue-500 bg-blue-500/20 text-blue-200" : "border-[#444] bg-[#2a2a3e] text-gray-300"}`}
                  >
                    {option}
                  </span>
                ))}
                {(field.options ?? []).filter((o) => o.trim()).length === 0 && <span className="text-gray-500">(add options)</span>}
              </div>
            </div>
          )
        )}
        <div className="rounded border border-[#444] bg-[#2a2a3e] p-1.5 text-gray-500">Comment…</div>
      </div>
    </div>
  );
}
