import { useEffect, useState } from "react";

import { Annotation, listAnnotationsForStudy, reviewAnnotation } from "../api/annotationApi";
import Avatar from "./Avatar";
import EmptyState from "./EmptyState";

const STATUS_STYLE: Record<Annotation["status"], { badge: string; dot: string }> = {
  draft: { badge: "badge-gray", dot: "bg-gray-400" },
  submitted: { badge: "badge-blue", dot: "bg-blue-500" },
  approved: { badge: "badge-green", dot: "bg-emerald-500" },
  rejected: { badge: "badge-red", dot: "bg-red-500" },
};

export default function ReviewQueuePanel({ studyId }: { studyId: string }) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listAnnotationsForStudy(studyId, statusFilter || undefined)
      .then(setAnnotations)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, [studyId, statusFilter]);

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

      <label className="field w-48">
        <span className="label">Filter by status</span>
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All</option>
          <option value="draft">draft</option>
          <option value="submitted">submitted</option>
          <option value="approved">approved</option>
          <option value="rejected">rejected</option>
        </select>
      </label>

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
                <td colSpan={5}>
                  <EmptyState message="No annotations found." />
                </td>
              </tr>
            )}
            {annotations.map((a) => {
              const style = STATUS_STYLE[a.status];
              return (
                <tr key={a.id}>
                  <td className="text-xs text-gray-500">
                    {a.target_type}/<span className="font-mono">{a.target_id}</span>
                  </td>
                  <td>
                    <code className="code-chip">{JSON.stringify(a.payload)}</code>
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <Avatar id={a.annotator_id} />
                      <span className="font-mono text-xs text-gray-500">{a.annotator_id.slice(0, 8)}…</span>
                    </div>
                  </td>
                  <td>
                    <span className={style.badge}>
                      <span className={`badge-dot ${style.dot}`} />
                      {a.status}
                    </span>
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
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
