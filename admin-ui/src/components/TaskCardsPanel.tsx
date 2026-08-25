import { ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { KeycloakUser, listKeycloakUsers } from "../api/adminApi";
import { getWorkflowBoard, WorkflowCard, WorkflowCardType } from "../api/workflowApi";
import Avatar from "./Avatar";
import EmptyState from "./EmptyState";
import { QuestionMarkCircleIcon } from "./icons";
import SectionHeader from "./SectionHeader";
import { TASK_STATUS_STYLE } from "./workflow/statusStyle";

/** Table view of every Annotation or Review card on this study's
 * workflow board -- a dedicated section per job-producing card type
 * (mirroring how DatasetsPanel is its own section for Dataset cards)
 * instead of burying status/assignee/progress in WorkflowSummaryPanel's
 * generic mixed-type card grid, which only shows the *other* types now
 * (split/filter/union/note/milestone/surfaces). */
export default function TaskCardsPanel({
  studyId,
  cardType,
  title,
  icon,
  progressLabel,
}: {
  studyId: string;
  cardType: Extract<WorkflowCardType, "annotation" | "review">;
  title: string;
  icon: ReactNode;
  progressLabel: string;
}) {
  const [cards, setCards] = useState<WorkflowCard[]>([]);
  const [users, setUsers] = useState<KeycloakUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getWorkflowBoard(studyId)
      .then((board) => setCards(board.cards.filter((c) => c.type === cardType)))
      .catch((err) => setError(String(err)));
    listKeycloakUsers()
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [studyId, cardType]);

  const usersById = new Map(users.map((u) => [u.id, u]));

  return (
    <div className="card">
      <SectionHeader
        title={title}
        action={
          <Link to={`/studies/${studyId}/workflow`} className="btn-secondary btn-sm">
            Open board
          </Link>
        }
      />
      {error && <p className="alert-error mt-3">{error}</p>}

      <div className="table-wrap mt-4">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Title</th>
              <th>Assignee</th>
              <th>Status</th>
              <th>Progress</th>
            </tr>
          </thead>
          <tbody>
            {cards.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <EmptyState message={`No ${title.toLowerCase()} cards on this study's workflow board yet.`} />
                </td>
              </tr>
            )}
            {cards.map((card) => {
              const assignedUserId = card.config.assigned_user_id as string | null;
              const assignedUser = assignedUserId ? usersById.get(assignedUserId) : null;
              const status = (card.config.status as string) ?? "todo";
              const style = TASK_STATUS_STYLE[status] ?? TASK_STATUS_STYLE.todo;
              const progress = card.annotation_progress;

              return (
                <tr key={card.id}>
                  <td>
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-gray-100 text-gray-500">
                      {icon}
                    </span>
                  </td>
                  <td>
                    <Link to={`/studies/${studyId}/workflow`} className="font-medium text-brand-600 hover:text-brand-700">
                      {card.title}
                    </Link>
                    {card.stale && <span className="badge-gray ml-2 text-[10px]">stale</span>}
                  </td>
                  <td>
                    {assignedUserId ? (
                      <div className="flex items-center gap-1.5">
                        <Avatar id={assignedUserId} />
                        <span className="truncate text-xs text-gray-600">
                          {assignedUser?.username ?? `${assignedUserId.slice(0, 8)}…`}
                        </span>
                      </div>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-red-500" title="Nobody is assigned to this job">
                        <QuestionMarkCircleIcon className="h-3.5 w-3.5" />
                        unassigned
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={style.badge}>
                      <span className={`badge-dot ${style.dot}`} />
                      {style.label}
                    </span>
                  </td>
                  <td className="text-xs text-gray-600">
                    {progress ? `${progress.annotated} of ${progress.total} ${progressLabel}` : "not run yet"}
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
