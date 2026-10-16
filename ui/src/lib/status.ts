// Service row status, derived from the services row plus its runtime-health row (contract
// section 13 view mapping). Pure so the whole table is unit-tested.

export type StatusKind =
  | 'online' | 'sleeping' | 'stopped' | 'suspended' | 'starting' | 'waking' | 'crashed' | 'none' | 'unknown'

export interface ServiceStatus {
  kind: StatusKind
  label: string
  /** Hover text explaining the state (why it sleeps, what crashed means). */
  title?: string
  /** True only for a sleeping compute service: the cloud's start route is compute-only. */
  wakeable: boolean
}

export interface StatusRow { type: string; runtime?: string; desired_state?: string }
export interface HealthRow { status: string }

const DB_TYPES: ReadonlySet<string> = new Set(['postgres', 'redis', 'mysql', 'mongodb'])

const ONLINE: ServiceStatus = { kind: 'online', label: 'Online', wakeable: false }
const STOPPED: ServiceStatus = { kind: 'stopped', label: 'Stopped', title: 'Stopped on request; Start it to serve traffic again', wakeable: false }
const SUSPENDED: ServiceStatus = { kind: 'suspended', label: 'Suspended', title: 'Paused; Start resumes it', wakeable: false }
const STARTING: ServiceStatus = { kind: 'starting', label: 'Starting', wakeable: false }
const WAKING: ServiceStatus = { kind: 'waking', label: 'Waking', wakeable: false }
const CRASHED: ServiceStatus = { kind: 'crashed', label: 'Crashed', title: 'Not answering on its port; check Logs', wakeable: false }
const NONE: ServiceStatus = { kind: 'none', label: 'Not deployed', wakeable: false }
const UNKNOWN: ServiceStatus = { kind: 'unknown', label: 'Unknown', wakeable: false }

function sleeping(type: string): ServiceStatus {
  return {
    kind: 'sleeping',
    label: 'Sleeping',
    title: DB_TYPES.has(type) ? 'Idle; wakes on the next connection' : 'Idle; wakes on the next request',
    wakeable: type === 'compute',
  }
}

/** Fallback when runtime-health has nothing to say (storage rows, or health unreadable): the
 *  services row's own `runtime` column. */
function fromRuntime(row: StatusRow): ServiceStatus {
  switch (row.runtime) {
    case 'online': return ONLINE
    case 'stopped': return STOPPED
    case 'suspended': return SUSPENDED
    case 'asleep': return sleeping(row.type)
    case 'none': return NONE
    default: return UNKNOWN
  }
}

/** Evaluation order (plan 07 E.2): a wake in flight wins; then the health row; `standby` splits
 *  into Stopped / Suspended / Sleeping by the compute row's desired state. */
export function deriveStatus(row: StatusRow, health?: HealthRow, waking = false): ServiceStatus {
  if (waking) return WAKING
  if (!health || health.status === 'unknown') return fromRuntime(row)
  switch (health.status) {
    case 'healthy': return ONLINE
    case 'starting': return STARTING
    case 'crashed': return CRASHED
    case 'none': return NONE
    case 'standby':
      if (row.type === 'compute' && row.desired_state === 'stopped') return STOPPED
      if (row.desired_state === 'suspended') return SUSPENDED
      return sleeping(row.type)
    default: return fromRuntime(row)
  }
}

/** `<branchId>:<serviceId>` -> `<serviceId>`; a bare id is returned as is. Only used to match a
 *  runtime-health row to a services row from the SAME branch listing (decision 49), never to
 *  compare ids across branches. */
export function bareServiceId(id: string): string {
  const i = id.lastIndexOf(':')
  return i === -1 ? id : id.slice(i + 1)
}

/** Find the health row for a services row: exact id first, then the bare form on either side. */
export function healthFor<H extends { serviceId: string }>(rows: H[] | undefined, id: string): H | undefined {
  if (!rows) return undefined
  const exact = rows.find((h) => h.serviceId === id)
  if (exact) return exact
  const bare = bareServiceId(id)
  return rows.find((h) => bareServiceId(h.serviceId) === bare)
}
