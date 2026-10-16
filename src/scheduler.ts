// The scheduler: what makes a single node behave like a serverless one (contract 00 sections 8.3
// and 13, plan 03).
//
// Three jobs, one lock. It sleeps idle services (`docker stop` with a grace, never `docker pause`),
// wakes them on the three doors (traffic, api, deploy), and evicts the least recently active
// service when free RAM drops below the floor.
// The lock is `withOp`: exclusive per ServiceKey, taken by EVERY container-mutating path in the
// engine (deploy, restart, lifecycle, branch create, teardown, service add/remove/rename, limits),
// re-entrant inside the acquiring async context, and visible to the sweep so a service with an
// operation in flight is never a sleep candidate (decision 52).
//
// Everything the ledger holds is in memory (decision 10): activity stamps, wake singleflight, RSS
// samples, holds. The only thing that reaches state.json is `sleptAt`, through `hooks.markSlept`,
// so runtime-health can tell standby from crashed after a restart.
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config'
import { dockerCall } from './docker'
import { parseSize } from './observe'
import type { ManagedDbType, ServiceKey, ServiceKind, ServiceLimits } from './types'
import type { UpstreamLike } from './upstream'

/** One schedulable service, projected out of state.json by the engine on every read (contract 8.3). */
export interface ServiceTarget {
  key: ServiceKey
  kind: ServiceKind
  container: string
  network: string
  port: number
  projectId: string
  branchId: string
  serviceId: string
  alwaysOn: boolean
  desiredState: 'running' | 'stopped' | 'suspended'
  idleSec: number
  limits?: ServiceLimits
  managedType?: ManagedDbType
  sleptAt: number | null
  createdAt: number
}

export type ContainerState = 'running' | 'paused' | 'exited' | 'created' | 'restarting' | 'dead'

/** The docker seam. `DockerRuntime` below is production; `FakeRuntime` (test/fakes.ts) is the single
 *  fake state store every fake-adapter suite reads, so the routes and the scheduler agree. */
export interface Runtime {
  /** Every container docker knows, by name (`docker ps -a`); the id feeds `upstream.forgetIfChanged`. */
  containers(): Promise<Map<string, { state: ContainerState; id: string }>>
  /** RSS bytes per container name (`docker stats --no-stream`). */
  stats(): Promise<Map<string, number>>
  /** Host memory, or null when this box cannot report it (macOS without INSTA_OSS_MEM_BUDGET_MB). */
  memory(): { availableBytes: number; totalBytes: number } | null
  start(container: string): Promise<void>
  stop(container: string, graceSec: number): Promise<void>
  unpause(container: string): Promise<void>
  update(container: string, limits: ServiceLimits): Promise<void>
  /** Readiness: postgres answers `pg_isready`, everything else a TCP dial through the upstream. */
  probe(t: ServiceTarget): Promise<boolean>
}

/** Traffic asked for a service the developer stopped: the lanes answer 503 and never wake it. */
export class ServiceStoppedError extends Error { constructor() { super('service is stopped') } }
/** The wake ran out of `INSTA_OSS_WAKE_TIMEOUT_SEC`. Two situations, one class, because the
 *  lanes classify it by class and both are the same answer to a request: `readiness` is the
 *  container started and never became ready, and `waiting` is this CALLER's budget running out
 *  while the wake carries on under the operation lock.
 *
 *  Each says what actually happened, and the waiting one cannot borrow the readiness wording:
 *  a caller can run out queued behind another operation or partway through eviction, before
 *  `wakeLocked` has reached the readiness wait at all, so "did not become ready" would name
 *  something nothing had attempted yet. Its audience is the daemon log and any direct caller:
 *  the lanes rewrite a `timeout` into their own one-line answer, and `insta compute start` is
 *  re-entrant and therefore never bounded, so no operator at a CLI reads this string.
 *
 *  What both must keep is the token `timed out`: `classifyWakeError` matches the CLASS first and
 *  falls back to the text only when it is handed a message rather than an error, and that
 *  fallback keys on those two words. They are the contract between these strings and the lanes,
 *  and `test/router.test.ts` pins it so a future rewording reds there rather than in production. */
export class WakeTimeoutError extends Error {
  constructor(sec: number, phase: 'readiness' | 'waiting' = 'readiness') {
    super(phase === 'waiting'
      ? `this request timed out after ${sec} s waiting for the service to wake, and the wake is still running under its lock: the service may come up shortly`
      : `the wake timed out after ${sec} s: the container started but never became ready`)
  }
}
/** The lock was taken and the container is not there: a deploy is between `rm -f` and `create`, or
 *  the service is gone. Never `docker start` on a name that does not exist. */
export class NoContainerError extends Error {
  constructor() { super('service has no container (deploy in progress or removed)') }
}
/** The key names no service any more (removed while an op or a wake was queued behind it). */
export class NoTargetError extends Error { constructor() { super('service not found') } }

export type SleepReason = 'idle' | 'memory' | 'branch-create'
export type WakeDoor = 'traffic' | 'api' | 'deploy'

export interface SchedulerHooks {
  /** `sleptAt` on the service's row: an audit-class write (decision 54). */
  markSlept(key: ServiceKey, at: number | null): void
  /** One resource event (`service.sleep` / `service.wake`, decision 39). */
  emit(key: ServiceKey, kind: string, payload: Record<string, unknown>): void
  /** True while the boot data migration runs: the sweep stays inert (decision 24). */
  booting?(): boolean
}

const MiB = 1024 * 1024
/** What a wake assumes a service needs when nothing has ever been measured for it. */
const DEFAULT_RSS: Record<ServiceKind, number> = { compute: 256 * MiB, postgres: 128 * MiB, managed: 256 * MiB }
/** A runaway ceiling for the eviction loop, sampled from nothing and high enough that no real
 *  box reaches it: the loop's real terminators are the floor being met and the candidate pool
 *  being empty, and `tried` makes it provably unable to revisit a service. */
/** The floor under `maxStateAgeMs`: with a very short sweep interval an observation would
 *  otherwise be stale before the pass that took it finished. */
const MIN_STATE_AGE_MS = 30_000

export const EVICTION_CEILING = 10_000
/** How many idle services the sweep stops at once. */
const SLEEP_CONCURRENCY = 4
/** Readiness poll interval inside a wake. */
const PROBE_INTERVAL_MS = 250

const sleepFor = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref?.() })

interface LedgerEntry { lastActiveAt: number; wokeAt?: number; lastRssBytes?: number }
interface OpEntry { chain: Promise<unknown>; count: number }

export class Scheduler {
  private ledger = new Map<ServiceKey, LedgerEntry>()
  private ops = new Map<ServiceKey, OpEntry>()
  private owned = new AsyncLocalStorage<Set<ServiceKey>>()
  private wakes = new Map<ServiceKey, Promise<void>>()
  private sleeping = new Set<ServiceKey>()
  private holdCounts = new Map<ServiceKey, number>()
  /** The last `docker ps -a` snapshot, keyed by container name: what `stateOf` answers from.
   *  `at` is WHEN that fact was observed, because a failed read used to be indistinguishable
   *  from a fresh one and the two decisions below act on `running`. */
  private stateCache = new Map<string, { state: ContainerState; id: string; at: number }>()
  /** Whether the last `runtime.containers()` read answered, so a persistent failure is said once
   *  rather than every sweep. */
  private statesReadable = true
  private timer: ReturnType<typeof setInterval> | undefined
  private sweepInFlight: Promise<void> | undefined
  private stopped = false
  private memoryWarned = false
  private evictionLogged = false

