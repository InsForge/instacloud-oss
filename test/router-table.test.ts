// Pure tests for the route table: the hostname scheme (decisions 7, 35, 55), what a state document
// turns into, and the two things the request path depends on never happening (a throw, a clone).
import { test, expect } from 'vitest'
import { testConfig, serverConfig } from './fakes'
import { assertHostLabel, buildTable, hostFor, hostOnly, labelFor } from '../src/router/table'
import type { State } from '../src/state'
import type { Branch, Project } from '../src/types'

const EMPTY: State = {
  projects: {}, branches: {}, policies: {}, approvals: [], events: [], userSecrets: {},
  rev: 1, auditRev: 0, customDomains: {}, templateDeployments: {},
}

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'demo', status: 'ready', createdAt: 1, refSlug: 'demo', ...over,
})

const branch = (over: Partial<Branch> = {}): Branch => ({
  id: 'b1', projectId: 'p1', name: 'main', isDefault: true, status: 'ready', ref: 'demo-main',
  network: 'io-demo-main', cloneOf: null, createdAt: 1, apps: {}, ...over,
})

const stateWith = (parts: Partial<State>): State => ({ ...EMPTY, ...parts })

test('hostFor shapes for compute, postgres and managed in both modes', () => {
  expect(hostFor('compute', 'web', 'demo-main', 'localhost')).toBe('web-demo-main.localhost')
  expect(hostFor('compute', 'default', 'demo-main', 'example.test')).toBe('default-demo-main.example.test')
  expect(hostFor('postgres', 'db', 'demo-main', 'example.test')).toBe('pg-db-demo-main.example.test')
  expect(hostFor('redis', 'cache', 'demo-main', 'example.test')).toBe('redis-cache-demo-main.example.test')
  expect(hostFor('mysql', 'sql', 'demo-main', 'localhost')).toBe('mysql-sql-demo-main.localhost')
  expect(hostFor('mongodb', 'docs', 'demo-main', 'localhost')).toBe('mongodb-docs-demo-main.localhost')
})

test('hostFor bounds an 84-char label to 63 chars with a stable 6-hex suffix', () => {
  const name = 'a'.repeat(39)
  const ref = 'r'.repeat(41)
  const label = labelFor('compute', name, ref)
  expect(label.length).toBe(63)
  expect(label).toMatch(/^a+-r*-[0-9a-f]{6}$/)
  expect(labelFor('compute', name, ref)).toBe(label)          // deterministic
  // Two long names sharing the truncated prefix still differ.
  const other = labelFor('compute', `${name}b`, ref)
  expect(other).not.toBe(label)
  expect(other.length).toBe(63)
  // A short label is untouched.
  expect(labelFor('compute', 'web', 'demo-main')).toBe('web-demo-main')
})

test('assertHostLabel rejects bad characters and over-long labels (custom domains only)', () => {
  expect(() => assertHostLabel('app.example.com')).not.toThrow()
  expect(() => assertHostLabel('APP.example.com')).toThrow(/invalid hostname label/)
  expect(() => assertHostLabel('-app.example.com')).toThrow(/invalid hostname label/)
  expect(() => assertHostLabel('app_.example.com')).toThrow(/invalid hostname label/)
  expect(() => assertHostLabel(`${'a'.repeat(64)}.example.com`)).toThrow(/invalid hostname label/)
  expect(() => assertHostLabel('')).toThrow(/1 to 253/)
})

test('hostOnly strips the port and a trailing dot and lowercases', () => {
  expect(hostOnly('Web-demo-main.LOCALHOST:8080')).toBe('web-demo-main.localhost')
  expect(hostOnly('web.example.test.')).toBe('web.example.test')
  expect(hostOnly('[::1]:8080')).toBe('[::1]')
  expect(hostOnly(undefined)).toBe('')
})

test('buildTable yields one route per app, per database and per managed service, plus the static rows', () => {
  const cfg = serverConfig()
  const p = project({ managedServices: [{ id: 'rd-cache', type: 'redis', name: 'cache', createdAt: 1 }, { id: 'my-sql', type: 'mysql', name: 'sql', createdAt: 1 }] })
  const b = branch({
    apps: { web: { image: 'i', port: 3000, url: 'https://web-demo-main.example.test' } },
    databases: { 'pg-db': { url: 'postgres://x', container: 'io-demo-main-pg-db', dataId: 'db' } },
    managed: { 'rd-cache': { password: 'p' }, 'my-sql': { password: 'p' } },
    lanes: { 'my-sql': 20005 },
    buckets: { 'st-store': { bucket: 'io-demo-main-store', env: {} } },
  })
  const t = buildTable(stateWith({ projects: { p1: p }, branches: { b1: b } }), cfg, () => { /* quiet */ })

  expect(t.byHost('api.example.test')?.kind).toBe('api')
  expect(t.byHost('console.example.test')?.kind).toBe('api')
  expect(t.byHost('s3.example.test')?.kind).toBe('garage')
  expect(t.byHost('io-demo-main-store.s3.example.test')?.kind).toBe('garage-vhost')
  expect(t.byHost('deep.nested.s3.example.test')).toBeUndefined()

  const web = t.byHost('web-demo-main.example.test')
  expect(web).toMatchObject({ kind: 'compute', lane: 'http', container: 'io-demo-main-app-web', port: 3000, desiredState: 'running' })

  const db = t.byHost('pg-db-demo-main.example.test')
  expect(db).toMatchObject({ kind: 'postgres', lane: 'pg', container: 'io-demo-main-pg-db', port: 5432, listenPort: 5432, tls: true })

  expect(t.byHost('redis-cache-demo-main.example.test')).toMatchObject({ lane: 'sni', listenPort: 6379, tls: true })
  // MySQL greets first, so it gets a plaintext per-service port instead of the SNI lane.
  expect(t.byHost('mysql-sql-demo-main.example.test')).toMatchObject({ lane: 'port', listenPort: 20005, tls: false })
  expect(t.byPort(20005)?.serviceId).toBe('my-sql')
  expect(t.hosts().has('io-demo-main-store.s3.example.test')).toBe(true)
})

