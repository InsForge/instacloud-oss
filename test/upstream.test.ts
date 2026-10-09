// src/upstream.ts over a mocked docker CLI (contract 00 section 8.1). What is pinned: ONE inspect
// answers server mode, `docker port` answers local mode, a container that is not running has no
// address, the TTL expires, and `forget`/`forgetIfChanged` invalidate exactly what they claim.
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer } from 'node:net'

vi.mock('../src/docker', () => ({
  docker: vi.fn(async () => Buffer.from('')),
  dockerCall: () => ({ done: Promise.resolve(Buffer.from('')), kill: () => {} }),
}))

import { docker as dockerFn } from '../src/docker'
import { Upstream } from '../src/upstream'
import { testConfig, serverConfig } from './fakes'

const INSPECT = 'inspect'
type Args = readonly string[]

/** Answer `docker inspect -f ...` with one tab-joined row, and `docker port` with one binding. */
function mockDocker(rows: { ip?: string; id?: string; startedAt?: string; running?: boolean; hostPort?: number }): void {
  vi.mocked(dockerFn).mockImplementation(async (args: Args) => {
    if (args[0] === INSPECT) {
      const r = [rows.ip ?? '', rows.id ?? '', rows.startedAt ?? '', String(rows.running ?? true)].join('\t')
      return Buffer.from(`${r}\n`)
    }
    if (args[0] === 'port') {
      if (rows.hostPort === undefined) return Buffer.from('')
      return Buffer.from(`127.0.0.1:${rows.hostPort}\n[::1]:${rows.hostPort}\n`)
    }
    return Buffer.from('')
  })
}

beforeEach(() => { vi.mocked(dockerFn).mockReset() })
afterEach(() => { vi.useRealTimers() })

test('server mode resolves the network IP, the id and the start time from ONE inspect', async () => {
  mockDocker({ ip: '172.19.0.4', id: 'cid1', startedAt: '2026-09-08T00:00:00Z' })
  const up = new Upstream(serverConfig())
  expect(await up.resolve('io-demo-main-pg-db', 'io-demo-main', 5432)).toEqual({
    host: '172.19.0.4', port: 5432, containerId: 'cid1', startedAt: '2026-09-08T00:00:00Z',
  })
  // One docker call, and the template asks for the branch network by name.
  expect(vi.mocked(dockerFn).mock.calls).toHaveLength(1)
  expect(vi.mocked(dockerFn).mock.calls[0][0].join(' ')).toContain('"io-demo-main"')
  // A running container with no address on THAT network is not dialable.
  mockDocker({ ip: '', id: 'cid1' })
  const up2 = new Upstream(serverConfig())
  expect(await up2.resolve('io-demo-main-pg-db', 'other-net', 5432)).toBeNull()
})

test('local mode dials the loopback port docker port reports, not the container IP', async () => {
  mockDocker({ ip: '172.19.0.4', id: 'cid1', startedAt: 's', hostPort: 49154 })
  const up = new Upstream(testConfig())
  expect(await up.resolve('io-demo-main-pg-db', 'io-demo-main', 5432)).toEqual({
    host: '127.0.0.1', port: 49154, containerId: 'cid1', startedAt: 's',
  })
  // Nothing published: no address at all rather than a guess at the container port.
  mockDocker({ ip: '172.19.0.4', id: 'cid1', hostPort: undefined })
  expect(await new Upstream(testConfig()).resolve('io-demo-main-pg-db', 'io-demo-main', 5432)).toBeNull()
})

test('a container that is not running, or that docker cannot read, has no address', async () => {
  mockDocker({ ip: '172.19.0.4', id: 'cid1', running: false })
  expect(await new Upstream(serverConfig()).resolve('c', 'n', 5432)).toBeNull()
  vi.mocked(dockerFn).mockImplementation(async () => { throw new Error('No such object: c') })
  expect(await new Upstream(serverConfig()).resolve('c', 'n', 5432)).toBeNull()
})