  constructor(
    private runtime: Runtime,
    private cfg: Config,
    private targets: () => ServiceTarget[],
    private hooks: SchedulerHooks,
    private upstream: UpstreamLike,
  ) {}

  // ---- ledger -----------------------------------------------------------------------------------

  private rec(key: ServiceKey): LedgerEntry {
    let r = this.ledger.get(key)
    if (!r) { r = { lastActiveAt: Date.now() }; this.ledger.set(key, r) }
    return r
  }

  /** A request, a connection read, or a readiness stamp. The ONLY thing that resets the idle clock. */
  touch(key: ServiceKey): void { this.rec(key).lastActiveAt = Date.now() }

  /** First sight of a service: one full idle window, like the cloud's ready stamp. The CREATE grace
   *  is NOT reset here, because it is measured from the row's own `createdAt` (decision 10). */
  register(keys: ServiceKey[] | ServiceKey): void {
    for (const key of Array.isArray(keys) ? keys : [keys]) if (!this.ledger.has(key)) this.rec(key)
  }

  forget(keys: ServiceKey[] | ServiceKey): void {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.ledger.delete(key)
      this.wakes.delete(key)
      this.sleeping.delete(key)
      this.holdCounts.delete(key)
    }
  }

  rekey(from: ServiceKey, to: ServiceKey): void {
    const r = this.ledger.get(from)
    if (r) { this.ledger.set(to, r); this.ledger.delete(from) }
    const h = this.holdCounts.get(from)
    if (h !== undefined) { this.holdCounts.set(to, h); this.holdCounts.delete(from) }
  }

  /** After a deploy, a wake or an unpause: stamp, clear the sleep mark, drop the cached address. */
  onUp(key: ServiceKey): void {
    const r = this.rec(key)
    r.lastActiveAt = Date.now()
    r.wokeAt = Date.now()
    this.hooks.markSlept(key, null)
    this.setCached(key, 'running')
    this.forgetAddress(key)
  }

  /** The scheduler put it to sleep (or a clone was created and never started). */
  onAsleep(key: ServiceKey, _reason: SleepReason): void {
    this.hooks.markSlept(key, Date.now())
    this.setCached(key, 'exited')
    this.forgetAddress(key)
  }

  /** The developer stopped it: NOT sleep, so the sleep mark is cleared (runtime-health reads it).
   *
   *  Every `on<Transition>` hook RECORDS an outcome its caller has observed; none of them can
   *  verify one, because none of them reads docker. So a caller may only call one after the
   *  transition it names has actually happened: writing `exited` here for a `docker stop` that
   *  failed puts a fact that is not true into the snapshot the idle sweep and the eviction pass
   *  reason from, which is worse than any missing error. The callers are `lifecycleLocked` and
   *  `afterDeploy` in the engine (both now gated on the adapter call succeeding) and, inside
   *  this file, `sleep()` after `runtime.stop` resolves and `wakeLocked` after `awaitReady`. */
  onStopped(key: ServiceKey): void {
    this.hooks.markSlept(key, null)
    this.setCached(key, 'exited')
    this.forgetAddress(key)
  }

  onPaused(key: ServiceKey): void {
    this.setCached(key, 'paused')
    this.forgetAddress(key)
  }

  private setCached(key: ServiceKey, state: ContainerState): void {
    const t = this.targetOf(key)
    if (!t) return
    this.stateCache.set(t.container, { state, id: this.stateCache.get(t.container)?.id ?? '', at: Date.now() })
  }

  private forgetAddress(key: ServiceKey): void {
    const t = this.targetOf(key)
    if (t) this.upstream.forget(t.container)
  }

  /** One target by key. Indexed on the ARRAY the engine hands back, which it memoizes on the state
   *  revision, so a proxied request costs a map lookup rather than a scan of every service. */
  private index: { list: ServiceTarget[]; byKey: Map<ServiceKey, ServiceTarget> } | undefined
  targetOf(key: ServiceKey): ServiceTarget | undefined {
    const list = this.targets()
    if (this.index?.list !== list) this.index = { list, byKey: new Map(list.map((t) => [t.key, t])) }
    return this.index.byKey.get(key)
  }

  // ---- router bookkeeping -----------------------------------------------------------------------

  /** In-flight HTTP requests and TCP splices on the key. A held key is never an eviction victim. */
  holds(key: ServiceKey): number { return this.holdCounts.get(key) ?? 0 }
  beginHold(key: ServiceKey): void { this.holdCounts.set(key, this.holds(key) + 1) }
  endHold(key: ServiceKey): void {
    const n = this.holds(key) - 1
    if (n > 0) this.holdCounts.set(key, n)
    else this.holdCounts.delete(key)
  }

  // ---- the operation lock (decision 52) ---------------------------------------------------------

  /** THE mutual exclusion for container work. Keys are de-duplicated and acquired in sorted order
   *  (two multi-key ops can never deadlock), the chain is extended SYNCHRONOUSLY (a caller that
   *  returns before its first await has already reserved its place), and a key the current async
   *  context already holds is skipped, so `lifecycle start -> wake`, `createBranch -> deployLocked
   *  -> wake(source)` and `ensurePgAwake -> wake -> query` re-enter without a second acquisition. */
  withOp<T>(keys: ServiceKey[], fn: () => Promise<T>): Promise<T> {
    const inherited = this.owned.getStore() ?? new Set<ServiceKey>()
    const need = [...new Set(keys)].filter((k) => !inherited.has(k)).sort()
    if (!need.length) return fn()
    const gate = this.enqueue(need)
    const store = new Set<ServiceKey>([...inherited, ...need])
    return (async () => {
      try {
        await gate.ready
        return await this.owned.run(store, fn)
      } finally {
        gate.release()
        for (const k of need) this.release(k)
      }
    })()
  }

  /** `withOp` that refuses instead of queueing: any key held OR queued answers null without running
   *  `fn`. The sweep's `sleep` uses it, so a stop never lands behind a deploy it would undo. */
  tryWithOp<T>(keys: ServiceKey[], fn: () => Promise<T>): Promise<T | null> {
    const inherited = this.owned.getStore() ?? new Set<ServiceKey>()
    const need = [...new Set(keys)].filter((k) => !inherited.has(k)).sort()
    if (need.some((k) => (this.ops.get(k)?.count ?? 0) > 0)) return Promise.resolve(null)
    return this.withOp(keys, fn)
  }

  /** Is this container still there? Evidence, not assumption: `gone` only when docker ANSWERED
   *  and the container was not in the answer, `unknown` when it could not answer at all. The
   *  teardown paths delete bind-mounted bytes only on a `gone`, because deleting the files a
   *  surviving container is still writing is the one mistake there is no recovering from. */
  /** Every container name docker lists, or null when it could not answer. One read for a caller
   *  that is about to ask about many of them; `containerPresence` is the single-name form and
   *  each call is a full `docker ps -a`. */
  async containerSnapshot(): Promise<Set<string> | null> {
    try {
      return new Set((await this.readContainers()).keys())
    } catch {
      return null
    }
  }

  async containerPresence(container: string): Promise<'present' | 'gone' | 'unknown'> {
    try {
      return (await this.readContainers()).has(container) ? 'present' : 'gone'
    } catch {
      return 'unknown'
    }
  }

  /** Fold a FULL `docker ps -a` listing into the snapshot and hand the result back. Every full
   *  read goes through here, whoever made it and whatever they wanted from it: a read that
   *  proves what is running re-dates everything it saw, not just the one entry its caller asked
   *  about. That is what keeps the freshness gate from being evaluated against a read that a
   *  docker recovery, a stop grace or an eviction turn has since made old.
   *
   *  `at` is when the read was ISSUED, and the caller passes it, because a `docker ps -a` that
   *  took ten seconds to answer describes the box as it was ten seconds ago -- and a degraded
   *  docker is exactly the case this dating exists for. Stamping the return would record the
   *  slowest reads as the freshest facts.
   *
   *  A listing therefore never overwrites something learned SINCE it was issued: a wake or a
   *  sleep completing on another key while this read was in flight is the newer fact, and it
   *  stays. That is also why this is a fold and not a replacement -- a full listing does say
   *  which containers are gone, but only about the ones nobody has spoken for more recently. */
  private absorb(containers: Map<string, { state: ContainerState; id: string }>, at: number): Map<string, { state: ContainerState; id: string; at: number }> {
    const next = new Map(this.stateCache)
    for (const [name, c] of containers) {
      const known = next.get(name)
      if (!known || known.at <= at) next.set(name, { ...c, at })
    }
    for (const [name, known] of next) if (!containers.has(name) && known.at <= at) next.delete(name)
    this.stateCache = next
    return next
  }

  /** One full read, dated from when it was ISSUED. Every caller of `runtime.containers()` that
   *  feeds the snapshot goes through this rather than timing itself. */
  private async readContainers(): Promise<Map<string, { state: ContainerState; id: string; at: number }>> {
    const at = Date.now()
    return this.absorb(await this.runtime.containers(), at)
  }

  /** True while any operation holds or waits on the key (the sweep's in-flight test). */
  private busy(key: ServiceKey): boolean {
    return (this.ops.get(key)?.count ?? 0) > 0 || this.wakes.has(key) || this.sleeping.has(key)
  }

  /** Extend every named key's chain with one gate, synchronously. `ready` settles when every
   *  predecessor has finished; `release` lets the next holder of those keys through. */
  private enqueue(keys: ServiceKey[]): { ready: Promise<void>; release: () => void } {
    let release = (): void => {}
    const held = new Promise<void>((r) => { release = () => { r() } })
    const waits: Array<Promise<unknown>> = []
    for (const key of keys) {
      const prev = this.ops.get(key)?.chain ?? Promise.resolve()
      waits.push(prev)
      // The next acquirer of this key waits for our predecessor AND for our own release. A failed
      // op must not wedge the key, so both settle paths continue the chain.
      const chain = prev.then(() => held, () => held)
      this.ops.set(key, { chain, count: (this.ops.get(key)?.count ?? 0) + 1 })
    }
    return { ready: Promise.all(waits.map((p) => p.catch(() => undefined))).then(() => undefined), release }
  }

  private release(key: ServiceKey): void {
    const entry = this.ops.get(key)
    if (!entry) return
    entry.count -= 1
    if (entry.count <= 0) this.ops.delete(key)
  }

  // ---- state ------------------------------------------------------------------------------------

  /** The one runtime-state source (decision 53). `asleep` while a sleep holds the key (so the lanes
   *  take the wake path, which queues behind the stop, instead of dialling a stopping container)
   *  and `starting` while a wake does; otherwise the contract section 13 mapping over the last
   *  `docker ps -a` snapshot, the row's `sleptAt` and its desired state. */
  stateOf(key: ServiceKey): 'running' | 'asleep' | 'stopped' | 'paused' | 'starting' | 'none' {
    if (this.sleeping.has(key)) return 'asleep'
    if (this.wakes.has(key)) return 'starting'
    const t = this.targetOf(key)
    if (!t) return 'none'
    const live = this.stateCache.get(t.container)
    if (!live) return 'none'
    switch (live.state) {
      case 'running': return 'running'
      case 'paused': return 'paused'
      case 'restarting': return 'starting'
      default:
        return t.sleptAt !== null && t.sleptAt !== undefined && t.desiredState === 'running' ? 'asleep' : 'stopped'
    }
  }

  /** One container's last observed docker state, by NAME: what the engine's non-schedulable rows
   *  (the object store) read instead of taking a second `docker ps`. */
  containerState(container: string): ContainerState | undefined { return this.stateCache.get(container)?.state }

  /** `docker update` on one container, through the same seam the sweep uses (so a fake records it). */
  runtimeUpdate(container: string, limits: ServiceLimits): Promise<void> { return this.runtime.update(container, limits) }

  /** Fill the snapshot `stateOf` answers from (ONE docker read), and let the upstream cache drop
   *  addresses of containers that restarted underneath it.
   *
   *  A read that fails leaves the previous snapshot in place, which is what makes each entry's
   *  `at` load-bearing: without it a stale observation is indistinguishable from a fresh one,
   *  and the two decisions that act on `running` (the idle sweep and the eviction pass) would
   *  keep acting on facts that may be minutes old -- on a box under memory pressure, which is
   *  exactly when a docker read fails. Nothing is discarded here (a fact does not become false
   *  because it could not be re-read); it stops being ACTED on, in `observedRunning`. */
  async refreshStates(): Promise<void> {
    let containers: Map<string, { state: ContainerState; id: string; at: number }>
    try {
      containers = await this.readContainers()
    } catch (e) {
      if (this.statesReadable) {
        this.statesReadable = false
        console.warn(`warn: could not read container states (${e instanceof Error ? e.message : String(e)}); the idle sweep and the eviction pass act on nothing older than ${Math.round(this.maxStateAgeMs() / 1000)}s`)
      }
      return
    }
    this.statesReadable = true
    for (const [name, { id }] of containers) if (id) this.upstream.forgetIfChanged(name, id)
  }

  /** How old an observation may be and still be acted on: STRICTLY LESS THAN two sweep
   *  intervals (floored, so a very short interval does not make every fact stale by the time it
   *  is used). Derived from the sweep interval because that is the rate these facts are
   *  refreshed at. Stated as a duration rather than as a count of missed reads: at exactly two
   *  intervals the observation predates the second consecutive failed read, and `<=` would have
   *  acted on it, so the boundary is closed here and pinned by a test. */
  private maxStateAgeMs(): number {
    return Math.max(2 * this.cfg.sleep.sweepSec * 1000, MIN_STATE_AGE_MS)
  }

  /** Docker OBSERVED this container running, recently enough to act on. The freshness is per
   *  fact, not global: a wake or a sleep this scheduler just performed re-stamps its own
   *  container, so those stay authoritative through an unreadable sweep.
   *
   *  Deliberately NOT applied to `stateOf`: that answers reads and the router's wake decision,
   *  where a stale `running` costs one dial that the lane already retries with `forceWake`,
   *  and where reporting `none` for every service during a docker hiccup would be a worse
   *  answer than a slightly old one. It is applied where being wrong STOPS a container. */
  private observedRunning(container: string, now: number): boolean {
    const live = this.stateCache.get(container)
    return live?.state === 'running' && now - live.at < this.maxStateAgeMs()
  }

  /** True when nothing in the snapshot is fresh enough to act on, i.e. the last read failed (or
   *  never happened) long enough ago that this scheduler cannot say what is running. */
  private statesStale(now: number): boolean {
    for (const live of this.stateCache.values()) if (now - live.at < this.maxStateAgeMs()) return false
    return true
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  start(): void {
    this.stopped = false
    void this.reconcile().catch((e: unknown) => {
      console.warn(`warn: scheduler boot reconcile failed: ${e instanceof Error ? e.message : String(e)}`)
    })
    if (!this.cfg.sleep.enabled || this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.cfg.sleep.sweepSec * 1000)
    this.timer.unref?.()
  }

  /** Wakes the sweep starts without awaiting (the always-on pass); `stop()` waits for them. */
  private background = new Set<Promise<void>>()

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) { clearInterval(this.timer); this.timer = undefined }
    await this.sweepInFlight?.catch(() => undefined)
    // After the sweep, which is what adds to this set, so nothing it started is missed.
    await Promise.allSettled([...this.background])
  }

  /** Boot: one snapshot, a fresh idle window for every service, and the sleep marks reconciled with
   *  what docker actually runs. NO pressure pass here: with every stamp equal to boot time it would
   *  stop arbitrary running services on a busy box before any traffic could speak for them. */
  private async reconcile(): Promise<void> {
    await this.refreshStates()
    for (const t of this.targets()) {
      this.register(t.key)
      const live = this.stateCache.get(t.container)
      if (live?.state === 'running' && t.sleptAt !== null && t.sleptAt !== undefined) {
        // It came back up on its own (`--restart unless-stopped`): it is not asleep any more.
        this.hooks.markSlept(t.key, null)
        this.touch(t.key)
      }
    }
    // Not a warning when the floor is 0: eviction is off because the operator turned it off, and
    // saying otherwise sends them looking for a missing /proc/meminfo they do not need.
    if (this.cfg.sleep.ramFloorPct > 0 && !this.runtime.memory() && !this.memoryWarned) {
      this.memoryWarned = true
      console.warn('memory-pressure eviction disabled (no cgroup ceiling, no /proc/meminfo and no INSTA_OSS_MEM_BUDGET_MB)')
    }
  }

  /** One ticker beat. A tick that lands while a sweep runs is skipped, not queued. */
  private async tick(): Promise<void> {
    if (this.sweepInFlight || this.stopped) return
    this.sweepInFlight = this.sweep().catch((e: unknown) => {
      console.warn(`warn: sleep sweep failed: ${e instanceof Error ? e.message : String(e)}`)
    })
    try { await this.sweepInFlight } finally { this.sweepInFlight = undefined }
  }

  /** The idle sweep, then the memory-pressure pass. Inert while the boot data migration runs. */
  async sweep(): Promise<void> {
    if (this.hooks.booting?.()) return
    this.evictionLogged = false
    await this.refreshStates()
    const targets = this.targets()
    if (targets.some((t) => this.stateCache.get(t.container)?.state === 'running')) {
      try {
        const stats = await this.runtime.stats()
        for (const t of targets) {
          const rss = stats.get(t.container)
          if (rss !== undefined) this.rec(t.key).lastRssBytes = rss
        }
      } catch { /* one missed sample: the next tick takes another */ }
    }
    const now = Date.now()
    const candidates = targets
      .filter((t) => this.isIdleCandidate(t, now))
      .sort((a, b) => this.rec(a.key).lastActiveAt - this.rec(b.key).lastActiveAt)
    for (let i = 0; i < candidates.length; i += SLEEP_CONCURRENCY) {
      const batch = candidates.slice(i, i + SLEEP_CONCURRENCY)
      // allSettled, not all: one docker stop that times out must cost one service on one tick, not
      // the rest of the pass and the pressure pass behind it (plan 03: errors logged, retried next
      // pass).
      const results = await Promise.allSettled(batch.map(async (t) => {
        // The rule is re-read for each candidate at the moment IT is stopped, not once for the pass:
        // every earlier batch awaited a stop that can burn the whole grace (10 s compute, 30 s
        // databases), so with a dozen candidates the third batch starts a minute after `now` was
        // taken. A service that answered a request in between leaves no other trace the sweep sees
        // (a running upstream is dialled directly, with no wake and no op), and this check runs in
        // the same synchronous step that reserves the key's lock, so nothing slips between them.
        if (!this.isIdleCandidate(t, Date.now())) return false
        return this.sleep(t.key, 'idle')
      }))
      for (const [n, r] of results.entries()) {
        if (r.status === 'rejected') {
          const e = r.reason
          console.warn(`warn: sleep ${batch[n].key} failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    // An always-on service that is asleep is brought back up. The setting only takes a service out
    // of the sleep and eviction passes, so a service already asleep when it became always-on
    // (switched on, or the default turned on over an existing box) stayed asleep until its next
    // request while every view called it always-on. Through the ordinary wake, so it makes room
    // and queues behind any operation on the key; not awaited, so one slow image does not hold the
    // sweep, and a wake in flight reads `starting`, so the next pass does not start a second one.
    // The targets are read again HERE, not taken from the top of the sweep: the idle phase above
    // awaits stops and can run for minutes, and a setting switched meanwhile must win in both
    // directions. Checked once more under the key's lock, because the grant can come later still.
    for (const t of this.targets()) {
      if (!t.alwaysOn || t.desiredState !== 'running' || this.busy(t.key) || this.stateOf(t.key) !== 'asleep') continue
      const woke = this.withOp([t.key], async () => {
        const cur = this.targetOf(t.key)
        if (!cur?.alwaysOn || cur.desiredState !== 'running' || this.stateOf(t.key) !== 'asleep') return
        await this.wake(t.key, { door: 'api' })
      }).catch((e: unknown) => {
        console.warn(`warn: always-on wake ${t.key} failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      // Tracked so `stop()` waits for it: shutdown must not cut off a wake that is evicting or starting.
      this.background.add(woke)
      void woke.finally(() => { this.background.delete(woke) })
    }
    // Re-read BEFORE the pressure pass, not once for the whole sweep. The sleep phase above
    // awaits a stop per candidate and each can burn its grace (10 s compute, 30 s databases), so
    // with a dozen candidates this line is reached minutes after the sweep's own read -- past
    // the freshness bound `isVictim` applies, every time, on a box where nothing at all went
    // wrong. Gating eviction on evidence that is stale BY CONSTRUCTION at the point of use
    // turned the memory floor off. The gate is right and the reading was in the wrong place.
    // One extra `docker ps -a` per sweep tick, next to a phase that just spent seconds stopping
    // containers; if it fails, the pass finds no dateable victim and says so, which is the
    // intended behaviour rather than a new one.
    //
    // It is BELT, not the mechanism, and a future edit must not mistake it for one: what keeps
    // a long pass sighted is that every full read re-dates the whole snapshot, so each turn's
    // own `sleep()` re-dates the turn after it. Dropping this line leaves the suite green. It
    // stays for the case those reads do not cover: a sweep whose sleep phase stopped nothing at
    // all, where the pass would otherwise judge by the read at the top of the sweep.
    await this.refreshStates()
    await this.evictForRoom(0, new Set())
  }

  /** Every condition of the cloud's idle rule, each able to veto on its own (contract section 13). */
  private isIdleCandidate(t: ServiceTarget, now: number): boolean {
    if (!this.observedRunning(t.container, now)) return false
    if (t.alwaysOn) return false
    if (t.desiredState !== 'running') return false
    if (t.idleSec <= 0) return false
    if (this.busy(t.key)) return false
    if (now - this.rec(t.key).lastActiveAt < t.idleSec * 1000) return false
    // The create grace comes from the ROW, never from the ledger, so a daemon restart does not hand
    // every service a fresh 10 minutes (decision 10).
    if (now - t.createdAt < this.cfg.sleep.createGraceSec * 1000) return false
    return true
  }

  // ---- sleep ------------------------------------------------------------------------------------

  /** Stop one service. Non-blocking on the lock: a key with an operation in flight answers false
   *  and is retried on the next pass. Returns whether the service is now asleep. */
  async sleep(key: ServiceKey, reason: SleepReason): Promise<boolean> {
    const out = await this.tryWithOp([key], async () => {
      const t = this.targetOf(key)
      if (!t) return false
      // Marked FIRST, inside the lock: `stateOf` must report `asleep` for the whole stop, so a
      // request arriving now takes the wake path (queued behind this stop) instead of dialling a
      // container that is shutting down.
      this.sleeping.add(key)
      try {
        // The re-read under the lock is also the freshest truth there is, and it is a FULL
        // listing, so the whole snapshot is taken from it: a container that has gone away is not
        // reported running until the next sweep, and every stop in a sleep phase or an eviction
        // loop re-dates the pass that follows it. That last part is load-bearing -- each stop
        // can burn its whole grace, so a pass that dated its evidence once at the top would be
        // judging the last of its candidates against a read a minute old.
        const live = (await this.readContainers()).get(t.container)?.state
        if (live === 'paused') return false
        if (live === undefined) return false
        if (live !== 'running') {
          // A clone that was created and never started is already asleep; just mark it.
          if (live === 'created') { this.onAsleep(key, reason); return true }
          return false
        }
        try {
          await this.runtime.stop(t.container, this.graceFor(t, reason))
        } catch (e) {
          // A stop that failed or timed out may still land on the daemon side, so what this
          // snapshot says about the container is not evidence any more: drop the entry rather
          // than let the rest of this pass -- or the eviction pool behind it -- decide anything
          // from it. The next full read is what re-establishes the fact.
          this.stateCache.delete(t.container)
          throw e
        }
        this.onAsleep(key, reason)
        this.hooks.emit(key, 'service.sleep', { service: t.serviceId, reason })
        return true
      } finally {
        this.sleeping.delete(key)
      }
    })
    return out ?? false
  }

  /** Compute gets the short grace, databases the long one; an eviction victim is always in a hurry
   *  (decision 13). */
  private graceFor(t: ServiceTarget, reason: SleepReason): number {
    if (reason === 'memory') return this.cfg.sleep.stopGraceSec
    return t.kind === 'compute' ? this.cfg.sleep.stopGraceSec : this.cfg.sleep.stopGraceDbSec
  }

  // ---- eviction ---------------------------------------------------------------------------------

  /** Make room for `needBytes` by sleeping the least recently active service, until free memory is
   *  back above the floor. Every guard here is HARD, never a preference: a just-woken service, one
   *  that answered a request seconds ago, and one with a request or splice in flight are never
   *  victims, so two services that do not fit together cannot ping-pong on every request. An empty
   *  pool means the wake proceeds anyway and the kernel is the last resort. */
  async evictForRoom(needBytes: number, exclude: Set<ServiceKey>): Promise<void> {
    // The documented off switch: a floor of 0 means no pressure eviction anywhere, on the sweep's
    // pass and on the wake path alike (decision 12), so a low-RAM runner never stops a container
    // an e2e or a Docker suite is testing.
    if (this.cfg.sleep.ramFloorPct <= 0) return
    const first = this.runtime.memory()
    if (!first) return
    const floor = first.totalBytes * (this.cfg.sleep.ramFloorPct / 100)
    const tried = new Set<ServiceKey>()
    // What this pass has already freed. The runtime does not always see it in time: in budget mode
    // `memory()` answers `budget - lastRssTotal` and that total is only re-sampled by `stats()`,
    // which no wake and no later loop turn calls. Without this, one pass would keep finding the same
    // pressure and sleep EVERY eligible service instead of the least recently active one.
    let freed = 0
    // The two returns above are the real terminators: the floor being met, and the pool being
    // empty. Termination does not depend on the counter below at all -- each turn adds its
    // victim to `tried` and `isVictim` excludes those, so the loop provably cannot revisit a
    // service and the pool it draws from strictly shrinks.
    //
    // The counter is a runaway guard and nothing else, so it is a CONSTANT. The two obvious
    // alternatives are both wrong, and this delta shipped each of them in turn: a bound sampled
    // once from `targets().length` is too small the moment a deploy registers a service
    // mid-loop (every `sleep()` waits out a stop grace, so that window is seconds wide), and a
    // bound re-read from `targets().length` in the loop condition grows with the very set it is
    // bounding, which bounds nothing. A fixed ceiling is finite by inspection and cannot be
    // argued with.
    for (let guard = 0; guard < EVICTION_CEILING; guard++) {
      const mem = this.runtime.memory()
      if (!mem) return
      // Whichever is larger: what the runtime reports (authoritative once it notices a stop) or the
      // pass's own baseline plus what it freed. Never the sum, which would count a stop twice.
      const available = Math.max(mem.availableBytes, first.availableBytes + freed)
      if (available - needBytes >= floor) return
      const now = Date.now()
      const pool = this.targets().filter((t) => this.isVictim(t, now, exclude, tried))
      if (!pool.length) {
        // "No service can be evicted" and "this daemon cannot tell what is running" are
        // different answers and they get different words, because they send an operator to
        // different places. Both return: stopping containers on facts that may be minutes old
        // is how the wrong service gets stopped.
        //
        // Skipping cannot leave the floor unenforced indefinitely, and this is why: the thing
        // that GROWS memory here is a wake, and `wakeLocked` reads `runtime.containers()` itself
        // before it reaches this function. A docker that cannot answer therefore fails the wake
        // outright, before anything starts. The pass is only inert for as long as nothing can
        // start either, and the first read that succeeds re-stamps the snapshot and makes the
        // next tick's pass whole again.
        if (!this.evictionLogged) {
          this.evictionLogged = true
          console.warn(this.statesStale(now)
            ? `memory pressure: ${Math.round(available / MiB)} MiB free is under the ${this.cfg.sleep.ramFloorPct}% floor and this daemon cannot tell what is running (docker has not reported container states for more than ${Math.round(this.maxStateAgeMs() / 1000)}s), so nothing is evicted`
            : `memory pressure: ${Math.round(available / MiB)} MiB free is under the ${this.cfg.sleep.ramFloorPct}% floor and no service can be evicted`)
        }
        return
      }
      pool.sort((a, b) => {
        const d = this.rec(a.key).lastActiveAt - this.rec(b.key).lastActiveAt
        return d !== 0 ? d : (this.rec(b.key).lastRssBytes ?? 0) - (this.rec(a.key).lastRssBytes ?? 0)
      })
      const victim = pool[0]
      tried.add(victim.key)
      if (await this.sleep(victim.key, 'memory')) {
        freed += this.rec(victim.key).lastRssBytes ?? DEFAULT_RSS[victim.kind]
      }
    }
    // Falling out of the loop is not a full box and not an empty pool: both of those return
    // above. It means the loop ran EVICTION_CEILING times without meeting the floor and without
    // exhausting the pool, which the `tried` argument says cannot happen, so it is a bug in this
    // loop and it says exactly that rather than passing for either outcome.
    console.warn(`memory pressure: gave up after ${EVICTION_CEILING} eviction attempts with the floor still unmet and candidates remaining; this is a bug in the eviction loop, not a full box and not an empty pool`)
  }

  private isVictim(t: ServiceTarget, now: number, exclude: Set<ServiceKey>, tried: Set<ServiceKey>): boolean {
    if (exclude.has(t.key) || tried.has(t.key)) return false
    if (!this.observedRunning(t.container, now)) return false
    if (t.alwaysOn || t.desiredState !== 'running') return false
    if (this.busy(t.key)) return false
    if (this.holds(t.key) > 0) return false
    const r = this.rec(t.key)
    if (now - r.lastActiveAt < 2 * this.cfg.lanes.touchDebounceMs) return false
    if (r.wokeAt !== undefined && now - r.wokeAt < this.cfg.sleep.wakeProtectSec * 1000) return false
    return true
  }

  // ---- wake -------------------------------------------------------------------------------------

  /** Start a sleeping service and wait until it accepts connections. Singleflight per key: 25
   *  concurrent requests share ONE `docker start` and one readiness wait. The lock is taken
   *  BLOCKING, so a deploy, a lifecycle op or a stop in flight on the same container finishes
   *  first and the target is re-read afterwards.
   *
   *  EVERY CALLER IS BOUNDED, from the moment it starts waiting. `wakeTimeoutSec` is defined by
   *  contract (`00-contract.md:179-188`) as both the router's hold and the readiness bound, and
   *  the spec (`2026-09-08...:144`) says every held HTTP or database connection is bounded at
   *  it. The code applied it to readiness ALONE, and readiness is the last of three phases: the
   *  wait for this key's lock, then eviction, then the start. Eviction is sequential, each turn
   *  carrying a stop grace (10 s compute, 30 s databases) and a docker timeout, so under the
   *  memory pressure where a bound matters most a held socket could stay open for minutes and
   *  then still be granted a full readiness budget. The deadline is absolute and it starts here,
   *  which is what the contract already says it is.
   *
   *  Deliberately: the WORK is not cancelled when a caller's budget runs out. It keeps the
   *  operation lock and runs to completion, because a half-done eviction (victims stopped, the
   *  container never started, the floor still unmet) is a worse thing to leave behind than a
   *  wake nobody is waiting for, and because the next request through this lane joins that same
   *  singleflight instead of starting the eviction again. Its own phases are each finite:
   *  `EVICTION_CEILING` turns, `DOCKER_TIMEOUT_MS` per docker call, `wakeTimeoutSec` on
   *  readiness. What ends at the deadline is the CALLER's wait, with `WakeTimeoutError` -- the
   *  answer a wake that runs out of time already gives, so the lanes need no new outcome.
   *
   *  ...and the bound applies ONLY where this call made the acquisition. A RE-ENTRANT wake --
   *  `lifecycle start`, `ensureSourceRunning` inside a fork, `ensurePgAwake`, the three callers
   *  decision 52 names -- inherits the key from an engine operation that is still on the stack.
   *  There is no second acquisition to hold anything, so a timer there would release the caller,
   *  unwind the OUTER op, and leave the wake starting, probing and evicting with no entry in the
   *  lock queue at all: the container comes up under a `stopped` intent that a concurrent
   *  lifecycle op has just written, unreachable through the traffic door and never a candidate
   *  for eviction. Precisely the fabricated state this delta spent three rounds removing. What
   *  the contract bounds is a HELD CLIENT CONNECTION; an internal step of a branch create is
   *  not one, so it waits for the work it owns. */
  wake(key: ServiceKey, opts: { door: WakeDoor }): Promise<void> {
    const t = this.targetOf(key)
    if (!t) return Promise.reject(new NoTargetError())
    if (this.refuses(t, opts.door)) return Promise.reject(new ServiceStoppedError())
    if (this.owned.getStore()?.has(key)) {
      // Under the caller's own acquisition, so `withOp` would add nothing: run the work here.
      // It also must not JOIN another wake found in the map -- that one is queued behind the
      // very operation this call is inside, so awaiting it could never return.
      const inline = this.wakeLocked(key, opts.door)
      if (!this.wakes.has(key)) {
        // Reported as `starting` while it runs, like any other wake.
        this.wakes.set(key, inline)
        void inline.catch(() => { /* the caller awaits it; this is only the map's copy */ })
          .finally(() => { if (this.wakes.get(key) === inline) this.wakes.delete(key) })
      }
      return inline
    }
    let work = this.wakes.get(key)
    if (!work) {
      work = this.withOp([key], () => this.wakeLocked(key, opts.door))
        .finally(() => { this.wakes.delete(key) })
      this.wakes.set(key, work)
      // Every caller can give up before this settles, so nothing may be attached when it does.
      void work.catch(() => { /* reported to whoever was still waiting; see `bounded` */ })
    }
    return this.bounded(work, key)
  }

  /** One caller's view of a shared wake: it settles with the wake, or at this caller's own
   *  deadline, whichever comes first. Each caller gets its own budget because each is a
   *  different held connection, and the second request to arrive did not start waiting when the
   *  first did. */
  private bounded(work: Promise<void>, key: ServiceKey): Promise<void> {
    const sec = this.cfg.sleep.wakeTimeoutSec
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        console.warn(`wake ${key} passed its ${sec}s bound; the caller is released and the wake continues under the lock`)
        reject(new WakeTimeoutError(sec, 'waiting'))
      }, sec * 1000)
      timer.unref?.()
      work.then(() => { clearTimeout(timer); resolve() }, (e: unknown) => { clearTimeout(timer); reject(e) })
    })
  }

  /** Traffic never wakes a service the developer stopped or suspended; the api and deploy doors are
   *  explicit operations and are never refused. */
  private refuses(t: ServiceTarget, door: WakeDoor): boolean {
    return door === 'traffic' && t.kind === 'compute' && t.desiredState !== 'running'
  }

  private async wakeLocked(key: ServiceKey, door: WakeDoor): Promise<void> {
    const started = Date.now()
    const t = this.targetOf(key)
    if (!t) throw new NoTargetError()
    if (this.refuses(t, door)) throw new ServiceStoppedError()
    // A full listing, so it re-dates the whole snapshot rather than the one container this wake
    // wanted: after a docker outage this read is the very evidence that the daemon is answering
    // again, and keeping only one entry left the eviction pool undateable and the floor
    // unenforced for the wake that needed it most.
    const live = (await this.readContainers()).get(t.container)
    if (!live) throw new NoContainerError()
    if (live.state === 'running') {
      // A deploy that ended in `onUp` makes this wake a no-op: stamp and go.
      if (await this.runtime.probe(t)) {
        this.touch(key)
        if (t.sleptAt !== null && t.sleptAt !== undefined) this.hooks.markSlept(key, null)
        return
      }
    } else if (live.state === 'paused') {
      if (door === 'traffic') throw new Error('service is suspended')
      await this.runtime.unpause(t.container)
    } else if (live.state !== 'restarting') {
      const need = this.rec(key).lastRssBytes ?? (t.limits ? t.limits.memoryMb * MiB : DEFAULT_RSS[t.kind])
      // Room FIRST, then the start. These used to run concurrently, to keep the victim's stop
      // grace off the caller's hold, but that puts the victim and the waking container in memory
      // at the same moment, which is precisely the overshoot the RAM floor exists to prevent
      // (spec section 4: evict the LRU candidate, THEN start). The latency argument does not
      // survive contact with `evictForRoom`: it returns before it reads anything when the floor
      // is off, and before it sleeps anything when there is already room, so awaiting it costs
      // NOTHING on the common path and costs one stop grace exactly when the floor is at risk,
      // which is when that is the right price. A slow wake beats a box that needs a reboot.
      //
      // The failure is not swallowed either. `evictForRoom` returns quietly when it cannot find
      // a victim (it warns), so a throw here is a real fault in making room, and starting anyway
      // is how the floor gets crossed.
      try {
        await this.evictForRoom(need, new Set([key]))
      } catch (e) {
        throw new Error(`could not make room to wake ${t.container}: ${e instanceof Error ? e.message : String(e)}`)
      }
      await this.runtime.start(t.container)
    }
    await this.awaitReady(t)
    this.onUp(key)
    this.hooks.emit(key, 'service.wake', { service: t.serviceId, door, ms: Date.now() - started })
  }

  /** Poll readiness until the deadline. A container that exits mid-wake ends the wait with its own
   *  error (the sleep mark is left alone: it did not go to sleep, it crashed). */
  private async awaitReady(t: ServiceTarget): Promise<void> {
    const deadline = Date.now() + this.cfg.sleep.wakeTimeoutSec * 1000
    for (;;) {
      if (await this.runtime.probe(t)) return
      const live = (await this.runtime.containers()).get(t.container)?.state
      if (live === 'exited' || live === 'dead') throw new Error('service exited during wake')
      if (Date.now() >= deadline) throw new WakeTimeoutError(this.cfg.sleep.wakeTimeoutSec)
      await sleepFor(PROBE_INTERVAL_MS)
    }
  }
}

