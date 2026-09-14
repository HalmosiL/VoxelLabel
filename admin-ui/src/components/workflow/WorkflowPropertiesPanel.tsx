import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";

import { CaseSummary } from "../../api/dataApi";
import { SplitPart, WorkflowCard, WorkflowCardPatchInput } from "../../api/workflowApi";
import { TrashIcon } from "../icons";
import { RUNNABLE_TYPES } from "./handleRules";
import PytorchExportModal from "./PytorchExportModal";
import { TASK_STATUS_STYLE } from "./statusStyle";

export interface Assignee {
  id: string;
  label: string;
}

interface PanelProps {
  card: WorkflowCard | null;
  selectedCount: number;
  cases: CaseSummary[];
  // This study's members -- the only people a job can be assigned to.
  assignees: Assignee[];
  // Read-only board (viewer/annotator/reviewer): every field is disabled.
  readOnly: boolean;
  studyId: string;
  hasIncomingEdge: boolean;
  onClose: () => void;
  onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void;
  onDelete: (cardId: string) => void;
  onBulkDelete: () => void;
  onRun: (cardId: string) => void;
  onSelectCard: (cardId: string) => void;
  onOpenChat: (cardId: string) => void;
  running: boolean;
}

export default function WorkflowPropertiesPanel({
  card,
  selectedCount,
  cases,
  assignees,
  readOnly,
  studyId,
  hasIncomingEdge,
  onClose,
  onPatch,
  onDelete,
  onBulkDelete,
  onRun,
  onSelectCard,
  onOpenChat,
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
        {!readOnly && (
          <button onClick={onBulkDelete} className="btn-danger btn-sm self-start">
            Delete selected
          </button>
        )}
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
        {readOnly && (
          <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
            Read-only -- your role in this study doesn't allow editing the board.
          </p>
        )}
        {/* A disabled <fieldset> disables every form control and button
            inside it at once -- the whole panel goes read-only without
            threading a flag through every field component. */}
        <fieldset disabled={readOnly} className="contents">
        <Header card={card} onClose={onClose} onPatch={onPatch} onDelete={onDelete} />

        {card.type === "dataset" && (
          <DatasetFields
            card={card}
            studyId={studyId}
            cases={cases}
            onPatch={onPatch}
            onRun={onRun}
            onSelectCard={onSelectCard}
            running={running}
            hasIncomingEdge={hasIncomingEdge}
          />
        )}

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
            assignees={assignees}
            onPatch={onPatch}
            onRun={onRun}
            onSelectCard={onSelectCard}
            running={running}
          />
        )}

        {(card.type === "llm" || card.type === "builder" || card.type === "criterion") && (
          <AiFields
            card={card}
            onPatch={onPatch}
            onOpenChat={onOpenChat}
            onSelectCard={onSelectCard}
            onRun={onRun}
            running={running}
          />
        )}

        {card.type === "annotation_surface" && <AnnotationSurfaceFields card={card} onPatch={onPatch} />}

        {card.type === "review_surface" && <ReviewSurfaceFields card={card} onPatch={onPatch} />}

        {card.type === "note" && <NoteFields card={card} onPatch={onPatch} />}

        {card.type === "milestone" && <MilestoneFields card={card} onPatch={onPatch} />}
        </fieldset>
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
  studyId,
  cases,
  onPatch,
  onRun,
  onSelectCard,
  running,
  hasIncomingEdge,
}: {
  card: WorkflowCard;
  studyId: string;
  cases: CaseSummary[];
  onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void;
  onRun: (cardId: string) => void;
  onSelectCard: (cardId: string) => void;
  running: boolean;
  hasIncomingEdge: boolean;
}) {
  const [exporting, setExporting] = useState(false);
  const mode = (card.config.mode as string) ?? "all_cases";
  const manualIds = new Set((card.config.case_ids as string[] | undefined) ?? []);
  const exportCaseIds = mode === "manual" ? Array.from(manualIds) : cases.map((c) => c.id);

  // A Dataset another card materialized (Split's part, Review's
  // approved/rejected, Annotation's "(annotated)", ...) is owned by that
  // parent: every Run of the parent rewrites this card's case list, so
  // offering the All cases / Manual pick controls here would only invite
  // edits that silently vanish on the next Run. Show where the list comes
  // from instead, and keep export available -- the list itself is real.
  if (card.materialized_from) {
    return (
      <div className="flex flex-col gap-3">
        <p className="hint">
          Kept in sync from <span className="font-medium text-gray-700">{card.materialized_from.title}</span> -- every Run
          of that card rewrites this list. To change what lands here, change (and re-run) that card.
        </p>
        <button onClick={() => onSelectCard(card.materialized_from!.card_id)} className="btn-secondary btn-sm self-start">
          Open {card.materialized_from.title}
        </button>
        <p className="text-sm text-gray-700">
          {manualIds.size} case{manualIds.size === 1 ? "" : "s"} in this dataset.
        </p>
        <LastRun card={card} />
        <button onClick={() => setExporting(true)} className="btn-secondary btn-sm self-start">
          Export for PyTorch
        </button>
        {exporting && (
          <PytorchExportModal
            studyId={studyId}
            cardId={card.id}
            caseCount={manualIds.size}
            onClose={() => setExporting(false)}
          />
        )}
      </div>
    );
  }

  function setMode(next: "all_cases" | "manual") {
    if (next === "manual") {
      onPatch(card.id, { config: { mode: "manual", case_ids: Array.from(manualIds) } });
    } else {
      // Switching away from a real Manual pick selection is easy to click
      // by accident, and immediately overwrites this card's saved case
      // list (e.g. what Export for PyTorch or Run would use) with "every
      // case in the study" -- confirm first rather than silently
      // discarding a curated selection.
      if (mode === "manual" && manualIds.size > 0) {
        const ok = window.confirm(
          `Switch to "All cases"? This replaces your ${manualIds.size}-case manual selection with every case in the study.`
        );
        if (!ok) return;
      }
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
      {hasIncomingEdge && (
        <>
          <p className="hint">
            Something is connected into this card -- Run saves its current result as this dataset's case list.
          </p>
          <RunButton card={card} onRun={onRun} running={running} label="Save from connection" />
          <LastRun card={card} />
          <StaleBadge card={card} />
        </>
      )}
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
      <button
        onClick={() => setExporting(true)}
        disabled={exportCaseIds.length === 0}
        className="btn-secondary btn-sm self-start"
      >
        Export for PyTorch
      </button>
      {exporting && (
        <PytorchExportModal
          studyId={studyId}
          cardId={card.id}
          caseCount={exportCaseIds.length}
          onClose={() => setExporting(false)}
        />
      )}
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

// The Clinical Trial module's mocked-LLM card. No Run button here --
// unlike every other RUNNABLE_TYPES card, it isn't a batch recompute;
// its chat session (opened via onOpenChat) is what drives it.
// Per-card-type blurb and materialized-children label for the three
// Clinical Trial Assistant chat card types -- everything else about
// their panel (MCP badge, connected count, "Open session", the
// materialized-children list) is the same shape, so only these two
// strings actually vary by role.
const AI_CARD_BLURB: Record<string, string> = {
  llm: "Connects via MCP to whatever Dataset(s) are wired into its input, as this session's data sources.",
  builder:
    "Scoped to the whole study, not to connected data -- helps plan a CONSORT-style eligibility pipeline and constructs it on the board (a root Dataset, then a chain of Criterion cards).",
  criterion: "Connects via MCP to whatever's wired into its input, and judges each connected case against the criterion below.",
};
const AI_CARD_CHILDREN_LABEL: Record<string, string> = {
  llm: "Created datasets",
  criterion: "Included / excluded",
};

function AiFields({
  card,
  onPatch,
  onOpenChat,
  onSelectCard,
  onRun,
  running,
}: {
  card: WorkflowCard;
  onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void;
  onOpenChat: (cardId: string) => void;
  onSelectCard: (cardId: string) => void;
  onRun: (cardId: string) => void;
  running: boolean;
}) {
  const [criterion, setCriterion] = useState((card.config.criterion as string) ?? "");
  // Builder has no connected data of its own (scoped to the whole study
  // instead -- see handleRules.ts), so it never gets this field at all;
  // LLM/Criterion always do, defaulting to 0 rather than hiding the line.
  const connectedCount = card.llm_connected_case_count;
  const children = Object.entries(card.materialized_card_ids ?? {});

  return (
    <div className="flex flex-col gap-3">
      <p className="hint">{AI_CARD_BLURB[card.type] ?? AI_CARD_BLURB.llm}</p>
      {card.type === "criterion" && (
        <label className="field">
          <span className="label">Criterion</span>
          <textarea
            className="input"
            rows={2}
            placeholder='e.g. "age >= 18"'
            value={criterion}
            onChange={(e) => setCriterion(e.target.value)}
            onBlur={() => onPatch(card.id, { config: { ...card.config, criterion } })}
          />
        </label>
      )}
      {connectedCount != null && (
        <p className="flex items-center gap-1.5 text-xs text-gray-700">
          <span className="badge-blue">MCP</span>
          {connectedCount} case{connectedCount === 1 ? "" : "s"} connected
        </p>
      )}
      <div className="flex items-center gap-2">
        <button onClick={() => onOpenChat(card.id)} className="btn-secondary btn-sm self-start">
          Open session
        </button>
        {/* Criterion's one action ("evaluate every connected case") is
            well-defined enough to also offer as a one-click Run, unlike
            LLM/Builder's open-ended chat -- RunButton itself no-ops for
            those (see RUNNABLE_TYPES). */}
        <RunButton card={card} onRun={onRun} running={running} label="Evaluate" />
      </div>
      {card.type === "criterion" && (
        <div className="flex items-center gap-2">
          <StaleBadge card={card} />
          <LastRun card={card} />
        </div>
      )}
      {children.length > 0 && (
        <div className="flex flex-col items-start gap-1">
          <span className="label">{AI_CARD_CHILDREN_LABEL[card.type] ?? "Created datasets"}</span>
          {children.map(([handle, id]) => (
            <button key={handle} onClick={() => onSelectCard(id)} className="text-xs font-medium text-brand-600 hover:text-brand-700">
              → Open {handle} dataset card
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskFields({
  card,
  studyId,
  cases,
  assignees,
  onPatch,
  onRun,
  onSelectCard,
  running,
}: {
  card: WorkflowCard;
  studyId: string;
  cases: CaseSummary[];
  assignees: Assignee[];
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
          {assignees.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
          {assignedUserId && !assignees.some((u) => u.id === assignedUserId) && (
            <option value={assignedUserId}>{assignedUserId.slice(0, 8)}… (no longer a member)</option>
          )}
        </select>
        {assignees.length === 0 && <span className="hint">Add members to the study to assign this job.</span>}
      </label>
      <div className="field">
        <span className="label">Status</span>
        {/* Read-only: computed by the backend from the cases' real
            annotation state (compute_job_status) on every read, so it
            can neither drift nor be set by hand. */}
        <span className={`badge ${(TASK_STATUS_STYLE[status] ?? TASK_STATUS_STYLE.todo).badge} w-fit`}>
          <span className={`badge-dot ${(TASK_STATUS_STYLE[status] ?? TASK_STATUS_STYLE.todo).dot}`} />
          {(TASK_STATUS_STYLE[status] ?? TASK_STATUS_STYLE.todo).label}
        </span>
        <span className="hint">
          Follows the cases by itself: In progress once any case is started or sent back, Done once every case is
          {card.type === "review" ? " decided" : " annotated"}.
        </span>
      </div>
      {card.type === "review" ? (
        <p className="hint">Running this card always refreshes its "(approved)" and "(rejected)" Dataset cards.</p>
      ) : (
        <label className="flex items-center gap-2 text-xs text-gray-700">
          <input
            type="checkbox"
            checked={materializeDataset}
            onChange={(e) => onPatch(card.id, { config: { ...card.config, materialize_dataset: e.target.checked } })}
          />
          Also create/update a Dataset card of just the annotated cases
        </label>
      )}
      <RunButton card={card} onRun={onRun} running={running} label="Refresh from upstream" />
      <LastRun card={card} />
      <StaleBadge card={card} />
      {progress && (
        <p className="hint">
          {progress.annotated} of {progress.total} cases {card.type === "review" ? "reviewed" : "annotated"} (real data)
        </p>
      )}
      {card.output_case_ids && <CaseLinks ids={ids} studyId={studyId} cases={cases} />}
      {card.type === "review" && card.materialized_card_ids && (
        <div className="flex flex-col items-start gap-1">
          {card.materialized_card_ids.approved && (
            <button
              onClick={() => onSelectCard(card.materialized_card_ids!.approved)}
              className="text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              → Open approved dataset card
            </button>
          )}
          {card.materialized_card_ids.rejected && (
            <button
              onClick={() => onSelectCard(card.materialized_card_ids!.rejected)}
              className="text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              → Open rejected dataset card (feed this back into Annotation for rework)
            </button>
          )}
        </div>
      )}
      {card.type === "annotation" && card.materialized_card_id && (
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

// ct-annotator's stable tool/pane identifiers (see ViewerPage.tsx's
// DrawTool union and ALL_PANE_VISIBILITY_KEYS) -- "cursor" (pure
// navigation) and "three_d" are handled separately (3D has its own
// toggle below; cursor is never gated at all) rather than listed here.
const SURFACE_TOOL_OPTIONS: { value: string; label: string }[] = [
  { value: "paint", label: "Paint" },
  { value: "erase", label: "Erase" },
  { value: "fill", label: "Fill" },
  { value: "polygon", label: "Polygon" },
  { value: "auto", label: "Auto-contour" },
  { value: "histogram", label: "Histogram" },
];

const SURFACE_PANE_OPTIONS: { value: string; label: string }[] = [
  { value: "axial", label: "Axial" },
  { value: "sagittal", label: "Sagittal" },
  { value: "coronal", label: "Coronal" },
];

// Same 8-color rotation ct-annotator's own "New label" input auto-assigns
// from, so a label pre-defined here looks exactly like one an annotator
// would have created themselves.
const SURFACE_LABEL_COLOR_PALETTE = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];

interface SurfaceLabel {
  name: string;
  color: string;
}

function AnnotationSurfaceFields({
  card,
  onPatch,
}: {
  card: WorkflowCard;
  onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void;
}) {
  const tools = new Set((card.config.tools as string[] | undefined) ?? []);
  const panes = new Set((card.config.panes as string[] | undefined) ?? []);
  const show3d = card.config.show_3d !== false;
  const surfaceLabels = (card.config.labels as SurfaceLabel[] | undefined) ?? [];
  const [newLabelName, setNewLabelName] = useState("");

  function toggleTool(value: string) {
    const next = new Set(tools);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onPatch(card.id, { config: { ...card.config, tools: Array.from(next) } });
  }

  function togglePane(value: string) {
    const next = new Set(panes);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onPatch(card.id, { config: { ...card.config, panes: Array.from(next) } });
  }

  function addSurfaceLabel(event: FormEvent) {
    event.preventDefault();
    const name = newLabelName.trim();
    if (!name) return;
    const color = SURFACE_LABEL_COLOR_PALETTE[surfaceLabels.length % SURFACE_LABEL_COLOR_PALETTE.length];
    onPatch(card.id, { config: { ...card.config, labels: [...surfaceLabels, { name, color }] } });
    setNewLabelName("");
  }

  function recolorSurfaceLabel(index: number, color: string) {
    const next = surfaceLabels.map((l, i) => (i === index ? { ...l, color } : l));
    onPatch(card.id, { config: { ...card.config, labels: next } });
  }

  function removeSurfaceLabel(index: number) {
    onPatch(card.id, { config: { ...card.config, labels: surfaceLabels.filter((_, i) => i !== index) } });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="hint">
        Connect this to an Annotation card's top handle to mandatorily restrict what's available in the annotation
        surface for that job -- anything unchecked here is hidden entirely, not just off by default.
      </p>
      <div className="flex flex-col gap-1.5">
        <span className="label">Tools</span>
        {SURFACE_TOOL_OPTIONS.map((opt) => (
          <label key={opt.value} className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={tools.has(opt.value)} onChange={() => toggleTool(opt.value)} />
            {opt.label}
          </label>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="label">MPR panes</span>
        {SURFACE_PANE_OPTIONS.map((opt) => (
          <label key={opt.value} className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={panes.has(opt.value)} onChange={() => togglePane(opt.value)} />
            {opt.label}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-700">
        <input
          type="checkbox"
          checked={show3d}
          onChange={(e) => onPatch(card.id, { config: { ...card.config, show_3d: e.target.checked } })}
        />
        3D view
      </label>
      <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-3">
        <span className="label">Pre-defined labels</span>
        <p className="hint">
          Every annotator on this job starts with these labels already there (e.g. "Nodule") -- they just add
          instances under them while annotating, instead of each typing their own label name. Only applies to a
          series with no saved annotation yet.
        </p>
        {surfaceLabels.length > 0 && (
          <ul className="flex flex-col gap-1">
            {surfaceLabels.map((l, i) => (
              <li key={i} className="flex items-center gap-2">
                <input
                  type="color"
                  value={l.color}
                  onChange={(e) => recolorSurfaceLabel(i, e.target.value)}
                  className="h-5 w-5 flex-shrink-0 cursor-pointer rounded border-none bg-transparent p-0"
                  title="Change color"
                />
                <span className="flex-1 truncate text-xs text-gray-700">{l.name}</span>
                <button onClick={() => removeSurfaceLabel(i)} className="text-gray-400 hover:text-red-600" title="Remove label">
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addSurfaceLabel} className="flex gap-1.5">
          <input
            className="input flex-1"
            value={newLabelName}
            onChange={(e) => setNewLabelName(e.target.value)}
            placeholder="e.g. Nodule"
          />
          <button type="submit" className="btn-secondary btn-sm" disabled={!newLabelName.trim()}>
            Add
          </button>
        </form>
      </div>
    </div>
  );
}

// The review checklist a Review Surface defines: per label (e.g. Nodule)
// a few fields a reviewer ticks or picks instead of typing -- shown in
// ct-annotator's review card next to the comment box, stored on the
// object, folded into the review's comment. Same shape as ct-annotator's
// components/ReviewForm.tsx.
interface ReviewFormField {
  name: string;
  kind: "check" | "choice";
  options?: string[];
}
interface ReviewFormGroup {
  label: string;
  fields: ReviewFormField[];
}

// The review surface never has tools or 3D at all, unconditionally (see
// ct-annotator's ViewerPage reviewMode) -- no checkboxes for either
// here, since they'd be dead UI; only which MPR panes are visible, plus
// the review checklist.
function ReviewSurfaceFields({
  card,
  onPatch,
}: {
  card: WorkflowCard;
  onPatch: (cardId: string, patch: WorkflowCardPatchInput) => void;
}) {
  const panes = new Set((card.config.panes as string[] | undefined) ?? []);
  const form = (card.config.review_form as ReviewFormGroup[] | undefined) ?? [];

  function togglePane(value: string) {
    const next = new Set(panes);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onPatch(card.id, { config: { ...card.config, panes: Array.from(next) } });
  }
  function setForm(next: ReviewFormGroup[]) {
    onPatch(card.id, { config: { ...card.config, review_form: next } });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="hint">
        Connect this to a Review card's top handle to mandatorily restrict which MPR panes are available while
        reviewing that job -- the review surface has no tools or 3D at all.
      </p>
      <div className="flex flex-col gap-1.5">
        <span className="label">MPR panes</span>
        {SURFACE_PANE_OPTIONS.map((opt) => (
          <label key={opt.value} className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={panes.has(opt.value)} onChange={() => togglePane(opt.value)} />
            {opt.label}
          </label>
        ))}
      </div>
      <ReviewFormFields form={form} onChange={setForm} />
    </div>
  );
}

function ReviewFormFields({ form, onChange }: { form: ReviewFormGroup[]; onChange: (next: ReviewFormGroup[]) => void }) {
  const [newGroupLabel, setNewGroupLabel] = useState("");

  function updateGroup(index: number, patch: Partial<ReviewFormGroup>) {
    onChange(form.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  }
  function addGroup(event: FormEvent) {
    event.preventDefault();
    onChange([...form, { label: newGroupLabel.trim(), fields: [] }]);
    setNewGroupLabel("");
  }
  function addField(groupIndex: number, kind: ReviewFormField["kind"]) {
    const group = form[groupIndex];
    const field: ReviewFormField = kind === "check" ? { name: "", kind } : { name: "", kind, options: [] };
    updateGroup(groupIndex, { fields: [...group.fields, field] });
  }
  function updateField(groupIndex: number, fieldIndex: number, patch: Partial<ReviewFormField>) {
    const group = form[groupIndex];
    updateGroup(groupIndex, { fields: group.fields.map((f, i) => (i === fieldIndex ? { ...f, ...patch } : f)) });
  }
  function removeField(groupIndex: number, fieldIndex: number) {
    const group = form[groupIndex];
    updateGroup(groupIndex, { fields: group.fields.filter((_, i) => i !== fieldIndex) });
  }

  return (
    <div className="flex flex-col gap-2 border-t border-gray-100 pt-3" data-testid="review-form-editor">
      <span className="label">Review checklist</span>
      <p className="hint">
        Per label (e.g. "Nodule"), what the reviewer can tick or pick for each object instead of typing it --
        a <b>tick</b> is a yes/no flag, a <b>pick one</b> offers options (e.g. Type: solid, sub-solid,
        ground-glass). Leave the label empty for fields that apply to every label. The answers show next to the
        object for the annotator and go into the review's comment.
      </p>
      {form.map((group, gi) => (
        <div key={gi} className="flex flex-col gap-1.5 rounded border border-gray-200 p-2" data-testid="review-form-group">
          <div className="flex items-center gap-1.5">
            <input
              className="input flex-1"
              value={group.label}
              onChange={(e) => updateGroup(gi, { label: e.target.value })}
              placeholder="Label (empty = every label)"
              aria-label="Label"
            />
            <button
              onClick={() => onChange(form.filter((_, i) => i !== gi))}
              className="text-gray-400 hover:text-red-600"
              title="Remove this group"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {group.fields.map((field, fi) => (
            <div key={fi} className="flex flex-col gap-1 pl-2">
              <div className="flex items-center gap-1.5">
                <span className="w-14 flex-shrink-0 text-[10px] uppercase tracking-wide text-gray-400">
                  {field.kind === "check" ? "tick" : "pick one"}
                </span>
                <input
                  className="input flex-1"
                  value={field.name}
                  onChange={(e) => updateField(gi, fi, { name: e.target.value })}
                  placeholder={field.kind === "check" ? "e.g. Calcified" : "e.g. Type"}
                  aria-label="Field name"
                />
                <button onClick={() => removeField(gi, fi)} className="text-gray-400 hover:text-red-600" title="Remove this field">
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              {field.kind === "choice" && (
                <div className="pl-[3.9rem] pr-5">
                  <input
                    className="input w-full min-w-0"
                    value={(field.options ?? []).join(", ")}
                    onChange={(e) =>
                      updateField(gi, fi, { options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) })
                    }
                    placeholder="Options, comma-separated: solid, sub-solid, ground-glass"
                    aria-label="Options"
                  />
                </div>
              )}
            </div>
          ))}
          <div className="flex gap-1.5 pl-2">
            <button onClick={() => addField(gi, "check")} className="btn-secondary btn-sm">
              + Tick
            </button>
            <button onClick={() => addField(gi, "choice")} className="btn-secondary btn-sm">
              + Pick one
            </button>
          </div>
        </div>
      ))}
      <form onSubmit={addGroup} className="flex gap-1.5">
        <input
          className="input flex-1"
          value={newGroupLabel}
          onChange={(e) => setNewGroupLabel(e.target.value)}
          placeholder='Label, e.g. "Nodule" (or empty for all)'
          aria-label="New group label"
        />
        <button type="submit" className="btn-secondary btn-sm">
          Add group
        </button>
      </form>
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
