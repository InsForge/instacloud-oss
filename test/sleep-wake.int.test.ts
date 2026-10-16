// Integration (real Docker): sleep is a clean `docker stop` and wake really brings the service back.
// The fake-adapter suite (test/scheduler.test.ts) pins the DECISIONS; this file pins the six things
// only a real container can answer:
//
//   1. a Postgres told to stop within its grace shuts down cleanly ("database system is shut down"),
//      and its data is there after the wake, so sleep is not data loss;
//   2. a container created and never started (a clone, asleep from birth) wakes into `running` with
//      its port accepting;
//   3. `docker update` applies a cgroup ceiling to a STOPPED container, which is what makes
//      `insta compute limits` work on a sleeping service;
//   4. stopping a signal-forwarding container finishes well inside the grace, instead of costing the
//      whole window and a SIGKILL;
//   5. the ticker sleeps a really idle container on its own, and traffic never wakes a stopped one;
//   6. the pressure pass stops the least recently active container when the budget says the box is
//      full.
//
// Run by the integrator only (`RUN_DOCKER_TESTS=1`), one Docker file at a time. This file runs the
// TICKER (`INSTA_OSS_SCHEDULER=1`, set explicitly) with `INSTA_OSS_RAM_FLOOR_PCT=0`, so the idle
// sweep is live but no pressure pass can stop the containers under test: a floor of 0 is the off
// switch for eviction on the sweep and on the wake path alike (decision 12). The eviction case owns
// its own config, with a floor of 90 and a synthetic `INSTA_OSS_MEM_BUDGET_MB` instead of the
// host's real memory.
import { test, expect, afterAll, beforeAll } from 'vitest'
import { docker } from '../src/docker'
import { loadConfig } from '../src/config'
import { DockerCompute } from '../src/adapters/compute'
import { LocalPostgres } from '../src/adapters/postgres'
import { DockerRuntime, Scheduler, type ServiceTarget } from '../src/scheduler'
import { Upstream } from '../src/upstream'
import type { ServiceKey } from '../src/types'

const REF = 'sleepint-main'
const NETWORK = `io-${REF}`
const PG = `io-${REF}-pg-db`
const APP = `io-${REF}-app-web`
const APP_PORT = 18097

const compute = new DockerCompute()
const postgres = new LocalPostgres()

/** The ticker is ON here (that is the point), with eviction disabled by a 0 floor. `SCHEDULER: '1'`
 *  is explicit because CI sets `INSTA_OSS_SCHEDULER=0` for the whole `npm test` step (decision 12),
 *  which is right for every OTHER Docker suite and wrong for this one. */
const cfg = loadConfig({
  ...process.env,
  INSTA_OSS_MODE: 'local',
  INSTA_OSS_SCHEDULER: '1',
  INSTA_OSS_RAM_FLOOR_PCT: '0',
  INSTA_OSS_SWEEP_SEC: '2',
  INSTA_OSS_IDLE_COMPUTE_SEC: '3',
  INSTA_OSS_IDLE_DB_SEC: '3',
  INSTA_OSS_CREATE_GRACE_SEC: '0',
  INSTA_OSS_WAKE_TIMEOUT_SEC: '60',
}, [])

const upstream = new Upstream(cfg)
const runtime = new DockerRuntime(cfg, upstream)
const targets = new Map<ServiceKey, ServiceTarget>()
const marks = new Map<ServiceKey, number | null>()
const events: Array<{ kind: string; payload: Record<string, unknown> }> = []
const sched = new Scheduler(runtime, cfg, () => [...targets.values()], {
  markSlept: (key, at) => {
    marks.set(key, at)
    const t = targets.get(key)
    if (t) t.sleptAt = at
  },
  emit: (_key, kind, payload) => { events.push({ kind, payload }) },
}, upstream)

const PG_KEY = 'sleepint:pg-db'
const APP_KEY = 'sleepint:cp-web'

function target(key: ServiceKey, over: Partial<ServiceTarget>): ServiceTarget {
  const t: ServiceTarget = {
    key, kind: 'compute', container: APP, network: NETWORK, port: 80,
    projectId: 'sleepint', branchId: 'sleepint', serviceId: 'cp-web',
    alwaysOn: false, desiredState: 'running', idleSec: 3, sleptAt: null, createdAt: 0,
    ...over,
  }
  targets.set(key, t)
  sched.register(key)
  return t
}