// ---- production runtime -------------------------------------------------------------------------

/** How long any single docker call may take before the caller gives up on it. */
const DOCKER_TIMEOUT_MS = 20_000

/** A docker call with a deadline, where the deadline KILLS THE COMMAND and waits for it.
 *
 *  This used to reject its own wrapper and walk away, leaving the child running. The caller then
 *  released its operation key while a process it had started could still act, and that process
 *  acts on a NAME: a late `stop` stops whatever holds the name by then, which after a deploy is
 *  the replacement container, and a late `start` undoes an explicit stop. Same family as the
 *  wake bound above -- work outliving its lock -- one layer down.
 *
 *  So the promise settles only once the child has CLOSED: the timer kills it (SIGKILL, so the
 *  wait is process teardown and not a negotiation) and the rejection comes from the child's own
 *  exit. "The caller gave up" and "no docker command of ours is running" are then the same
 *  moment, which is what makes releasing the key afterwards safe.
 *
 *  What this cannot do is unmake a request dockerd has already accepted: `docker stop` is an
 *  HTTP call to the daemon, and killing the client does not cancel the daemon's own work. That
 *  residue is bounded by never RECORDING an outcome nobody verified (the caller throws, and its
 *  snapshot entry for the container is dropped so the next decision re-reads) and would only be
 *  closed completely by addressing containers by id rather than by name, which is a change to
 *  every runtime verb and every recorded call string, not one for this round. */
