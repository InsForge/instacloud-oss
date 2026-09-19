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
 *  runtime. An explicit allowlist, not "anything naming the service": the audit stream also
 *  carries governed READS (`db.query`, `db.read`, `storage.objects.*`) with a `service` field,
 *  and a log of deployments must not fill with browsing. */
const DEPLOY_KINDS: ReadonlySet<string> = new Set([
  'deploy', 'service.restart', 'service.start', 'service.stop', 'service.suspend',
  'service.sleep', 'service.wake', 'service.added', 'service.removed', 'service.rename',
])

/** The same allowlist as a `?kinds=` value, so the SERVER filters before its limit slice and the
 *  fetched page holds deploy events rather than whatever browsing happened since. */
export const DEPLOY_KINDS_PARAM = [...DEPLOY_KINDS].join(',')

function matches(e: DeployEvent, type: string, name: string): boolean {
  if (!DEPLOY_KINDS.has(e.kind)) return false
  const p = (e.payload ?? {}) as Record<string, unknown>
  if (e.kind === 'deploy') return type === 'compute' && p.group === name
  const sid = serviceIdFor(type, name)
  // Lifecycle, restart and sleep/wake events all name the service id. The scheduler's ids are
  // bare; API rows off the default branch carry a `<branchId>:` qualifier.
  if (typeof p.service === 'string' && (p.service === sid || p.service.endsWith(`:${sid}`))) return true
  // Registration events (`service.added|removed|rename`) carry {type, name} instead.
  if (p.type === type && (p.name === name || p.from === name || p.to === name)) return true
  return false
}

/** Events → newest-first table rows for one service on one branch, inside [fromMs, toMs].
 *  Branch scoping happens HERE, not on the request: registration events (`service.added`,
 *  `service.rename` for compute) are emitted with `branch: null`, so a server-side
 *  `?branch=` filter silently drops them — the caller fetches the project stream and this
 *  keeps the branch's events plus the project-scoped (null-branch) ones. */
export function deployEventRows(
  events: DeployEvent[], service: { type: string; name: string },
  window: { fromMs: number; toMs: number }, branch: string,
): DeployEventRow[] {
  const rows: DeployEventRow[] = []
  for (const e of events) {
    if (e.branch !== null && e.branch !== branch) continue
    const t = Date.parse(e.created_at)
    if (Number.isNaN(t) || t < window.fromMs || t > window.toMs) continue
    if (!matches(e, service.type, service.name)) continue
    rows.push({ id: e.id, created: e.created_at, kind: e.kind, detail: eventDetail(e.payload) ?? '', origin: e.source })
  }
  // The route answers oldest→newest; the table reads newest-first like the console's.
  return rows.reverse()
}