test('resolve caches per container+port; forget invalidates; the entry expires after the TTL', async () => {
  vi.useFakeTimers()
  mockDocker({ ip: '10.0.0.1', id: 'cid1', hostPort: 1 })
  const cfg = serverConfig()
  const up = new Upstream(cfg)
  await up.resolve('c', 'n', 5432)
  await up.resolve('c', 'n', 5432)
  expect(vi.mocked(dockerFn).mock.calls).toHaveLength(1) // second read served from the cache
  // A different port of the same container is its own entry (local mode maps each separately).
  await up.resolve('c', 'n', 6379)
  expect(vi.mocked(dockerFn).mock.calls).toHaveLength(2)
  // forget drops EVERY port of the container.
  up.forget('c')
  await up.resolve('c', 'n', 5432)
  await up.resolve('c', 'n', 6379)
  expect(vi.mocked(dockerFn).mock.calls).toHaveLength(4)
  // ...and an untouched entry expires on its own after touchDebounceMs.
  vi.advanceTimersByTime(cfg.lanes.touchDebounceMs + 1)
  await up.resolve('c', 'n', 5432)
  expect(vi.mocked(dockerFn).mock.calls).toHaveLength(5)
})

test('forgetIfChanged drops the entry only when the container id differs', async () => {
  vi.useFakeTimers()
  mockDocker({ ip: '10.0.0.1', id: 'cid1' })
  const up = new Upstream(serverConfig())
  await up.resolve('c', 'n', 5432)
  up.forgetIfChanged('c', 'cid1')
  await up.resolve('c', 'n', 5432)
  expect(vi.mocked(dockerFn).mock.calls).toHaveLength(1) // same id: the address still stands
  up.forgetIfChanged('c', 'cid2')
  await up.resolve('c', 'n', 5432)
  expect(vi.mocked(dockerFn).mock.calls).toHaveLength(2) // restarted underneath us: re-resolved
})

test('dial connects to a live listener and answers false on a refused port', async () => {
  const srv = createServer()
  const port = await new Promise<number>((resolve) => {
    srv.listen(0, '127.0.0.1', () => { resolve((srv.address() as { port: number }).port) })
  })
  mockDocker({ ip: '127.0.0.1', id: 'cid1' })
  const up = new Upstream(serverConfig())
  expect(await up.dial('c', 'n', port)).toBe(true)
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  up.forget('c')
  expect(await up.dial('c', 'n', port)).toBe(false)
  // No address at all is also a false, without a socket attempt.
  mockDocker({ ip: '', id: 'cid1' })
  up.forget('c')
  expect(await up.dial('c', 'n', port)).toBe(false)
})

/** Listen on an ephemeral loopback port and answer it. */
const listenOn = (srv: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolve) => { srv.listen(0, '127.0.0.1', () => { resolve((srv.address() as { port: number }).port) }) })
const closeSrv = (srv: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve) => srv.close(() => resolve()))

test('local mode: a published port that accepts and hangs up at once is NOT ready', async () => {
  // docker-proxy accepts before the container listens, then closes when its own dial is refused
  const hangup = createServer((c) => c.destroy())
  const port = await listenOn(hangup)
  mockDocker({ ip: '172.19.0.4', id: 'cid1', hostPort: port })
  expect(await new Upstream(testConfig()).dial('c', 'n', 80)).toBe(false)
  await closeSrv(hangup)
})

test('local mode: a published port whose peer holds the connection is ready', async () => {
  const holds = createServer()
  const port = await listenOn(holds)
  mockDocker({ ip: '172.19.0.4', id: 'cid1', hostPort: port })
  expect(await new Upstream(testConfig()).dial('c', 'n', 80)).toBe(true)
  await closeSrv(holds)
})

test('server mode dials the container itself, so an accept counts even if the peer hangs up', async () => {
  const hangup = createServer((c) => c.destroy())
  const port = await listenOn(hangup)
  mockDocker({ ip: '127.0.0.1', id: 'cid1' })
  expect(await new Upstream(serverConfig()).dial('c', 'n', port)).toBe(true)
  await closeSrv(hangup)
})
