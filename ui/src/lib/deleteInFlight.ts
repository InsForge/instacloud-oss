// Which projects have a Delete Project request in flight, kept outside the component. The Settings panel is
// URL-driven, so browser Back and Forward unmount and remount it mid-request; a lock held in the component would
// come back fresh and let a second DELETE through before the first answered. Kept here, the remounted dialog still
// reads as busy and cannot submit. Subscribers (useSyncExternalStore) hear when a delete starts or ends, so a
// dialog mounted during the request clears when it settles. Pure so the root vitest covers it.

const inFlight = new Set<string>()
const listeners = new Set<() => void>()

const notify = () => { for (const listener of listeners) listener() }

/** Claim the delete for `projectId`: false when one is already in flight, so the caller must not send another. */
export function beginDelete(projectId: string): boolean {
  if (inFlight.has(projectId)) return false
  inFlight.add(projectId)
  notify()
  return true
}

/** Release the claim once the request has settled, success or failure. */
export function endDelete(projectId: string): void {
  if (inFlight.delete(projectId)) notify()
}

export function isDeleting(projectId: string): boolean {
  return inFlight.has(projectId)
}

export function subscribeDeletes(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
