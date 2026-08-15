import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { createProject, listProjects, Project, uploadProjectCoverImage } from "../api/adminApi";

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

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} onImageUploaded={refresh} />
        ))}
      </div>
      {projects.length === 0 && <p className="hint">No projects yet -- create one below.</p>}

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

function ProjectCard({ project, onImageUploaded }: { project: Project; onImageUploaded: () => void }) {
  const [uploading, setUploading] = useState(false);

  async function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await uploadProjectCoverImage(project.id, file);
      onImageUploaded();
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-gray-100 bg-white/90 shadow-sm transition-shadow hover:shadow-md">
      <Link to={`/projects/${project.id}`} className="block">
        <div className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-gradient-to-br from-brand-100 to-brand-50">
          {project.cover_image_url ? (
            <img src={project.cover_image_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <FolderIcon className="h-12 w-12 text-brand-300" />
          )}
        </div>
        <div className="p-4">
          <h3 className="font-semibold text-gray-900">{project.name}</h3>
          {project.description && <p className="mt-1 text-sm text-gray-500">{project.description}</p>}
        </div>
      </Link>

      <label
        className="absolute right-3 top-3 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-white/90 text-gray-600 opacity-0 shadow-sm transition-opacity hover:bg-white group-hover:opacity-100"
        title="Set cover image"
      >
        {uploading ? <Spinner className="h-4 w-4" /> : <CameraIcon className="h-4 w-4" />}
        <input type="file" accept="image/*" className="hidden" onChange={handleImageChange} />
      </label>
    </div>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M2 4a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V4z" />
    </svg>
  );
}

function CameraIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M4 5a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-1.586a1 1 0 01-.707-.293l-1.121-1.121A2 2 0 0011.172 3H8.828a2 2 0 00-1.414.586L6.293 4.707A1 1 0 015.586 5H4z" />
      <path fillRule="evenodd" d="M10 8a3 3 0 100 6 3 3 0 000-6zm-5 3a5 5 0 1110 0 5 5 0 01-10 0z" clipRule="evenodd" />
    </svg>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
