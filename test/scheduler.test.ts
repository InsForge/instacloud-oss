// The scheduler over FakeRuntime and fake timers (contract 00 sections 8.3 and 13, plan 03).
// Nothing here touches docker or the engine: the Scheduler takes a Runtime, a Config, a targets
// function, two hooks and an Upstream, which is exactly what makes the sweep, the wake doors, the
// operation lock and eviction testable without containers.
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  EVICTION_CEILING, NoContainerError, Scheduler, ServiceStoppedError, WakeTimeoutError, withTimeout,
  type ServiceTarget, type SleepReason, type WakeDoor,
} from '../src/scheduler'

import type { ServiceKey } from '../src/types'
import { calls, FakeRuntime, FakeUpstream, fakeTarget, testConfig } from './fakes'

const MiB = 1024 * 1024

/** Wait for a wake's WORK, not just for one caller's budget. Past `wakeTimeoutSec` the caller is
 *  released with `WakeTimeoutError` while the wake keeps the operation lock and runs on, so a
 *  test that wants the finished state asks for the key afterwards: that queues behind the wake
 *  and is granted when it lets go. Returns what the caller saw. */
async function wakeFully(h: Harness, key: ServiceKey): Promise<'ready' | 'released'> {
  const seen = await h.sched.wake(key, { door: 'traffic' }).then(
    () => 'ready' as const,
    (e: unknown) => {
      if (!(e instanceof WakeTimeoutError)) throw e
      return 'released' as const
    },
  )
  await h.sched.withOp([key], async () => { /* granted only once the wake has let the key go */ })
  return seen
}

interface Harness {
  sched: Scheduler
  runtime: FakeRuntime
  upstream: FakeUpstream
  targets: Map<ServiceKey, ServiceTarget>
  slept: Array<[ServiceKey, number | null]>
  events: Array<{ key: ServiceKey; kind: string; payload: Record<string, unknown> }>
  add(key: ServiceKey, over?: Partial<ServiceTarget>): ServiceTarget
  setBooting(v: boolean): void
}

/** One scheduler with its own runtime, upstream and target table. `add` both registers a target and
 *  puts its container in the store, because that is the shape every real code path sees. */
function harness(env: Record<string, string> = {}): Harness {
  const runtime = new FakeRuntime()
  const upstream = new FakeUpstream(runtime)
  const targets = new Map<ServiceKey, ServiceTarget>()
  const slept: Array<[ServiceKey, number | null]> = []
  const events: Array<{ key: ServiceKey; kind: string; payload: Record<string, unknown> }> = []
  let booting = false
  const sched = new Scheduler(
    runtime, testConfig(env), () => [...targets.values()],
    {
      markSlept: (key, at) => {
        slept.push([key, at])
        const t = targets.get(key)
        if (t) t.sleptAt = at
      },
      emit: (key, kind, payload) => { events.push({ key, kind, payload }) },
      booting: () => booting,
    },
    upstream,
  )
  return {
    sched, runtime, upstream, targets, slept, events,
    add(key, over = {}) {
      const t = fakeTarget({ key, ...over })
      targets.set(key, t)
      runtime.put(t.container, over.sleptAt ? 'exited' : 'running')
      sched.register(key)
      return t
    },
    setBooting(v) { booting = v },
  }
}

const K = '11111111-1111-1111-1111-111111111111:cp-web'
const K2 = '11111111-1111-1111-1111-111111111111:cp-api'
const PG = '11111111-1111-1111-1111-111111111111:pg-db'

beforeEach(() => { calls.length = 0; vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// ---- the sweep -----------------------------------------------------------------------------------

test('sweep table: each of running, alwaysOn, desiredState, stamp age, create grace and in-flight flips the outcome on its own', async () => {
  const h = harness()
  const t = h.add(K)
  // Baseline: idle past the window, nothing else in the way.
  vi.advanceTimersByTime(301_000)
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${t.container}:10`)

  // ...and now each veto in turn, each from that same baseline in its own harness.
  const vetoes: Array<[string, (h: Harness, t: ServiceTarget) => void]> = [
    ['not running', (fresh, target) => { fresh.runtime.put(target.container, 'exited') }],
    ['alwaysOn', (_fresh, target) => { target.alwaysOn = true }],
    ['user-stopped', (_fresh, target) => { target.desiredState = 'stopped' }],
    ['idle window disabled', (_fresh, target) => { target.idleSec = 0 }],
    ['inside the create grace', (_fresh, target) => { target.createdAt = Date.now() - 60_000 }],
    ['freshly stamped', (fresh) => { fresh.sched.touch(K) }],
  ]
  for (const [name, veto] of vetoes) {
    const fresh = harness()
    const target = fresh.add(K)
    vi.advanceTimersByTime(301_000)
    veto(fresh, target)
    calls.length = 0
    await fresh.sched.sweep()
    expect(calls.filter((c) => c.startsWith('runtime.stop:')), name).toEqual([])
  }
  expect(t.sleptAt).toBeTypeOf('number')      // the baseline above really did sleep
})

test('the sweep wakes an always-on service that is asleep, and only that one', async () => {
  // Always-on used to only take a service OUT of the sweep, so one already asleep when it became
  // always-on (switched on, or the default turned on over an existing box) stayed asleep until
  // its next request while every view called it always-on.
  const h = harness()
  const on = h.add(K, { alwaysOn: true, sleptAt: Date.now() })
  const off = h.add(K2, { sleptAt: Date.now() })
  const held = h.add('11111111-1111-1111-1111-111111111111:cp-job', {
    alwaysOn: true, sleptAt: Date.now(), desiredState: 'stopped', container: 'io-x-app-job',
  })
  await h.sched.refreshStates()               // the snapshot stateOf answers from
  expect(h.sched.stateOf(K)).toBe('asleep')
  await h.sched.sweep()
  await h.sched.withOp([K], async () => { /* granted only once the wake has let the key go */ })
  expect(calls).toContain(`runtime.start:${on.container}`)
  expect(h.sched.stateOf(K)).toBe('running')
  // Not always-on: it stays asleep until traffic. Stopped by hand: a stop is a standing intent.
  expect(calls).not.toContain(`runtime.start:${off.container}`)
  expect(calls).not.toContain(`runtime.start:${held.container}`)
})

test('the always-on wake reads the setting as it is after the idle phase, not as the sweep began', async () => {
  // The idle phase awaits stops, which can take minutes. A setting switched while it runs must win
  // in both directions: switched to scale-to-zero, the service is NOT started; switched to
  // always-on, it is, in this same sweep. The engine hands back new target objects after every
  // state change, so the switch is a replaced object, not a mutated one.
  const h = harness()
  h.add('11111111-1111-1111-1111-111111111111:cp-busy', { container: 'io-x-app-busy' })
  const was = h.add(K, { alwaysOn: true, sleptAt: Date.now() })
  const now = h.add(K2, { sleptAt: Date.now() })
  vi.advanceTimersByTime(301_000)
  let entered = false
  let open = (): void => {}
  const gate = new Promise<void>((r) => { open = () => { r() } })
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (c, g) => { entered = true; await gate; return realStop(c, g) }

  const sweep = h.sched.sweep()
  for (let i = 0; i < 1000 && !entered; i++) await Promise.resolve()
  expect(entered).toBe(true)              // the idle phase is blocked inside its stop
  h.targets.set(K, { ...was, alwaysOn: false })
  h.targets.set(K2, { ...now, alwaysOn: true })
  open()
  await sweep
  await h.sched.withOp([K, K2], async () => { /* granted only once any wake has let go */ })

  expect(calls).not.toContain(`runtime.start:${was.container}`)
  expect(calls).toContain(`runtime.start:${now.container}`)
})

test('stop() waits for a wake the sweep started in the background', async () => {
  // The sweep does not await its always-on wakes, so shutdown has to: exiting while one is
  // evicting or starting would leave docker mid-change with nothing holding the key.
  const h = harness()
  const t = h.add(K, { alwaysOn: true, sleptAt: Date.now() })
  let open = (): void => {}
  const gate = new Promise<void>((r) => { open = () => { r() } })
  const realStart = h.runtime.start.bind(h.runtime)
  h.runtime.start = async (c) => { await gate; return realStart(c) }
  await h.sched.sweep()
  let stopped = false
  const stopping = h.sched.stop().then(() => { stopped = true })
  for (let i = 0; i < 100; i++) await Promise.resolve()
  expect(stopped).toBe(false)             // the wake is still inside docker start
  open()
  await stopping
  expect(calls).toContain(`runtime.start:${t.container}`)
})

test('an operation in flight on the key makes it no sweep candidate, and sleep refuses without queueing', async () => {
  const h = harness()
  const t = h.add(K)
  vi.advanceTimersByTime(301_000)
  let release = (): void => {}
  const held = new Promise<void>((r) => { release = () => { r() } })
  const op = h.sched.withOp([K], () => held)
  await h.sched.sweep()
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  // tryWithOp refuses rather than lining up behind the op (a stop that ran later would stop the
  // container the op had just created).
  expect(await h.sched.sleep(K, 'idle')).toBe(false)
  release()
  await op
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${t.container}:10`)
})

test('windows: compute 300 s, databases 600 s, a per-database override, and 0 disables', async () => {
  const h = harness()
  const web = h.add(K)
  const pg = h.add(PG, { kind: 'postgres', container: 'io-demo-main-pg-db', port: 5432, idleSec: 600 })
  const never = h.add(K2, { idleSec: 0 })
  vi.advanceTimersByTime(301_000)
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${web.container}:10`)          // compute window passed
  expect(calls).not.toContain(`runtime.stop:${pg.container}:30`)       // the database's has not
  vi.advanceTimersByTime(300_000)
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${pg.container}:30`)           // databases get the long grace
  expect(calls.some((c) => c.startsWith(`runtime.stop:${never.container}`))).toBe(false)
})