export function withTimeout<T>(call: { done: Promise<T>; kill: () => void }, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let expired = false
    const timer = setTimeout(() => { expired = true; call.kill() }, ms)
    timer.unref?.()
    const timedOut = (): Error => new Error(`docker ${what} timed out after ${ms} ms (the command was killed and has exited)`)
    call.done.then(
      (v) => { clearTimeout(timer); if (expired) reject(timedOut()); else resolve(v) },
      (e: unknown) => { clearTimeout(timer); reject(expired ? timedOut() : (e instanceof Error ? e : new Error(String(e)))) },
    )
  })
}

/** `docker(...)` with a deadline: the seam every mutating verb in this file goes through. */
function boundedDocker(args: string[], ms: number, what: string): Promise<Buffer> {
  return withTimeout(dockerCall(args), ms, what)
}

/** The memory ceiling of THIS process's own cgroup, or null when it has none.
 *
 *  cgroup v2 only, and deliberately so: `memory.max` on the root cgroup of a machine does not exist,
 *  so a daemon running straight on a Linux box answers null here and /proc/meminfo stands. A daemon
 *  inside a container sees its own limit, which /proc/meminfo cannot show it. `memory.current`
 *  counts page cache, and cache inside the ceiling is reclaimable rather than pressure, so the
 *  reclaimable part is added back the way MemAvailable does it for the machine.
 *  `root` is a parameter for the tests; nothing in the daemon passes it. */
