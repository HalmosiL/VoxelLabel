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

  const memberIds = new Set(members.map((m) => m.user_id));
  const availableUsers = users.filter((u) => !memberIds.has(u.id));

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    try {
      await addStudyMember(studyId, selectedUserId, role);
      setSelectedUserId("");
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  async function handleRoleChange(member: StudyMember, nextRole: string) {
    try {
      await addStudyMember(studyId, member.user_id, nextRole);
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  async function handleRemove(member: StudyMember) {
    if (!window.confirm(`Remove ${memberLabel(member)} from this study? Their assigned jobs stay on the board until reassigned.`)) return;
    try {
      await removeStudyMember(studyId, member.user_id);
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
              <tr key={m.user_id}>
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
                  {canAdminister ? (
                    <select
                      className="input !w-auto !py-1 text-xs"
                      value={m.role}
                      onChange={(e) => handleRoleChange(m, e.target.value)}
                      title={ROLE_HINT[m.role as (typeof ROLES)[number]] ?? ""}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {roleLabel(r)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="badge-blue">{roleLabel(m.role)}</span>
                  )}
                </td>
                {canAdminister && (
                  <td className="text-right">
                    <button onClick={() => handleRemove(m)} className="text-gray-400 hover:text-red-600" title="Remove from study">
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
              <select className="input" value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} required>
                <option value="" disabled>
                  Select a user…
                </option>
                {availableUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username ?? u.id}
                    {u.email ? ` (${u.email})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field w-48">
              <span className="label">Role</span>
              <select className="input" value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn-primary" disabled={availableUsers.length === 0}>
              Add
            </button>
          </form>
          <p className="hint mt-2">{ROLE_HINT[role]}</p>
          {availableUsers.length === 0 && users.length > 0 && (
            <p className="hint mt-1">Every user in the directory is already a member of this study.</p>
          )}
        </>
      )}
    </div>
  );
}
