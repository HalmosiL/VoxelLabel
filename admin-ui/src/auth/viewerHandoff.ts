import type { MouseEvent } from "react";

import keycloak from "../keycloak";

/** Appends this session's tokens to a ct-annotator URL as a URL
 * *fragment* -- never the query string or anywhere else a server
 * would log it. ct-annotator's own bootstrap (frontend/src/main.tsx)
 * consumes and immediately strips it, letting someone already signed
 * in on admin-ui open the viewer (or the practice Tutorial) without a
 * second Keycloak login. Every link into ct-annotator needs this, not
 * just the case-detail "Open in Viewer" link -- see CaseDetailPage.tsx
 * and MyJobsPage.tsx's Tutorial card. Falls back to the bare URL
 * (ct-annotator's own login-required redirect) if, for whatever
 * reason, this session has no live tokens yet. */
/** Bump when ct-annotator ships something a browser MUST pick up. Its
 * index.html is served with Cache-Control: no-store now, but a copy a
 * browser cached *before* that header existed can legitimately be
 * reused, unrevalidated, for hours (heuristic freshness: 10% of the
 * file's age -- a day-old build buys ~2h of stale serving). A changed
 * query string is a different cache key, so this forces one fresh fetch
 * of index.html; from then on no-store keeps it fresh on its own.
 * ct-annotator's routes ignore the extra `cb` parameter. */
const CT_ANNOTATOR_CACHE_BUST = "20260912-2";

export function withViewerHandoff(url: string): string {
  // Idempotent: refreshViewerHandoffOnClick feeds an already-busted URL back in.
  const busted = /[?&]cb=/.test(url) ? url : `${url}${url.includes("?") ? "&" : "?"}cb=${CT_ANNOTATOR_CACHE_BUST}`;
  if (!keycloak.token || !keycloak.refreshToken || !keycloak.idToken) return busted;
  const handoff = new URLSearchParams({ at: keycloak.token, rt: keycloak.refreshToken, it: keycloak.idToken });
  return `${busted}#${handoff.toString()}`;
}

/** A link's `href` is computed once, at render time -- but the tokens
 * it carries can go stale before someone actually clicks: found live,
 * the hard way, when a link sat rendered for a few minutes and
 * ct-annotator's own consumption of it came back "invalid_grant /
 * Session not active" from Keycloak (the SSO session behind that
 * particular refresh token had already moved on, even though the JWTs'
 * own `exp` hadn't been reached). This click handler re-runs
 * withViewerHandoff() with whatever the *current* live tokens are,
 * right as the click happens, and swaps it into the href the browser
 * is about to follow -- closing that staleness window instead of
 * trusting whatever was baked in at render. */
export function refreshViewerHandoffOnClick(e: MouseEvent<HTMLAnchorElement>): void {
  const base = e.currentTarget.href.split("#")[0];
  e.currentTarget.href = withViewerHandoff(base);
}
