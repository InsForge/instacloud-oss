// WP1 state.json discipline (plan 01 section 7) and the one-daemon-per-data-dir lock (section 8).
// No Docker, no server: fs plus the state module.
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as st from '../src/state'
import { resetAdmin } from '../src/auth'
import { serverConfig, testConfig } from './fakes'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'io-st-'))
  file = join(dir, 'state.json')
  st.initStatePath(file)
})
afterEach(() => { st.releaseLock() })

const lockPath = (): string => join(dir, 'instad.lock')
const noSleep = (): void => {}

test('mutate refuses an async callback before anything is written', () => {
  expect(() => st.mutate(async (s) => { s.rev = 99 })).toThrowError(/must be synchronous/)
  expect(readdirSync(dir)).toEqual([])
})

test('saveState is atomic, bumps rev, and leaves no tmp file behind', () => {
  st.mutate((s) => { s.projects.a = { id: 'a', name: 'a', status: 'ready', createdAt: 1 } })
  expect(readdirSync(dir)).toEqual(['state.json'])
  expect(JSON.parse(readFileSync(file, 'utf8')).rev).toBe(1)
  st.mutate((s) => { s.projects.b = { id: 'b', name: 'b', status: 'ready', createdAt: 1 } })
  expect(st.stateRev()).toBe(2)
  expect(st.loadState().auditRev).toBe(0)
})

test('audit-class writes bump auditRev only, so the router never rebuilds for them', () => {
  st.mutate((s) => { s.rev += 0 })
  const before = st.stateRev()
  st.mutate((s) => { s.events.push({ id: 'e1', projectId: 'p', branch: null, source: 'agent', kind: 'k', payload: {}, dedupKey: null, createdAt: 'now' }) }, { audit: true })
  expect(st.stateRev()).toBe(before)
  expect(st.loadState().auditRev).toBe(1)
  expect(st.loadState().events).toHaveLength(1)
})

test('events are capped at EVENTS_CAP, newest kept', () => {
  st.mutate((s) => {
    for (let i = 0; i < st.EVENTS_CAP + 10; i++) {
      s.events.push({ id: `e${i}`, projectId: 'p', branch: null, source: 'agent', kind: 'k', payload: {}, dedupKey: null, createdAt: 'now' })
    }
  })
  const events = st.loadState().events
  expect(events).toHaveLength(st.EVENTS_CAP)
  expect(events[0].id).toBe('e10')
  expect(events[events.length - 1].id).toBe(`e${st.EVENTS_CAP + 9}`)
})

test('stateRev reads the rev without cloning and follows an external write', () => {
  st.mutate((s) => { s.rev += 0 })
  st.loadState()
  const spy = vi.spyOn(globalThis, 'structuredClone')
  expect(st.stateRev()).toBe(1)
  expect(spy).not.toHaveBeenCalled()
  spy.mockRestore()
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.rev = 42
  writeFileSync(file, JSON.stringify(doc))
  expect(st.stateRev()).toBe(42)
})

test('loadState hands out clones and re-parses when the file changes', () => {
  st.mutate((s) => { s.policies.p = { deploy: 'deny' } })
  const a = st.loadState()
  const b = st.loadState()
  expect(a).not.toBe(b)
  a.policies.p.deploy = 'allow'
  expect(st.loadState().policies.p.deploy).toBe('deny')
})

test('onSave subscribers see the write class', () => {
  const kinds: string[] = []
  st.onSave((_s, kind) => { kinds.push(kind) })
  st.mutate((s) => { s.rev += 0 })
  st.mutate((s) => { s.rev += 0 }, { audit: true })
  expect(kinds).toEqual(['routing', 'audit'])
})

test('touchLater coalesces and flushes on releaseLock', () => {
  st.mutate((s) => { s.userSecrets.p = [] })
  st.acquireLock(dir, { heartbeatMs: 0 })
  st.touchLater((s) => { s.userSecrets.p.push({ name: 'A', value: '1', branch: null }) })
  st.touchLater((s) => { s.userSecrets.p.push({ name: 'B', value: '2', branch: null }) })
  expect(st.loadState().userSecrets.p).toHaveLength(0)
  const auditBefore = st.loadState().auditRev
  st.releaseLock()
  expect(st.loadState().userSecrets.p.map((x) => x.name)).toEqual(['A', 'B'])
  expect(st.loadState().auditRev).toBe(auditBefore + 1)
})

test('one lock per process and per data dir', () => {
  st.acquireLock(dir, { heartbeatMs: 0 })
  expect(statSync(lockPath()).isFile()).toBe(true)
  expect(() => st.acquireLock(dir, { heartbeatMs: 0 })).toThrowError(/already held by this process/)
  st.releaseLock()
  expect(() => statSync(lockPath())).toThrowError()
})

test('a lock with a stale heartbeat is taken over', () => {
  writeFileSync(lockPath(), JSON.stringify({ pid: 999999, bootId: 'x', startedAt: 'then', host: 'h' }))
  const old = new Date(Date.now() - 5 * 60_000)
  utimesSync(lockPath(), old, old)
  st.acquireLock(dir, { heartbeatMs: 0, timeoutMs: 0, sleep: noSleep })
  expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid)
})

const heldByOther = (): void => {
  writeFileSync(lockPath(), JSON.stringify({ pid: 999999, bootId: 'x', startedAt: 'then', host: 'h' }))
}
const spin = (ms: number): void => { const until = Date.now() + ms; while (Date.now() < until) { void 0 } }

