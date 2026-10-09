// Single-tenant state: one JSON file (<dataDir>/state.json; main.ts calls initStatePath(cfg.statePath),
// INSTA_OSS_STATE stays the fallback for processes that never do). Contract 00 section 5:
//   - every write is tmp + rename (a crash never leaves a half-written state.json);
//   - reads go through a stat-keyed parse cache, so loadState() is one statSync plus a clone and
//     stateRev() is one statSync and NO clone (the router keys its table cache on it);
//   - two write classes: routing (default, bumps `rev`) and audit (`{ audit: true }`, bumps
//     `auditRev` only: emit, touchLater, markSlept; the router never rebuilds for those);
//   - `events` is trimmed to the newest EVENTS_CAP rows on every save;
//   - one daemon per data dir: <dataDir>/instad.lock with a 20 s heartbeat, stale at 60 s, and a
//     fresh lock retried for up to 60 s (the container-restart case: the previous instad was
//     SIGKILLed and its heartbeat is still under 60 s old);
//   - touchLater() coalesces low-rate audit fields (token lastUsedAt, session slide) into one
//     write every 30 s; releaseLock() and initStatePath() flush it.
// Activity stamps, in-flight markers, RSS samples, rate-limiter buckets and wake singleflight maps
// never touch this file.
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Project, Branch, Approval, AuditEvent, GatedAction, Decision, UserSecret, CustomDomainEntry, TemplateDeploymentRecord } from './types'
import type { GitBindingRecord } from './gitdeploy'

// ---- region WP1 (identity/config) ----
export interface IdentityState {
  admin: { id: string; email: string; name: string; passwordHash: string; createdAt: string; updatedAt: string } | null
  previousAdminId?: string
  sessions: Array<{ id: string; tokenHash: string; userId: string; createdAt: string; updatedAt: string; expiresAt: string; ipAddress: string; userAgent: string }>
  tokens: Array<{ id: string; name: string; prefix: 'insta_'; keyHash: string; orgId: null; scopes: string[]; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string }>
}
export const EMPTY_IDENTITY: IdentityState = { admin: null, sessions: [], tokens: [] }
// ---- end region WP1 ----

export interface State {
  projects: Record<string, Project>
  branches: Record<string, Branch> // keyed by branch id
  policies: Record<string, Partial<Record<GatedAction, Decision>>> // per project
  approvals: Approval[]
  events: AuditEvent[]
  userSecrets: Record<string, UserSecret[]> // per project id
  identity?: IdentityState                                   // WP1: absent in local mode and before setup
  rev: number                                                // WP2: bumped by every ROUTING-class saveState (router table cache key; decision 54)
  auditRev: number                                           // WP1: bumped by audit-class writes (emit, touchLater, markSlept); the router ignores it
  // ---- region WP2 (router) ----
  customDomains: Record<string, CustomDomainEntry>           // key = normalized hostname
  laneReservations?: Record<string, string>                  // lane port -> branchId, written synchronously by allocLanes before provisioning awaits; released by compensation, superseded by branch.lanes (decision 51)
  hostReservations?: Record<string, string>                  // minted hostname LABEL -> owning operation, written synchronously by reserveHosts before the first await; released by compensation, superseded by the row that records the host (decision 51)
  branchReservations?: Record<string, string>                // branch REF -> owning branchId, written synchronously by reserveBranchRef before provisionBranch's first await; released by compensation, superseded by the branch row (decision 51)
  // ---- end region WP2 ----
  // ---- region WP5 (templates/parity) ----
  templateDeployments: Record<string, TemplateDeploymentRecord>
  // ---- end region WP5 ----
  // Git push-to-deploy bindings (server mode), keyed by binding id so the webhook resolves in one lookup.
  gitBindings?: Record<string, GitBindingRecord>
}

/** saveState keeps the newest EVENTS_CAP events (decision 54). */
export const EVENTS_CAP = 5000
/** touchLater() flushes its buffer at this cadence (unref'd, so it never holds the process open). */
export const TOUCH_FLUSH_MS = 30_000

type SaveKind = 'routing' | 'audit'
type StatKey = { ino: number; mtimeMs: number; size: number }

const EMPTY: State = { projects: {}, branches: {}, policies: {}, approvals: [], events: [], userSecrets: {}, rev: 0, auditRev: 0, customDomains: {}, templateDeployments: {} }

let statePathOverride: string | null = null
const subscribers: Array<(s: State, kind: SaveKind) => void> = []
/** The parsed document for `path` as of `key`. Callers get clones (loadState) or scalars (stateRev), never this object. */
let cache: { path: string; key: StatKey; doc: State } | null = null
let tmpSeq = 0

