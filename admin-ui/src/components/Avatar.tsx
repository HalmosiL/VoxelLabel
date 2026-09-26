const PALETTE = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6"];

function colorFor(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

/** "Anna Kovács" -> "AK", "dr-test" -> "DT", "réka" -> "RÉ"; a bare id
 * gives its first two characters. */
export function initialsOf(value: string): string {
  const words = value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? value).slice(0, 2).toUpperCase();
}

/** A colored initials chip for a person. `id` keeps the color stable;
 * `name` (the display name, see memberLabel) gives the initials and the
 * hover text -- without it the chip falls back to the id itself (UX: every
 * avatar read "UX" or two hex digits). */
export default function Avatar({ id, name }: { id: string; name?: string | null }) {
  const shown = name?.trim() || id;
  return (
    <span className="avatar" style={{ backgroundColor: colorFor(id) }} title={shown}>
      {initialsOf(shown)}
    </span>
  );
}