test('a service sleeps between 300 and 330 s after its last stamp, and touch restarts the clock', async () => {
  const h = harness({ INSTA_OSS_SWEEP_SEC: '30' })
  const t = h.add(K)
  vi.advanceTimersByTime(299_000)
  await h.sched.sweep()
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  h.sched.touch(K)                                    // one request lands: the window starts over
  vi.advanceTimersByTime(299_000)
  await h.sched.sweep()
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  vi.advanceTimersByTime(2_000)
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${t.container}:10`)
})

test('sleep stamps sleptAt, emits service.sleep with the BARE service id, and leaves desiredState alone', async () => {
  const h = harness()
  const t = h.add(K)
  expect(await h.sched.sleep(K, 'idle')).toBe(true)
  expect(h.slept.at(-1)?.[0]).toBe(K)
  expect(typeof h.slept.at(-1)?.[1]).toBe('number')
  expect(h.events).toEqual([{ key: K, kind: 'service.sleep', payload: { service: 'cp-web', reason: 'idle' } }])
  expect(t.desiredState).toBe('running')
  expect(calls).toContain(`upstream.forget:${t.container}`)
})

test('sleep on a created container marks it asleep without a docker stop; a paused one is refused', async () => {
  const h = harness()
  const t = h.add(K)
  h.runtime.put(t.container, 'created')
  expect(await h.sched.sleep(K, 'branch-create')).toBe(true)
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  expect(h.slept.at(-1)?.[1]).toBeTypeOf('number')

  h.runtime.put(t.container, 'paused')
  h.slept.length = 0
  expect(await h.sched.sleep(K, 'idle')).toBe(false)
  expect(h.slept).toEqual([])
})

test('onUp stamps, clears sleptAt through markSlept and drops the cached address', async () => {
  const h = harness()
  const t = h.add(K, { sleptAt: 123 })
  h.sched.onUp(K)
  expect(h.slept).toEqual([[K, null]])
  expect(calls).toContain(`upstream.forget:${t.container}`)
  expect(h.sched.stateOf(K)).toBe('running')
})

test('a user stop clears the sleep mark (a stop is not sleep) and a pause records paused', async () => {
  const h = harness()
  h.add(K, { sleptAt: 5 })
  h.sched.onStopped(K)
  expect(h.slept).toEqual([[K, null]])
  expect(h.sched.stateOf(K)).toBe('stopped')
  h.sched.onPaused(K)
  expect(h.sched.stateOf(K)).toBe('paused')
})

test('the sweep tells the upstream about a container whose id changed between ticks', async () => {
  const h = harness()
  const t = h.add(K)
  await h.sched.sweep()
  expect(calls).toContain(`upstream.checked:${t.container}:cid1`)
  h.runtime.replace(t.container, 'running')            // restarted by itself: same name, new id
  calls.length = 0
  await h.sched.sweep()
  expect(calls.some((c) => c.startsWith(`upstream.checked:${t.container}:`) && !c.endsWith(':cid1'))).toBe(true)
})

test('the sweep is inert while the boot data migration runs', async () => {
  const h = harness()
  h.add(K)
  h.setBooting(true)
  vi.advanceTimersByTime(301_000)
  await h.sched.sweep()
  expect(calls).toEqual([])
  h.setBooting(false)
  await h.sched.sweep()
  expect(calls.some((c) => c.startsWith('runtime.stop:'))).toBe(true)
})

// ---- boot ----------------------------------------------------------------------------------------

test('boot reconcile: a running container with a sleep mark is cleared, unknown keys get a full window', async () => {
  const h = harness({ INSTA_OSS_SCHEDULER: '0' })
  const t = h.add(K, { sleptAt: 999 })
  h.runtime.put(t.container, 'running')                // it came back up on its own
  h.sched.start()
  await vi.runOnlyPendingTimersAsync()
  expect(h.slept).toEqual([[K, null]])
  expect(h.sched.stateOf(K)).toBe('running')
  // ...and the fresh stamp means it is not swept for a full idle window after the restart.
  vi.advanceTimersByTime(299_000)
  await h.sched.sweep()
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
})

test('the create grace comes from the ROW, so a restart does not grant a fresh one', async () => {
  const h = harness({ INSTA_OSS_SCHEDULER: '0' })
  const old = h.add(K, { createdAt: Date.now() - 20 * 60_000 })   // created 20 min ago
  const young = h.add(K2, { createdAt: Date.now() - 60_000 })     // created 1 min ago
  h.sched.start()
  await vi.runOnlyPendingTimersAsync()
  vi.advanceTimersByTime(301_000)                                 // ONE idle window after the boot
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${old.container}:10`)
  expect(calls.some((c) => c.startsWith(`runtime.stop:${young.container}`))).toBe(false)
})