/** main.ts, --reset-admin, and test/fakes.ts resetFakes()/makeEngine() call it before the first loadState; INSTA_OSS_STATE env stays the fallback. Pending touchLater writes belong to the previous file and are flushed there first. */
export function initStatePath(p: string): void {
  if (statePathOverride === p) return
  try { flushTouchLater() } catch { /* the previous file's directory is gone; those audit fields are lost with it */ }
  statePathOverride = p
  cache = null
}
export function statePath(): string { return statePathOverride ?? process.env.INSTA_OSS_STATE ?? join(homedir(), '.insta-oss', 'state.json') }

function statKey(p: string): StatKey | null {
  try { const st = statSync(p); return { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size } }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
const sameKey = (a: StatKey, b: StatKey): boolean => a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size

/** What a fresh read of the file yields: parsed JSON over the empty shape, then migrateState (WP5). */
function parseDoc(json: string): State {
  return migrateState({ ...structuredClone(EMPTY), ...(JSON.parse(json) as Partial<State>) })
}

/** The cached document for the current path, re-parsed when the file changed on disk; null when there is no file yet. */
function current(): State | null {
  const p = statePath()
  const key = statKey(p)
  if (!key) { cache = null; return null }
  if (cache && cache.path === p && sameKey(cache.key, key)) return cache.doc
  const doc = parseDoc(readFileSync(p, 'utf8'))
  cache = { path: p, key, doc }
  return doc
}

/** A clone of the current state (stat-keyed parse cache underneath). Never on the router's request path: it uses stateRev() plus Route fields. */
export function loadState(): State { return structuredClone(current() ?? EMPTY) }

/** Current routing rev WITHOUT cloning (one statSync on a cache hit); the router's table cache key. */
export function stateRev(): number { return current()?.rev ?? 0 }

/** Called after every saveState with the saved document and its class; the router subscribes to rebuild its table on 'routing' saves. */
export function onSave(cb: (s: State, kind: SaveKind) => void): void { subscribers.push(cb) }

/** state.json holds every credential the daemon minted: the Postgres and managed-database
 *  passwords in their DSNs, the Garage access keys, and every secret an operator set. It is written
 *  0600, like `config.ts` writes the session secret, rather than left at the default 0644 inside a
 *  directory whose mode is the only thing protecting it (and which is not 0700 when
 *  INSTA_OSS_STATE points somewhere the daemon had to create). The tmp file carries the same bytes,
 *  so it is created with the same mode and the rename keeps it. */
export const STATE_FILE_MODE = 0o600

/** tmp + rename; bumps rev (default) or auditRev (`{ audit: true }`); trims events to EVENTS_CAP; refreshes the parse cache; notifies subscribers. */
export function saveState(s: State, opts: { audit?: boolean } = {}): void {
  const kind: SaveKind = opts.audit ? 'audit' : 'routing'
  if (opts.audit) s.auditRev = (s.auditRev ?? 0) + 1
  else s.rev = (s.rev ?? 0) + 1
  if (Array.isArray(s.events) && s.events.length > EVENTS_CAP) s.events = s.events.slice(-EVENTS_CAP)
  const p = statePath()
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  const json = JSON.stringify(s, null, 2)
  const tmp = `${p}.tmp-${process.pid}-${++tmpSeq}`
  writeFileSync(tmp, json, { mode: STATE_FILE_MODE })
  // writeFileSync applies `mode` only when it CREATES the file, and a tmp name is fresh every
  // time, so this also repairs a state.json an older build left at 0644.
  chmodSync(tmp, STATE_FILE_MODE)
  renameSync(tmp, p)
  const key = statKey(p)
  cache = key ? { path: p, key, doc: parseDoc(json) } : null
  for (const cb of subscribers) cb(s, kind)
}

const isThenable = (v: unknown): boolean => v !== null && typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function'

/** Read-modify-write helper so callers never hold stale copies. Callbacks are synchronous: an async callback throws BEFORE anything is written. */
export function mutate<T>(fn: (s: State) => T, opts: { audit?: boolean } = {}): T {
  const s = loadState()
  const out = fn(s)
  if (isThenable(out)) throw new Error('mutate() callbacks must be synchronous: read state, decide, write; await outside')
  saveState(s, opts)
  return out
}

// ---- process lock: one instad per data dir ----

export interface LockOptions {
  staleMs?: number      // a heartbeat older than this is a dead holder (default 60 s)
  retryMs?: number      // wait between attempts on a fresh lock (default 2 s)
  timeoutMs?: number    // give up on a fresh lock after this long (default 60 s; 0 = one attempt)
  heartbeatMs?: number  // utimes cadence once held (default 20 s; 0 = none)
  sleep?: (ms: number) => void   // tests inject; the default blocks the thread (boot is synchronous here)
}

let held: { path: string; bootId: string; timer: NodeJS.Timeout | null } | null = null

function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readHolder(lockPath: string): { pid?: number; bootId?: string; startedAt?: string; host?: string } {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; bootId?: string; startedAt?: string; host?: string } }
  catch { return {} }
}

