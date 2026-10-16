// Managed-database catalog + the seam's naming contract for them — pure data, no docker. Mirrors
// the platform (services.ts MANAGED_FLY_DATABASES + secretNames.ts CANONICAL_KEYS): same images,
// ports, env, bundle keys and suffix rule, so `.env` written against either target is identical
// modulo the host. The host is the LOCAL container name (the cloud's is `<flyApp>.internal`) —
// both resolve only from inside the branch's private network.
import { randomBytes } from 'node:crypto'
import type { ManagedDbType } from './types'

export const MANAGED_DB_TYPES: readonly ManagedDbType[] = ['redis', 'mysql', 'mongodb']
export const isManagedDbType = (s: string): s is ManagedDbType => (MANAGED_DB_TYPES as readonly string[]).includes(s)

type ManagedDbConfig = {
  idPrefix: string // stable oss service-id prefix (pg-db / st-store / cp-<group> convention)
  image: string
  port: number
  volumeGib: number // fixed 1Gi on the cloud; advisory locally (reported, not enforced)
  cmd?: string[]
  env(password: string): Record<string, string>
  bundle(host: string, password: string): Record<string, string>
}

export const MANAGED_DB: Record<ManagedDbType, ManagedDbConfig> = {
  redis: {
    idPrefix: 'rd',
    image: 'valkey/valkey:7',
    port: 6379,
    volumeGib: 1,
    cmd: [
      'sh',
      '-c',
      'exec valkey-server --appendonly yes --dir /data --requirepass "$REDIS_PASSWORD" --bind 0.0.0.0 --protected-mode no',
    ],
    env: (password) => ({ REDIS_PASSWORD: password }),
    bundle: (host, password) => ({
      REDIS_URL: `redis://default:${encodeURIComponent(password)}@${host}:6379/0`,
      REDIS_HOST: host,
      REDIS_PORT: '6379',
      REDIS_USERNAME: 'default',
      REDIS_PASSWORD: password,
    }),
  },
  mysql: {
    idPrefix: 'my',
    image: 'mysql:8.4',
    port: 3306,
    volumeGib: 1,
    env: (password) => ({
      MYSQL_DATABASE: 'app',
      MYSQL_USER: 'insta',
      MYSQL_PASSWORD: password,
      // the image refuses to start without a root password; like the cloud, it is random and
      // never surfaced — apps use the `insta` user
      MYSQL_ROOT_PASSWORD: randomBytes(32).toString('base64url'),
    }),
    bundle: (host, password) => ({
      MYSQL_URL: `mysql://insta:${encodeURIComponent(password)}@${host}:3306/app`,
      MYSQL_HOST: host,
      MYSQL_PORT: '3306',
      MYSQL_DATABASE: 'app',
      MYSQL_USERNAME: 'insta',
      MYSQL_PASSWORD: password,
    }),
  },
  mongodb: {
    idPrefix: 'mo',
    image: 'mongo:7',
    port: 27017,
    volumeGib: 1,
    env: (password) => ({
      MONGO_INITDB_ROOT_USERNAME: 'root',
      MONGO_INITDB_ROOT_PASSWORD: password,
    }),
    bundle: (host, password) => ({
      MONGODB_URL: `mongodb://root:${encodeURIComponent(password)}@${host}:27017/admin?authSource=admin`,
      MONGODB_HOST: host,
      MONGODB_PORT: '27017',
      MONGODB_DATABASE: 'admin',
      MONGODB_USERNAME: 'root',
      MONGODB_PASSWORD: password,
    }),
  },
}

// The canonical (unsuffixed) key set per type — reserved from user secrets, aliased at read time
// for the oldest service of each type (platform secretNames.ts CANONICAL_KEYS).
export const CANONICAL_MANAGED_KEYS: ReadonlySet<string> = new Set(
  MANAGED_DB_TYPES.flatMap((t) => Object.keys(MANAGED_DB[t].bundle('h', 'p'))),
)

// Service names are lower-kebab, so this is injective (platform secretNames.ts envSuffix).
export const envSuffix = (serviceName: string): string => serviceName.replace(/-/g, '_').toUpperCase()

export function suffixBundle(bundle: Record<string, string>, serviceName: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(bundle)) out[`${k}_${envSuffix(serviceName)}`] = v
  return out
}

export const managedServiceId = (type: ManagedDbType, name: string): string => `${MANAGED_DB[type].idPrefix}-${name}`
export const managedContainerName = (ref: string, type: ManagedDbType, name: string): string =>
  `io-${ref}-${MANAGED_DB[type].idPrefix}-${name}`

