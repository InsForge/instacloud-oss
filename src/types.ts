// src/types.ts
export type Decision = 'allow' | 'deny' | 'approve'
// ---- region WP3 (scheduler): 'service.upgrade' added (cloud gates PUT limits on it, platform server.ts:2024 comment + agent guard) ----
export const GATED_ACTIONS = ['secrets.read', 'secrets.write', 'storage.read', 'storage.write', 'storage.delete', 'db.read', 'db.query', 'deploy', 'project.delete', 'branch.delete', 'service.add', 'service.remove', 'service.setAccess', 'service.rename', 'service.upgrade'] as const
export type GatedAction = (typeof GATED_ACTIONS)[number]
export const isGatedAction = (a: string): a is GatedAction => (GATED_ACTIONS as readonly string[]).includes(a)

export type ManagedDbType = 'redis' | 'mysql' | 'mongodb'
export type ObservedComponent = 'db' | 'compute' | ManagedDbType

// ---- region WP3 (scheduler) ----
export type ServiceKind = 'compute' | 'postgres' | 'managed'
/** `${branchId}:${serviceId}` e.g. `<uuid>:cp-web`, `<uuid>:pg-db`, `<uuid>:rd-cache`. */
export type ServiceKey = string
export interface ServiceLimits { cpu: number; memoryMb: number }
/** Project-level per-service settings keyed by service id (cp-<group> | rd-/my-/mo-<name>). Postgres settings are per branch (Branch.databases[id]). */
export interface ServiceSettings {
  alwaysOn?: boolean            // undefined = the default: cfg.sleep.alwaysOnDefault on the default branch, scale-to-zero elsewhere
  limits?: ServiceLimits        // undefined = no cgroup ceiling
  createdAt?: number
  renamedAt?: number            // when the service took its current name: its metrics history starts no earlier
  port?: number                 // WP5: default listen port recorded by services add / template deploy
  templateDeploymentId?: string // WP5
  templateCode?: string         // WP5
  templateModified?: boolean    // WP5
}
// ---- end region WP3 ----

export interface Project {
  id: string; name: string; status: string; createdAt: number; computeGroups?: string[]
  refSlug?: string
  computeVolumes?: Record<string, { id: string; sizeGib: number }>
  managedServices?: Array<{ id: string; type: ManagedDbType; name: string; createdAt: number; renamedAt?: number; dataId?: string }>   // dataId: WP4 (8 hex, minted at add, backfilled by migration); renamedAt: when it took its current name
  // ---- region WP5 (templates/parity) ----
  dbServices?: Array<{ id: string; name: string; dataId: string; createdAt: number; renamedAt?: number; templateDeploymentId?: string }>        // id = `pg-${name}`; oldest gets the canonical DATABASE_URL alias
  storageServices?: Array<{ id: string; name: string; createdAt: number; public?: boolean }>                             // id = `st-${name}`
  // ---- end region WP5 ----
  // ---- region WP3 (scheduler) ----
  serviceSettings?: Record<string, ServiceSettings>
  // ---- end region WP3 ----
}

export interface UserSecret { name: string; value: string; branch: string | null; service?: string | null }

export interface Branch {
  id: string; projectId: string; name: string; isDefault: boolean; status: string
  ref?: string
  network: string
  // DEPRECATED (WP5): dbUrl, bucket, s3, storagePublic are migrated into databases/buckets by state.migrateState and never read afterwards.
  dbUrl?: string; bucket?: string; s3?: Record<string, string>; storagePublic?: boolean
  cloneOf: string | null
  createdAt: number
  dbVolumeGib?: number
  apps: Record<string, {
    image: string; port: number
    hostPort?: number             // LOCAL mode only (loopback-published); absent in server mode
    url: string                   // router URL: https://<host> | http://<host>:<port>
    host?: string                 // WP2: bare minted hostname (bounded label, decision 55); recorded at deploy, never re-derived
    updatedAt?: number
    addedAt?: number              // when this branch first carried the group: its metrics history here starts no earlier; a redeploy keeps it
    desiredState?: 'running' | 'stopped' | 'suspended'
    sleptAt?: number | null       // WP3: set when the scheduler stopped it (idle | memory | branch-create); cleared on wake/start/deploy
  }>
  managed?: Record<string, { password: string; sleptAt?: number | null; host?: string /* WP2: minted lane hostname, recorded at provision */; addedAt?: number /* when this branch got it: its metrics history here starts no earlier */ }>
  // ---- region WP5 (templates/parity) ----
  databases?: Record<string, {    // keyed by service id (pg-<name>)
    url: string                   // container-host form: postgres://postgres:<pw>@<container>:5432/app (the engine rewrites host:port to the lane at read time)
    container: string             // io-<ref>-pg-<name> (legacy: io-<ref>-pg until migrated)
    dataId: string                // directory key under <dataDir>/pg/<ref>/
    addedAt?: number              // when this branch got the database: its metrics history here starts no earlier
    host?: string                 // WP2: minted lane hostname (bounded label, decision 55), recorded at provision
    sleptAt?: number | null       // WP3
    scaleToZero?: boolean         // WP3: default true; PATCH database/settings {scaleToZero}
    idleTimeoutSec?: number       // WP3: PATCH {idleTimeout}; undefined = cfg.sleep.idleDbSec; 0 = never
    limits?: ServiceLimits        // WP3: PATCH {cpu, memory}
  }>
  buckets?: Record<string, { bucket: string; env: Record<string, string>; public?: boolean }>   // keyed by st-<name>; bucket = io-<ref>-<name> (legacy io-<ref>)
  bindings?: Array<{ envName: string; target: string; source: string; sourceName: string }>    // target 'compute/<group>', source '<type>/<name>'
  // ---- end region WP5 ----
  // ---- region WP2 (router) ----
  lanes?: Record<string, number>  // serviceId -> host listen port (local mode every DB; server mode mysql only)
  // ---- end region WP2 ----
  // ---- region WP4 (data dir) ----
  dataVersion?: 1                 // undefined = legacy docker-volume layout, migrated at boot
  // ---- end region WP4 ----
}

