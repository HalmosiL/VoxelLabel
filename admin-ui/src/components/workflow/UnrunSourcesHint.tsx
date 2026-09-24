/** Names the inputs of an LLM/Criterion card whose source card hasn't
 * been Run yet: their cases can't be counted (or reach the assistant)
 * until it is. Renders nothing when every input is resolved. */
export default function UnrunSourcesHint({ titles }: { titles?: string[] }) {
  if (!titles || titles.length === 0) return null;
  const names = titles.map((t) => `"${t}"`).join(", ");
  return (
    <span className="text-amber-700" data-testid="unrun-sources">
      Run {names} first to connect {titles.length === 1 ? "its" : "their"} cases
    </span>
  );
}
