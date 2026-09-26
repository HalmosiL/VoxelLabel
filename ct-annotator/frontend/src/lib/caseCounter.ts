/** The header's place in the job: "Case 2 of 4 · handed in · 1 more to
 * do". It read "Case 1 of 1 open" on the second of two cases -- a count of
 * the open ones, not a position (UX-annot-1-04, UX-rev-2-12). */
export function caseCounterText({
  index,
  total,
  openOthers,
  currentDone,
  reviewMode,
}: {
  index: number;
  total: number;
  openOthers: number;
  currentDone: boolean;
  reviewMode: boolean;
}): string {
  const parts = [`Case ${index + 1} of ${total}`];
  if (currentDone) parts.push(reviewMode ? "decided" : "handed in");
  if (openOthers > 0) parts.push(`${openOthers} more to do`);
  else parts.push(currentDone ? "all done" : "last one open");
  return parts.join(" · ");
}