export function cgroupMemory(root = '/sys/fs/cgroup'): { availableBytes: number; totalBytes: number } | null {
  try {
    const max = readFileSync(join(root, 'memory.max'), 'utf8').trim()
    if (max === 'max') return null
    const totalBytes = Number(max)
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null
    const current = Number(readFileSync(join(root, 'memory.current'), 'utf8').trim())
    if (!Number.isFinite(current)) return null
    let reclaimable = 0
    try {
      const stat = readFileSync(join(root, 'memory.stat'), 'utf8')
      const field = (name: string): number => Number(new RegExp(`^${name} (\\d+)`, 'm').exec(stat)?.[1] ?? 0)
      reclaimable = field('inactive_file') + field('slab_reclaimable')
    } catch { /* no memory.stat: count the cache as used, which only evicts sooner */ }
    return { totalBytes, availableBytes: Math.max(0, Math.min(totalBytes, totalBytes - current + reclaimable)) }
  } catch {
    return null
  }
}

/** The ZFS ARC's RECLAIMABLE part, in bytes, or 0 on a machine with no ZFS.
 *
 *  On Linux the ARC is not page cache: it is allocated through the SPL's own caches and scatter
 *  ABDs, so it is counted in neither the page-cache nor the reclaimable-slab terms the kernel
 *  builds `MemAvailable` from. It is nonetheless given back under pressure, down to `c_min`,
 *  through the ARC's shrinker. So on a ZFS host with a warm ARC, `MemAvailable` understates what
 *  is available by most of the ARC, and this daemon would read a box that is fine as permanently
 *  under its RAM floor and evict continuously -- on the product whose whole premise is keeping
 *  branches asleep and waking them on traffic. `cgroupMemory` already adds a reclaimable term
 *  back for the same reason; the `/proc/meminfo` path had no equivalent.
 *
 *  `size - c_min` is the part the shrinker may take: `c_min` is the floor the ARC will not go
 *  below (1/32 of RAM by default). Absent or unparseable file: 0, never an error, because the
 *  safe direction here is the SMALLER number -- a machine with no ZFS must be bit for bit
 *  unaffected, and a probe that cannot answer must not be the thing that switches the floor off.
 *
 *  If a future OpenZFS ever accounts the ARC into `MemAvailable` (it would have to register the
 *  pages under a counter the kernel's MemAvailable sums, which it does not do today), this term
 *  would double count. That is why the caller CLAMPS to the total: the error would be bounded by
 *  the ARC rather than unbounded, and it would show up as evicting late rather than never. */
