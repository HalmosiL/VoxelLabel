import { FormEvent, useEffect, useState } from "react";

import {
  createStudyVersion,
  deleteStudyVersion,
  getStudyVersion,
  listStudyVersions,
  restoreStudyVersion,
  StudyVersion,
  StudyVersionDetail,
} from "../api/adminApi";
import { describeApiError } from "../api/client";
import EmptyState from "./EmptyState";
import Modal from "./Modal";
import SectionHeader from "./SectionHeader";
import { TrashIcon } from "./icons";

const KIND_LABEL: Record<StudyVersion["kind"], { label: string; badge: string }> = {
  auto: { label: "Auto", badge: "badge-gray" },
  manual: { label: "Saved", badge: "badge-blue" },
  pre_restore: { label: "Safety copy", badge: "badge-green" },
};

/** The study's version history: every change is captured automatically
 * (coalesced into one entry per ~10 minutes of edits by the same person),
 * anyone who can edit can also save a named version, and a study admin
 * can restore any of them -- a safety copy of the current state is taken
 * first, so a restore is itself reversible. */
export default function VersionsPanel({
  studyId,
  canManage,
  canAdminister,
  onRestored,
}: {
  studyId: string;
  canManage: boolean;
  canAdminister: boolean;
  // Called after a successful restore so the surrounding page refetches.
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<StudyVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [inspecting, setInspecting] = useState<StudyVersionDetail | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function refresh() {
    listStudyVersions(studyId)
      .then(setVersions)
      .catch((err) => setError(describeApiError(err)));
  }

  useEffect(refresh, [studyId]);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await createStudyVersion(studyId, label);
      setLabel("");
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(version: StudyVersion) {
    setLoadingId(version.id);
    setError(null);
    try {
      setInspecting(await getStudyVersion(studyId, version.id));
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setLoadingId(null);
    }
  }

  async function handleRestore(version: StudyVersionDetail) {
    const c = version.changes_if_restored;
    const summary = [
      `cards: +${c.cards.added} / −${c.cards.removed} / ~${c.cards.modified}`,
      `connections: +${c.edges.added} / −${c.edges.removed}`,
      `members: +${c.members.added} / −${c.members.removed} / ~${c.members.modified}`,
      `case details: ~${c.cases.modified}`,
      c.study ? "study name/description/profile" : null,
    ]
      .filter(Boolean)
      .join("\n");
    if (
      !window.confirm(
        `Restore version ${version.number}${version.label ? ` ("${version.label}")` : ""}?\n\nThis will change:\n${summary}\n\nImaging data, documents and annotations are never touched. A safety copy of the current state is saved first.`
      )
    ) {
      return;
    }
    setError(null);
    try {
      const result = await restoreStudyVersion(studyId, version.id);
      setInspecting(null);
      setNotice(
        `Restored version ${result.restored_version}. The previous state was kept as safety copy v${result.safety_version}.`
      );
      refresh();
      onRestored();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  async function handleDelete(version: StudyVersion) {
    if (!window.confirm(`Delete version ${version.number} from the history? This cannot be undone.`)) return;
    try {
      await deleteStudyVersion(studyId, version.id);
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  const visible = showAll ? versions : versions.slice(0, 8);

  return (
    <div className="card">
      <SectionHeader
        title="Version history"
        action={
          canManage ? (
            <form onSubmit={handleSave} className="flex items-center gap-2">
              <input
                className="input !w-56 !py-1 text-xs"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label, e.g. before reshuffle"
                aria-label="Version label"
              />
              <button type="submit" className="btn-secondary btn-sm" disabled={saving}>
                {saving ? "Saving…" : "Save version"}
              </button>
            </form>
          ) : undefined
        }
      />
      <p className="hint mt-1">
        Every change to the board, members, study details or case details is recorded automatically. Restoring puts
        the study back into a version's state without touching images, documents or annotations.
      </p>
      {error && <p className="alert-error mt-3">{error}</p>}
      {notice && (
        <div className="mt-3 flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-xs font-medium underline">
            Dismiss
          </button>
        </div>
      )}

      <div className="table-wrap mt-4">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>When</th>
              <th>By</th>
              <th>Contents</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {versions.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <EmptyState message="No versions yet -- the first change to this study will create one." />
                </td>
              </tr>
            )}
            {visible.map((v) => {
              const kind = KIND_LABEL[v.kind] ?? KIND_LABEL.auto;
              return (
                <tr key={v.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-gray-500">v{v.number}</span>
                      <span className={kind.badge}>{kind.label}</span>
                      {v.label && <span className="text-sm text-gray-800">{v.label}</span>}
                    </div>
                  </td>
                  <td className="whitespace-nowrap text-xs text-gray-500">{v.created_at ? new Date(v.created_at).toLocaleString() : "—"}</td>
                  <td className="text-xs text-gray-500">{v.created_by_name ?? `${v.created_by.slice(0, 8)}…`}</td>
                  <td className="text-xs text-gray-500">
                    {v.summary.cards} cards · {v.summary.edges} connections · {v.summary.members} members · {v.summary.cases} cases
                  </td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => openDetail(v)} className="btn-secondary btn-sm" disabled={loadingId === v.id}>
                        {loadingId === v.id ? "Loading…" : canAdminister ? "Inspect / restore" : "Inspect"}
                      </button>
                      {canAdminister && (
                        <button onClick={() => handleDelete(v)} className="text-gray-400 hover:text-red-600" title="Delete this version">
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {versions.length > 8 && (
        <button onClick={() => setShowAll((v) => !v)} className="mt-3 text-xs font-medium text-brand-600 hover:text-brand-700">
          {showAll ? "Show fewer" : `Show all ${versions.length} versions`}
        </button>
      )}

      {inspecting && (
        <VersionDetailModal
          version={inspecting}
          canAdminister={canAdminister}
          onClose={() => setInspecting(null)}
          onRestore={() => handleRestore(inspecting)}
        />
      )}
    </div>
  );
}

function ChangeCell({ label, counts }: { label: string; counts: { added: number; removed: number; modified: number } }) {
  const none = counts.added === 0 && counts.removed === 0 && counts.modified === 0;
  return (
    <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm">
      <span className="text-gray-600">{label}</span>
      {none ? (
        <span className="text-xs text-gray-400">unchanged</span>
      ) : (
        <span className="flex gap-2 font-mono text-xs">
          {counts.added > 0 && <span className="text-emerald-700">+{counts.added}</span>}
          {counts.removed > 0 && <span className="text-red-700">−{counts.removed}</span>}
          {counts.modified > 0 && <span className="text-amber-700">~{counts.modified}</span>}
        </span>
      )}
    </div>
  );
}

function VersionDetailModal({
  version,
  canAdminister,
  onClose,
  onRestore,
}: {
  version: StudyVersionDetail;
  canAdminister: boolean;
  onClose: () => void;
  onRestore: () => void;
}) {
  const snapshot = version.snapshot as {
    study?: { name?: string; description?: string | null };
    cards?: { title: string; type: string }[];
    members?: { user_id: string; role: string }[];
  };
  const c = version.changes_if_restored;
  const unchanged =
    !c.study &&
    [c.members, c.cards, c.edges, c.cases].every((x) => x.added === 0 && x.removed === 0 && x.modified === 0);

  return (
    <Modal title={`Version ${version.number}${version.label ? ` -- ${version.label}` : ""}`} onClose={onClose} maxWidthClassName="max-w-2xl">
      <div className="flex flex-col gap-4">
        <p className="hint">
          Saved {version.created_at ? new Date(version.created_at).toLocaleString() : ""} by {version.created_by_name ?? "unknown"} ·{" "}
          {KIND_LABEL[version.kind]?.label ?? version.kind}
        </p>

        <div>
          <p className="label mb-2">Restoring this version would change</p>
          {unchanged ? (
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-500">Nothing -- the study is already in this state.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <ChangeCell label="Cards" counts={c.cards} />
              <ChangeCell label="Connections" counts={c.edges} />
              <ChangeCell label="Members" counts={c.members} />
              <ChangeCell label="Case details" counts={c.cases} />
              {c.study && (
                <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 sm:col-span-2">
                  Study name, description or de-identification profile differs.
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <p className="label mb-2">Board in this version</p>
          <div className="flex flex-wrap gap-1.5">
            {(snapshot.cards ?? []).length === 0 && <span className="hint">No cards.</span>}
            {(snapshot.cards ?? []).map((card, i) => (
              <span key={i} className="badge-gray" title={card.type}>
                {card.title}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-100 pt-4">
          <p className="hint">Images, documents and annotations are never changed by a restore.</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary">
              Close
            </button>
            {canAdminister && !unchanged && (
              <button onClick={onRestore} className="btn-primary">
                Restore this version
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