test('a candidate that answers a request while an earlier batch is stopping is left alone, and one failing stop costs only itself', async () => {
  const h = harness()
  // Six candidates, so the sweep runs two batches of four and two: the second batch starts only
  // after the first batch's docker stops have all been awaited.
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `11111111-1111-1111-1111-111111111111:cp-${n}` as const)
  const targets = keys.map((k, i) => h.add(k, { container: `io-x-app-${'abcdef'[i]}` }))
  vi.advanceTimersByTime(301_000)                                  // every one of them is idle now
  const late = keys[5]
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (c, g) => {
    if (c === targets[0].container) {
      h.sched.touch(late)                                          // a request lands mid-sweep
      throw new Error('docker stop timed out')                     // ...and this stop fails
    }
    await realStop(c, g)
  }
  await h.sched.sweep()
  const stopped = calls.filter((c) => c.startsWith('runtime.stop:')).map((c) => c.split(':')[1])
  // The failure cost one service, not the pass: b..e all slept.
  expect(stopped).toEqual(targets.slice(1, 5).map((t) => t.container))
  expect(targets[0].sleptAt).toBeNull()
  // ...and the one that answered a request is NOT stopped on a stamp taken before it did.
  expect(targets[5].sleptAt).toBeNull()
})

test('boot performs no eviction: nothing is stopped below the floor until the first sweep tick', async () => {
  const h = harness({ INSTA_OSS_SCHEDULER: '0', INSTA_OSS_RAM_FLOOR_PCT: '15' })
  const t = h.add(K)
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: 10 * MiB }   // far below the floor
  h.sched.start()
  await vi.runOnlyPendingTimersAsync()
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  // The first sweep is where the pressure pass lives.
  vi.advanceTimersByTime(4 * h.sched['cfg'].lanes.touchDebounceMs)
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${t.container}:10`)
})

// ---- wake ----------------------------------------------------------------------------------------

test('wake singleflight: 25 concurrent calls share one docker start and all resolve', async () => {
  const h = harness()
  const t = h.add(K)
  h.runtime.put(t.container, 'exited')
  let ready = false
  h.runtime.probeFn = () => ready
  const all = Promise.all(Array.from({ length: 25 }, () => h.sched.wake(K, { door: 'traffic' })))
  await vi.advanceTimersByTimeAsync(300)
  expect(calls.filter((c) => c === `runtime.start:${t.container}`)).toHaveLength(1)
  expect(h.sched.stateOf(K)).toBe('starting')
  ready = true
  await vi.advanceTimersByTimeAsync(300)
  await all
  expect(h.sched.stateOf(K)).toBe('running')
  expect(h.slept.at(-1)).toEqual([K, null])
  expect(h.events.at(-1)?.kind).toBe('service.wake')
  expect(h.events.at(-1)?.payload.service).toBe('cp-web')
  expect(h.events.at(-1)?.payload.door).toBe('traffic')
})

test('traffic never wakes a service the developer stopped or suspended; the api door proceeds', async () => {
  for (const desiredState of ['stopped', 'suspended'] as const) {
    calls.length = 0
    const h = harness()
    const t = h.add(K, { desiredState })
    h.runtime.put(t.container, 'exited')
    await expect(h.sched.wake(K, { door: 'traffic' })).rejects.toBeInstanceOf(ServiceStoppedError)
    expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])
    await h.sched.wake(K, { door: 'api' })
    expect(calls).toContain(`runtime.start:${t.container}`)
  }
})

test('a wake that never becomes ready is a WakeTimeoutError, the container is left running and the sleep mark untouched', async () => {
  const h = harness({ INSTA_OSS_WAKE_TIMEOUT_SEC: '2' })
  const t = h.add(K, { sleptAt: 7 })
  h.runtime.put(t.container, 'exited')
  h.runtime.probeFn = () => false
  const p = h.sched.wake(K, { door: 'api' })
  const settled = expect(p).rejects.toBeInstanceOf(WakeTimeoutError)
  await vi.advanceTimersByTimeAsync(3_000)
  await settled
  expect(h.runtime.stateOfContainer(t.container)).toBe('running')       // never rolled back
  expect(h.slept).toEqual([])                                          // sleptAt is still 7
  expect(h.sched.stateOf(K)).toBe('asleep')
})

test('a container that exits mid-wake ends the wake with an error, not a timeout', async () => {
  const h = harness({ INSTA_OSS_WAKE_TIMEOUT_SEC: '60' })
  const t = h.add(K)
  h.runtime.put(t.container, 'exited')
  h.runtime.probeFn = () => false
  const p = h.sched.wake(K, { door: 'api' })
  const settled = expect(p).rejects.toThrow(/exited during wake/)
  await vi.advanceTimersByTimeAsync(300)
  h.runtime.put(t.container, 'exited')                                 // it died on start-up
  await vi.advanceTimersByTimeAsync(600)
  await settled
})

test('a key with no container after the lock is taken throws NoContainerError and never starts anything', async () => {
  const h = harness()
  const t = h.add(K)
  h.runtime.drop(t.container)                                          // a deploy is between rm and create
  await expect(h.sched.wake(K, { door: 'api' })).rejects.toBeInstanceOf(NoContainerError)
  expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])
})

test('a wake onto a running, ready container is a no-op that only stamps', async () => {
  const h = harness()
  h.add(K, { sleptAt: 42 })
  h.runtime.put(fakeTarget({ key: K }).container, 'running')
  await h.sched.wake(K, { door: 'deploy' })
  expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])
  expect(h.slept).toEqual([[K, null]])                                 // the stale mark is cleared
  expect(h.events).toEqual([])                                         // no event for a no-op wake
})

test('the api door unpauses a paused container; traffic gets the suspended error instead', async () => {
  const h = harness()
  const t = h.add(K)
  h.runtime.put(t.container, 'paused')
  await expect(h.sched.wake(K, { door: 'traffic' })).rejects.toThrow(/suspended/)
  await h.sched.wake(K, { door: 'api' })
  expect(calls).toContain(`runtime.unpause:${t.container}`)
})

test('a sweep whose docker read FAILS stops nothing on the snapshot it already had', async () => {
  // `refreshStates` returns on a failed read and leaves the previous snapshot in place, so
  // `running` was indistinguishable from `running as of some time ago`. The sweep and the
  // eviction pass are the two decisions that act on it, and both act by STOPPING a container.
  const h = harness()
  const t = h.add(K)
  vi.advanceTimersByTime(301_000)
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${t.container}:10`)   // the readable baseline

  // Now docker stops answering. The snapshot still says what it said one read ago, and the
  // service is idle, so the pass used to pick it as a candidate and go on to `sleep()` it.
  const fresh = harness()
  const t2 = fresh.add(K)
  await fresh.sched.sweep()                                    // seed: running, and stamped now
  fresh.runtime.containers = async () => { throw new Error('Cannot connect to the Docker daemon') }
  const said: string[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { said.push(String(m)) })
  calls.length = 0
  vi.advanceTimersByTime(301_000)                              // idle, and the snapshot is old
  try {
    await fresh.sched.sweep()
  } finally {
    warn.mockRestore()
  }

  // The pass never entered `sleep()`: that would have re-read under the lock, failed, and said
  // so. Its re-read is a backstop, not a decision, and the decision is not taken on a fact this
  // daemon cannot vouch for. (The read failure itself IS reported, once.)
  expect(said.filter((m) => m.startsWith('warn: sleep '))).toEqual([])
  expect(said.some((m) => m.includes('could not read container states'))).toBe(true)
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  expect(t2.sleptAt ?? null).toBeNull()
})