/** <dataDir>/instad.lock: created with O_EXCL and heartbeat-touched every 20 s. A lock whose heartbeat is older than 60 s is taken over; a fresh one is retried every 2 s for up to 60 s (the previous container was SIGKILLed and its heartbeat has not aged out yet) before throwing with the holder's pid. Throws immediately when this process already holds a lock. */
export function acquireLock(dataDir: string, opts: LockOptions = {}): void {
  const staleMs = opts.staleMs ?? 60_000
  const retryMs = opts.retryMs ?? 2_000
  const timeoutMs = opts.timeoutMs ?? 60_000
  const heartbeatMs = opts.heartbeatMs ?? 20_000
  const sleep = opts.sleep ?? sleepSync
  const lockPath = join(dataDir, 'instad.lock')
  if (held) throw new Error(`lock already held by this process (${held.path})`)
  mkdirSync(dataDir, { recursive: true })
  const bootId = randomUUID()
  const body = JSON.stringify({ pid: process.pid, bootId, startedAt: new Date().toISOString(), host: hostname() })
  const deadline = Date.now() + timeoutMs
  let staleTakeovers = 0
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try { writeSync(fd, body) } finally { closeSync(fd) }
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const key = statKey(lockPath)
    if (key === null) continue // vanished between the open and the stat: the holder just released it
    if (Date.now() - key.mtimeMs > staleMs) {
      try { unlinkSync(lockPath) } catch { /* someone else removed it first */ }
      if (++staleTakeovers <= 1) continue
    }
    if (Date.now() >= deadline) {
      const h = readHolder(lockPath)
      throw new Error(`another instad (pid ${h.pid ?? 'unknown'}, started ${h.startedAt ?? 'unknown'}) holds ${dataDir}; stop it or point INSTA_OSS_DATA_DIR elsewhere`)
    }
    sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())))
  }
  let timer: NodeJS.Timeout | null = null
  if (heartbeatMs > 0) {
    timer = setInterval(() => {
      const now = new Date()
      try { utimesSync(lockPath, now, now) } catch { /* the data dir is gone; nothing to heartbeat */ }
    }, heartbeatMs)
    timer.unref()
  }
  held = { path: lockPath, bootId, timer }
}

/** Stop the heartbeat, flush touchLater, and remove the lock only if it still carries our bootId. Safe to call twice and without a lock (it still flushes). */
export function releaseLock(): void {
  try { flushTouchLater() } catch { /* best effort at exit */ }
  const h = held
  if (!h) return
  held = null
  if (h.timer) clearInterval(h.timer)
  try { if (readHolder(h.path).bootId === h.bootId) unlinkSync(h.path) }
  catch { /* already gone */ }
}

// ---- coalesced audit writes ----

const touchBuffer: Array<(s: State) => void> = []
let touchTimer: NodeJS.Timeout | null = null

/** Queue a low-rate audit-class edit (token lastUsedAt, session slide). Buffered callbacks run inside ONE mutate(..., { audit: true }) every TOUCH_FLUSH_MS; they must look rows up by id, never through captured references. */
export function touchLater(fn: (s: State) => void): void {
  touchBuffer.push(fn)
  if (!touchTimer) {
    touchTimer = setInterval(flushTouchLater, TOUCH_FLUSH_MS)
    touchTimer.unref()
  }
}

/** Apply every queued touchLater callback now (one audit-class write); no-op when nothing is queued. */
export function flushTouchLater(): void {
  if (touchBuffer.length === 0) return
  const fns = touchBuffer.splice(0)
  mutate((s) => { for (const f of fns) f(s) }, { audit: true })
}

/**
 * Release every reservation whose owner never committed a row (decision 51, boot recovery).
 *
 * The three reservation maps are claims held ACROSS an await by an operation still in flight, and
 * each is released by its own compensation. A daemon killed between the claim and the row that
 * supersedes it leaves the claim behind with no one to release it, and because the claim is what
 * makes a second attempt refuse, every retry of that name then fails as a duplicate forever. The
 * data directory lock means only one daemon runs at a time, so at boot there is BY DEFINITION no
 * operation in flight: any claim still standing is abandoned, and the safe thing is to drop it.
 *
 * Ownership is what decides, not age: a branch claim survives only while its branch row exists,
 * and a lane or host claim only while some branch or service still names that owner. Anything
 * else is the residue of an interrupted create. Returns what it released so boot can say so.
 */
