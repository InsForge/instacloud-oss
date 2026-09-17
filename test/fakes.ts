// Fake adapters + engine factory shared by every fake-adapter suite (contract 00 section 6). Every
// fake records the same strings it recorded inside test/server.test.ts before the extraction, keyed
// by the HANDLE the engine now passes (container / bucket) instead of the ref, so the existing
// assertions moved only where the contract lists them. Each WP appends recorders in its region.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseAdapter, ComputeAdapter, StorageAdapter, ManagedDbAdapter, DataDirOps, ServiceKey, ServiceLimits } from '../src/types'
import type { Config } from '../src/config'
import { loadConfig } from '../src/config'
import { Engine, type EngineOptions } from '../src/engine'
import { initStatePath } from '../src/state'
// ---- region WP2 (router) ----
import type { Resolver } from '../src/router/domains'
// ---- end region WP2 ----
// ---- region WP3 (scheduler) ----
import { appContainerName } from '../src/manageddb'
import type { ContainerState, Runtime, ServiceTarget } from '../src/scheduler'
import type { UpstreamAddr, UpstreamLike } from '../src/upstream'
// ---- end region WP3 ----

export const calls: string[] = []

// The fake DSN is the contract §6 container-host form (what WP2's laneAddress rewrites host:port
// of and WP5's credentials bundle reads); a fork keeps the source's password, host swapped.
export const db: DatabaseAdapter = {
  provision: async (t) => { calls.push(`db.provision:${t.container}`); runtime.put(t.container, 'running'); return { url: `postgres://postgres:pw@${t.container}:5432/app` } },
  fork: async (src, dst) => { calls.push(`db.fork:${src.container}->${dst.container}`); runtime.put(dst.container, 'running'); return { url: src.url.replace(src.container, dst.container), method: 'reflink', ms: 1 } },
  // Answers the observability SQL with canned JSON (order matters: metrics SQL also mentions pg_stat_activity).
  query: async (_container, sql) => {
    calls.push(`db.query:${sql.split(/\s+/).slice(0, 3).join(' ')}`)
    if (sql.includes('drop database "ghost"')) throw new Error('database "ghost" does not exist')
    if (sql.includes('pg_ls_waldir')) return JSON.stringify({
      sizes: { databaseBytes: 9000, tablesBytes: 5000, indexesBytes: 2000, walBytes: 100 },
      tables: [{ name: 'users', liveRows: 10, dataBytes: 4096, indexBytes: 1024, seqScans: 5, idxScans: 7 }],
      vacuum: { totalDeadRows: 2, tables: [{ name: 'users', deadRows: 2, deadPct: 16.7, lastVacuum: null, xidAge: 55 }] },
      unusedIndexes: [{ name: 'idx_dead', table: 'users', sizeBytes: 512, scans: 0 }],
    })
    if (sql.includes('pg_available_extensions')) return JSON.stringify({
      available: [{ name: 'pg_stat_statements' }, { name: 'plpgsql' }, { name: 'vector' }],
      enabled: ['pg_stat_statements', 'plpgsql'],
    })
    if (sql.includes('not datistemplate')) return JSON.stringify([{ name: 'app' }, { name: 'postgres' }])
    // The ad-hoc query route's wrap (before the metrics SQL's bare row_to_json below).
    if (sql.includes('json_agg(row_to_json')) return JSON.stringify([{ one: 1, two: 'b' }])
    if (sql.includes('row_to_json')) return JSON.stringify({ total: 3, active: 1, idle: 2, max: 100, db_size_bytes: 123456, deadlocks: 0, inserted: 10, updated: 5, deleted: 1, blks_hit: 90, blks_read: 10 })
    if (sql.includes('pg_stat_statements')) return JSON.stringify([{ queryId: 'q1', query: 'select 1', calls: 3, totalMs: 9, meanMs: 3, rows: 3 }])
    if (sql.includes('pg_stat_activity')) return JSON.stringify([{ pid: 42, state: 'active', durationMs: 12.5, query: 'select 1' }])
    return ''
  },
  destroy: async (container) => { calls.push(`db.destroy:${container}`); runtime.drop(container) },
  rename: async (container, to) => { calls.push(`db.rename:${container}->${to}`); runtime.move(container, to) },
}

