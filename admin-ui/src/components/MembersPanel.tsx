import { FormEvent, useEffect, useState } from "react";

import {
  addStudyMember,
  KeycloakUser,
  listKeycloakUsers,
  listStudyMembers,
  memberLabel,
  removeStudyMember,
  StudyMember,
} from "../api/adminApi";
import { describeApiError } from "../api/client";
import { roleLabel } from "../auth/MeContext";
import Avatar from "./Avatar";
import EmptyState from "./EmptyState";
import { TrashIcon } from "./icons";
import SectionHeader from "./SectionHeader";
import { trackAction } from "../usage/tracker";

const ROLES = ["viewer", "annotator", "reviewer", "data_manager", "admin"] as const;

const ROLE_HINT: Record<(typeof ROLES)[number], string> = {
  viewer: "Can browse this study's cases and images.",
  annotator: "Can be assigned Annotation jobs and submit annotations.",
  reviewer: "Can be assigned Review jobs and approve/reject annotations.",
  data_manager: "Can create cases, upload data and edit the workflow board.",
  admin: "Everything a data manager can, plus editing the study and its members.",
};

/** Who can do what in this study. Every member sees the list (names are
 * resolved server-side); only a study admin (or global admin) sees the
 * add/change/remove controls -- the same rule the backend enforces. */
export default function MembersPanel({ studyId, canAdminister }: { studyId: string; canAdminister: boolean }) {
  const [members, setMembers] = useState<StudyMember[]>([]);
  const [users, setUsers] = useState<KeycloakUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("annotator");

  function refresh() {
    listStudyMembers(studyId)
      .then(setMembers)
      .catch((err) => setError(describeApiError(err)));
  }

  useEffect(refresh, [studyId]);
  useEffect(() => {
    if (!canAdminister) return;
    listKeycloakUsers()
      .then(setUsers)
      .catch((err) => setError(describeApiError(err)));
  }, [canAdminister]);

  // A person can hold several roles in this study at once -- each is its
  // own row from listStudyMembers, so grouping by user_id is only for the
  // "add" form's role choices (no point offering a role they already have).
  const rolesByUser = new Map<string, Set<string>>();
  for (const m of members) {
    if (!rolesByUser.has(m.user_id)) rolesByUser.set(m.user_id, new Set());
    rolesByUser.get(m.user_id)!.add(m.role);
  }
  const availableRolesForSelected = selectedUserId
    ? ROLES.filter((r) => !rolesByUser.get(selectedUserId)?.has(r))
    : ROLES;

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    try {
      await addStudyMember(studyId, selectedUserId, role);
      trackAction("member.add", { study_id: studyId });
      setSelectedUserId("");
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  async function handleRemove(member: StudyMember) {
    if (
      !window.confirm(
        `Remove the ${roleLabel(member.role)} role from ${memberLabel(member)}? Their assigned jobs stay on the board until reassigned. ` +
          `Any other roles they hold in this study are unaffected.`
      )
    )
      return;
    try {
      await removeStudyMember(studyId, member.user_id, member.role);
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <div className="card">
      <SectionHeader title="Members" />
      {error && <p className="alert-error mt-3">{error}</p>}

      <div className="table-wrap mt-4">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              {canAdminister && <th></th>}
            </tr>
          </thead>
          <tbody>
            {members.length === 0 && (
              <tr>
                <td colSpan={canAdminister ? 3 : 2}>
                  <EmptyState message={canAdminister ? "No members yet -- add one below." : "No members yet."} />
                </td>
              </tr>
            )}
            {members.map((m) => (
              <tr key={`${m.user_id}:${m.role}`}>
                <td>
                  <div className="flex items-center gap-2.5">
                    <Avatar id={m.user_id} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm text-gray-700">{memberLabel(m)}</span>
                      {m.email && m.username && <span className="truncate text-xs text-gray-400">{m.email}</span>}
                    </div>
                  </div>
                </td>
                <td>
                  <span className="badge-blue" title={ROLE_HINT[m.role as (typeof ROLES)[number]] ?? ""}>
                    {roleLabel(m.role)}
                  </span>
                </td>
                {canAdminister && (
                  <td className="text-right">
                    <button onClick={() => handleRemove(m)} className="text-gray-400 hover:text-red-600" title={`Remove the ${roleLabel(m.role)} role`}>
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canAdminister && (
        <>
          <form onSubmit={handleAdd} className="mt-4 flex flex-wrap items-end gap-4">
            <label className="field flex-1">
              <span className="label">User</span>
              <select
                className="input"
                value={selectedUserId}
                onChange={(e) => {
                  const nextUserId = e.target.value;
                  setSelectedUserId(nextUserId);
                  const taken = rolesByUser.get(nextUserId);
                  if (taken?.has(role)) {
                    const firstFree = ROLES.find((r) => !taken.has(r));
                    if (firstFree) setRole(firstFree);
                  }
                }}
                required
              >
                <option value="" disabled>
                  Select a user…
                </option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username ?? u.id}
                    {u.email ? ` (${u.email})` : ""}
                    {rolesByUser.has(u.id) ? ` -- already: ${[...(rolesByUser.get(u.id) ?? [])].map(roleLabel).join(", ")}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field w-48">
              <span className="label">Role to grant</span>
              <select className="input" value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
                {ROLES.map((r) => (
                  <option key={r} value={r} disabled={!availableRolesForSelected.includes(r)}>
                    {roleLabel(r)}
                    {rolesByUser.get(selectedUserId)?.has(r) ? " (already granted)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn-primary" disabled={!selectedUserId || availableRolesForSelected.length === 0}>
              Grant role
            </button>
          </form>
          <p className="hint mt-2">
            A person can hold more than one role in the same study (e.g. both annotator and reviewer) -- granting a role
            never takes away one they already have. {ROLE_HINT[role]}
          </p>
        </>
      )}
    </div>
  );
}
