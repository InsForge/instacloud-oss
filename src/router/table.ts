// The route table: pure functions from state + config to hostnames, lanes and upstreams (contract 00
// sections 8.2 and 10; decisions 7, 20, 51, 55). Nothing here touches the network or docker; the
// Router rebuilds this table whenever a routing-class state write lands and looks routes up per
// request, so `buildTable` never throws: a duplicate host or lane port is logged and the first
// route wins (the engine's reservations make duplicates impossible from now on; legacy state may
// still carry them).
import { createHash } from 'node:crypto'
import type { Config } from '../config'
import type { State } from '../state'
import { MANAGED_DB, MANAGED_SNI, managedContainerName } from '../manageddb'
import type { Branch, ManagedDbType, Project, ServiceKey } from '../types'

export type HostKind = 'compute' | 'postgres' | ManagedDbType
export type RouteKind = HostKind | 'api' | 'garage' | 'garage-vhost'
export type Lane = 'http' | 'pg' | 'sni' | 'port'

export interface Route {
  key: ServiceKey | 'api' | 'garage' | 'garage-vhost'
  host: string
  aliases: string[]
  kind: RouteKind
  lane: Lane
  projectId?: string
  branchId?: string
  serviceId?: string
  group?: string
  container: string
  network: string
  port: number
  listenPort?: number
  tls: boolean
  /** Copied from state at build time (compute: apps[g].desiredState ?? 'running'; databases:
   *  'running'), so the request path never calls loadState (decision 54). */
  desiredState: 'running' | 'stopped' | 'suspended'
}

export interface RouteTable {
  byHost(host: string): Route | undefined
  byPort(port: number): Route | undefined
  hosts(): Set<string>
  routes(): Route[]
}

/** Labels no service may mint (they name the daemon and the object store). */
export const RESERVED_LABELS: ReadonlySet<string> = new Set(['api', 'console', 's3'])
/** Compose container name of the object store (decision 46; equals GARAGE in adapters/garage.ts). */
export const GARAGE_CONTAINER = 'io-garage'
export const GARAGE_S3_PORT = 3900
export const GARAGE_WEB_PORT = 3902

const MAX_LABEL = 63
const HASH_LEN = 6

/** The engine's slug rule (engine.ts), duplicated so the table can derive a ref for rows written
 *  before refs were frozen. */
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)

/** A branch's frozen `<projectSlug>-<branchSlug>` ref (older rows derive it from the names). */
export function refOf(project: Project, branch: Branch): string {
  return branch.ref ?? `${project.refSlug ?? slug(project.name)}-${slug(branch.name)}`
}

/** Bare bounded label (decision 55): compute `<group>-<ref>`, postgres `pg-<name>-<ref>`, managed
 *  `<type>-<name>-<ref>`. A label over 63 chars keeps a readable prefix and appends `-` plus 6 hex
 *  of sha256(readable): deterministic, unique, never a 400. */
export function labelFor(kind: HostKind, name: string, ref: string): string {
  const readable = kind === 'compute' ? `${name}-${ref}` : kind === 'postgres' ? `pg-${name}-${ref}` : `${kind}-${name}-${ref}`
  if (readable.length <= MAX_LABEL) return readable
  const hash = createHash('sha256').update(readable).digest('hex').slice(0, HASH_LEN)
  const prefix = readable.slice(0, MAX_LABEL - HASH_LEN - 1).replace(/-+$/, '')
  return `${prefix}-${hash}`
}

/** The FQDN a service answers on: `${labelFor(...)}.${domain}`. */
export function hostFor(kind: HostKind, name: string, ref: string, domain: string): string {
  return `${labelFor(kind, name, ref)}.${domain}`
}

/** Strip a trailing dot and a :port (IPv6 literals keep their brackets), lowercase. */
export function hostOnly(hostHeader: string | undefined): string {
  if (!hostHeader) return ''
  let h = hostHeader.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    if (end !== -1) h = h.slice(0, end + 1)
  } else {
    const i = h.lastIndexOf(':')
    if (i !== -1 && !h.slice(0, i).includes(':')) h = h.slice(0, i)
  }
  return h.replace(/\.$/, '')
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** True when every label of `hostname` is `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` and the whole name
 *  is at most 253 chars. The one shape test: `assertHostLabel` turns a false into the 400 the domain
 *  routes send, and the certificate store uses it to refuse a name before building a path out of it
 *  (a TLS servername arrives from anyone who can reach a public lane, and `<certDir>/<issuer>/<host>
 *  /<host>.crt` would otherwise put `..` in a filesystem read). */
export function isHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false
  return hostname.split('.').every((label) => LABEL_RE.test(label))
}

/** Operator-supplied hostnames only (custom domains): every label `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`,
 *  the whole name at most 253 chars. Minted labels are bounded, never rejected. Throws a 400-class Error. */
export function assertHostLabel(hostname: string): void {
  if (!hostname || hostname.length > 253) throw new Error(`invalid hostname: ${JSON.stringify(hostname)} (1 to 253 characters)`)
  for (const label of hostname.split('.')) {
    if (!LABEL_RE.test(label)) throw new Error(`invalid hostname label ${JSON.stringify(label)} in ${hostname}: lower-case letters, digits and hyphens, 1 to 63 characters, no leading or trailing hyphen`)
  }
}

/** The database rows of a branch, with the legacy single-database shape (`dbUrl`, container
 *  `io-<ref>-pg`) presented as `pg-db` until WP5's migrateState folds it in. */
export function databasesOf(branch: Branch, ref: string): Record<string, { url: string; container: string; host?: string }> {
  if (branch.databases && Object.keys(branch.databases).length) return branch.databases
  if (branch.dbUrl !== undefined) return { 'pg-db': { url: branch.dbUrl, container: `io-${ref}-pg` } }
  return {}
}