test('a SLOW listing is dated when it was issued, and does not un-say what happened meanwhile', async () => {
  // Widening the cache update from one entry to the whole map bought the re-dating that keeps a
  // long eviction pass sighted, and brought two hazards with it. Both are about a read that is
  // in flight while the box moves: a listing describes the box as it was when it was ISSUED.
  const h = harness()
  const a = h.add(K, { idleSec: 10 })
  const b = h.add(K2, { idleSec: 10 })
  h.sched.touch(a.key)
  h.sched.touch(b.key)
  await h.sched.sweep()

  // A `docker ps -a` that takes ten seconds to answer -- the degraded docker this dating exists
  // for -- while a lifecycle stop completes on the OTHER key in that window.
  const listing = new Map([
    [a.container, { state: 'running' as const, id: 'cid-a' }],
    [b.container, { state: 'running' as const, id: 'cid-b' }],
  ])
  h.runtime.containers = async () => {
    vi.advanceTimersByTime(10_000)
    h.sched.onStopped(b.key)
    return listing
  }
  await h.sched.refreshStates()

  // The newer fact stands: the listing said `running` about B, but only as of before the stop.
  expect(h.sched.stateOf(b.key)).toBe('stopped')
  expect(h.sched.stateOf(a.key)).toBe('running')

  // ...and A's entry is ten seconds into its budget already, not freshly minted at read-return:
  // at exactly two sweep intervals from the ISSUE it is out of date and the sweep leaves it be.
  vi.advanceTimersByTime(60_000 - 10_000)
  h.runtime.containers = async () => { throw new Error('Cannot connect to the Docker daemon') }
  const said: string[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { said.push(String(m)) })
  try {
    await h.sched.sweep()
  } finally {
    warn.mockRestore()
  }
  expect(said.some((m) => m.startsWith('warn: sleep '))).toBe(false)
})

test('the freshness bound is a duration, and its BOUNDARY is closed', async () => {
  // The gate reads "no older than two sweep intervals", and the two are not the same sentence:
  // at exactly the bound the observation predates the SECOND consecutive failed read, which is
  // one more than the docstring allows. Nothing pinned it either way, and this gate has already
  // turned the memory floor off once, so the boundary is a test rather than a reading.
  const bound = 60_000                                        // 2 x the 30 s default sweep
  for (const [age, acted] of [[bound - 1, true], [bound, false]] as const) {
    const h = harness()
    const t = h.add(K, { idleSec: 10 })
    h.sched.touch(t.key)
    await h.sched.sweep()                                     // seeds the snapshot; not idle yet
    h.runtime.containers = async () => { throw new Error('Cannot connect to the Docker daemon') }
    vi.advanceTimersByTime(age)                               // idle now, and the snapshot is `age` old
    const said: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { said.push(String(m)) })
    try {
      await h.sched.sweep()
    } finally {
      warn.mockRestore()
    }
    // Entering `sleep()` is the observable: it re-reads under the lock, fails, and says so.
    // That the backstop then catches it is not the point -- the pass should not have acted.
    expect(said.some((m) => m.startsWith('warn: sleep ')), `age ${age}`).toBe(acted)
  }
})

test('the pressure pass evicts after a REALISTIC sleep phase, not only against a fresh snapshot', async () => {
  // Every other eviction case here runs the pressure pass moments after the sweep's own read,
  // which is why a freshness gate that can never pass in production still looked fine. In a
  // real sweep the sleep phase comes first and AWAITS a stop per candidate, each able to burn
  // its whole grace (10 s compute, 30 s databases), so the pass is reached minutes after that
  // read. Gating `isVictim` on evidence that is stale by construction at the point of use
  // turned memory-pressure eviction off entirely, with docker answering every call.
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '50' })
  for (let i = 0; i < 12; i++) h.add(`${'2'.repeat(8)}-2222-2222-2222-${'2'.repeat(12)}:cp-idle${i}`)
  // Not an idle candidate (touched inside its idle window) and still a victim (no traffic right
  // now): what the pressure pass exists to reach once the idle ones are already asleep.
  const busy = h.add(K)
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: 100 * MiB }
  vi.advanceTimersByTime(301_000)
  h.sched.touch(busy.key)
  vi.advanceTimersByTime(20_000)

  // Each stop burns its grace, which is what makes the snapshot old by the time the pass runs.
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (container, grace) => { vi.advanceTimersByTime(10_000); return realStop(container, grace) }
  calls.length = 0
  await h.sched.sweep()

  // The twelve idle ones slept, and the pass that follows them still evicted.
  expect(calls.filter((c) => c.startsWith('runtime.stop:')).length).toBe(13)
  expect(calls).toContain(`runtime.stop:${busy.container}:10`)
  expect(h.slept.map(([key]) => key)).toContain(busy.key)
})

test('nothing can START while the floor cannot be enforced, so skipping the pass is bounded', async () => {
  // The question skipping the pass raises: can the RAM floor go unenforced indefinitely? No,
  // and this is the reason. The thing that grows memory is a wake, and `wakeLocked` reads
  // `runtime.containers()` itself before it evicts or starts anything, so the same unreadable
  // docker that makes the pass inert also fails the wake outright. The pass is only inert for
  // as long as nothing can start either.
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '50' })
  h.add(K2)
  const waking = h.add(K)
  h.runtime.put(waking.container, 'exited')
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: 100 * MiB }
  await h.sched.sweep()                                        // seed the snapshot
  vi.advanceTimersByTime(301_000)                              // ...and let it go stale
  h.runtime.containers = async () => { throw new Error('Cannot connect to the Docker daemon') }
  calls.length = 0

  await expect(h.sched.wake(K, { door: 'traffic' })).rejects.toThrow(/Cannot connect to the Docker daemon/)
  expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])
  // ...and the stale snapshot evicted nobody on the way past.
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
})

test('a wake needing room evicts BEFORE it starts: the victim is down before the container comes up', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '50' })
  const victim = h.add(K2)
  const waking = h.add(K)
  h.runtime.put(waking.container, 'exited')
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: 100 * MiB }
  await h.sched.sweep()                                       // seed the snapshot; both are known
  calls.length = 0
  vi.advanceTimersByTime(20_000)                              // past the no-recent-traffic guard
  let releaseStop = (): void => {}
  const stopGate = new Promise<void>((r) => { releaseStop = () => { r() } })
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (container, grace) => { calls.push(`stop.enter:${container}`); await stopGate; await realStop(container, grace) }
  const p = h.sched.wake(K, { door: 'traffic' })
  await vi.advanceTimersByTimeAsync(50)
  expect(calls).toContain(`stop.enter:${victim.container}`)
  // The whole point of the floor: the victim's memory is released before the waking container
  // claims any. Started concurrently, both are resident at once, which is the overshoot the
  // floor exists to prevent.
  expect(calls).not.toContain(`runtime.start:${waking.container}`)
  releaseStop()
  await vi.advanceTimersByTimeAsync(50)
  await p
  expect(calls).toContain(`runtime.start:${waking.container}`)
  expect(calls.findIndex((c) => c.startsWith(`runtime.stop:${victim.container}`)))
    .toBeLessThan(calls.indexOf(`runtime.start:${waking.container}`))
})