export function arcReclaimable(procRoot = '/proc'): number {
  try {
    // `name  type  data`, three columns, after two header lines.
    const text = readFileSync(join(procRoot, 'spl', 'kstat', 'zfs', 'arcstats'), 'utf8')
    const field = (name: string): number => Number(new RegExp(`^${name}\\s+\\d+\\s+(\\d+)\\b`, 'm').exec(text)?.[1] ?? NaN)
    const size = field('size')
    if (!Number.isFinite(size)) return 0
    const floor = field('c_min')
    return Math.max(0, size - (Number.isFinite(floor) ? floor : 0))
  } catch {
    return 0
  }
}

/** What the MACHINE has, from `/proc/meminfo`, with the ZFS ARC's reclaimable part added back.
 *  Clamped to the total: available can never exceed it, whatever the two sources say. */
export function hostMemory(procRoot = '/proc'): { availableBytes: number; totalBytes: number } | null {
  try {
    const text = readFileSync(join(procRoot, 'meminfo'), 'utf8')
    const kb = (field: string): number => Number(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? NaN)
    const total = kb('MemTotal')
    const available = kb('MemAvailable')
    if (!Number.isFinite(total) || !Number.isFinite(available)) return null
    const totalBytes = total * 1024
    return { totalBytes, availableBytes: Math.min(totalBytes, available * 1024 + arcReclaimable(procRoot)) }
  } catch {
    return null
  }
}

