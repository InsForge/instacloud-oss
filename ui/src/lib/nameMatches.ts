/** The console's type-to-confirm rule (insta-frontend confirm-delete-dialog.tsx `nameMatches`):
 *  trimmed, because the name is copied off the line above and a copy carries a trailing space;
 *  case-sensitive, because `Prod` is not `prod`; and a blank name fails closed, since a gate that
 *  opens on an empty input is a deleted resource.
 *
 *  Self-host divergence: the saved name is trimmed too, not only what was typed. The daemon stores a
 *  project name exactly as given (`insta project create "prod "` or a PATCH), so trimming only the
 *  input left no text that could ever match a name with a leading or trailing space, and that
 *  project could not be deleted from the dashboard at all. Spaces inside a name still count. */
export function nameMatches(typed: string, name: string): boolean {
  if (name.trim() === '') return false
  return typed.trim() === name.trim()
}