test('eviction keeps going past 32 victims: the old cap gave up with the floor unmet', async () => {
  // The loop used to give up after 32 turns and fall through in silence, so a wake on a box
  // with more services than that could start with the floor still uncleared while eligible
  // victims remained. Distinct from an empty pool, which proceeds on purpose.
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '50' })
  const waking = h.add(K)
  h.runtime.put(waking.container, 'exited')
  h.runtime.rss.set(waking.container, 5 * MiB)
  for (let i = 0; i < 45; i++) {
    const v = h.add(`22222222-2222-2222-2222-222222222222:cp-v${i}`)
    h.runtime.rss.set(v.container, 10 * MiB)
  }
  await h.sched.sweep()                                       // seeds lastRssBytes; memory() is null, so no pressure pass
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: 100 * MiB }
  calls.length = 0
  vi.advanceTimersByTime(20_000)                              // past the no-recent-traffic guard

  await h.sched.wake(K, { door: 'traffic' })

  // 100 MiB free, a 500 MiB floor and a 5 MiB waking service needs 405 MiB back at 10 MiB a
  // victim: 41 evictions, which the old cap could not reach.
  const stopped = calls.filter((c) => c.startsWith('runtime.stop:')).length
  expect(stopped).toBeGreaterThanOrEqual(41)
  expect(calls).toContain(`runtime.start:${waking.container}`)
  // ...and it stopped when the floor was met rather than emptying the pool.
  expect(stopped).toBeLessThan(45)
})

test('a long eviction pass re-dates its evidence as it goes, instead of going blind mid-loop', async () => {
  // The other half of the same defect, and the half a single read before the pass does not
  // cover: each turn AWAITS a stop, so a pass that needs forty of them takes minutes of clock.
  // The freshness gate is re-evaluated every turn, so evidence dated once at the top goes stale
  // around turn six and the pool empties with the floor unmet -- which reads as "no service can
  // be evicted" while a dozen are running. Every full `containers()` read re-dates the whole
  // snapshot, and `sleep()` makes one per turn, so the pass stays sighted for its whole length.
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '50' })
  const waking = h.add(K)
  h.runtime.put(waking.container, 'exited')
  h.runtime.rss.set(waking.container, 5 * MiB)
  for (let i = 0; i < 45; i++) {
    const v = h.add(`22222222-2222-2222-2222-222222222222:cp-v${i}`)
    h.runtime.rss.set(v.container, 10 * MiB)
  }
  await h.sched.sweep()                                       // seeds lastRssBytes; memory() is null, so no pressure pass
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: 100 * MiB }
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (container, grace) => { vi.advanceTimersByTime(10_000); return realStop(container, grace) }
  calls.length = 0
  vi.advanceTimersByTime(20_000)                              // past the no-recent-traffic guard

  // Seven minutes of pass against a 60 s caller budget: the caller is released long before it
  // ends, and the pass finishes under the lock.
  expect(await wakeFully(h, K)).toBe('released')

  // The same 41 the fixed ceiling case needs, over a pass that now spans seven minutes.
  const stopped = calls.filter((c) => c.startsWith('runtime.stop:')).length
  expect(stopped).toBeGreaterThanOrEqual(41)
  expect(calls).toContain(`runtime.start:${waking.container}`)
})

test('eviction does not give up when the target set grows under it', async () => {
  // Every `sleep()` waits out a stop grace, so the loop is seconds long, and a deploy that
  // commits in that window registers a new running service. A bound computed once at the start
  // is then too small and the loop gives up with the floor unmet and victims still available:
  // the same silent give-up as the old cap of 32, reached through concurrency.
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '50' })
  const waking = h.add(K)
  h.runtime.put(waking.container, 'exited')
  let n = 0
  const addVictim = (): string => {
    const key = `33333333-3333-3333-3333-333333333333:cp-v${n++}`
    h.add(key)
    return key
  }
  for (let i = 0; i < 20; i++) addVictim()                    // 21 targets: a once-computed bound of 22
  await h.sched.sweep()                                       // seeds the runtime snapshot; mem is null, so no pressure pass
  h.runtime.mem = { totalBytes: 20_000 * MiB, availableBytes: 100 * MiB }
  calls.length = 0
  vi.advanceTimersByTime(20_000)                              // past the no-recent-traffic guard

  // Services keep arriving while the loop runs, exactly as a deploy registering one would
  // (`onUp` is what a deploy calls), and time moves on with each stop grace, so each becomes
  // eligible once it is past the wake-protection window.
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (container: string, grace: number) => {
    if (n < 60) h.sched.onUp(addVictim())
    vi.advanceTimersByTime(20_000)
    return realStop(container, grace)
  }

  await wakeFully(h, K)

  // 100 MiB free against a 10,000 MiB floor, freeing the 256 MiB default per victim: about 40
  // evictions, which a bound frozen at 22 cannot reach.
  const stopped = calls.filter((c) => c.startsWith('runtime.stop:')).length
  expect(stopped).toBeGreaterThan(22)
  expect(calls).toContain(`runtime.start:${waking.container}`)
})

test('the eviction guard is a CONSTANT: a pool that grows every turn still terminates', async () => {
  // The distinguishing case between the three forms this guard has had. A bound sampled once is
  // too small when the set grows; a bound re-read from `targets().length` in the loop condition
  // grows WITH the set it is bounding, so a pool that gains a candidate every turn is never
  // bounded by it at all. A constant is finite by inspection, and this is the case that tells
  // the two apart: services arrive as fast as they are evicted, and the loop still stops.
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '50' })
  const waking = h.add(K)
  h.runtime.put(waking.container, 'exited')
  let n = 0
  const addVictim = (): string => {
    const key = `44444444-4444-4444-4444-444444444444:cp-v${n++}`
    h.add(key)
    return key
  }
  for (let i = 0; i < 5; i++) addVictim()
  await h.sched.sweep()
  // A floor this loop cannot reach by evicting: a 50% floor of 4 TiB against victims worth
  // 256 MiB each is 16,384 evictions, more than the ceiling, so the ceiling is what stops it.
  h.runtime.mem = { totalBytes: 8 * 1024 * 1024 * MiB, availableBytes: 1 * MiB }
  calls.length = 0
  vi.advanceTimersByTime(20_000)

  // Every stop registers another running service, for ever: the pool never empties.
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (container: string, grace: number) => {
    h.sched.onUp(addVictim())
    vi.advanceTimersByTime(20_000)
    return realStop(container, grace)
  }

  await wakeFully(h, K)

  // It stopped, and it stopped AT the ceiling: neither of the two earlier forms could.
  const stopped = calls.filter((c) => c.startsWith('runtime.stop:')).length
  expect(stopped).toBe(EVICTION_CEILING)
  expect(calls).toContain(`runtime.start:${waking.container}`)
}, 120_000)

