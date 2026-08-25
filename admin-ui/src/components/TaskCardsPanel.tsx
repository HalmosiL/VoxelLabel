import { Fragment, ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { KeycloakUser, listKeycloakUsers } from "../api/adminApi";
import { getWorkflowBoard, getWorkflowCardCases, WorkflowCard, WorkflowCardCase, WorkflowCardType } from "../api/workflowApi";
import Avatar from "./Avatar";
import EmptyState from "./EmptyState";
import { QuestionMarkCircleIcon } from "./icons";
import SectionHeader from "./SectionHeader";
import { CASE_STATUS_STYLE, TASK_STATUS_STYLE } from "./workflow/statusStyle";

/** Table view of every Annotation or Review card on this study's
 * workflow board -- a dedicated section per job-producing card type
 * (mirroring how DatasetsPanel is its own section for Dataset cards)
 * instead of burying status/assignee/progress in WorkflowSummaryPanel's
 * generic mixed-type card grid, which only shows the *other* types now
 * (split/filter/union/note/milestone/surfaces). Each row expands in
 * place to its case-by-case annotated/not-annotated breakdown -- same
 * data My Jobs' own detail page shows, just reachable for any card on
 * this board, not only ones assigned to the viewer. */
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [casesByCard, setCasesByCard] = useState<Record<string, WorkflowCardCase[]>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    getWorkflowBoard(studyId)
      .then((board) => setCards(board.cards.filter((c) => c.type === cardType)))
      .catch((err) => setError(String(err)));
    listKeycloakUsers()
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [studyId, cardType]);

  const usersById = new Map(users.map((u) => [u.id, u]));

  function toggleExpand(cardId: string) {
    if (expandedId === cardId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(cardId);
    if (!casesByCard[cardId]) {
      setLoadingId(cardId);
      getWorkflowCardCases(cardId)
        .then((cases) => setCasesByCard((prev) => ({ ...prev, [cardId]: cases })))
        .catch((err) => setError(String(err)))
        .finally(() => setLoadingId(null));
    }
  }

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
                <td colSpan={6}>
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
              const expanded = expandedId === card.id;

              return (
                <Fragment key={card.id}>
                  <tr onClick={() => toggleExpand(card.id)} className="cursor-pointer">
                    <td>
                      <ChevronIcon expanded={expanded} />
                    </td>
                    <td>
                      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-gray-100 text-gray-500">
                        {icon}
                      </span>
                    </td>
                    <td>
                      <span className="font-medium text-gray-900">{card.title}</span>
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
                  {expanded && (
                    <tr>
                      <td colSpan={6} className="bg-gray-50/60">
                        {loadingId === card.id ? (
                          <p className="hint py-2">Loading cases…</p>
                        ) : (
                          <CardCaseList studyId={studyId} cardId={card.id} cases={casesByCard[card.id] ?? []} />
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CardCaseList({ studyId, cardId, cases }: { studyId: string; cardId: string; cases: WorkflowCardCase[] }) {
  if (cases.length === 0) {
    return <p className="hint py-2">No cases in scope yet -- run this card on the workflow board.</p>;
  }
  return (
    <ul className="flex flex-col gap-1 py-2">
      {cases.map((c) => {
        const caseStyle = CASE_STATUS_STYLE[c.annotated ? "annotated" : "not_annotated"];
        return (
          <li key={c.id} className="flex items-center justify-between gap-3 py-0.5">
            <Link
              to={`/studies/${studyId}/cases/${c.id}?jobId=${cardId}`}
              className="truncate text-sm text-brand-600 hover:text-brand-700"
            >
              {c.title || `${c.id.slice(0, 8)}…`}
            </Link>
            <span className={`${caseStyle.badge} flex-shrink-0`}>
              <span className={`badge-dot ${caseStyle.dot}`} />
              {caseStyle.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className={`h-4 w-4 text-gray-400 transition-transform ${expanded ? "rotate-90" : ""}`}
    >
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
        clipRule="evenodd"
      />
    </svg>
  );
}
