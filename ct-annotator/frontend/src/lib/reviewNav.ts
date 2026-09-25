/** Where review goes after a decision: the next object still undecided
 * after `from` (wrapping round), or null when every other one is decided
 * (G-06: it went to from + 1, often an object already decided). */
export function nextUndecidedIndex(statuses: (string | undefined)[], from: number): number | null {
  const n = statuses.length;
  for (let step = 1; step < n; step++) {
    const i = (from + step) % n;
    if ((statuses[i] ?? "pending") === "pending") return i;
  }
  return null;
}