/** `INFO keyspace` → the logical dbs that hold keys ("db0:keys=3,expires=0,avg_ttl=0"), for the
 *  console's db chips on the redis key browser. Empty dbs are simply absent from the output. */
export function parseKeyspaceInfo(text: string): Array<{ db: number; keys: number }> {
  const out: Array<{ db: number; keys: number }> = []
  for (const line of text.split('\n')) {
    const m = /^db(\d+):keys=(\d+)/.exec(line.trim())
    if (m) out.push({ db: Number(m[1]), keys: Number(m[2]) })
  }
  return out
}

/** A *SCAN page (`[cursor, [f1, v1, …]]`) → at most `maxPairs` field/value pairs as an object.
 *  The daemon enforces the bound itself: SCAN's COUNT is a hint the server may exceed, so the
 *  page is hard-sliced here rather than trusted. */
export function scanPageToHash(page: unknown, maxPairs = 200): Record<string, string> {
  const flat = Array.isArray(page) && Array.isArray(page[1]) ? (page[1] as unknown[]) : []
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < Math.min(flat.length, maxPairs * 2); i += 2) out[String(flat[i])] = String(flat[i + 1])
  return out
}

/** A *SCAN page (`[cursor, [m1, m2, …]]`) → at most `max` members. Same hard slice as above. */
export function scanPageMembers(page: unknown, max = 200): string[] {
  const flat = Array.isArray(page) && Array.isArray(page[1]) ? (page[1] as unknown[]) : []
  return flat.slice(0, max).map(String)
}

/** `INFO` → its key:value pairs (comment lines dropped), for the redis Stats view. */
export function parseRedisInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon > 0) out[line.slice(0, colon)] = line.slice(colon + 1)
  }
  return out
}

// ---- region WP2 (router) ----
/** Which managed types route by TLS SNI on the shared server-mode lane (redis 6379, mongo 27017).
 *  MySQL greets first and has no SNI, so it gets a plaintext per-service port (decision 38). Kept as
 *  its own map (the catalog type above is not this region's to extend). */
export const MANAGED_SNI: Record<ManagedDbType, boolean> = { redis: true, mysql: false, mongodb: true }

/** The credential bundle against a LANE address instead of the container: same keys as
 *  `MANAGED_DB[type].bundle`, host and port swapped, and the TLS flag folded into the URL
 *  (`rediss://`, mongo `&tls=true`) when the lane terminates TLS (contract 00 section 10). */
export function laneBundle(type: ManagedDbType, host: string, port: number, password: string, tls: boolean): Record<string, string> {
  const pw = encodeURIComponent(password)
  const portStr = String(port)
  if (type === 'redis') {
    return {
      REDIS_URL: `${tls ? 'rediss' : 'redis'}://default:${pw}@${host}:${portStr}/0`,
      REDIS_HOST: host, REDIS_PORT: portStr, REDIS_USERNAME: 'default', REDIS_PASSWORD: password,
    }
  }
  if (type === 'mysql') {
    return {
      MYSQL_URL: `mysql://insta:${pw}@${host}:${portStr}/app`,
      MYSQL_HOST: host, MYSQL_PORT: portStr, MYSQL_DATABASE: 'app', MYSQL_USERNAME: 'insta', MYSQL_PASSWORD: password,
    }
  }
  return {
    MONGODB_URL: `mongodb://root:${pw}@${host}:${portStr}/admin?authSource=admin${tls ? '&tls=true' : ''}`,
    MONGODB_HOST: host, MONGODB_PORT: portStr, MONGODB_DATABASE: 'admin', MONGODB_USERNAME: 'root', MONGODB_PASSWORD: password,
  }
}
// ---- end region WP2 ----
// ---- region WP4 (data dir) ----
/** Where each managed image keeps its state, and the sub-directory of `md/<ref>/<prefix>-<dataId>/`
 *  that bind-mounts onto it (contract 00 section 12). One entry per path the image writes: mongo
 *  keeps its config server separate. A missing bind source makes `--mount type=bind` fail, so the
 *  engine creates every sub-directory before the container starts. */
export const MANAGED_DB_DATA_PATHS: Record<ManagedDbType, ReadonlyArray<{ containerPath: string; sub: string }>> = {
  redis: [{ containerPath: '/data', sub: 'data' }],
  mysql: [{ containerPath: '/var/lib/mysql', sub: 'mysql' }],
  mongodb: [{ containerPath: '/data/db', sub: 'db' }, { containerPath: '/data/configdb', sub: 'configdb' }],
}
export const dataPaths = (type: ManagedDbType): ReadonlyArray<{ containerPath: string; sub: string }> =>
  MANAGED_DB_DATA_PATHS[type]