export const compute: ComputeAdapter = {
  supportsVolumes: true,
  deploy: async (ref, o) => {
    calls.push(`deploy:${ref}:${o.group}:${o.image}:s3=${o.envVars.BUCKET_NAME ?? 'none'}:p=${o.port}->${o.hostPort}`)
    // Recorded separately, and only when explicitly false, so the deploy line above stays the exact
    // string the older assertions match.
    if (o.start === false) calls.push(`deploy.nostart:${ref}:${o.group}`)
    if (o.volume) calls.push(`deploy.volume:${ref}:${o.group}:${o.volume.hostPath}`)
    if (o.hostAliases?.length) calls.push(`deploy.aliases:${ref}:${o.group}:${o.hostAliases.join(',')}`)
    if (o.limits) calls.push(`deploy.limits:${ref}:${o.group}:${o.limits.cpu}/${o.limits.memoryMb}`)
    // WP3 (decision 53): the adapter moves the ONE fake container store, so liveState, the services
    // `runtime` column and the scheduler all read the same truth. A deploy replaces the container.
    runtime.put(appContainerName(ref, o.group), o.start === false ? 'created' : 'running')
    return { url: `http://localhost:${o.hostPort}` }
  },
  destroy: async (ref) => { calls.push(`compute.destroy:${ref}`); runtime.dropPrefix(`io-${ref}-app-`) },
  start: async (ref, group) => { calls.push(`compute.start:${ref}:${group}`); runtime.put(appContainerName(ref, group), 'running') },
  // The grace lands on its OWN line, so today's `compute.stop:<ref>:<group>` strings still match
  // byte for byte now that the engine passes one on every lifecycle stop.
  stop: async (ref, group, opts) => {
    calls.push(`compute.stop:${ref}:${group}`)
    if (opts?.graceSec !== undefined) calls.push(`compute.stop.grace:${ref}:${group}:${opts.graceSec}`)
    runtime.put(appContainerName(ref, group), 'exited')
  },
  // Real docker, measured on 25.0.14: `docker pause` on an ALREADY-PAUSED container exits 1,
  // while `docker stop` on an exited one exits 0. That asymmetry is why a duplicate re-assert of
  // a standing intent broke only the suspended arm, and a fake that pauses twice happily is a
  // fake that hides it.
  suspend: async (ref, group) => {
    const c = appContainerName(ref, group)
    if (runtime.stateOfContainer(c) === 'paused') {
      throw new Error(`Error response from daemon: Container ${c} is already paused`)
    }
    calls.push(`compute.suspend:${ref}:${group}`)
    runtime.put(c, 'paused')
  },
  rename: async (ref, from_, to) => { calls.push(`compute.rename:${ref}:${from_}->${to}`); runtime.move(appContainerName(ref, from_), appContainerName(ref, to)) },
}