export interface Approval { id: string; projectId: string; action: GatedAction; status: 'pending' | 'granted' | 'denied' | 'consumed'; requestedAt: string; decidedAt: string | null }
export interface AuditEvent { id: string; projectId: string; branch: string | null; source: 'agent' | 'resource' | 'govern'; kind: string; payload: unknown; dedupKey: string | null; createdAt: string }

// ---- region WP2 (router) ----
export interface CustomDomainEntry { hostname: string; projectId: string; branchId: string; group: string; createdAt: number }
// ---- end region WP2 ----

// ---- region WP5 (templates/parity) ----
export interface TemplateDeploymentRecord {
  id: string; projectId: string; branchId: string
  templateCode: string; templateVersion: string; templateSource: string
  status: 'running' | 'succeeded' | 'failed' | 'partial'
  step: 'create_services' | 'write_variables' | 'deploy' | 'health_check'
  services: Record<string, {
    serviceName: string; serviceId?: string; type: 'web' | 'postgres'
    image?: string; port?: number; healthcheck?: string; volumeGib?: number; alwaysOn?: boolean
    env: Record<string, { source: 'fixed' | 'generated' | 'platform' | 'required' | 'optional'; generator?: string; value?: string; ref?: string }>
    url?: string; state: 'pending' | 'created' | 'deployed' | 'healthy' | 'failed'
  }>
  manifestDigest: string; digestEpoch: 2; claimToken: string
  error?: string; logsTail?: string
  createdAt: string; updatedAt: string
}
// ---- end region WP5 ----

// ---- adapters (single signature; owners: postgres body WP4, garage body WP5, compute/manageddb bodies WP2+WP3+WP4 by marked lines) ----
export interface PgTarget { container: string; network: string; dataDir: string }
export interface DatabaseAdapter {
  /** Fresh instance (initdb) on an EMPTY dataDir; returns the container-host URL with a freshly minted password. */
  provision(t: PgTarget, opts?: { publishLoopback?: boolean; limits?: ServiceLimits }): Promise<{ url: string }>
  /** File-level fork: a reflink copy of a source AT REST, else pg_basebackup (a running source, or no reflinks; it wakes a sleeping source through ensureSourceRunning). Returns the clone's URL (source password preserved). */
  fork(src: PgTarget & { url: string }, dst: PgTarget, opts?: { publishLoopback?: boolean; limits?: ServiceLimits; ensureSourceRunning?: () => Promise<void> }): Promise<{ url: string; method: 'reflink' | 'basebackup'; ms: number }>
  query(container: string, sql: string): Promise<string>
  /** Container only (rm -f -v); the engine removes the directory. */
  destroy(container: string): Promise<void>
  rename?(container: string, to: string): Promise<void>
}

