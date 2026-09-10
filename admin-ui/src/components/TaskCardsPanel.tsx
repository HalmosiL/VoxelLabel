import { Fragment, ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { KeycloakUser, listStudyMembers, memberLabel } from "../api/adminApi";
import { deleteAnnotation, reviewAnnotation } from "../api/annotationApi";
import {
  getWorkflowBoard,
  getWorkflowCardCases,
  runWorkflowCard,
  updateWorkflowCard,
  WorkflowCard,
  WorkflowCardCase,
  WorkflowCardType,
} from "../api/workflowApi";
import Avatar from "./Avatar";
import EmptyState from "./EmptyState";
import { QuestionMarkCircleIcon } from "./icons";
import SectionHeader from "./SectionHeader";
import { AWAITING_REVIEW_STYLE, CASE_STATUS_STYLE, TASK_STATUS_STYLE } from "./workflow/statusStyle";
import { describeApiError } from "../api/client";

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
      .catch((err) => setError(describeApiError(err)));
    listStudyMembers(studyId)
      .then((members) =>
        setUsers(members.map((m) => ({ id: m.user_id, username: memberLabel(m), email: m.email ?? null, is_admin: false })))
      )
      .catch(() => setUsers([]));
  }, [studyId, cardType]);

  function loadCases(cardId: string) {
    setLoadingId(cardId);
    getWorkflowCardCases(cardId)
      .then((cases) => setCasesByCard((prev) => ({ ...prev, [cardId]: cases })))
      .catch((err) => setError(describeApiError(err)))
      .finally(() => setLoadingId(null));
  }

  function toggleExpand(cardId: string) {
    if (expandedId === cardId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(cardId);
    if (!casesByCard[cardId]) loadCases(cardId);
  }

  function handleAssign(card: WorkflowCard, userId: string) {
    const config = { ...card.config, assigned_user_id: userId || null };
    setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, config } : c)));
    updateWorkflowCard(card.id, { config }).catch((err) => setError(describeApiError(err)));
  }

  function handleStatusChange(card: WorkflowCard, status: string) {
    const config = { ...card.config, status };
    setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, config } : c)));
    updateWorkflowCard(card.id, { config }).catch((err) => setError(describeApiError(err)));
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
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5">
                        {assignedUserId ? (
                          <Avatar id={assignedUserId} />
                        ) : (
                          <span title="Nobody is assigned to this job">
                            <QuestionMarkCircleIcon className="h-3.5 w-3.5 flex-shrink-0 text-red-500" />
                          </span>
                        )}
                        <select
                          className="input w-auto max-w-[10rem] truncate border-none bg-transparent px-0 py-0.5 text-xs text-gray-600 shadow-none focus:ring-0"
                          value={assignedUserId ?? ""}
                          onChange={(e) => handleAssign(card, e.target.value)}
                        >
                          <option value="">Unassigned</option>
                          {users.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.username ?? u.id}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5">
                        <span className={`badge-dot ${style.dot} flex-shrink-0`} />
                        <select
                          className="input w-auto max-w-[8rem] truncate border-none bg-transparent px-0 py-0.5 text-xs text-gray-600 shadow-none focus:ring-0"
                          value={status}
                          onChange={(e) => handleStatusChange(card, e.target.value)}
                        >
                          {Object.entries(TASK_STATUS_STYLE).map(([value, s]) => (
                            <option key={value} value={value}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </div>
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
                          <CardCaseList
                            studyId={studyId}
                            cardId={card.id}
                            cardType={cardType}
                            cases={casesByCard[card.id] ?? []}
                            onReviewed={() => loadCases(card.id)}
                          />
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

function CardCaseList({
  studyId,
  cardId,
  cardType,
  cases,
  onReviewed,
}: {
  studyId: string;
  cardId: string;
  cardType: WorkflowCardType;
  cases: WorkflowCardCase[];
  onReviewed: () => void;
}) {
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (cases.length === 0) {
    return <p className="hint py-2">No cases in scope yet -- run this card on the workflow board.</p>;
  }

  // A decision (or a deletion undoing one) changes which cases belong in
  // this card's own materialized approved/rejected (or annotated)
  // children, but that recompute only happens on a Run -- without this,
  // the card's own case list silently keeps showing a just-decided case
  // until someone notices the "stale" badge and re-runs it by hand.
  // Best-effort: the decision/deletion itself already succeeded, so a
  // failed refresh here isn't surfaced as an error, just left for the
  // stale badge to catch on the board.
  async function refreshCard() {
    await runWorkflowCard(cardId).catch(() => undefined);
  }

  async function handleDecision(annotationId: string, decision: "approve" | "reject") {
    setDecidingId(annotationId);
    setError(null);
    try {
      await reviewAnnotation(annotationId, decision);
      await refreshCard();
      onReviewed();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setDecidingId(null);
    }
  }

  async function handleDelete(annotationId: string) {
    if (!window.confirm("Delete this annotation? The case reverts to not annotated. This cannot be undone.")) return;
    setDecidingId(annotationId);
    setError(null);
    try {
      await deleteAnnotation(annotationId);
      await refreshCard();
      onReviewed();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setDecidingId(null);
    }
  }

  return (
    <div className="py-2">
      {error && <p className="alert-error mb-2">{error}</p>}
      <ul className="flex flex-col gap-1">
        {cases.map((c) => {
          const caseStyle =
            cardType === "review" && c.pending_annotation_id ? AWAITING_REVIEW_STYLE : CASE_STATUS_STYLE[c.status];
          return (
            <li key={c.id} className="flex items-center justify-between gap-3 py-0.5">
              <Link
                to={`/studies/${studyId}/cases/${c.id}?jobId=${cardId}`}
                className="truncate text-sm text-brand-600 hover:text-brand-700"
              >
                {c.title || `${c.id.slice(0, 8)}…`}
              </Link>
              <div className="flex flex-shrink-0 items-center gap-2">
                {cardType === "review" && c.pending_annotation_id && (
                  <>
                    <button
                      onClick={() => handleDecision(c.pending_annotation_id!, "approve")}
                      disabled={decidingId === c.pending_annotation_id}
                      className="btn-secondary btn-sm"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleDecision(c.pending_annotation_id!, "reject")}
                      disabled={decidingId === c.pending_annotation_id}
                      className="btn-danger btn-sm"
                    >
                      Reject
                    </button>
                  </>
                )}
                {c.latest_annotation_id && (
                  <button
                    onClick={() => handleDelete(c.latest_annotation_id!)}
                    disabled={decidingId === c.latest_annotation_id}
                    className="text-xs font-medium text-red-600 hover:text-red-700"
                  >
                    Delete annotation
                  </button>
                )}
                <span className={caseStyle.badge}>
                  <span className={`badge-dot ${caseStyle.dot}`} />
                  {caseStyle.label}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
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
