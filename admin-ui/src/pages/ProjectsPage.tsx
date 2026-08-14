import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { createProject, listProjects, Project } from "../api/adminApi";

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

  return (
    <div className="flex flex-col gap-6">
      <h1 className="page-title">Projects</h1>
      {error && <p className="alert-error">{error}</p>}

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
                <td colSpan={2} className="py-6 text-center text-gray-400">
                  No projects yet.
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
          <div className="field w-64">
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field flex-1">
            <label className="label">Description</label>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <button type="submit" className="btn-primary">
            Create
          </button>
        </form>
      </div>
    </div>
  );
}