/** The `Runtime` over the docker CLI. One `docker ps -a` per sweep and one `docker stats` when
 *  anything runs; `memory()` is synchronous, so it answers from this process's cgroup ceiling or
 *  /proc/meminfo (Linux, whichever is tighter) or from the synthetic budget minus the last RSS
 *  sample (`INSTA_OSS_MEM_BUDGET_MB`, tests and macOS). */
export class DockerRuntime implements Runtime {
  private meminfoMissing = false
  private cgroupMissing = false
  private lastRssTotal = 0
  /** The last per-container sample of `stats()`, so `stop()` can take that container out of the
   *  running total instead of waiting for the next sweep to re-sample it (budget mode). */
  private lastRss = new Map<string, number>()

  constructor(private cfg: Config, private upstream: UpstreamLike) {}

  async containers(): Promise<Map<string, { state: ContainerState; id: string }>> {
    const out = await boundedDocker(['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.ID}}'], DOCKER_TIMEOUT_MS, 'ps')
    const map = new Map<string, { state: ContainerState; id: string }>()
    for (const line of out.toString().trim().split('\n').filter(Boolean)) {
      const [name, state, id] = line.split('\t')
      if (name) map.set(name, { state: (state ?? 'exited') as ContainerState, id: id ?? '' })
    }
    return map
  }