const state = async (container: string): Promise<string> =>
  (await docker(['inspect', '-f', '{{.State.Status}}', container])).toString().trim()
const logs = async (container: string): Promise<string> =>
  (await docker(['logs', '--tail', '40', container], { mergeStderr: true })).toString()
const psql = async (sql: string): Promise<string> => (await postgres.query(PG, sql)).trim()

beforeAll(async () => {
  await docker(['network', 'create', NETWORK]).catch(() => { /* already there */ })
})

afterAll(async () => {
  await sched.stop()
  for (const c of [PG, APP]) await docker(['rm', '-f', '-v', c]).catch(() => { /* best-effort */ })
  await docker(['network', 'rm', NETWORK]).catch(() => { /* best-effort */ })
})

test('a database sleeps cleanly and wakes with its data: no dump, no restore, no loss', async () => {
  await docker(['rm', '-f', '-v', PG]).catch(() => { /* not there */ })
  await postgres.provision({ container: PG, network: NETWORK, dataDir: '' }, { publishLoopback: true })
  await psql('create table if not exists sleepy(id int)')
  await psql('insert into sleepy values (42)')
  target(PG_KEY, { kind: 'postgres', container: PG, port: 5432, serviceId: 'pg-db', idleSec: 3 })

  expect(await sched.sleep(PG_KEY, 'idle')).toBe(true)
  expect(await state(PG)).toBe('exited')
  // The image's STOPSIGNAL is SIGINT (fast shutdown); the grace is what lets it finish.
  expect(await logs(PG)).toContain('database system is shut down')
  expect(marks.get(PG_KEY)).toBeTypeOf('number')
  expect(events.some((e) => e.kind === 'service.sleep' && e.payload.service === 'pg-db')).toBe(true)

  const t0 = Date.now()
  await sched.wake(PG_KEY, { door: 'api' })
  expect(Date.now() - t0).toBeLessThan(15_000)          // pg_isready inside the wake bound
  expect(await state(PG)).toBe('running')
  expect(marks.get(PG_KEY)).toBeNull()
  expect(await psql('select id from sleepy')).toContain('42')
  expect(events.some((e) => e.kind === 'service.wake' && e.payload.door === 'api')).toBe(true)
}, 180_000)

test('a container created and never started (a clone) wakes into running with its port accepting', async () => {
  await docker(['rm', '-f', APP]).catch(() => { /* not there */ })
  await compute.deploy(REF, {
    image: 'nginx:alpine', port: 80, hostPort: APP_PORT, network: NETWORK, envVars: {}, group: 'web', start: false,
  })
  expect(await state(APP)).toBe('created')
  const t = target(APP_KEY, { container: APP, port: 80 })
  // Asleep from birth: exactly what `createBranch` records for a non-always-on clone.
  sched.onAsleep(APP_KEY, 'branch-create')
  expect(sched.stateOf(APP_KEY)).toBe('asleep')

  const t0 = Date.now()
  await sched.wake(APP_KEY, { door: 'traffic' })
  expect(Date.now() - t0).toBeLessThan(5_000)
  expect(await state(APP)).toBe('running')
  expect(await runtime.probe(t)).toBe(true)
  expect(sched.stateOf(APP_KEY)).toBe('running')
}, 120_000)

test('the stop grace is honoured: a signal-forwarding container is down well inside it', async () => {
  expect(await state(APP)).toBe('running')
  const t0 = Date.now()
  expect(await sched.sleep(APP_KEY, 'idle')).toBe(true)
  const ms = Date.now() - t0
  expect(await state(APP)).toBe('exited')
  // 10 s is the grace; a container that forwards SIGTERM is gone in a fraction of it. A container
  // that ignored the signal would take the whole window and end in SIGKILL.
  expect(ms).toBeLessThan(2_000)
  // ...and `--init` is what guarantees that for an image whose entrypoint is a shell.
  expect((await docker(['inspect', '-f', '{{.HostConfig.Init}}', APP])).toString().trim()).toBe('true')
}, 120_000)