test('a fresh lock is retried and taken over once the heartbeat stops', () => {
  heldByOther()
  let ticks = 0
  const sleep = (): void => {
    ticks++
    if (ticks === 2) { const old = new Date(Date.now() - 5 * 60_000); utimesSync(lockPath(), old, old) }
  }
  st.acquireLock(dir, { heartbeatMs: 0, retryMs: 1, timeoutMs: 10_000, sleep })
  expect(ticks).toBeGreaterThanOrEqual(2)
  expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid)
})

test('a lock whose heartbeat keeps ticking is refused, naming the holder', () => {
  heldByOther()
  const sleep = (): void => { const n = new Date(); utimesSync(lockPath(), n, n); spin(2) }
  expect(() => st.acquireLock(dir, { heartbeatMs: 0, retryMs: 1, timeoutMs: 5, sleep }))
    .toThrowError(/another instad \(pid 999999, started then\) holds/)
  expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(999999)
})

test('resetAdmin refuses while a daemon holds the lock and says how to stop it', () => {
  const cfg = serverConfig({ INSTA_OSS_DATA_DIR: dir, INSTA_OSS_STATE: file })
  st.acquireLock(dir, { heartbeatMs: 0 })
  const errors: string[] = []
  const code = resetAdmin(cfg, { log: () => {}, error: (m) => errors.push(m) })
  expect(code).toBe(1)
  expect(errors.join()).toContain('stop the daemon first')
})

test('resetAdmin is server-only and says so in local mode', () => {
  const errors: string[] = []
  const code = resetAdmin(testConfig(), { log: () => {}, error: (m) => errors.push(m) })
  expect(code).toBe(1)
  expect(errors.join()).toContain('server mode only')
})

test('resetAdmin on a fresh daemon reports that no admin exists', () => {
  const cfg = serverConfig({ INSTA_OSS_DATA_DIR: dir, INSTA_OSS_STATE: file })
  const logs: string[] = []
  expect(resetAdmin(cfg, { log: (m) => logs.push(m), error: () => {} })).toBe(0)
  expect(logs.join()).toContain('no admin exists')
})

test('state.json is written 0600: it holds every database password, S3 key and operator secret', () => {
  st.saveState(st.loadState())
  expect(statSync(file).mode & 0o777).toBe(st.STATE_FILE_MODE)
  expect(st.STATE_FILE_MODE).toBe(0o600)
  // A file an older build left world readable is repaired by the next write, because the tmp file
  // the rename replaces it with is created fresh with the mode.
  chmodSync(file, 0o644)
  st.saveState(st.loadState())
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

// ---- boot recovery of abandoned reservations (decision 51) -------------------------------------

test('a reservation whose creator never committed is released at boot, so a retry is not refused forever', () => {
  // The shape a daemon killed mid-provision leaves behind: the claims are written synchronously
  // before the first await and the branch row only at the end, so a crash in between keeps the
  // claims with nobody left to release them. `ghost` is that dead creator.
  st.mutate((s) => {
    // `live` is a committed branch whose claims are all still backed by a row, so they stay.
    s.branches = {
      live: {
        id: 'live', projectId: 'p1', name: 'main',
        apps: { web: { hostPort: 20002, host: 'web-demo-main.example.test' } },
      } as never,
    }
    s.branchReservations = { 'demo-feat': 'ghost', 'demo-main': 'live' }
    s.laneReservations = { '20000': 'ghost', '20002': 'live' }
    s.hostReservations = { 'web-demo-feat': 'ghost:cp-web', 'web-demo-main': 'live:cp-web' }
  })

  const released = st.reclaimAbandonedReservations()

  // Only the dead creator's claims go. Ownership decides, not age: a claim held by a branch that
  // really exists is still load-bearing, and dropping it would let a second create collide with it.
  expect(released.branches).toEqual(['demo-feat'])
  expect(released.lanes).toEqual(['20000'])
  expect(released.hosts).toEqual(['web-demo-feat'])
  const after = st.loadState()
  expect(after.branchReservations).toEqual({ 'demo-main': 'live' })
  expect(after.laneReservations).toEqual({ '20002': 'live' })
  expect(after.hostReservations).toEqual({ 'web-demo-main': 'live:cp-web' })
})

test('a lane or host claim abandoned on a branch that still exists is released too', () => {
  // The harder half of the same bug: a deploy or a service add takes these claims one at a time on
  // a branch that already exists, so testing "does the branch exist" keeps an abandoned claim
  // forever. Only the row that supersedes the claim proves it is still needed. `live` here has one
  // real app holding one port and one hostname; the other two claims are residue.
  st.mutate((s) => {
    s.branches = {
      live: {
        id: 'live', projectId: 'p1', name: 'main',
        apps: { web: { hostPort: 20002, host: 'web-demo-main.example.test' } },
      } as never,
    }
    s.laneReservations = { '20002': 'live', '20004': 'live' }
    s.hostReservations = { 'web-demo-main': 'live:cp-web', 'api-demo-main': 'live:cp-api' }
  })

  const released = st.reclaimAbandonedReservations()

  expect(released.lanes).toEqual(['20004'])
  expect(released.hosts).toEqual(['api-demo-main'])
  const after = st.loadState()
  expect(after.laneReservations).toEqual({ '20002': 'live' })
  expect(after.hostReservations).toEqual({ 'web-demo-main': 'live:cp-web' })
})

test('boot recovery is idempotent, and silent when nothing was abandoned', () => {
  st.mutate((s) => {
    s.branches = { live: { id: 'live', projectId: 'p1', name: 'main' } as never }
    s.branchReservations = { 'demo-main': 'live' }
  })
  expect(st.reclaimAbandonedReservations()).toEqual({ branches: [], lanes: [], hosts: [] })
  expect(st.reclaimAbandonedReservations()).toEqual({ branches: [], lanes: [], hosts: [] })
  expect(st.loadState().branchReservations).toEqual({ 'demo-main': 'live' })
})
