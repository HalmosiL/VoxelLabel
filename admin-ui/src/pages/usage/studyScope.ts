/** The Usage page's study filter: all studies, "My studies" (every study
 * the viewer is a member of), or one study. It opens on My studies when
 * the viewer has any -- the page opened on every study on the platform,
 * the test studies included, and its "Act now" was about work the viewer
 * can't change -- and remembers the last choice in this browser. */

export const MY_STUDIES = "mine";
const REMEMBER_KEY = "vl.usage.study";

/** The studies I'm a member of or created, still in the list (a trashed
 * one isn't), in its order. */
export function myStudyIds(memberships: { study_id: string }[], studies: { id: string }[], created: string[] = []): string[] {
  const mine = new Set([...memberships.map((m) => m.study_id), ...created]);
  return studies.filter((s) => mine.has(s.id)).map((s) => s.id);
}

/** What the API's `study_id` gets: "" (no filter), one id, or "a,b,c". */
export function scopeOf(choice: string, mine: string[]): string {
  return choice === MY_STUDIES ? mine.join(",") : choice;
}

/** The remembered choice while it still makes sense, else My studies
 * when there are any, else all studies. */
export function initialChoice(remembered: string | null, mine: string[], studyIds: string[]): string {
  if (remembered === "") return "";
  if (remembered === MY_STUDIES && mine.length > 0) return MY_STUDIES;
  if (remembered && studyIds.includes(remembered)) return remembered;
  return mine.length > 0 ? MY_STUDIES : "";
}

export function rememberedChoice(): string | null {
  try {
    return localStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
}

export function rememberChoice(choice: string): void {
  try {
    localStorage.setItem(REMEMBER_KEY, choice);
  } catch {
    // a blocked storage just means it isn't remembered
  }
}
