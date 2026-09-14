// The Activities panel's event cards (insta-frontend lib/api/mappers/activity.ts), pure so the root vitest
// covers them: the daemon's events as a source badge, the kind, a one-line detail and a local timestamp,
// newest first.

/** Events per fetch; "Load more" grows the window by another page. */
export const ACTIVITY_PAGE_SIZE = 50

/** The approvals poll, tagged with the project it read: like the events feed, the poll hook keeps the
 *  previous project's answer across a switch, so an untagged count badges one project with another's queue. */
export type ApprovalsLoad = { projectId: string; statuses: string[] }

/** How many approvals are waiting on `projectId`: 0 until a load for THIS project has answered. */
export function pendingFor(load: ApprovalsLoad | undefined, projectId: string): number {
  if (!load || load.projectId !== projectId) return 0
  return load.statuses.filter((status) => status === 'pending').length
}

/** One answered poll, tagged with what it was asked for: the poll hook keeps its last data across a
 *  project change, so an untagged window would go on showing one project's events under another. */
export type EventsLoad = { projectId: string; limit: number; events: ActivityEvent[] }

/** What the panel draws for `projectId` at page size `limit`:
 *  - `events`: only a load for THIS project; undefined (the skeleton) while its first one is pending;
 *  - `loadingMore`: a grown window that has not answered yet and has not failed;
 *  - `maybeMore`: whether to offer Load more, kept while more is loading or after a failed attempt so it
 *    can be retried. */
export function panelState(load: EventsLoad | undefined, projectId: string, limit: number, failed: boolean): {
  events: ActivityEvent[] | undefined; loadingMore: boolean; maybeMore: boolean
} {
  if (!load || load.projectId !== projectId) return { events: undefined, loadingMore: false, maybeMore: false }
  const grown = load.limit !== limit
  return {
    events: load.events,
    loadingMore: grown && !failed,
    maybeMore: grown || load.events.length >= limit,
  }
}

export type ActivityEvent = { id: string; source: string; kind: string; detail: string | null; created: string }

/** A compact one-line payload summary, "key: value · key: value": primitive values only, the first four. */
export function eventDetail(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const parts = Object.entries(payload as Record<string, unknown>)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${String(value)}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** "Sep 14, 2026, 2:19 PM" in the viewer's zone, as the console's cards read; "—" for a missing or
 *  unreadable time. `timeZone` exists for tests, which cannot depend on the machine's zone. */
export function formatLocalDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(date)
}

/** The daemon's audit events as cards, newest first. The console's platform answers newest first; the
 *  daemon answers its latest window in the order the events happened, so the cards are ordered here.
 *  Events at the same instant keep the daemon's order, reversed: the later-recorded one comes first. */
export function mapEvents(
  events: ReadonlyArray<{ id?: string; source?: string; kind?: string; payload?: unknown; created_at?: string }>,
  timeZone?: string,
): ActivityEvent[] {
  const at = (iso: string | undefined) => {
    const t = iso ? Date.parse(iso) : Number.NaN
    return Number.isNaN(t) ? 0 : t
  }
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => at(b.event.created_at) - at(a.event.created_at) || b.index - a.index)
    .map(({ event, index }) => ({
      id: event.id ?? `event-${index}`,
      source: event.source ?? 'resource',
      kind: event.kind ?? '—',
      detail: eventDetail(event.payload),
      created: formatLocalDateTime(event.created_at, timeZone),
    }))
}
