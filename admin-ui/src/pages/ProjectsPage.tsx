import { FormEvent, ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { createProject, listProjects, Project } from "../api/adminApi";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function refresh() {
    listProjects()
      .then(setProjects)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    try {
      await createProject(name, description);
      setName("");
      setDescription("");
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  const withDeidentification = projects.filter((p) => p.deidentification_profile_id).length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Projects" subtitle="Manage the projects that scope data access across the platform." />
      {error && <p className="alert-error">{error}</p>}

      <div className="grid grid-cols-2 gap-4">
        <StatCard
          icon={<FolderStatIcon />}
          iconBg="bg-brand-50 text-brand-600"
          value={projects.length}
          label="Total projects"
        />
        <StatCard
          icon={<ShieldStatIcon />}
          iconBg="bg-emerald-50 text-emerald-600"
          value={withDeidentification}
          label="With a de-identification profile"
        />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {projects.length === 0 && (
              <tr>
                <td colSpan={2}>
                  <EmptyState message="No projects yet -- create one below." />
                </td>
              </tr>
            )}
            {projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/projects/${p.id}`} className="font-medium text-brand-600 hover:text-brand-700">
                    {p.name}
                  </Link>
                </td>
                <td>{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="section-title mb-4">New project</h2>
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-4">
          <label className="field w-64">
            <span className="label">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field flex-1">
            <span className="label">Description</span>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <button type="submit" className="btn-primary">
            Create
          </button>
        </form>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  iconBg,
  value,
  label,
}: {
  icon: ReactNode;
  iconBg: string;
  value: number;
  label: string;
}) {
  return (
    <div className="stat-card">
      <span className={`stat-icon ${iconBg}`}>{icon}</span>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}

function FolderStatIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
      <path d="M2 4a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V4z" />
    </svg>
  );
}

function ShieldStatIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
      <path
        fillRule="evenodd"
        d="M10 1l7 3v6c0 4.418-3.134 7.803-7 9-3.866-1.197-7-4.582-7-9V4l7-3zm0 3.5a1 1 0 00-1 1v4a1 1 0 001 1 1 1 0 001-1v-4a1 1 0 00-1-1zm0 8a1 1 0 100 2 1 1 0 000-2z"
        clipRule="evenodd"
      />
    </svg>
  );
}
