import { useEffect, useState } from "react";

import { ratingDue, trackAction } from "./tracker";

/** What a rating is about: the case just finished, and in which job. */
export interface RatingAsk {
  case_id: string;
  job_id: string | null;
  task: "annotate" | "review";
}

let current: RatingAsk | null = null;
const listeners = new Set<(ask: RatingAsk | null) => void>();

/** Call when a case has just been finished (Mark as annotated, Submit
 * review). Every n-th time (the admin's "rating_every_n" setting) it
 * shows the one-click "how demanding was that?" prompt -- the only
 * direct measure of cognitive load the Usage page gets. The prompt
 * lives outside the viewer page, so the jump to the next case doesn't
 * take it away. */
export function askRatingIfDue(ask: RatingAsk): void {
  if (!ratingDue()) return;
  current = ask;
  listeners.forEach((l) => l(current));
}

const LABELS = ["", "Easy", "Fine", "Some effort", "Hard", "Very demanding"];
const AUTO_HIDE_MS = 20_000;

/** The prompt itself: five buttons and Skip, bottom centre, gone by
 * itself after 20 s. Mounted once, next to the usage tracker. */
export default function RatingPrompt() {
  const [ask, setAsk] = useState<RatingAsk | null>(current);
  useEffect(() => {
    listeners.add(setAsk);
    return () => {
      listeners.delete(setAsk);
    };
  }, []);
  useEffect(() => {
    if (!ask) return;
    const timer = window.setTimeout(() => close(), AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [ask]);

  function close() {
    current = null;
    setAsk(null);
  }

  if (!ask) return null;
  return (
    <div
      className="fixed bottom-4 left-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 rounded-xl border border-[#444] bg-[#1a1a2e]/95 px-4 py-3 text-gray-200 shadow-2xl"
      role="dialog"
      aria-label="How demanding was that case?"
      data-testid="rating-prompt"
    >
      <p className="text-sm font-medium">How demanding was the {ask.task === "review" ? "review" : "case"} you just finished?</p>
      <p className="mb-2 text-[11px] text-gray-400">One click, optional -- it tells us which cases and tools cost the most effort.</p>
      <div className="flex gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => {
              trackAction("case.rating", { case_id: ask.case_id, job_id: ask.job_id ?? undefined, task: ask.task, rating: n });
              close();
            }}
            className="flex flex-1 flex-col items-center rounded border border-[#444] bg-[#2a2a3e] px-1 py-1.5 hover:border-blue-500 hover:bg-[#333]"
            title={LABELS[n]}
            data-testid={`rating-${n}`}
          >
            <span className="text-sm font-semibold tabular-nums">{n}</span>
            <span className="text-[10px] leading-tight text-gray-400">{LABELS[n]}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => {
          trackAction("case.rating.skip", { case_id: ask.case_id, job_id: ask.job_id ?? undefined, task: ask.task });
          close();
        }}
        className="mt-2 text-[11px] text-gray-400 hover:text-gray-200"
        data-testid="rating-skip"
      >
        Skip
      </button>
    </div>
  );
}
