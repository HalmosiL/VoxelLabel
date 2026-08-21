import { FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { addStudyMember, KeycloakUser, listKeycloakUsers, listStudyMembers, StudyMember } from "../api/adminApi";
import Avatar from "../components/Avatar";
import CasesPanel from "../components/CasesPanel";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import ReviewQueuePanel from "../components/ReviewQueuePanel";

type Tab = "cases" | "review" | "members";

const tabs: { id: Tab; label: string }[] = [
  { id: "cases", label: "Cases" },
  { id: "review", label: "Annotation review" },
  { id: "members", label: "Members" },
];

export default function StudyDetailPage() {
  const { studyId } = useParams<{ studyId: string }>();
  const [tab, setTab] = useState<Tab>("cases");

  if (!studyId) return null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Study" />

      <div className="flex gap-1 border-b border-gray-200/70">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "cases" && <CasesPanel studyId={studyId} />}
      {tab === "review" && <ReviewQueuePanel studyId={studyId} />}
      {tab === "members" && <MembersPanel studyId={studyId} />}
    </div>
  );
}

function MembersPanel({ studyId }: { studyId: string }) {
  const [members, setMembers] = useState<StudyMember[]>([]);
  const [users, setUsers] = useState<KeycloakUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [role, setRole] = useState("viewer");

  function refresh() {
    listStudyMembers(studyId)
      .then(setMembers)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, [studyId]);
  useEffect(() => {
    listKeycloakUsers()
      .then(setUsers)
      .catch((err) => setError(String(err)));
  }, []);

  function labelFor(userId: string): string {
    const user = users.find((u) => u.id === userId);
    return user ? (user.username ?? user.email ?? userId) : userId;
  }

  const memberIds = new Set(members.map((m) => m.user_id));
  const availableUsers = users.filter((u) => !memberIds.has(u.id));

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    try {
      await addStudyMember(studyId, selectedUserId, role);
      setSelectedUserId("");
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="alert-error">{error}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {members.length === 0 && (
              <tr>
                <td colSpan={2}>
                  <EmptyState message="No members yet -- add one below." />
                </td>
              </tr>
            )}
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>
                  <div className="flex items-center gap-2.5">
                    <Avatar id={m.user_id} />
                    <span className="text-sm text-gray-700">{labelFor(m.user_id)}</span>
                  </div>
                </td>
                <td>
                  <span className="badge-blue">{m.role}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 className="section-title mb-4">Add member</h3>
        <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-4">
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
            <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="viewer">viewer</option>
              <option value="annotator">annotator</option>
              <option value="reviewer">reviewer</option>
              <option value="data_manager">data_manager</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <button type="submit" className="btn-primary" disabled={availableUsers.length === 0}>
            Add
          </button>
        </form>
        {availableUsers.length === 0 && users.length > 0 && (
          <p className="hint mt-2">Every realm user is already a member of this study.</p>
        )}
      </div>
    </div>
  );
}