export interface ComputeAdapter {
  supportsVolumes?: boolean
  deploy(ref: string, opts: {
    image: string; port: number; envVars: Record<string, string>; network?: string; group: string; start?: boolean
    hostPort?: number                 // LOCAL mode only: publish 127.0.0.1:<hostPort>:<port>; undefined = publish nothing
    hostAliases?: string[]            // each becomes --add-host <name>:host-gateway
    volume?: { hostPath: string }     // WP4: `--mount type=bind,src=<hostPath>,dst=/data` (decision 56); scaffold interim: a docker named-volume name mounted with `-v <name>:/data`
    limits?: ServiceLimits            // --cpus / --memory / --memory-swap
  }): Promise<{ url: string }>        // informational; the engine records the router URL. The container is created with `--init` (decision 60).
  destroy(ref: string): Promise<void>
  start?(ref: string, group: string): Promise<void>
  stop?(ref: string, group: string, opts?: { graceSec?: number }): Promise<void>
  suspend?(ref: string, group: string): Promise<void>
  // ---- region WP3 (scheduler): there is no `state?` any more (decision 53). `Runtime.containers()`
  // is the single docker read and `Engine.liveState` maps `scheduler.stateOf`, so an adapter can no
  // longer answer with a second, disagreeing opinion of what is running. ----
  // ---- end region WP3 ----
  rename?(ref: string, from: string, to: string): Promise<void>
}

export interface ManagedDbTarget { container: string; network: string; type: ManagedDbType; name: string; password: string; dataDir: string }
export interface ManagedDbAdapter {
  provision(t: ManagedDbTarget, opts?: { publishLoopback?: boolean; limits?: ServiceLimits }): Promise<void>
  destroy(container: string): Promise<void>
  rename(container: string, to: string): Promise<void>
  /** Run one client command inside the managed container (valkey-cli for redis) and return its
   *  output. Optional like the storage adapter's object methods: absent, the data browser answers
   *  "not supported" instead of failing deep inside an exec. */
  command?(container: string, password: string, args: string[]): Promise<string>
}

export type ObjectListing = { objects: Array<{ key: string; size: number; lastModified: string; etag: string }>; nextCursor?: string }
export interface StorageAdapter {
  provision(ref: string, network: string, name: string): Promise<{ bucket: string; env: Record<string, string> }>
  cloneInto(srcBucket: string, dstBucket: string, network: string): Promise<void>
  destroy(bucket: string, network: string): Promise<void>
  /** Release whatever the PROVIDER attached to a branch network (the shared object store is one
   *  container for the whole box), once the last bucket on that network is gone. */
  detachFrom?(network: string): Promise<void>
  setAccess?(bucket: string, network: string, isPublic: boolean): Promise<void>
  listBucketObjects?(env: Record<string, string>, opts: { prefix?: string; cursor?: string; limit: number }): Promise<ObjectListing>
  presignObjectGet?(env: Record<string, string>, key: string, disposition: 'attachment' | 'inline'): Promise<{ url: string; expiresAt: string }>
  presignObjectPost?(env: Record<string, string>, key: string, contentType: string, size: number): Promise<{ url: string; fields: Record<string, string>; expiresAt: string }>
  removeObject?(env: Record<string, string>, key: string): Promise<void>
  removeObjects?(env: Record<string, string>, keys: string[]): Promise<{ deleted: number; failed: Array<{ key: string; message: string }> }>
}

// ---- region WP4 (data dir) ----
/** Every method runs in-process first and falls back to the helper container (`fsclone.cjs` verbs probe | clone | rm | stat | isempty) on EACCES|EPERM on Linux: a PGDATA chowned 0700 to the image's postgres uid is unreadable to an unprivileged daemon, so `hasPgData`/`isEmptyOrMissing` need the helper exactly like `clonePostgres`/`remove`. On darwin the copy engine is `/bin/cp -c -a` (decision 23). `probe()` throws only when the data dir itself is unwritable; a failed clone attempt of any kind yields `reflink: false` plus `warning` (decision 23). */
export interface DataDirOps {
  probe(): Promise<{ dataDir: string; reflink: boolean; engine: 'inprocess' | 'helper' | 'cp-c'; warning?: string }>
  ensureDir(path: string, mode: number): Promise<void>
  clonePostgres(src: string, dst: string): Promise<{ method: 'reflink'; ms: number }>   // throws NoReflinkError
  cloneTree(src: string, dst: string): Promise<{ method: 'reflink' | 'copy'; ms: number }>
  remove(path: string): Promise<void>
  /** Atomic promotion inside the data dir: what makes a staged copy visible in ONE step, so a
   *  destination directory exists only when the copy that filled it finished (boot migration). */
  rename(src: string, dst: string): Promise<void>
  copyFromContainerVolume(source: { container?: string; volume?: string }, containerPath: string, dst: string): Promise<void>
  hasPgData(dir: string): Promise<boolean>        // helper fallback on EACCES (verb `stat`)
  isEmptyOrMissing(dir: string): Promise<boolean> // helper fallback on EACCES (verb `isempty`)
}
export class NoReflinkError extends Error {}
// ---- end region WP4 ----

// ---- region WP1 (identity/config) ----
// ---- end region WP1 ----