  async stats(): Promise<Map<string, number>> {
    const out = await boundedDocker(['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}'], DOCKER_TIMEOUT_MS, 'stats')
    const map = new Map<string, number>()
    let total = 0
    for (const line of out.toString().trim().split('\n').filter(Boolean)) {
      const [name, usage] = line.split('\t')
      if (!name) continue
      const bytes = parseSize((usage ?? '0B').split('/')[0] ?? '')
      map.set(name, bytes)
      if (name.startsWith('io-')) total += bytes
    }
    this.lastRssTotal = total
    this.lastRss = map
    return map
  }

  memory(): { availableBytes: number; totalBytes: number } | null {
    const budget = this.cfg.sleep.memBudgetMb
    if (budget !== null) {
      const totalBytes = budget * MiB
      return { totalBytes, availableBytes: Math.max(0, totalBytes - this.lastRssTotal) }
    }
    const host = this.meminfo()
    // /proc/meminfo describes the MACHINE even when this process is inside a container, so an
    // instad under a cgroup ceiling smaller than the box would never see pressure and the kernel
    // would OOM-kill a container before the sweep evicted one. The tighter of the two views wins.
    const ceiling = this.cgroupMissing ? null : cgroupMemory()
    if (!ceiling) this.cgroupMissing = true
    if (ceiling && (!host || ceiling.totalBytes < host.totalBytes)) return ceiling
    return host
  }

  private meminfo(): { availableBytes: number; totalBytes: number } | null {
    if (this.meminfoMissing) return null
    // Read on the same cadence as everything else here: `memory()` is called once per sweep and
    // once per wake that needs room, and the ARC file is read with it, so the two halves of the
    // sum are always the same moment.
    const out = hostMemory()
    if (!out) { this.meminfoMissing = true; return null }
    return out
  }

  async start(container: string): Promise<void> {
    await boundedDocker(['start', container], DOCKER_TIMEOUT_MS, 'start')
  }

  /** Sleep is `docker stop` with a grace, never `docker pause`: SIGTERM (SIGINT for the postgres
   *  image, its fast shutdown), then SIGKILL after the grace. Compute containers carry `--init` so
   *  the signal reaches an app whose PID 1 is a shell (decision 60). */
  async stop(container: string, graceSec: number): Promise<void> {
    await boundedDocker(['stop', '-t', String(graceSec), container], DOCKER_TIMEOUT_MS + graceSec * 1000, 'stop')
    // Budget mode has no kernel to ask, so the total it subtracts from the budget is maintained
    // here: a container that is gone is not holding its last sample any more.
    const sample = this.lastRss.get(container)
    if (sample !== undefined) {
      this.lastRss.delete(container)
      this.lastRssTotal = Math.max(0, this.lastRssTotal - sample)
    }
  }

  async unpause(container: string): Promise<void> {
    await boundedDocker(['unpause', container], DOCKER_TIMEOUT_MS, 'unpause')
  }

  async update(container: string, limits: ServiceLimits): Promise<void> {
    await boundedDocker(
      ['update', '--cpus', String(limits.cpu), '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`, container],
      DOCKER_TIMEOUT_MS, 'update',
    )
  }

  /** Postgres is ready when `pg_isready` says so (a TCP accept happens before recovery finishes);
   *  everything else when its port accepts a connection. */
  async probe(t: ServiceTarget): Promise<boolean> {
    if (t.kind === 'postgres') {
      try {
        await boundedDocker(['exec', t.container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'app'], DOCKER_TIMEOUT_MS, 'exec pg_isready')
        return true
      } catch { return false }
    }
    return this.upstream.dial(t.container, t.network, t.port, 1000)
  }
}
