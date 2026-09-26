/** The one step that can still be taken back: a hand-in or a review
 * decision just made. It lives outside the viewer page because the viewer
 * moves on to the next case (a fresh page) right after the step, while the
 * "Undo" offer has to stay on screen (components/UndoToast.tsx).
 *
 * The server has the final word (annotation-service's /undo: the same
 * person, a few minutes, nothing newer on the image); the window here is
 * only how long the offer is shown. */

export const UNDO_OFFER_MS = 10_000;

export interface UndoOffer {
  /** the version whose hand-in / decision is taken back */
  annotationId: string;
  /** what was done, in words: "Case 0709 handed in" */
  message: string;
  /** what the case is once taken back: "draft again", "awaiting your decision again" */
  undoneMessage: string;
  /** the viewer URL that opens the case again */
  backTo: string;
  expiresAt: number;
}

type Listener = () => void;

let offer: UndoOffer | null = null;
const listeners = new Set<Listener>();
const undoneListeners = new Set<(annotationId: string) => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function offerUndo(next: Omit<UndoOffer, "expiresAt">, now = Date.now()): void {
  offer = { ...next, expiresAt: now + UNDO_OFFER_MS };
  emit();
}

export function currentUndo(now = Date.now()): UndoOffer | null {
  return offer && offer.expiresAt > now ? offer : null;
}

export function clearUndo(): void {
  offer = null;
  emit();
}

export function subscribeUndo(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tells whoever cares (the viewer's pending move to the next case) that
 * the step on `annotationId` was taken back. */
export function announceUndone(annotationId: string): void {
  for (const fn of undoneListeners) fn(annotationId);
}

export function onUndone(fn: (annotationId: string) => void): () => void {
  undoneListeners.add(fn);
  return () => undoneListeners.delete(fn);
}