export function reclaimAbandonedReservations(): { branches: string[]; lanes: string[]; hosts: string[] } {
  return mutate((s) => {
    const liveBranch = new Set(Object.keys(s.branches ?? {}))
    const released = { branches: [] as string[], lanes: [] as string[], hosts: [] as string[] }

    for (const [ref, owner] of Object.entries(s.branchReservations ?? {})) {
      if (!liveBranch.has(owner)) { delete s.branchReservations![ref]; released.branches.push(ref) }
    }
    // A live branch is NOT enough for a lane or a host claim. Those are taken per deploy and per
    // service add, so a create interrupted on a branch that already existed leaves a claim whose
    // owning branch is still there: testing the branch alone would keep it forever, which is the
    // same leak one level down. What retires a claim is the row that supersedes it, so look for
    // that row. Repeated interrupted deploys would otherwise eat the lane range.
    const portsInUse = new Set<string>()
    const hostsInUse = new Set<string>()
    for (const b of Object.values(s.branches ?? {})) {
      for (const p of Object.values(b.lanes ?? {})) portsInUse.add(String(p))
      for (const app of Object.values(b.apps ?? {})) {
        if (app.hostPort !== undefined) portsInUse.add(String(app.hostPort))
        if (app.host) hostsInUse.add(app.host)
      }
      for (const d of Object.values(b.databases ?? {})) if (d.host) hostsInUse.add(d.host)
      for (const m of Object.values(b.managed ?? {})) if (m.host) hostsInUse.add(m.host)
    }
    for (const [port, owner] of Object.entries(s.laneReservations ?? {})) {
      if (!liveBranch.has(owner) || !portsInUse.has(port)) { delete s.laneReservations![port]; released.lanes.push(port) }
    }
    // A host claim is owned by a ServiceKey (`<branchId>:<serviceId>`) or by a branchId. The
    // recorded hosts are full names and the claim is the bounded label, so compare on the label.
    for (const [label, owner] of Object.entries(s.hostReservations ?? {})) {
      const owned = liveBranch.has(owner.split(':')[0]!)
        && [...hostsInUse].some((h) => h === label || h.startsWith(`${label}.`))
      if (!owned) { delete s.hostReservations![label]; released.hosts.push(label) }
    }
    return released
  })
}

// ---- region WP5 (templates/parity) ----
/** Present a pre-multi-service document as the registration model, in memory, on every parse
 *  (contract 00 section 5, plan 05 §9). Pure and idempotent: a project with a branch and no
 *  `dbServices` gains the `pg-db` / `st-store` pair, and every branch lacking `databases` /
 *  `buckets` gains the rows derived from its legacy `dbUrl` / `bucket` / `s3` / `storagePublic`
 *  fields. The legacy fields are LEFT in place (an older daemon reading the same file keeps
 *  working) and never read again by this code.
 *
 *  The container name is the legacy `io-<ref>-pg` and the dataId the literal `db` (decision 16):
 *  WP4's boot migration renames the container while moving its bytes, and writes the new handle
 *  onto the row, so nothing here has to guess which side of that migration a branch is on. */
export function migrateState(s: State): State {
  const branchesOf = (projectId: string): Branch[] => Object.values(s.branches).filter((b) => b.projectId === projectId)
  const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)
  for (const project of Object.values(s.projects)) {
    const branches = branchesOf(project.id)
    if (!branches.length) continue
    // Only a LEGACY project is migrated. A project created after WP5 starts empty and stays empty
    // until `services add` registers something: deriving the fixed pair for it would resurrect a
    // postgres and a bucket nobody asked for on the next parse.
    const hadDb = branches.some((b) => b.dbUrl !== undefined)
    const hadBucket = branches.some((b) => b.bucket !== undefined)
    if (!hadDb && !hadBucket) continue
    const def = branches.find((b) => b.isDefault) ?? branches[0]
    if (hadDb && !project.dbServices) {
      project.dbServices = [{ id: 'pg-db', name: 'db', dataId: 'db', createdAt: project.createdAt }]
    }
    if (hadBucket && !project.storageServices) {
      project.storageServices = [{ id: 'st-store', name: 'store', createdAt: project.createdAt, public: def.storagePublic ?? false }]
    }
    for (const b of branches) {
      const ref = b.ref ?? `${project.refSlug ?? slug(project.name)}-${slug(b.name)}`
      if (!b.databases && b.dbUrl !== undefined) {
        b.databases = { 'pg-db': { url: b.dbUrl, container: `io-${ref}-pg`, dataId: 'db' } }
      }
      if (!b.buckets && b.bucket !== undefined) {
        b.buckets = { 'st-store': { bucket: b.bucket, env: b.s3 ?? {}, public: b.storagePublic ?? false } }
      }
    }
  }
  return s
}
// ---- end region WP5 ----
