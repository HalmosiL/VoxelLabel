const PALETTE = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6"];

function colorFor(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

/** A colored initials chip for an identifier (Keycloak subject, etc.) that
 * has no display name of its own -- gives raw UUIDs some visual distinction
 * instead of a wall of monospace text. */
export default function Avatar({ id }: { id: string }) {
  return (
    <span className="avatar" style={{ backgroundColor: colorFor(id) }} title={id}>
      {id.slice(0, 2).toUpperCase()}
    </span>
  );
}
