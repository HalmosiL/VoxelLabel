import { useState } from "react";
import { Link } from "react-router-dom";

import { KeycloakUser } from "../../api/adminApi";
import { CaseSummary } from "../../api/dataApi";
import { SplitPart, WorkflowCard, WorkflowCardPatchInput } from "../../api/workflowApi";
import { RUNNABLE_TYPES } from "./handleRules";
import { TASK_STATUS_STYLE } from "./statusStyle";

interface PanelProps {
  card: WorkflowCard | null;
  selectedCount: number;
  cases: CaseSummary[];
  keycloakUsers: KeycloakUser[];
  studyId: string;
  onClose: () => void;
  onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void;
  onDelete: (cardId: string) => void;
  onBulkDelete: () => void;
  onRun: (cardId: string) => void;
  onSelectCard: (cardId: string) => void;
  running: boolean;
}

export default function WorkflowPropertiesPanel({
  card,
  selectedCount,
  cases,
  keycloakUsers,
  studyId,
  onClose,
  onPatch,
  onDelete,
  onBulkDelete,
  onRun,
  onSelectCard,
  running,
}: PanelProps) {
  if (selectedCount > 1) {
    return (
      <aside className="flex w-80 flex-shrink-0 flex-col gap-4 border-l border-gray-200/70 bg-white/90 p-4">
        <div className="flex items-center justify-between">
          <p className="section-title">{selectedCount} cards selected</p>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            ×
          </button>
        </div>
        <button onClick={onBulkDelete} className="btn-danger btn-sm self-start">
          Delete selected
        </button>
      </aside>
    );
  }

  if (!card) return null;

  return (
    <aside className="flex w-80 flex-shrink-0 flex-col gap-4 overflow-y-auto border-l border-gray-200/70 bg-white/90 p-4">
      {/* Keyed by card.id so every field component below fully remounts
          (resetting its local useState buffer) when the selection moves
          to a different card of the same type -- otherwise React reuses
          the same instance and text fields would keep showing the
          previously-selected card's stale value. */}
      <div key={card.id} className="contents">
        <Header card={card} onClose={onClose} onPatch={onPatch} onDelete={onDelete} />

        {card.type === "dataset" && <DatasetFields card={card} cases={cases} onPatch={onPatch} />}

        {card.type === "split" && (
          <SplitFields
            card={card}
            studyId={studyId}
            cases={cases}
            onPatch={onPatch}
            onRun={onRun}
            onSelectCard={onSelectCard}
            running={running}
          />
        )}

        {card.type === "filter" && (
          <FilterFields card={card} studyId={studyId} cases={cases} onPatch={onPatch} onRun={onRun} running={running} />
        )}

        {card.type === "union" && (
          <UnionFields card={card} studyId={studyId} cases={cases} onRun={onRun} running={running} />
        )}

        {(card.type === "annotation" || card.type === "review") && (
          <TaskFields
            card={card}
            studyId={studyId}
            cases={cases}
            keycloakUsers={keycloakUsers}
            onPatch={onPatch}
            onRun={onRun}
            onSelectCard={onSelectCard}
            running={running}
          />
        )}

        {card.type === "note" && <NoteFields card={card} onPatch={onPatch} />}

        {card.type === "milestone" && <MilestoneFields card={card} onPatch={onPatch} />}
      </div>
    </aside>
  );
}

function Header({
  card,
  onClose,
  onPatch,
  onDelete,
}: {
  card: WorkflowCard;
  onClose: () => void;
  onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void;
  onDelete: (cardId: string) => void;
}) {
  const [title, setTitle] = useState(card.title);

  function handleBlur() {
    if (title !== card.title) onPatch(card.id, { title });
  }

  function handleDelete() {
    if (!window.confirm(`Delete "${card.title}"? This cannot be undone.`)) return;
    onDelete(card.id);
  }

  return (
    <div className="flex flex-col gap-3 border-b border-gray-100 pb-4">
      <div className="flex items-center justify-between">
        <span className="badge-blue">{card.type}</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
          ×
        </button>
      </div>
      <label className="field">
        <span className="label">Title</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={handleBlur} />
      </label>
      <button onClick={handleDelete} className="btn-danger btn-sm self-start">
        Delete card
      </button>
    </div>
  );
}