export const storage: StorageAdapter = {
  // The bucket HANDLE is `io-<ref>-<name>` (what cloneInto/destroy/setAccess receive) and, as in the
  // real adapter, the env's BUCKET_NAME is that same bucket (contract §6).
  provision: async (ref, _network, name) => { const bucket = `io-${ref}-${name}`; calls.push(`st.provision:${ref}:${name}`); return { bucket, env: { BUCKET_NAME: bucket, AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's', AWS_ENDPOINT_URL_S3: 'http://io-garage:3900', AWS_REGION: 'local' } } },
  cloneInto: async (srcBucket, dstBucket) => { calls.push(`st.clone:${srcBucket}->${dstBucket}`) },
  destroy: async (bucket) => { calls.push(`st.destroy:${bucket}`) },
  detachFrom: async (network) => { calls.push(`st.detach:${network}`) },
  setAccess: async (bucket, _network, isPublic) => { calls.push(`st.access:${bucket}:${isPublic}`) },
  listBucketObjects: async (env, o) => {
    calls.push(`st.list:${env.BUCKET_NAME}:prefix=${o.prefix ?? ''}:limit=${o.limit}`)
    return { objects: [{ key: 'a.txt', size: 3, lastModified: '2026-08-18T00:00:00Z', etag: '"x"' }], ...(o.cursor ? {} : { nextCursor: 'page2' }) }
  },
  presignObjectGet: async (env, key, disposition) => {
    calls.push(`st.presignGet:${env.BUCKET_NAME}:${key}:${disposition}`)
    return { url: `http://127.0.0.1:3900/${env.BUCKET_NAME}/${key}?sig`, expiresAt: '2026-08-18T00:01:00Z' }
  },
  presignObjectPost: async (env, key, contentType, size) => {
    calls.push(`st.presignPost:${env.BUCKET_NAME}:${key}:${contentType}:${size}`)
    return { url: `http://127.0.0.1:3900/${env.BUCKET_NAME}`, fields: { key, policy: 'p' }, expiresAt: '2026-08-18T00:05:00Z' }
  },
  removeObject: async (env, key) => { calls.push(`st.rm:${env.BUCKET_NAME}:${key}`) },
  removeObjects: async (env, keys) => { calls.push(`st.rmN:${env.BUCKET_NAME}:${keys.join(',')}`); return { deleted: keys.length, failed: [] } },
}

export const managed: ManagedDbAdapter = {
  provision: async (t) => { calls.push(`md.provision:${t.container}`); runtime.put(t.container, 'running') },
  destroy: async (container) => { calls.push(`md.destroy:${container}`); runtime.drop(container) },
  rename: async (container, to) => { calls.push(`md.rename:${container}->${to}`); runtime.move(container, to) },
  // Canned valkey-cli answers for the key-browser routes; the password never rides argv, so the
  // recorded call carries container + args only.
  command: async (container, _password, args) => {
    calls.push(`md.cmd:${container}:${args.join(' ')}`)
    const joined = args.join(' ')
    if (joined.includes('SCAN')) return '["0",["user:1","user:2"]]'
    if (joined.includes('INFO keyspace')) return '# Keyspace\ndb0:keys=2,expires=0,avg_ttl=0'
    if (joined === 'INFO') {
      return ['# Server', 'valkey_version:7.2.14', 'uptime_in_seconds:120', '# Clients', 'connected_clients:2',
        '# Memory', 'used_memory:1048576', 'maxmemory:0', '# Stats', 'total_commands_processed:42',
        'instantaneous_ops_per_sec:1', 'keyspace_hits:9', 'keyspace_misses:1', 'expired_keys:0', 'evicted_keys:0'].join('\n')
    }
    if (joined.includes('TYPE')) return '"string"'
    if (joined.includes('TTL')) return '-1'
    if (joined.includes('HGETALL')) return '{"token":"abc"}'
    if (joined.includes('GET')) return '"{\\"name\\":\\"ada\\"}"'
    return ''
  },
}

export const data: DataDirOps = {
  probe: async () => ({ dataDir: '/tmp/fake', reflink: true, engine: 'inprocess' }),
  ensureDir: async (path) => { calls.push(`data.ensure:${path}`) },
  clonePostgres: async (src, dst) => { calls.push(`data.clone:${src}->${dst}`); return { method: 'reflink', ms: 1 } },
  cloneTree: async (src, dst) => { calls.push(`data.cloneTree:${src}->${dst}`); return { method: 'reflink', ms: 1 } },
  remove: async (path) => { calls.push(`data.remove:${path}`) },
  rename: async (src, dst) => { calls.push(`data.rename:${src}->${dst}`) },
  copyFromContainerVolume: async (source, containerPath, dst) => { calls.push(`data.copyFrom:${source.container ?? source.volume}:${containerPath}->${dst}`) },
  hasPgData: async () => true,
  isEmptyOrMissing: async () => true,
}

