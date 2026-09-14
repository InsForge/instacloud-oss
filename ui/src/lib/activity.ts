// The Activities panel's event cards (insta-frontend lib/api/mappers/activity.ts), pure so the root vitest
// covers them: the daemon's events as a source badge, the kind, a one-line detail and a local timestamp,
// newest first.

/** Events per fetch; "Load more" grows the window by another page. */
export const ACTIVITY_PAGE_SIZE = 50

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
