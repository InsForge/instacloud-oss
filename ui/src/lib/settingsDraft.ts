// The Settings panel's unsaved Project Name, kept outside the component. The panel is URL-driven
// (`?panel=settings`), so browser Back and Forward unmount it without passing through the close guard that
// refuses to discard a draft; keeping the draft here means the next open shows it again, with its save footer,
// instead of losing it. It lasts for the page session: a reload starts clean. Pure so the root vitest covers it.

const drafts = new Map<string, string>()

/** The unsaved name for `projectId`, or null when there is none. */
export function readDraftName(projectId: string): string | null {
  return drafts.get(projectId) ?? null
}

/** Remember a draft for `projectId`, or forget it with null (after Save or Discard). */
export function writeDraftName(projectId: string, name: string | null): void {
  if (name === null) drafts.delete(projectId)
  else drafts.set(projectId, name)
}