test('a cgroup ceiling applies to a STOPPED container, which is what resizing a sleeping service needs', async () => {
  expect(await state(APP)).toBe('exited')
  await runtime.update(APP, { cpu: 2, memoryMb: 512 })
  expect((await docker(['inspect', '-f', '{{.HostConfig.NanoCpus}}', APP])).toString().trim()).toBe('2000000000')
  expect((await docker(['inspect', '-f', '{{.HostConfig.Memory}}', APP])).toString().trim()).toBe('536870912')
  // ...and it is still there when the service wakes.
  await sched.wake(APP_KEY, { door: 'api' })
  expect((await docker(['inspect', '-f', '{{.HostConfig.Memory}}', APP])).toString().trim()).toBe('536870912')
}, 120_000)

test('the ticker sleeps an idle service on its own, and traffic never wakes a stopped one', async () => {
  expect(await state(APP)).toBe('running')
  sched.touch(APP_KEY)
  sched.start()
  // idle 3 s, sweep every 2 s, create grace 0: the sweep takes it down without anyone asking.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && (await state(APP)) === 'running') {
    await new Promise((r) => setTimeout(r, 500))
  }
  await sched.stop()
  expect(await state(APP)).toBe('exited')
  expect(sched.stateOf(APP_KEY)).toBe('asleep')

  // A service the developer stopped is a different thing entirely: traffic must leave it alone.
  const t = targets.get(APP_KEY)!
  t.desiredState = 'stopped'
  await expect(sched.wake(APP_KEY, { door: 'traffic' })).rejects.toThrow(/service is stopped/)
  expect(await state(APP)).toBe('exited')
  t.desiredState = 'running'
}, 180_000)

test('memory pressure evicts the least recently active service, with a synthetic budget', async () => {
  // The floor is 0 above, so pressure is expressed through a budget this test owns: with a 1 MB
  // budget everything running is over it, and the least recently active service is the victim.
  const tiny = loadConfig({
    ...process.env,
    INSTA_OSS_MODE: 'local',
    INSTA_OSS_RAM_FLOOR_PCT: '90',
    INSTA_OSS_MEM_BUDGET_MB: '1',
    // The pool excludes anything active within `2 * touchDebounceMs` (contract section 13), which
    // at the 5 s default is longer than this test can hold a container still without the idle pass
    // taking it first. 50 ms puts the whole window inside the 3 s idle window.
    INSTA_OSS_TOUCH_DEBOUNCE_MS: '50',
    INSTA_OSS_SCHEDULER: '0',
  }, [])
  const tinyRuntime = new DockerRuntime(tiny, upstream)
  const tinySched = new Scheduler(tinyRuntime, tiny, () => [...targets.values()], {
    markSlept: (key, at) => { marks.set(key, at); const t = targets.get(key); if (t) t.sleptAt = at },
    emit: (_key, kind, payload) => { events.push({ kind, payload }) },
  }, upstream)

  // State the precondition instead of inheriting it from whatever ran before: the app is the only
  // running candidate, so it is unambiguously the least recently active one when the pass runs.
  // Without this the victim depends on the database's state, which earlier cases leave differently
  // depending on timing, and the case fails for a reason that has nothing to do with eviction.
  await sched.sleep(PG_KEY, 'test-precondition').catch(() => {})
  expect(await state(PG)).toBe('exited')
  await sched.wake(APP_KEY, { door: 'api' })
  expect(await state(APP)).toBe('running')
  // The daemon runs ONE scheduler whose ledger has seen every service; this second one exists only
  // to carry a different floor and budget, so it gets the same registrations. A key it has never
  // seen is stamped `now` on first sight and is therefore never a victim, which is the right
  // default for a service the daemon knows nothing about yet.
  tinySched.register([PG_KEY, APP_KEY])
  await new Promise((r) => setTimeout(r, 2 * tiny.lanes.touchDebounceMs + 50))
  await tinySched.sweep()                                  // one sweep: stats, then the pressure pass
  // Whatever it picked, it picked by activity and it stopped something rather than nothing.
  expect(await state(APP)).toBe('exited')
  expect(events.some((e) => e.kind === 'service.sleep' && e.payload.reason === 'memory')).toBe(true)
}, 180_000)