test('a wake releases its caller at the BOUND, not when a long eviction finishes', async () => {
  // `wakeTimeoutSec` is the bound on a HELD connection (spec :144, contract :179-188) and it
  // used to start at the readiness wait -- the last of three phases. Eviction runs before it,
  // sequentially, a stop grace per turn, so exactly under the memory pressure that makes the
  // bound matter a socket could stay open for minutes and then still be granted a full
  // readiness budget on top.
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '50' })
  const waking = h.add(K)
  h.runtime.put(waking.container, 'exited')
  h.runtime.rss.set(waking.container, 5 * MiB)
  for (let i = 0; i < 45; i++) {
    const v = h.add(`55555555-5555-5555-5555-555555555555:cp-v${i}`)
    h.runtime.rss.set(v.container, 10 * MiB)
  }
  await h.sched.sweep()
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: 100 * MiB }
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (container, grace) => { vi.advanceTimersByTime(10_000); return realStop(container, grace) }
  calls.length = 0
  vi.advanceTimersByTime(20_000)

  // 41 victims at a 10 s grace each is nearly seven minutes of eviction. The caller waits 60.
  const t0 = Date.now()
  await expect(h.sched.wake(K, { door: 'traffic' })).rejects.toBeInstanceOf(WakeTimeoutError)
  const heldMs = Date.now() - t0
  const stoppedWhenReleased = calls.filter((c) => c.startsWith('runtime.stop:')).length
  expect(heldMs).toBeLessThanOrEqual(60_000)
  expect(stoppedWhenReleased).toBeLessThan(41)                 // released mid-eviction...
  expect(calls).not.toContain(`runtime.start:${waking.container}`)

  // ...and the wake was NOT cancelled with it: it keeps the operation lock and runs to the end,
  // because a half-done eviction is a worse thing to leave behind than a wake nobody awaits.
  await h.sched.withOp([K], async () => { /* granted only once the wake has let go */ })
  expect(calls.filter((c) => c.startsWith('runtime.stop:')).length).toBeGreaterThanOrEqual(41)
  expect(calls).toContain(`runtime.start:${waking.container}`)
})

test('a wake with NO victim available still starts: no room found is not a failure', async () => {
  // The whole fail-closed change above rests on this distinction. `evictForRoom` warns and
  // returns when it can find nothing to evict, and only THROWS when making room actually broke.
  // If "no victim" threw, every wake on a box under the floor with one always-on service would
  // fail instead of running slightly over it, which is the opposite of what the floor is for.
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '50' })
  const waking = h.add(K)
  h.runtime.put(waking.container, 'exited')
  // The only other service is always-on, so it is never a candidate: the pool is empty.
  const pinned = h.add(K2, { alwaysOn: true })
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: 100 * MiB }
  await h.sched.sweep()
  calls.length = 0
  vi.advanceTimersByTime(20_000)

  await h.sched.wake(K, { door: 'traffic' })

  expect(calls).toContain(`runtime.start:${waking.container}`)
  expect(calls.some((c) => c.startsWith(`runtime.stop:${pinned.container}`))).toBe(false)
})

test('a wake whose eviction FAILS does not start the container anyway', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '50' })
  const victim = h.add(K2)
  const waking = h.add(K)
  h.runtime.put(waking.container, 'exited')
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: 100 * MiB }
  await h.sched.sweep()
  calls.length = 0
  vi.advanceTimersByTime(20_000)
  h.runtime.stop = async (container: string) => { calls.push(`stop.enter:${container}`); throw new Error('docker stop failed') }

  await expect(h.sched.wake(K, { door: 'traffic' })).rejects.toThrow(/could not make room to wake/)
  expect(calls).toContain(`stop.enter:${victim.container}`)
  expect(calls).not.toContain(`runtime.start:${waking.container}`)
})

test('a wake that arrives during a sleep queues behind the stop and then starts the container', async () => {
  const h = harness()
  const t = h.add(K)
  let releaseStop = (): void => {}
  const stopGate = new Promise<void>((r) => { releaseStop = () => { r() } })
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (container, grace) => { await stopGate; await realStop(container, grace) }
  const sleeping = h.sched.sleep(K, 'idle')
  await vi.advanceTimersByTimeAsync(1)
  expect(h.sched.stateOf(K)).toBe('asleep')                             // deterministic while stopping
  const waking = h.sched.wake(K, { door: 'traffic' })
  await vi.advanceTimersByTimeAsync(1)
  expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])
  releaseStop()
  expect(await sleeping).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  await waking
  expect(calls.indexOf(`runtime.start:${t.container}`)).toBeGreaterThan(calls.indexOf(`runtime.stop:${t.container}:10`))
  expect(h.sched.stateOf(K)).toBe('running')
})

test('a wake behind an operation re-reads afterwards: no start when the op left it running, a start when it left it created', async () => {
  // The op ends in onUp (a deploy that started the replacement): the wake is a no-op.
  const h = harness()
  const t = h.add(K)
  h.runtime.put(t.container, 'exited')
  let release = (): void => {}
  const gate = new Promise<void>((r) => { release = () => { r() } })
  const op = h.sched.withOp([K], async () => { await gate; h.runtime.put(t.container, 'running'); h.sched.onUp(K) })
  const waking = h.sched.wake(K, { door: 'traffic' })
  await vi.advanceTimersByTimeAsync(1)
  expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])
  release()
  await op
  await vi.advanceTimersByTimeAsync(1)
  await waking
  expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])

  // The op ends in a created container (a clone deployed with start:false): the wake starts it.
  const h2 = harness()
  const t2 = h2.add(K)
  let release2 = (): void => {}
  const gate2 = new Promise<void>((r) => { release2 = () => { r() } })
  const op2 = h2.sched.withOp([K], async () => { await gate2; h2.runtime.put(t2.container, 'created'); h2.sched.onAsleep(K, 'branch-create') })
  const waking2 = h2.sched.wake(K, { door: 'traffic' })
  release2()
  await op2
  await vi.advanceTimersByTimeAsync(1)
  await waking2
  expect(calls).toContain(`runtime.start:${t2.container}`)
})

test('an operation arriving during a wake runs only after the wake settles', async () => {
  const h = harness()
  const t = h.add(K)
  h.runtime.put(t.container, 'exited')
  let ready = false
  h.runtime.probeFn = () => ready
  const waking = h.sched.wake(K, { door: 'api' })
  const op = h.sched.withOp([K], async () => { calls.push('op.ran') })
  await vi.advanceTimersByTimeAsync(300)
  expect(calls).not.toContain('op.ran')          // the op is queued behind the wake, not inside it
  ready = true
  await vi.advanceTimersByTimeAsync(300)
  await waking
  await op
  // `upstream.forget` is the wake's last act (onUp), so the op ran strictly after it settled.
  expect(calls.indexOf('op.ran')).toBeGreaterThan(calls.indexOf(`upstream.forget:${t.container}`))
})

// ---- the operation lock --------------------------------------------------------------------------

test('re-entrancy: a wake inside withOp on the same key does not deadlock, and nested multi-key ops run once', async () => {
  const h = harness()
  const t = h.add(K)
  h.runtime.put(t.container, 'exited')
  await h.sched.withOp([K], () => h.sched.wake(K, { door: 'api' }))
  expect(calls).toContain(`runtime.start:${t.container}`)

  let ran = 0
  await h.sched.withOp([K, K2], () => h.sched.withOp([K2], async () => { ran++ }))
  expect(ran).toBe(1)
})

