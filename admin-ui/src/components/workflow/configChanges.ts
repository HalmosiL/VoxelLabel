/** The config keys an edit actually changed, for a card PATCH.
 *
 * The properties panel builds each edit as `{...card.config, field: value}`
 * from the card as this tab last loaded it. Sending that whole object let
 * a tab that wasn't reloaded write its stale copy of every *other* field
 * back over another admin's change -- e.g. re-assigning a job someone had
 * just unassigned (C-13). The server merges what it gets into the stored
 * config, so sending only the changed keys leaves other people's edits
 * alone. Values are compared as JSON, so a re-built but equal list isn't
 * sent. */
export function configChanges(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(value) !== JSON.stringify(before[key])) changed[key] = value;
  }
  return changed;
}