test('local mode: no object-store routes, databases answer on their lane ports', () => {
  const cfg = testConfig()
  const p = project({ managedServices: [{ id: 'rd-cache', type: 'redis', name: 'cache', createdAt: 1 }] })
  const b = branch({
    databases: { 'pg-db': { url: 'postgres://x', container: 'io-demo-main-pg-db', dataId: 'db' } },
    managed: { 'rd-cache': { password: 'p' } },
    lanes: { 'pg-db': 20000, 'rd-cache': 20001 },
    buckets: { 'st-store': { bucket: 'io-demo-main-store', env: {} } },
  })
  const t = buildTable(stateWith({ projects: { p1: p }, branches: { b1: b } }), cfg, () => { /* quiet */ })

  expect(t.byHost('s3.localhost')).toBeUndefined()
  expect(t.byHost('io-demo-main-store.s3.localhost')).toBeUndefined()
  expect(t.byHost('pg-db-demo-main.localhost')).toMatchObject({ lane: 'pg', listenPort: 20000, tls: false })
  expect(t.byPort(20000)?.serviceId).toBe('pg-db')
  // Local mode has no TLS, so redis takes a plaintext port lane too.
  expect(t.byHost('redis-cache-demo-main.localhost')).toMatchObject({ lane: 'port', listenPort: 20001, tls: false })
  expect(t.byPort(20001)?.serviceId).toBe('rd-cache')
})

test('custom domains become aliases of their compute route, and desiredState is copied at build time', () => {
  const cfg = serverConfig()
  const p = project()
  const b = branch({ apps: { web: { image: 'i', port: 3000, url: 'u', desiredState: 'stopped' } } })
  const t = buildTable(stateWith({
    projects: { p1: p }, branches: { b1: b },
    customDomains: { 'app.example.com': { hostname: 'app.example.com', projectId: 'p1', branchId: 'b1', group: 'web', createdAt: 1 } },
  }), cfg, () => { /* quiet */ })

  expect(t.byHost('app.example.com')?.key).toBe('b1:cp-web')
  expect(t.byHost('app.example.com')?.desiredState).toBe('stopped')
  expect(t.hosts().has('app.example.com')).toBe(true)
})

test('a duplicate host or lane port does NOT throw: it is logged and the first route wins', () => {
  const cfg = testConfig()
  const logged: string[] = []
  const p = project()
  const b1 = branch({ id: 'b1', apps: { web: { image: 'i', port: 3000, url: 'u', host: 'clash.localhost' } } })
  const b2 = branch({ id: 'b2', name: 'feat', isDefault: false, ref: 'demo-feat', apps: { web: { image: 'i', port: 4000, url: 'u', host: 'clash.localhost' } } })
  const t = buildTable(stateWith({ projects: { p1: p }, branches: { b1, b2 } }), cfg, (m) => logged.push(m))

  expect(t.byHost('clash.localhost')?.port).toBe(3000)
  expect(logged.some((m) => m.includes('duplicate host clash.localhost'))).toBe(true)

  const logged2: string[] = []
  const c1 = branch({ id: 'c1', databases: { 'pg-a': { url: 'u', container: 'ca', dataId: 'a' } }, lanes: { 'pg-a': 20000 } })
  const c2 = branch({ id: 'c2', name: 'feat', isDefault: false, ref: 'demo-feat', databases: { 'pg-a': { url: 'u', container: 'cb', dataId: 'a' } }, lanes: { 'pg-a': 20000 } })
  const t2 = buildTable(stateWith({ projects: { p1: p }, branches: { c1, c2 } }), cfg, (m) => logged2.push(m))
  expect(t2.byPort(20000)?.container).toBe('ca')
  expect(logged2.some((m) => m.includes('duplicate lane port 20000'))).toBe(true)
})

test('a legacy branch row (dbUrl, no databases) still routes its io-<ref>-pg container', () => {
  const cfg = testConfig()
  const t = buildTable(stateWith({
    projects: { p1: project() },
    branches: { b1: branch({ dbUrl: 'postgres://postgres:pw@io-demo-main-pg:5432/app' }) },
  }), cfg, () => { /* quiet */ })
  expect(t.byHost('pg-db-demo-main.localhost')?.container).toBe('io-demo-main-pg')
})
