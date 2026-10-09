// A docker-daemon restart (reboot, Desktop update) must not take environments down for good:
// every long-lived container gets --restart unless-stopped. (Found live: a reboot left all
// branch apps+dbs Exited(255) until hand-started.)
import { test, expect, vi } from 'vitest'

const calls: string[][] = []
// The REAL module with only `docker` replaced: it also exports the shared container
// destroy-and-probe helper (and the not-found pattern it classifies with), and a factory that
// returns just `docker` makes those undefined for every importer.
vi.mock('../src/docker', async (orig) => ({
  ...(await orig<typeof import('../src/docker')>()),
  docker: vi.fn(async (args: string[]) => { calls.push(args); return Buffer.from('') }),
}))

import { DockerCompute } from '../src/adapters/compute'
import { LocalPostgres, type DockerExec } from '../src/adapters/postgres'

// The database adapter takes its docker seam directly (the way Scheduler takes a Runtime), so the
// readiness probe gets the answer a live server sends instead of the module mock's empty buffer.
// The production predicate is what stops a premature ready (#34); it must not be widened for us.
const pgDocker: DockerExec = async (args) => {
  calls.push(args)
  if (args[0] === 'inspect') throw new Error('Error: No such object')
  return Buffer.from(args.includes('select 1') ? '1' : '')
}
const postgres = (): LocalPostgres => new LocalPostgres({ docker: pgDocker })

// `create` for compute (the container is started separately so a stopped service's replacement is
// not run), `run` for the database. Asserted per verb, and each test asserts the call it expects
// EXISTS — filter().every() is vacuously true on an empty list, so a verb rename would otherwise
// disable the guard silently rather than fail it.
const restartArgs = (verb: string) => (a: string[]) =>
  a[0] === verb && a.includes('--restart') && a[a.indexOf('--restart') + 1] === 'unless-stopped'

test('app containers survive docker restarts', async () => {
  await new DockerCompute().deploy('p-main', { image: 'i', port: 3000, hostPort: 3000, network: 'io-p-main', envVars: {}, group: 'default' })
  const creates = calls.filter((a) => a[0] === 'create')
  expect(creates.length).toBeGreaterThan(0)
  expect(creates.every(restartArgs('create'))).toBe(true)
})

test('a deploy whose service is down creates the container without starting it', async () => {
  calls.length = 0
  await new DockerCompute().deploy('p-main', { image: 'i', port: 3000, hostPort: 3000, network: 'io-p-main', envVars: {}, group: 'default', start: false })
  expect(calls.some((a) => a[0] === 'create')).toBe(true)
  expect(calls.some((a) => a[0] === 'start')).toBe(false)
})

test('a deploy whose service is up starts it', async () => {
  calls.length = 0
  await new DockerCompute().deploy('p-main', { image: 'i', port: 3000, hostPort: 3000, network: 'io-p-main', envVars: {}, group: 'default' })
  expect(calls.some((a) => a[0] === 'start' && a[1] === 'io-p-main-app-default')).toBe(true)
})

test('branch postgres survives docker restarts', async () => {
  calls.length = 0
  await postgres().provision({ container: 'io-p-main-pg-db', network: 'io-p-main', dataDir: '' })
  const runs = calls.filter((a) => a[0] === 'run')
  expect(runs.length).toBeGreaterThan(0)
  expect(runs.every(restartArgs('run'))).toBe(true)
})

// ---- WP3 (scheduler): what sleep and the recorded ceiling need from the adapters ----------------

// Sleep is `docker stop` with a grace, and the grace is only worth anything if SIGTERM reaches the
// app. `--init` interposes docker's tini as PID 1, so an image whose entrypoint is `sh -c ...`
// (most of them) forwards the signal instead of ignoring it and being SIGKILLed (decision 60).
test('compute containers are created with --init, so SIGTERM reaches an app behind a shell', async () => {
  calls.length = 0
  await new DockerCompute().deploy('p-main', { image: 'i', port: 3000, network: 'io-p-main', envVars: {}, group: 'default' })
  const create = calls.find((a) => a[0] === 'create')
  expect(create).toBeDefined()
  expect(create).toContain('--init')
})

test('the recorded ceiling reaches docker as --cpus/--memory/--memory-swap, and nothing when unset', async () => {
  const limitFlags = (a: string[]): string[] => a.filter((x) => x === '--cpus' || x === '--memory' || x === '--memory-swap')
  calls.length = 0
  await new DockerCompute().deploy('p-main', { image: 'i', port: 3000, network: 'io-p-main', envVars: {}, group: 'default', limits: { cpu: 2, memoryMb: 512 } })
  const create = calls.find((a) => a[0] === 'create')!
  expect(create.slice(create.indexOf('--cpus'), create.indexOf('--cpus') + 6))
    .toEqual(['--cpus', '2', '--memory', '512m', '--memory-swap', '512m'])   // no swap: OOM at the ceiling

  calls.length = 0
  await postgres().provision({ container: 'io-p-main-pg-db', network: 'io-p-main', dataDir: '' }, { limits: { cpu: 1, memoryMb: 1024 } })
  const run = calls.find((a) => a[0] === 'run')!
  expect(run.slice(run.indexOf('--cpus'), run.indexOf('--cpus') + 6))
    .toEqual(['--cpus', '1', '--memory', '1024m', '--memory-swap', '1024m'])

  // Absent limits mean no cgroup flags at all, not a zero.
  calls.length = 0
  await new DockerCompute().deploy('p-main', { image: 'i', port: 3000, network: 'io-p-main', envVars: {}, group: 'default' })
  await postgres().provision({ container: 'io-p-main-pg-db', network: 'io-p-main', dataDir: '' })
  for (const a of calls) expect(limitFlags(a)).toEqual([])
})

test('stop passes the grace through as docker stop -t, and omits it when none is given', async () => {
  calls.length = 0
  await new DockerCompute().stop('p-main', 'default', { graceSec: 10 })
  expect(calls.find((a) => a[0] === 'stop')).toEqual(['stop', '-t', '10', 'io-p-main-app-default'])
  calls.length = 0
  await new DockerCompute().stop('p-main', 'default')
  expect(calls.find((a) => a[0] === 'stop')).toEqual(['stop', 'io-p-main-app-default'])
})
