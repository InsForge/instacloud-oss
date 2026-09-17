// Row shaping for the Deployment Logs tab (the console's per-service deploy-event table,
// insta-frontend services/deployment-logs.tsx). The daemon has no machine-operation feed — its
// `GET /events` audit stream is the record of what deployed, restarted, slept and woke — so the
// rows here are that stream filtered to one service and one time window.
//
// Self-host divergences: no Status or Machine column (audit events carry neither; a failed deploy
// reports its error at the call site and emits nothing).

import { eventDetail } from './activity'

/** The wire shape of one `GET /projects/:id/events` row this module needs. */
export type DeployEvent = {
  id: string; branch: string | null; source: string; kind: string; payload: unknown; created_at: string
}

export type DeployEventRow = { id: string; created: string; kind: string; detail: string; origin: string }

/** The daemon's service-id prefix per type (src/manageddb.ts idPrefix + pg/st/cp). */
const ID_PREFIX: Record<string, string> = {
  postgres: 'pg', storage: 'st', compute: 'cp', redis: 'rd', mysql: 'my', mongodb: 'mo',
}

export function serviceIdFor(type: string, name: string): string {
  return `${ID_PREFIX[type] ?? type}-${name}`
}

/** The event kinds the Deployment Logs table shows: what changed a service's deployment or
 *  runtime, not every audit line (variables and object reads stay on the Activities feed). */
function matches(e: DeployEvent, type: string, name: string): boolean {
  const p = (e.payload ?? {}) as Record<string, unknown>
  if (e.kind === 'deploy') return type === 'compute' && p.group === name
  const sid = serviceIdFor(type, name)
  // Lifecycle, restart, sleep/wake, access and settings events all name the service id. The
  // scheduler's ids are bare; API rows off the default branch carry a `<branchId>:` qualifier.
  if (typeof p.service === 'string' && (p.service === sid || p.service.endsWith(`:${sid}`))) return true
  // Registration events (`service.added|removed|rename`) carry {type, name} instead.
  if (p.type === type && (p.name === name || p.from === name || p.to === name)) return true
  return false
}

/** Events → newest-first table rows for one service, inside [fromMs, toMs]. */
export function deployEventRows(
  events: DeployEvent[], service: { type: string; name: string }, window: { fromMs: number; toMs: number },
): DeployEventRow[] {
  const rows: DeployEventRow[] = []
  for (const e of events) {
    const t = Date.parse(e.created_at)
    if (Number.isNaN(t) || t < window.fromMs || t > window.toMs) continue
    if (!matches(e, service.type, service.name)) continue
    rows.push({ id: e.id, created: e.created_at, kind: e.kind, detail: eventDetail(e.payload) ?? '', origin: e.source })
  }
  // The route answers oldest→newest; the table reads newest-first like the console's.
  return rows.reverse()
}