/** The bucket handles of a branch (WP5 rows first, the legacy single bucket otherwise). */
export function bucketsOf(branch: Branch): string[] {
  const out = Object.values(branch.buckets ?? {}).map((b) => b.bucket)
  if (!out.length && branch.bucket) out.push(branch.bucket)
  return out
}

export function buildTable(state: State, cfg: Config, log: (msg: string) => void = (m) => console.warn(m)): RouteTable {
  const server = cfg.mode === 'server'
  const d = cfg.domain
  const byHost = new Map<string, Route>()
  const byPort = new Map<number, Route>()
  const hosts = new Set<string>()
  const routes: Route[] = []

  const add = (r: Route): void => {
    routes.push(r)
    for (const h of [r.host, ...r.aliases]) {
      const prev = byHost.get(h)
      if (prev) { log(`router: duplicate host ${h}: ${prev.key} wins over ${r.key}`); continue }
      byHost.set(h, r)
      hosts.add(h)
    }
    // Per-port lanes: every `port` lane, plus local-mode postgres (one plaintext listener per lane port).
    if (r.listenPort !== undefined && (r.lane === 'port' || (!server && r.lane === 'pg'))) {
      const prev = byPort.get(r.listenPort)
      if (prev) { log(`router: duplicate lane port ${r.listenPort}: ${prev.key} wins over ${r.key}`); return }
      byPort.set(r.listenPort, r)
    }
  }

  // Static: the daemon (both modes) and, in server mode only, the object store (decision 20).
  add({ key: 'api', host: `api.${d}`, aliases: [`console.${d}`], kind: 'api', lane: 'http', container: '', network: '', port: cfg.port, tls: false, desiredState: 'running' })
  if (server) {
    add({ key: 'garage', host: `s3.${d}`, aliases: [], kind: 'garage', lane: 'http', container: GARAGE_CONTAINER, network: '', port: GARAGE_S3_PORT, tls: false, desiredState: 'running' })
    add({ key: 'garage-vhost', host: `*.s3.${d}`, aliases: [], kind: 'garage-vhost', lane: 'http', container: GARAGE_CONTAINER, network: '', port: GARAGE_S3_PORT, tls: false, desiredState: 'running' })
    hosts.delete(`*.s3.${d}`)
  }

  const domainsByTarget = new Map<string, string[]>()
  for (const cd of Object.values(state.customDomains ?? {})) {
    const k = `${cd.branchId}:${cd.group}`
    domainsByTarget.set(k, [...(domainsByTarget.get(k) ?? []), cd.hostname])
  }

  for (const b of Object.values(state.branches)) {
    const p = state.projects[b.projectId]
    if (!p) continue
    const ref = refOf(p, b)
    for (const [g, app] of Object.entries(b.apps ?? {})) {
      add({
        key: `${b.id}:cp-${g}`, host: app.host ?? hostFor('compute', g, ref, d), aliases: domainsByTarget.get(`${b.id}:${g}`) ?? [],
        kind: 'compute', lane: 'http', projectId: p.id, branchId: b.id, serviceId: `cp-${g}`, group: g,
        container: `io-${ref}-app-${g}`, network: b.network, port: app.port, tls: false,
        desiredState: app.desiredState ?? 'running',
      })
    }
    for (const [id, db] of Object.entries(databasesOf(b, ref))) {
      const name = id.startsWith('pg-') ? id.slice(3) : id
      add({
        key: `${b.id}:${id}`, host: db.host ?? hostFor('postgres', name, ref, d), aliases: [],
        kind: 'postgres', lane: 'pg', projectId: p.id, branchId: b.id, serviceId: id,
        container: db.container, network: b.network, port: 5432,
        listenPort: server ? cfg.lanes.pgPort : b.lanes?.[id], tls: server, desiredState: 'running',
      })
    }
    for (const m of p.managedServices ?? []) {
      const cred = b.managed?.[m.id]
      if (!cred) continue
      const sni = server && MANAGED_SNI[m.type]
      add({
        key: `${b.id}:${m.id}`, host: cred.host ?? hostFor(m.type, m.name, ref, d), aliases: [],
        kind: m.type, lane: sni ? 'sni' : 'port', projectId: p.id, branchId: b.id, serviceId: m.id,
        container: managedContainerName(ref, m.type, m.name), network: b.network, port: MANAGED_DB[m.type].port,
        listenPort: sni ? (m.type === 'redis' ? cfg.lanes.redisPort : cfg.lanes.mongoPort) : b.lanes?.[m.id],
        tls: sni, desiredState: 'running',
      })
    }
    if (server) for (const bucket of bucketsOf(b)) hosts.add(`${bucket}.s3.${d}`)
  }

  const vhostSuffix = `.s3.${d}`
  const vhost = byHost.get(`*.s3.${d}`)
  return {
    byHost(host) {
      const h = hostOnly(host)
      const exact = byHost.get(h)
      if (exact) return exact
      // `<bucket>.s3.<domain>`: exactly one label in front of the suffix (server mode only). This
      // match is ROUTING, not ownership: the bucket need not exist, and the object store answers
      // its own 404. Ownership (`hosts()`, which carries only buckets that exist) is what
      // authorizes certificate work; a `byHost` hit here must never stand in for it.
      if (vhost && h.endsWith(vhostSuffix)) {
        const label = h.slice(0, -vhostSuffix.length)
        if (label && !label.includes('.') && label !== '*') return vhost
      }
      return undefined
    },
    byPort: (port) => byPort.get(port),
    hosts: () => new Set(hosts),
    routes: () => [...routes],
  }
}
