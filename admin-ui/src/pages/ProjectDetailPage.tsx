import { FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { addProjectMember, listProjectMembers, ProjectMember } from "../api/adminApi";
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

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [tab, setTab] = useState<Tab>("cases");

  if (!projectId) return null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Project" />

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

      {tab === "cases" && <CasesPanel projectId={projectId} />}
      {tab === "review" && <ReviewQueuePanel projectId={projectId} />}
      {tab === "members" && <MembersPanel projectId={projectId} />}
    </div>
  );
}

function MembersPanel({ projectId }: { projectId: string }) {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("viewer");

  function refresh() {
    listProjectMembers(projectId)
      .then(setMembers)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, [projectId]);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    try {
      await addProjectMember(projectId, userId, role);
      setUserId("");
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
                    <span className="font-mono text-xs text-gray-600">{m.user_id}</span>
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
            <span className="label">User ID</span>
            <input className="input" value={userId} onChange={(e) => setUserId(e.target.value)} required />
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
          <button type="submit" className="btn-primary">
            Add
          </button>
        </form>
      </div>
    </div>
  );
}