/** A fresh local-mode Config on its own tmp data dir (scheduler ticker off). */
export function testConfig(over: Record<string, string> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'io-cfg-'))
  // INSTA_OSS_ALWAYS_ON_DEFAULT is pinned OFF: the suites exercise sleep, eviction and wake, which
  // only happen to a service that is allowed to sleep. The always-on default has tests of its own.
  return loadConfig({ INSTA_OSS_MODE: 'local', INSTA_OSS_DATA_DIR: dir, INSTA_OSS_STATE: join(dir, 'state.json'), INSTA_OSS_SCHEDULER: '0', INSTA_OSS_ALWAYS_ON_DEFAULT: '0', ...over }, [])
}

/** Server-mode twin: example.test, auth on, a fixed secret (no file I/O). */
export function serverConfig(over: Record<string, string> = {}): Config {
  return testConfig({ INSTA_OSS_MODE: 'server', INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_SECRET: 's'.repeat(32), INSTA_OSS_AUTH: '1', ...over })
}

/** An Engine over the fakes; points the state module at cfg.statePath first. The engine builds its
 *  own (unstarted) Scheduler over the shared FakeRuntime and FakeUpstream, so the routes and the
 *  scheduler read ONE container store (decisions 53 and 57). */
export function makeEngine(cfg: Config = testConfig(), extra: Partial<EngineOptions> = {}): Engine {
  initStatePath(cfg.statePath)
  return new Engine(db, compute, storage, managed, { cfg, data, upstream, runtime, resolver, ...extra })
}

/** Clear the recorder and start from an empty state file. */
export function resetFakes(): void {
  calls.length = 0
  runtime.reset()
  upstream.reset()
  dnsRecords.clear()
  initStatePath(join(mkdtempSync(join(tmpdir(), 'io-')), 'state.json'))
}

// ---- region WP1 (identity/config) ----
// ---- end region WP1 ----
// ---- region WP2 (router) ----
// DNS for the four custom-domain routes. No fake-adapter test may reach a real nameserver: it
// makes the suite depend on the box's egress and on how fast a public resolver says NXDOMAIN, and
// `insta compute domains` fans one lookup out per attached name. An empty map answers ENOTFOUND
// (which `checkDns` reads as `missing`); a test that wants a name to resolve sets it here.
export const dnsRecords = new Map<string, { a?: string[]; cname?: string[] }>()

