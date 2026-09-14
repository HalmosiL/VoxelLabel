import keycloak from "./keycloak";

/** A platform admin can look at the viewer "as" another role, to walk
 * the whole annotate → review loop from one account. Purely a UI
 * simulation (the token stays the admin's): "annotator" forces the
 * annotation surface, "reviewer" forces the review surface, the other
 * two leave the job's own surface in charge. The value arrives in the
 * URL (`?viewAs=`) from admin-ui -- the two apps are different origins,
 * so localStorage can't be shared -- and is then kept in this app's own
 * storage; a non-admin token ignores it entirely. */
export type ViewAs = "admin" | "data_manager" | "reviewer" | "annotator";

export const VIEW_AS_OPTIONS: { value: ViewAs; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "data_manager", label: "Data manager" },
  { value: "reviewer", label: "Reviewer" },
  { value: "annotator", label: "Annotator" },
];

const KEY = "vl.viewAs";

function isViewAs(v: string | null): v is ViewAs {
  return VIEW_AS_OPTIONS.some((o) => o.value === v);
}

/** True when the signed-in person holds the realm-wide admin role. */
export function isPlatformAdmin(): boolean {
  const roles = (keycloak.tokenParsed as { realm_access?: { roles?: string[] } } | undefined)?.realm_access?.roles ?? [];
  return roles.includes("admin");
}

/** The URL parameter wins (it carries admin-ui's current choice), then
 * this app's own remembered value, then plain "admin". */
export function readViewAs(search: string): ViewAs {
  const fromUrl = new URLSearchParams(search).get("viewAs");
  if (isViewAs(fromUrl)) {
    writeViewAs(fromUrl);
    return fromUrl;
  }
  try {
    const stored = window.localStorage.getItem(KEY);
    return isViewAs(stored) ? stored : "admin";
  } catch {
    return "admin";
  }
}

export function writeViewAs(value: ViewAs): void {
  try {
    if (value === "admin") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, value);
  } catch {
    /* ignore */
  }
}

/** Appends `viewAs` to a URL (admin-ui's, typically) so the mode travels
 * back with the person; nothing is added for plain "admin". */
export function withViewAs(url: string, value: ViewAs): string {
  if (value === "admin") return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}viewAs=${value}`;
}