function CaseLinks({ ids, studyId, cases }: { ids: string[]; studyId: string; cases: CaseSummary[] }) {
  const [open, setOpen] = useState(false);
  const byId = new Map(cases.map((c) => [c.id, c]));

  return (
    <div className="mt-1">
      <button onClick={() => setOpen((o) => !o)} className="text-xs font-medium text-brand-600 hover:text-brand-700">
        {open ? "Hide" : "Show"} {ids.length} case{ids.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border border-gray-100 p-2">
          {ids.map((id) => {
            const summary = byId.get(id);
            return (
              <li key={id}>
                <Link to={`/studies/${studyId}/cases/${id}`} className="truncate text-xs text-brand-600 hover:text-brand-700">
                  {summary?.title || summary?.accession_number || `${id.slice(0, 8)}…`}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StaleBadge({ card }: { card: WorkflowCard }) {
  if (!card.stale) return null;
  return <span className="badge-gray">needs re-run</span>;
}

function LastRun({ card }: { card: WorkflowCard }) {
  if (!card.last_run_at) return <p className="hint">Not run yet.</p>;
  return <p className="hint">Last run {new Date(card.last_run_at).toLocaleString()}</p>;
}

function RunButton({ card, onRun, running, label }: { card: WorkflowCard; onRun: (id: string) => void; running: boolean; label: string }) {
  if (!RUNNABLE_TYPES.includes(card.type)) return null;
  return (
    <button onClick={() => onRun(card.id)} disabled={running} className="btn-secondary btn-sm self-start">
      {running ? "Running…" : label}
    </button>
  );
}

function DatasetFields({
  card,
  cases,
  onPatch,
}: {
  card: WorkflowCard;
  cases: CaseSummary[];
  onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void;
}) {
  const mode = (card.config.mode as string) ?? "all_cases";
  const manualIds = new Set((card.config.case_ids as string[] | undefined) ?? []);

  function setMode(next: "all_cases" | "manual") {
    if (next === "manual") {
      onPatch(card.id, { config: { mode: "manual", case_ids: Array.from(manualIds) } });
    } else {
      onPatch(card.id, { config: { mode: "all_cases" } });
    }
  }

  function toggleCase(caseId: string) {
    const next = new Set(manualIds);
    if (next.has(caseId)) next.delete(caseId);
    else next.add(caseId);
    onPatch(card.id, { config: { mode: "manual", case_ids: Array.from(next) } });
  }

  const count = mode === "manual" ? manualIds.size : (card.output_count as number) ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
        <button
          onClick={() => setMode("all_cases")}
          className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
            mode === "all_cases" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
          }`}
        >
          All cases
        </button>
        <button
          onClick={() => setMode("manual")}
          className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
            mode === "manual" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
          }`}
        >
          Manual pick
        </button>
      </div>
      <p className="hint">{count} case{count === 1 ? "" : "s"} in this dataset.</p>
      {mode === "manual" && (
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-gray-100 p-2">
          {cases.map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <input type="checkbox" checked={manualIds.has(c.id)} onChange={() => toggleCase(c.id)} />
              <span className="truncate text-xs text-gray-700">{c.title || c.accession_number || c.id.slice(0, 8)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const DEFAULT_SPLIT_PARTS: SplitPart[] = [
  { name: "Part 1", ratio: 0.5 },
  { name: "Part 2", ratio: 0.5 },
];

function SplitFields({
  card,
  studyId,
  cases,
  onPatch,
  onRun,
  onSelectCard,
  running,
}: {
  card: WorkflowCard;
  studyId: string;
  cases: CaseSummary[];
  onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void;
  onRun: (cardId: string) => void;
  onSelectCard: (cardId: string) => void;
  running: boolean;
}) {
  const [parts, setParts] = useState<SplitPart[]>((card.config.parts as SplitPart[] | undefined) ?? DEFAULT_SPLIT_PARTS);
  const counts = card.output_count as Record<string, number> | null;
  const outputIds = card.output_case_ids as Record<string, string[]> | null;
  const materializedIds = card.materialized_card_ids ?? {};

  function commit(next: SplitPart[]) {
    setParts(next);
    onPatch(card.id, { config: { ...card.config, parts: next } });
  }

  function updatePart(index: number, patch: Partial<SplitPart>) {
    setParts((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function addPart() {
    commit([...parts, { name: `Part ${parts.length + 1}`, ratio: 0 }]);
  }

  function removePart(index: number) {
    if (parts.length <= 2) return;
    commit(parts.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <span className="label">Parts</span>
        {parts.map((part, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <input
              className="input min-w-0 flex-1"
              value={part.name}
              onChange={(e) => updatePart(index, { name: e.target.value })}
              onBlur={() => commit(parts)}
            />
            <input
              className="input w-16 flex-shrink-0"
              type="number"
              min="0"
              step="0.05"
              value={part.ratio}
              onChange={(e) => updatePart(index, { ratio: Number(e.target.value) })}
              onBlur={() => commit(parts)}
            />
            <button
              onClick={() => removePart(index)}
              disabled={parts.length <= 2}
              className="flex-shrink-0 text-gray-400 hover:text-red-600 disabled:opacity-30"
              title="Remove part"
            >
              ×
            </button>
          </div>
        ))}
        <button onClick={addPart} className="btn-secondary btn-sm self-start">
          + Add part
        </button>
        <p className="hint">Ratios don't need to sum to 1 -- they're normalized automatically.</p>
      </div>
      <RunButton card={card} onRun={onRun} running={running} label="Run split" />
      <LastRun card={card} />
      <StaleBadge card={card} />
      {counts && outputIds && (
        <div className="flex flex-col gap-2">
          {parts.map((part, index) => {
            const handle = `part_${index}`;
            const materializedId = materializedIds[handle];
            return (
              <div key={handle}>
                <p className="text-xs font-medium text-gray-700">
                  {part.name || `Part ${index + 1}`} -- {counts[handle] ?? 0}
                </p>
                <CaseLinks ids={outputIds[handle] ?? []} studyId={studyId} cases={cases} />
                {materializedId && (
                  <button
                    onClick={() => onSelectCard(materializedId)}
                    className="mt-0.5 text-xs font-medium text-brand-600 hover:text-brand-700"
                  >
                    → Open dataset card
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FilterFields({
  card,
  studyId,
  cases,
  onPatch,
  onRun,
  running,
}: {
  card: WorkflowCard;
  studyId: string;
  cases: CaseSummary[];
  onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void;
  onRun: (cardId: string) => void;
  running: boolean;
}) {
  const tagOptions = Array.from(new Set(cases.flatMap((c) => c.tags))).sort();
  const tag = (card.config.tag as string) ?? "";
  const ids = (card.output_case_ids as string[] | null) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <label className="field">
        <span className="label">Tag</span>
        <select
          className="input"
          value={tag}
          onChange={(e) => onPatch(card.id, { config: { criterion_type: "tag", tag: e.target.value } })}
        >
          <option value="">Select a tag…</option>
          {tagOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <RunButton card={card} onRun={onRun} running={running} label="Run filter" />
      <LastRun card={card} />
      <StaleBadge card={card} />
      {card.output_case_ids && <CaseLinks ids={ids} studyId={studyId} cases={cases} />}
    </div>
  );
}

function UnionFields({
  card,
  studyId,
  cases,
  onRun,
  running,
}: {
  card: WorkflowCard;
  studyId: string;
  cases: CaseSummary[];
  onRun: (cardId: string) => void;
  running: boolean;
}) {
  const ids = (card.output_case_ids as string[] | null) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <RunButton card={card} onRun={onRun} running={running} label="Run union" />
      <LastRun card={card} />
      <StaleBadge card={card} />
      {card.output_case_ids && <CaseLinks ids={ids} studyId={studyId} cases={cases} />}
    </div>
  );
}

function TaskFields({
  card,
  studyId,
  cases,
  keycloakUsers,
  onPatch,
  onRun,
  onSelectCard,
  running,
}: {
  card: WorkflowCard;
  studyId: string;
  cases: CaseSummary[];
  keycloakUsers: KeycloakUser[];
  onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void;
  onRun: (cardId: string) => void;
  onSelectCard: (cardId: string) => void;
  running: boolean;
}) {
  const assignedUserId = (card.config.assigned_user_id as string | null) ?? "";
  const status = (card.config.status as string) ?? "todo";
  const materializeDataset = Boolean(card.config.materialize_dataset);
  const ids = (card.output_case_ids as string[] | null) ?? [];
  const progress = card.annotation_progress;

  return (
    <div className="flex flex-col gap-3">
      <label className="field">
        <span className="label">Assignee</span>
        <select
          className="input"
          value={assignedUserId}
          onChange={(e) => onPatch(card.id, { config: { ...card.config, assigned_user_id: e.target.value || null } })}
        >
          <option value="">Unassigned</option>
          {keycloakUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username ?? u.id}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="label">Status</span>
        <select className="input" value={status} onChange={(e) => onPatch(card.id, { config: { ...card.config, status: e.target.value } })}>
          {Object.entries(TASK_STATUS_STYLE).map(([value, style]) => (
            <option key={value} value={value}>
              {style.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-700">
        <input
          type="checkbox"
          checked={materializeDataset}
          onChange={(e) => onPatch(card.id, { config: { ...card.config, materialize_dataset: e.target.checked } })}
        />
        Also create/update a Dataset card of just the annotated cases
      </label>
      <RunButton card={card} onRun={onRun} running={running} label="Refresh from upstream" />
      <LastRun card={card} />
      <StaleBadge card={card} />
      {progress && (
        <p className="hint">
          {progress.annotated} of {progress.total} cases {card.type === "review" ? "reviewed" : "annotated"} (real data)
        </p>
      )}
      {card.output_case_ids && <CaseLinks ids={ids} studyId={studyId} cases={cases} />}
      {card.materialized_card_id && (
        <button
          onClick={() => onSelectCard(card.materialized_card_id!)}
          className="self-start text-xs font-medium text-brand-600 hover:text-brand-700"
        >
          → Open annotated dataset card
        </button>
      )}
    </div>
  );
}

function NoteFields({ card, onPatch }: { card: WorkflowCard; onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void }) {
  const [text, setText] = useState((card.config.text as string) ?? "");

  return (
    <label className="field">
      <span className="label">Text</span>
      <textarea
        className="input"
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onPatch(card.id, { config: { text } })}
      />
    </label>
  );
}

function MilestoneFields({ card, onPatch }: { card: WorkflowCard; onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void }) {
  const [text, setText] = useState((card.config.text as string) ?? "");
  const [date, setDate] = useState((card.config.date as string | null) ?? "");

  return (
    <div className="flex flex-col gap-3">
      <label className="field">
        <span className="label">Label</span>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onPatch(card.id, { config: { text, date: date || null } })} />
      </label>
      <label className="field">
        <span className="label">Date</span>
        <input
          className="input"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          onBlur={() => onPatch(card.id, { config: { text, date: date || null } })}
        />
      </label>
    </div>
  );
}