const notFound = (host: string): never => {
  throw Object.assign(new Error(`queryA ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
}
export const resolver: Resolver = {
  resolve4: async (host) => dnsRecords.get(host)?.a ?? notFound(host),
  resolveCname: async (host) => dnsRecords.get(host)?.cname ?? notFound(host),
}
// ---- end region WP2 ----
// ---- region WP3 (scheduler) ----
// FakeRuntime is THE fake container store (decision 53): the four adapters above move it, the
// engine's `liveState`, `runtime` column and runtime-health read it through `scheduler.stateOf`,
// and the scheduler's own sweep, wake and sleep act on it. Two module-level singletons, cleared by
// `resetFakes`, because the adapters that move them are module-level too. The store field is
// `store`, not `containers`: the `Runtime` interface needs that name for its one docker read.
export class FakeRuntime implements Runtime {
  store = new Map<string, { state: ContainerState; id: string }>()
  /** RSS bytes per container: the eviction tie-break and a wake's room estimate. */
  rss = new Map<string, number>()
  /** null = this box cannot report memory, which disables eviction entirely. */
  mem: { availableBytes: number; totalBytes: number } | null = null
  /** Readiness. The default answers for a running container; a test can refuse or delay. */
  probeFn: (t: ServiceTarget) => boolean | Promise<boolean> = (t) => this.store.get(t.container)?.state === 'running'
  private seq = 0

  put(name: string, state: ContainerState): void {
    this.store.set(name, { state, id: this.store.get(name)?.id ?? `cid${++this.seq}` })
  }
  /** A restart under our feet: same name, a new id (what `forgetIfChanged` is for). */
  replace(name: string, state: ContainerState): void { this.store.set(name, { state, id: `cid${++this.seq}` }) }
  drop(name: string): void { this.store.delete(name) }
  dropPrefix(prefix: string): void { for (const k of [...this.store.keys()]) if (k.startsWith(prefix)) this.store.delete(k) }
  move(from: string, to: string): void {
    const c = this.store.get(from)
    if (c) { this.store.set(to, c); this.store.delete(from) }
  }
  stateOfContainer(name: string): ContainerState | undefined { return this.store.get(name)?.state }
  reset(): void {
    this.store.clear(); this.rss.clear(); this.mem = null
    this.probeFn = (t) => this.store.get(t.container)?.state === 'running'
  }

  async containers(): Promise<Map<string, { state: ContainerState; id: string }>> { return new Map(this.store) }
  async stats(): Promise<Map<string, number>> { return new Map(this.rss) }
  memory(): { availableBytes: number; totalBytes: number } | null { return this.mem }
  async start(container: string): Promise<void> { calls.push(`runtime.start:${container}`); this.put(container, 'running') }
  async stop(container: string, graceSec: number): Promise<void> { calls.push(`runtime.stop:${container}:${graceSec}`); this.put(container, 'exited') }
  async unpause(container: string): Promise<void> { calls.push(`runtime.unpause:${container}`); this.put(container, 'running') }
  async update(container: string, limits: ServiceLimits): Promise<void> {
    calls.push(`runtime.update:${container}:${limits.cpu}/${limits.memoryMb}`)
    if (!this.store.has(container)) throw new Error(`No such container: ${container}`)
  }
  async probe(t: ServiceTarget): Promise<boolean> { return this.probeFn(t) }
}

/** The upstream twin: an address exists exactly while the container runs. */
export class FakeUpstream implements UpstreamLike {
  addrs = new Map<string, { host: string; port: number }>()
  constructor(private rt: FakeRuntime) {}
  async resolve(container: string, _network: string, port: number): Promise<UpstreamAddr | null> {
    const live = this.rt.store.get(container)
    if (live?.state !== 'running') return null
    const a = this.addrs.get(container) ?? { host: '127.0.0.1', port }
    return { host: a.host, port: a.port, containerId: live.id, startedAt: '' }
  }
  forget(container: string): void { calls.push(`upstream.forget:${container}`) }
  forgetIfChanged(container: string, containerId: string): void { calls.push(`upstream.checked:${container}:${containerId}`) }
  async dial(container: string, network: string, port: number): Promise<boolean> { return (await this.resolve(container, network, port)) !== null }
  reset(): void { this.addrs.clear() }
}

export const runtime = new FakeRuntime()
export const upstream = new FakeUpstream(runtime)

/** One ServiceTarget for test/scheduler.test.ts, which drives the Scheduler directly. */
export function fakeTarget(over: Partial<ServiceTarget> & { key: ServiceKey }): ServiceTarget {
  const serviceId = over.serviceId ?? over.key.slice(over.key.indexOf(':') + 1)
  return {
    kind: 'compute', container: `io-demo-main-app-${serviceId.replace(/^cp-/, '')}`, network: 'io-demo-main', port: 8080,
    projectId: 'p1', branchId: over.key.slice(0, over.key.indexOf(':')), serviceId,
    alwaysOn: false, desiredState: 'running', idleSec: 300, sleptAt: null, createdAt: 0,
    ...over,
  }
}
// ---- end region WP3 ----
// ---- region WP4 (data dir) ----
// ---- end region WP4 ----
// ---- region WP5 (templates/parity) ----
// No new fake: WP5 drives the SAME four adapters, once per registered service instead of once per
// branch, so `db.provision:<container>` / `st.provision:<ref>:<name>` / `st.access:<bucket>:<bool>`
// above already record every call it makes. The template catalog reads the real `templates/`
// directory and the executor's health probe is injected per test (test/templates.test.ts).
// ---- end region WP5 ----