test('two multi-key ops naming the same keys in different orders both complete (sorted acquisition)', async () => {
  const h = harness()
  h.add(K); h.add(K2)
  const order: string[] = []
  const a = h.sched.withOp([K, K2], async () => { order.push('a-in'); await Promise.resolve(); order.push('a-out') })
  const b = h.sched.withOp([K2, K], async () => { order.push('b-in'); order.push('b-out') })
  await Promise.all([a, b])
  expect(order).toEqual(['a-in', 'a-out', 'b-in', 'b-out'])
})

test('the lock is exclusive per key and unrelated keys stay concurrent', async () => {
  const h = harness()
  h.add(K); h.add(K2)
  const order: string[] = []
  let release = (): void => {}
  const gate = new Promise<void>((r) => { release = () => { r() } })
  const first = h.sched.withOp([K], async () => { order.push('first-in'); await gate; order.push('first-out') })
  const second = h.sched.withOp([K], async () => { order.push('second') })
  const other = h.sched.withOp([K2], async () => { order.push('other') })
  await vi.advanceTimersByTimeAsync(1)
  expect(order).toEqual(['first-in', 'other'])       // K2 never waited on K
  release()
  await Promise.all([first, second, other])
  expect(order).toEqual(['first-in', 'other', 'first-out', 'second'])
})

test('a failed operation does not wedge the key', async () => {
  const h = harness()
  h.add(K)
  await expect(h.sched.withOp([K], () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
  let ran = false
  await h.sched.withOp([K], async () => { ran = true })
  expect(ran).toBe(true)
})

// ---- eviction ------------------------------------------------------------------------------------

/** Pressure with a synthetic total: `available` is what the test sets, so the pool decides. */
function pressure(h: Harness, availableMiB: number): void {
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: availableMiB * MiB }
}

test('eviction picks the least recently active service and stops once free memory is back above the floor', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20' })
  const oldest = h.add(K)
  const newer = h.add(K2)
  await h.sched.sweep()
  calls.length = 0
  vi.advanceTimersByTime(20_000)
  h.sched.touch(K2)                                    // K2 is the busier one
  vi.advanceTimersByTime(20_000)
  pressure(h, 100)
  // Each stop frees 150 MiB in this fake, so ONE eviction is enough.
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (c, g) => { await realStop(c, g); pressure(h, 250) }
  await h.sched.evictForRoom(0, new Set())
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([`runtime.stop:${oldest.container}:10`])
  expect(newer.sleptAt).toBeNull()
  expect(h.events.map((e) => e.payload.reason)).toEqual(['memory'])
})

test('one pass stops ONE service when the runtime cannot see the memory it just freed', async () => {
  // Budget mode: `memory()` answers `budget - lastRssTotal`, and that total is only re-sampled by
  // stats(), so nothing improves inside the pass. The pass must still stop the least recently
  // active service and then stop, not drain the pool.
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20' })
  const oldest = h.add(K)
  const newer = h.add(K2)
  const third = h.add('11111111-1111-1111-1111-111111111111:cp-third', { container: 'io-x-app-third' })
  await h.sched.sweep()
  vi.advanceTimersByTime(20_000)
  h.sched.touch(K2)
  h.sched.touch('11111111-1111-1111-1111-111111111111:cp-third')
  vi.advanceTimersByTime(20_000)
  calls.length = 0
  pressure(h, 100)                                     // 100 MiB free against a 200 MiB floor
  await h.sched.evictForRoom(0, new Set())             // no stop hook: memory never improves
  // One compute default RSS (256 MiB) covers the 100 MiB gap, so one victim is enough.
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([`runtime.stop:${oldest.container}:10`])
  expect(newer.sleptAt).toBeNull()
  expect(third.sleptAt).toBeNull()
})

test('a 0 RAM floor disables the pressure pass everywhere: the sweep and a wake both stop nothing', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '0', INSTA_OSS_IDLE_COMPUTE_SEC: '0', INSTA_OSS_IDLE_DB_SEC: '0' })
  const idle = h.add(K)
  const waking = h.add(K2)
  h.runtime.put(waking.container, 'exited')
  await h.sched.sweep()
  pressure(h, 1)                                       // as far under any floor as it gets
  vi.advanceTimersByTime(60_000)
  await h.sched.sweep()
  await h.sched.wake(K2, { door: 'api' })
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  expect(idle.sleptAt ?? null).toBeNull()
})

test('eviction skips alwaysOn, paused, user-stopped, excluded and not-running services', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20' })
  const always = h.add('b:cp-always', { alwaysOn: true, container: 'io-x-app-always' })
  const paused = h.add('b:cp-paused', { container: 'io-x-app-paused' })
  const stopped = h.add('b:cp-stopped', { desiredState: 'stopped', container: 'io-x-app-stopped' })
  const excluded = h.add('b:cp-excluded', { container: 'io-x-app-excluded' })
  await h.sched.sweep()
  h.runtime.put(paused.container, 'paused')
  await h.sched.sweep()
  calls.length = 0
  vi.advanceTimersByTime(20_000)
  pressure(h, 100)
  await h.sched.evictForRoom(0, new Set(['b:cp-excluded']))
  const stops = calls.filter((c) => c.startsWith('runtime.stop:'))
  for (const t of [always, paused, stopped, excluded]) {
    expect(stops.some((c) => c.includes(t.container)), t.container).toBe(false)
  }
})

test('eviction hard guards: a just-woken service, a freshly stamped one and a held one are never the victim', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20', INSTA_OSS_WAKE_PROTECT_SEC: '60' })
  const woken = h.add(K)
  const held = h.add(K2)
  await h.sched.sweep()
  calls.length = 0
  h.sched.onUp(K)                                       // woken just now
  h.sched.beginHold(K2)
  vi.advanceTimersByTime(20_000)                        // past the recent-traffic guard for both
  pressure(h, 100)
  await h.sched.evictForRoom(0, new Set())
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])   // empty pool, one log line
  // The hold going away makes it a candidate; wake protection still shields the other one.
  h.sched.endHold(K2)
  await h.sched.evictForRoom(0, new Set())
  expect(calls).toContain(`runtime.stop:${held.container}:10`)
  expect(calls.some((c) => c.startsWith(`runtime.stop:${woken.container}`))).toBe(false)
})

test('two services that do not fit together do not ping-pong: the second wake proceeds with an empty pool', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20', INSTA_OSS_WAKE_PROTECT_SEC: '60' })
  const a = h.add(K)
  const b = h.add(K2)
  h.runtime.put(b.container, 'exited')
  await h.sched.sweep()
  calls.length = 0
  h.sched.onUp(K)                                       // A was woken a moment ago
  vi.advanceTimersByTime(20_000)
  pressure(h, 100)                                      // still under the floor whatever we stop
  await h.sched.wake(K2, { door: 'traffic' })
  expect(calls).toContain(`runtime.start:${b.container}`)               // the wake still proceeds
  expect(calls.some((c) => c.startsWith(`runtime.stop:${a.container}`))).toBe(false)
})

test('a stamp inside two touch-debounce windows protects a service under load', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20' })
  const t = h.add(K)
  await h.sched.sweep()
  calls.length = 0
  vi.advanceTimersByTime(20_000)
  h.sched.touch(K)                                      // answered a request 0 s ago
  pressure(h, 100)
  await h.sched.evictForRoom(0, new Set())
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  vi.advanceTimersByTime(11_000)                        // 2 * touchDebounceMs later it is fair game
  await h.sched.evictForRoom(0, new Set())
  expect(calls).toContain(`runtime.stop:${t.container}:10`)
})

