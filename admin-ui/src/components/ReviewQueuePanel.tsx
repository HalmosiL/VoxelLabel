import { useEffect, useState } from "react";

import { Annotation, listAnnotationsForProject, reviewAnnotation } from "../api/annotationApi";

const STATUS_BADGE: Record<Annotation["status"], string> = {
  draft: "badge-gray",
  submitted: "badge-blue",
  approved: "badge-green",
  rejected: "badge-red",
};

export default function ReviewQueuePanel({ projectId }: { projectId: string }) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listAnnotationsForProject(projectId, statusFilter || undefined)
      .then(setAnnotations)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, [projectId, statusFilter]);

  async function decide(id: string, decision: "approve" | "reject") {
    try {
      await reviewAnnotation(id, decision, "");
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="alert-error">{error}</p>}

      <div className="field w-48">
        <label className="label">Filter by status</label>
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All</option>
          <option value="draft">draft</option>
          <option value="submitted">submitted</option>
          <option value="approved">approved</option>
          <option value="rejected">rejected</option>
        </select>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Target</th>
              <th>Payload</th>
              <th>Annotator</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {annotations.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-gray-400">
                  No annotations found.
                </td>
              </tr>
            )}
            {annotations.map((a) => (
              <tr key={a.id}>
                <td className="text-xs text-gray-500">
                  {a.target_type}/<span className="font-mono">{a.target_id}</span>
                </td>
                <td>
                  <code className="code-chip">{JSON.stringify(a.payload)}</code>
                </td>
                <td className="font-mono text-xs">{a.annotator_id}</td>
                <td>
                  <span className={STATUS_BADGE[a.status]}>{a.status}</span>
                </td>
                <td>
                  {(a.status === "submitted" || a.status === "draft") && (
                    <div className="flex gap-2">
                      <button onClick={() => decide(a.id, "approve")} className="btn-secondary btn-sm">
                        Approve
                      </button>
                      <button onClick={() => decide(a.id, "reject")} className="btn-danger btn-sm">
                        Reject
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
