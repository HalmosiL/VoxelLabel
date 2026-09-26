import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { KeycloakUser, listKeycloakUsers } from "../api/adminApi";
import { describeApiError } from "../api/client";
import { AllJobsEntry, listAllJobs } from "../api/workflowApi";
import Avatar from "../components/Avatar";
import { DocumentIcon, PencilIcon, QuestionMarkCircleIcon } from "../components/icons";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import { TASK_STATUS_STYLE } from "../components/workflow/statusStyle";
import { JOBS_STEPS } from "../guide/adminSteps";
import { useRegisterGuide } from "../guide/GuideContext";

const TYPE_META = {
  annotation: { label: "Annotation", icon: <PencilIcon className="h-3.5 w-3.5" /> },
  review: { label: "Review", icon: <DocumentIcon className="h-3.5 w-3.5" /> },
} as const;

/** Global, admin-only directory of every Annotation/Review job on the
 * platform -- across every Study, not just the ones the signed-in
 * account happens to be assigned to (that's My Jobs). Answers "who is
 * this job assigned to, and is it stuck on nobody" at a glance, with
 * search and filters to narrow a platform that can have dozens of
 * these spread across many studies' own boards -- with no single page
 * to scan them from before this one. Read-only: reassigning a job
 * still happens on its own study's workflow board (the Assignee column
 * links there), which already owns that action and its own validation
 * (an assignee must be a member of the study). */
export default function JobsPage() {
  const [jobs, setJobs] = useState<AllJobsEntry[] | null>(null);
  const [users, setUsers] = useState<KeycloakUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "annotation" | "review">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "todo" | "in_progress" | "done">("all");
  const [assigneeFilter, setAssigneeFilter] = useState<"all" | "unassigned" | string>("all");

  useEffect(() => {
    listAllJobs()
      .then(setJobs)
      .catch((err) => setError(describeApiError(err)));
    listKeycloakUsers()
      .then(setUsers)
      .catch(() => setUsers([])); // names are a nicety here -- IDs still work without them
  }, []);
  useRegisterGuide("jobs", JOBS_STEPS, jobs !== null, false);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  function assigneeLabel(userId: string | null): string {
    if (!userId) return "Unassigned";
    const u = usersById.get(userId);
    return u ? (u.name || u.username || u.email || `${userId.slice(0, 8)}…`) : `${userId.slice(0, 8)}…`;
  }

  const needle = search.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!jobs) return null;
    return jobs
      .filter((j) => typeFilter === "all" || j.card_type === typeFilter)
      .filter((j) => statusFilter === "all" || j.status === statusFilter)
      .filter((j) => {
        if (assigneeFilter === "all") return true;
        if (assigneeFilter === "unassigned") return !j.assigned_user_id;
        return j.assigned_user_id === assigneeFilter;
      })
      .filter(
        (j) =>
          !needle ||
          [j.study_name, j.card_title, assigneeLabel(j.assigned_user_id)].some((v) => (v ?? "").toLowerCase().includes(needle))
      )
      .sort((a, b) => (a.study_name ?? "").localeCompare(b.study_name ?? "") || a.card_title.localeCompare(b.card_title));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, typeFilter, statusFilter, assigneeFilter, needle, usersById]);

  const unassignedCount = jobs?.filter((j) => !j.assigned_user_id).length ?? 0;
  const studyCount = jobs ? new Set(jobs.map((j) => j.study_id)).size : 0;
  // Only users who actually hold at least one job -- picking a name here
  // narrows the table to exactly that person, so nobody with zero jobs
  // belongs in the list.
  const assignedUsers = useMemo(() => {
    if (!jobs) return [];
    const ids = new Set(jobs.map((j) => j.assigned_user_id).filter((id): id is string => Boolean(id)));
    return Array.from(ids)
      .map((id) => ({ id, label: assigneeLabel(id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, usersById]);

  return (
    <div>
      <PageHeader
        title="Jobs"
        subtitle={
          jobs
            ? `${jobs.length} job${jobs.length === 1 ? "" : "s"} across ${studyCount} stud${studyCount === 1 ? "y" : "ies"}${
                unassignedCount ? ` · ${unassignedCount} unassigned` : ""
              }`
            : "Every Annotation and Review job on the platform, and who it belongs to."
        }
      />
      {error && <p className="alert-error mb-4">{error}</p>}

      <div className="card">
        <div className="flex flex-wrap items-center gap-2" data-guide="filters">
          <input
            className="input min-w-[14rem] flex-1"
            placeholder="Search study, job or assignee…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="input w-auto" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}>
            <option value="all">Every type</option>
            <option value="annotation">Annotation</option>
            <option value="review">Review</option>
          </select>
          <select className="input w-auto" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">Every status</option>
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
          </select>
          <select className="input w-auto max-w-[12rem]" value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
            <option value="all">Everyone</option>
            <option value="unassigned">Unassigned{unassignedCount ? ` (${unassignedCount})` : ""}</option>
            {assignedUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </div>

        <div className="table-wrap mt-4" data-guide="table">
          <table>
            <thead>
              <tr>
                <th>Study</th>
                <th>Job</th>
                <th>Assignee</th>
                <th>Status</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {visible === null && (
                <tr>
                  <td colSpan={5}>
                    <p className="hint py-2">Loading…</p>
                  </td>
                </tr>
              )}
              {visible !== null && visible.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState message={jobs && jobs.length > 0 ? "No job matches these filters." : "No Annotation or Review jobs exist yet."} />
                  </td>
                </tr>
              )}
              {visible?.map((job) => {
                const type = TYPE_META[job.card_type as "annotation" | "review"] ?? TYPE_META.annotation;
                const style = TASK_STATUS_STYLE[job.status] ?? TASK_STATUS_STYLE.todo;
                return (
                  <tr key={job.card_id}>
                    <td>
                      <Link to={`/studies/${job.study_id}`} className="text-gray-700 hover:text-brand-600 hover:underline">
                        {job.study_name ?? job.study_id.slice(0, 8)}
                      </Link>
                    </td>
                    <td>
                      <Link
                        to={`/studies/${job.study_id}/workflow`}
                        className="inline-flex items-center gap-1.5 font-medium text-gray-900 hover:text-brand-600 hover:underline"
                      >
                        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500">
                          {type.icon}
                        </span>
                        {job.card_title}
                      </Link>
                      <span className="ml-1 text-xs text-gray-400">{type.label}</span>
                    </td>
                    <td>
                      {job.assigned_user_id ? (
                        <span className="flex items-center gap-1.5">
                          <Avatar id={job.assigned_user_id} name={assigneeLabel(job.assigned_user_id)} />
                          <span className="text-gray-700">{assigneeLabel(job.assigned_user_id)}</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-red-600">
                          <QuestionMarkCircleIcon className="h-3.5 w-3.5 flex-shrink-0" />
                          Unassigned
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${style.badge}`}>
                        <span className={`badge-dot ${style.dot} flex-shrink-0`} />
                        {style.label}
                      </span>
                    </td>
                    <td className="text-xs text-gray-600">
                      {job.progress.total > 0
                        ? `${job.progress.annotated} of ${job.progress.total} ${job.card_type === "review" ? "reviewed" : "annotated"}`
                        : "no cases yet"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