test('eviction is disabled when the box cannot report memory, and the synthetic budget enables it', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20' })
  h.add(K)
  await h.sched.sweep()
  calls.length = 0
  vi.advanceTimersByTime(20_000)
  h.runtime.mem = null
  await h.sched.evictForRoom(500 * MiB, new Set())
  expect(calls).toEqual([])
  pressure(h, 100)
  await h.sched.evictForRoom(0, new Set())
  expect(calls.some((c) => c.startsWith('runtime.stop:'))).toBe(true)
})

test('a wake asks for room sized by the last RSS sample, the recorded limit, or the per-kind default', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '10' })
  const t = h.add(K)
  h.runtime.rss.set(t.container, 700 * MiB)
  await h.sched.sweep()                                  // records lastRssBytes
  h.runtime.put(t.container, 'exited')
  const other = h.add(K2)
  h.runtime.put(other.container, 'running')
  await h.sched.sweep()
  calls.length = 0
  vi.advanceTimersByTime(20_000)
  pressure(h, 500)                                       // above the floor, but not by 700 MiB
  await h.sched.wake(K, { door: 'api' })
  expect(calls).toContain(`runtime.stop:${other.container}:10`)   // room was made for the sample
})

// ---- bookkeeping ---------------------------------------------------------------------------------

test('holds count up and down, and forget/rekey move the record', async () => {
  const h = harness()
  h.add(K)
  expect(h.sched.holds(K)).toBe(0)
  h.sched.beginHold(K); h.sched.beginHold(K)
  expect(h.sched.holds(K)).toBe(2)
  h.sched.endHold(K); h.sched.endHold(K)
  expect(h.sched.holds(K)).toBe(0)

  h.sched.beginHold(K)
  h.sched.rekey(K, K2)
  expect(h.sched.holds(K)).toBe(0)
  expect(h.sched.holds(K2)).toBe(1)
  h.sched.forget([K2])
  expect(h.sched.holds(K2)).toBe(0)
})

test('stateOf maps the snapshot, the sleep mark and the desired state; an unknown key is none', async () => {
  const h = harness()
  const t = h.add(K)
  expect(h.sched.stateOf('nobody:cp-x')).toBe('none')
  await h.sched.sweep()
  expect(h.sched.stateOf(K)).toBe('running')
  h.runtime.put(t.container, 'restarting')
  await h.sched.sweep()
  expect(h.sched.stateOf(K)).toBe('starting')
  h.runtime.put(t.container, 'exited')
  await h.sched.sweep()
  expect(h.sched.stateOf(K)).toBe('stopped')            // exited with no sleep mark
  h.targets.get(K)!.sleptAt = Date.now()
  expect(h.sched.stateOf(K)).toBe('asleep')             // ...and with one, it is standby
  h.runtime.drop(t.container)
  await h.sched.sweep()
  expect(h.sched.stateOf(K)).toBe('none')
})

test('the ticker sweeps on its own interval and stop() ends it', async () => {
  const h = harness({ INSTA_OSS_SWEEP_SEC: '1', INSTA_OSS_SCHEDULER: '1' })
  const t = h.add(K)
  h.sched.start()
  await vi.advanceTimersByTimeAsync(301_000)
  expect(calls).toContain(`runtime.stop:${t.container}:10`)
  await h.sched.stop()
  h.runtime.put(t.container, 'running')
  h.sched.touch(K)
  calls.length = 0
  await vi.advanceTimersByTimeAsync(301_000)
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
})

test('the ticker never starts when INSTA_OSS_SCHEDULER=0, but wake and sleep still work on demand', async () => {
  const h = harness({ INSTA_OSS_SCHEDULER: '0' })
  const t = h.add(K)
  h.sched.start()
  await vi.advanceTimersByTimeAsync(600_000)
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  expect(await h.sched.sleep(K, 'idle')).toBe(true)
  await h.sched.wake(K, { door: 'api' })
  expect(calls).toContain(`runtime.start:${t.container}`)
})

// The door and reason unions are part of the contract the engine and the router code against.
test('the door and reason unions are the four doors and the three reasons', () => {
  const doors: WakeDoor[] = ['traffic', 'api', 'deploy']
  const reasons: SleepReason[] = ['idle', 'memory', 'branch-create']
  expect(doors).toHaveLength(3)
  expect(reasons).toHaveLength(3)
})


// ---- a docker call that outran its deadline -----------------------------------------------------

test('a timed-out docker call is KILLED and waited for: nothing acts after the caller unwinds', async () => {
  // The wrapper used to reject its own promise and walk away, leaving the child running. The
  // caller then released its operation key while a process it had started could still act, and
  // that process acts on a NAME: a late `stop` stops whatever holds the name by then, which
  // after a deploy is the replacement container. Same family as the wake bound, one layer down.
  let killed = false
  let exited = false
  let endChild!: () => void
  const done = new Promise<string>((_, reject) => { endChild = () => { exited = true; reject(new Error('killed')) } })
  const call = {
    done,
    // A real child does not vanish on the signal: it is reaped a moment later, and it is THAT
    // moment the caller may not run before.
    kill: () => { killed = true; setTimeout(endChild, 50) },
  }

  let settled = false
  const p = withTimeout(call, 10, 'stop').then(
    () => { settled = true },
    () => { settled = true },
  )
  await vi.advanceTimersByTimeAsync(20)
  expect(killed).toBe(true)
  expect(exited).toBe(false)
  expect(settled, 'the caller must not be released while its child is still alive').toBe(false)

  await vi.advanceTimersByTimeAsync(60)
  await p
  expect(exited).toBe(true)
  expect(settled).toBe(true)
  await expect(withTimeout({ done: Promise.reject(new Error('killed')), kill: () => {} }, 10, 'stop').catch((e: unknown) => (e as Error).message))
    .resolves.toContain('killed')
})

test('a timed-out docker call reports the timeout, not the child\'s own dying error', async () => {
  // Built at the moment it is awaited: a rejected promise left lying about is an unhandled
  // rejection warning, not a test.
  const failing = (): { done: Promise<string>; kill: () => void } =>
    ({ done: Promise.reject(new Error('signal SIGKILL')), kill: () => {} })
  // Expired first, so the caller is told what actually happened to its command.
  const slow = { done: new Promise<string>((_, reject) => { setTimeout(() => { reject(new Error('signal SIGKILL')) }, 30) }), kill: () => {} }
  // The handler is attached BEFORE the clock moves: a rejection that lands while nothing is
  // waiting on it is an unhandled rejection, and vitest fails the run for it (it did, in CI,
  // where the turn ordering differs from here).
  const p = withTimeout(slow, 10, 'stop')
  const rejects = expect(p).rejects.toThrow(/docker stop timed out after 10 ms \(the command was killed and has exited\)/)
  await vi.advanceTimersByTimeAsync(40)
  await rejects
  // ...and a call that fails on its own, inside the deadline, keeps its own error.
  await expect(withTimeout(failing(), 10_000, 'stop')).rejects.toThrow(/signal SIGKILL/)
})
