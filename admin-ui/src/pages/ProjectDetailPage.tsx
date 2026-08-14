import { FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { addProjectMember, listProjectMembers, ProjectMember } from "../api/adminApi";
import ReviewQueuePanel from "../components/ReviewQueuePanel";
import StudiesPanel from "../components/StudiesPanel";

type Tab = "studies" | "review" | "members";

const tabs: { id: Tab; label: string }[] = [
  { id: "studies", label: "Studies" },
  { id: "review", label: "Annotation review" },
  { id: "members", label: "Members" },
];

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [tab, setTab] = useState<Tab>("studies");

  if (!projectId) return null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="page-title">Project</h1>

      <div className="flex gap-1 border-b border-gray-200">
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

      {tab === "studies" && <StudiesPanel projectId={projectId} />}
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
              <th>User ID (Keycloak subject)</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {members.length === 0 && (
              <tr>
                <td colSpan={2} className="py-6 text-center text-gray-400">
                  No members yet.
                </td>
              </tr>
            )}
            {members.map((m) => (
              <tr key={m.user_id}>
                <td className="font-mono text-xs">{m.user_id}</td>
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
          <div className="field flex-1">
            <label className="label">User ID</label>
            <input className="input" value={userId} onChange={(e) => setUserId(e.target.value)} required />
          </div>
          <div className="field w-48">
            <label className="label">Role</label>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="viewer">viewer</option>
              <option value="annotator">annotator</option>
              <option value="reviewer">reviewer</option>
              <option value="data_manager">data_manager</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button type="submit" className="btn-primary">
            Add
          </button>
        </form>
      </div>
    </div>
  );
}