// ---- end region WP4 ----
// ---- region WP5 (templates/parity) ----
// Naming helpers shared by every package (contract 00 section 7). Handles are READ from state when a
// row carries them (databases[id].container, buckets[id].bucket) and derived here only at provision.
/** Postgres container for one database service on a branch: `io-<ref>-pg-<name>`. */
export const pgContainerName = (ref: string, name: string): string => `io-${ref}-pg-${name}`
/** The ONE object-store container of the box, on every branch network that has a bucket. */
export const GARAGE_CONTAINER = 'io-garage'
/** Bucket for one storage service on a branch: `io-<ref>-<name>` (legacy single bucket: `io-<ref>`). */
export const bucketName = (ref: string, name: string): string => `io-${ref}-${name}`
/** App container for one compute group on a branch: `io-<ref>-app-<group>`. */
export const appContainerName = (ref: string, group: string): string => `io-${ref}-app-${group}`

/** Service id of one postgres service: `pg-<name>` (the legacy single database is `pg-db`). */
export const pgServiceId = (name: string): string => `pg-${name}`
/** Service id of one storage service: `st-<name>` (the legacy single bucket is `st-store`). */
export const storageServiceId = (name: string): string => `st-${name}`
/** Service id of one compute group: `cp-<group>`. */
export const computeServiceId = (group: string): string => `cp-${group}`

/** Every service type's canonical (unsuffixed) credential keys, in the platform's own order
 *  (insta-platform src/provisioning/secretNames.ts CANONICAL_KEYS). A template's env.platform ref
 *  `${{services.<name>.<KEY>}}` may only name a key of the target's type, and `credentials()`
 *  returns exactly this set for one service. Managed types read their keys off the catalog above,
 *  so the two can never drift. */
export const CANONICAL_KEYS: Record<string, readonly string[]> = {
  postgres: ['DATABASE_URL'],
  storage: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT_URL_S3', 'BUCKET_NAME', 'AWS_REGION'],
  redis: Object.keys(MANAGED_DB.redis.bundle('h', 'p')),
  mysql: Object.keys(MANAGED_DB.mysql.bundle('h', 'p')),
  mongodb: Object.keys(MANAGED_DB.mongodb.bundle('h', 'p')),
}

/** Every oss service type a service id can name. */
export type ServiceType = 'postgres' | 'storage' | 'compute' | ManagedDbType

/** A parsed service id: the optional branch qualifier of decision 49, the BARE service id, and the
 *  type + name its prefix encodes. `null` for an id no prefix claims.
 *
 *  The qualifier is what `GET /projects/:id/services?branch=<b>` puts in front of a row id on a
 *  non-default branch (`<branchId>:pg-db`), because the CLI takes an id from that list and calls
 *  credentials/state/start/stop with NO branch. Stripping it here keeps every project-level key
 *  (`serviceSettings`, limits, always-on) branch-free. */
export function parseServiceId(sid: string): { branchId?: string; serviceId: string; type: ServiceType; name: string } | null {
  const i = sid.indexOf(':')
  const branchId = i === -1 ? undefined : sid.slice(0, i)
  const serviceId = i === -1 ? sid : sid.slice(i + 1)
  if (branchId === '' || serviceId === '' || serviceId.includes(':')) return null
  const managed = parseManagedServiceId(serviceId)
  if (managed) return { ...(branchId !== undefined ? { branchId } : {}), serviceId, type: managed.type, name: managed.name }
  for (const [prefix, type] of [['pg-', 'postgres'], ['st-', 'storage'], ['cp-', 'compute']] as const) {
    if (serviceId.startsWith(prefix) && serviceId.length > prefix.length) {
      return { ...(branchId !== undefined ? { branchId } : {}), serviceId, type, name: serviceId.slice(prefix.length) }
    }
  }
  return null
}
// ---- end region WP5 ----

/** Resolve a managed service id (rd-* | my-* | mo-*) to its type + name, or null. */
export function parseManagedServiceId(sid: string): { type: ManagedDbType; name: string } | null {
  for (const type of MANAGED_DB_TYPES) {
    const p = `${MANAGED_DB[type].idPrefix}-`
    if (sid.startsWith(p) && sid.length > p.length) return { type, name: sid.slice(p.length) }
  }
  return null
}
