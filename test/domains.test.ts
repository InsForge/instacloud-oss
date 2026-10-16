// The four custom-domain routes end to end over the API (contract 00 section 9, decision 25). They
// had no HTTP-level coverage: `test/internal.test.ts` reached them only through `engine`, and it
// did so against the real system resolver, so the one property the CLI depends on most, that the
// envelope carries NO `ssl` key, was pinned nowhere. DNS is the fake resolver from `test/fakes.ts`.
import { test, expect, beforeEach } from 'vitest'
import { join } from 'node:path'
import { buildServer } from '../src/server'
import { dnsRecords, makeEngine, resetFakes, serverConfig, testConfig } from './fakes'
import type { FastifyInstance } from 'fastify'
import type { Engine } from '../src/engine'

let app: FastifyInstance
let engine: Engine
let projectId: string

const json = (r: { json(): unknown }): Record<string, unknown> => r.json() as Record<string, unknown>

beforeEach(async () => {
  resetFakes()
  engine = makeEngine(testConfig())
  app = buildServer(engine)
  const { project } = await engine.createProject('demo')
  projectId = project.id
  await engine.deploy(projectId, 'main', { image: 'nginx', port: 80 })
})

const post = (body: unknown): Promise<{ statusCode: number; json(): unknown }> =>
  app.inject({ method: 'POST', url: `/projects/${projectId}/compute/domain`, payload: body })
const get = (qs: string): Promise<{ statusCode: number; json(): unknown }> =>
  app.inject({ method: 'GET', url: `/projects/${projectId}/compute/domain?${qs}` })

// Every key `insta compute check-domain` reads, and every key whose PRESENCE changes how it reads
// the answer: an `ssl` key makes the CLI treat this as a cloud plane response and demand an
// ownership TXT record it will never get here.
const FORBIDDEN = ['ssl', 'origin', 'edgeOrigin', 'originOk', 'originStatus']

test('attach: the envelope is the cloud shape, and it carries none of the plane-only keys', async () => {
  const r = await post({ hostname: 'App.Example.COM.' })
  expect(r.statusCode).toBe(200)
  const b = json(r)
  // Normalised: lowercased, trailing dot stripped.
  expect(b.hostname).toBe('app.example.com')
  expect(b.service).toBe('default')
  expect(b.region).toBe('local')
  expect(b.flyApp).toBe('io-demo-main-app-default')
  for (const k of FORBIDDEN) expect(Object.keys(b), k).not.toContain(k)
  // Nothing resolves in the fake resolver, so the record is missing and the domain is pending.
  expect(b.configured).toBe(false)
  expect(b.status).toBe('pending')
  expect(b.dns).toEqual([{ type: 'CNAME', name: 'app.example.com', value: 'api.localhost', status: 'missing' }])
})

test('the dns verdict follows the record: a CNAME to us is ok, an A record elsewhere is a mismatch', async () => {
  dnsRecords.set('api.localhost', { a: ['203.0.113.7'] })

  dnsRecords.set('cname.example.com', { cname: ['api.localhost.'] })
  await post({ hostname: 'cname.example.com' })
  let b = json(await get('hostname=cname.example.com'))
  expect((b.dns as { status: string }[])[0].status).toBe('ok')
  // `configured` is the dns verdict in local mode (no certificate store to consult).
  expect(b.configured).toBe(true)
  expect(b.status).toBe('ready')

  dnsRecords.set('a-hit.example.com', { a: ['203.0.113.7'] })
  await post({ hostname: 'a-hit.example.com' })
  expect(((json(await get('hostname=a-hit.example.com')).dns as { status: string }[])[0]).status).toBe('ok')

  dnsRecords.set('elsewhere.example.com', { a: ['198.51.100.9'] })
  await post({ hostname: 'elsewhere.example.com' })
  b = json(await get('hostname=elsewhere.example.com'))
  expect((b.dns as { status: string }[])[0].status).toBe('mismatch')
  expect(b.configured).toBe(false)
})

test('server mode with no certificate store to read does not report a domain ready', async () => {
  // `domainCertOk` answered `true` when it could not LOOK -- server mode with the certificate
  // directory unset -- so `configured`/`ready` was reported for a name whose edge may hold no
  // certificate at all. Local mode still answers true, because there is no TLS to have.
  // `INSTA_OSS_TLS_CERT_DIR=''` falls back to the server default PATH, so the unset case is
  // reached on the config object: this is the daemon that has no certificate store to consult,
  // not one whose store is empty.
  const base = serverConfig()
  const cfg2 = { ...base, tls: { ...base.tls, certDir: null } }
  const engine2 = makeEngine(cfg2)
  const { project } = await engine2.createProject('demo2')
  await engine2.deploy(project.id, 'main', { image: 'app:1', port: 3000, group: 'web' })
  dnsRecords.set('api.example.test', { a: ['203.0.113.7'] })
  dnsRecords.set('tls.example.com', { a: ['203.0.113.7'] })

  const b = await engine2.setComputeDomain(project.id, { hostname: 'tls.example.com', group: 'web' }) as unknown as Record<string, unknown>
  // The DNS half is fine: this is the certificate half saying "unknown", not "no".
  expect((b.dns as { status: string }[])[0].status).toBe('ok')
  expect(b.configured).toBe(false)
  expect(b.status).toBe('pending')
})

test('with a SUPPLIED certificate, a custom domain is ready only if that certificate covers it', async () => {
  // `--tls custom` has no certificate store to walk: nothing is issued, so the question is
  // whether the operator's certificate covers the name, and the certificate answers it. A name
  // inside their wildcard reads ready; one outside it reads pending, which is the truth in a
  // mode where no certificate will appear for it on its own.
  const base = serverConfig({ INSTA_OSS_DOMAIN: 'example.test' })
  const cfg = {
    ...base,
    tls: {
      ...base.tls,
      certFile: join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'),
      keyFile: join('test', 'fixtures', 'local', 'router.test', 'router.test.key'),
    },
  }
  const engine2 = makeEngine(cfg)
  const { project } = await engine2.createProject('demo2')
  await engine2.deploy(project.id, 'main', { image: 'app:1', port: 3000, group: 'web' })
  dnsRecords.set('api.example.test', { a: ['203.0.113.7'] })
  // The fixture certificate's SANs are router.test, api.router.test and pg-db-demo-main.router.test.
  for (const host of ['router.test', 'nope.test']) dnsRecords.set(host, { a: ['203.0.113.7'] })

  const covered = await engine2.setComputeDomain(project.id, { hostname: 'router.test', group: 'web' }) as unknown as Record<string, unknown>
  expect((covered.dns as { status: string }[])[0].status).toBe('ok')
  expect(covered.configured).toBe(true)
  expect(covered.status).toBe('ready')

  const outside = await engine2.setComputeDomain(project.id, { hostname: 'nope.test', group: 'web' }) as unknown as Record<string, unknown>
  expect((outside.dns as { status: string }[])[0].status).toBe('ok')
  expect(outside.configured).toBe(false)
  expect(outside.status).toBe('pending')
})

test('an unattached name reads `not added` with an empty dns list, never a 404', async () => {
  const b = json(await get('hostname=never-added.example.com'))
  expect(b.status).toBe('not added')
  expect(b.configured).toBe(false)
  expect(b.dns).toEqual([])
  for (const k of FORBIDDEN) expect(Object.keys(b), k).not.toContain(k)
})

test('refusals: a name under our own domain, an IP literal, a bad label and a missing hostname are 400', async () => {
  expect((await post({ hostname: 'api.localhost' })).statusCode).toBe(400)
  expect((await post({ hostname: 'anything.localhost' })).statusCode).toBe(400)
  expect((await post({ hostname: '203.0.113.7' })).statusCode).toBe(400)
  expect((await post({ hostname: 'no-dot' })).statusCode).toBe(400)
  expect((await post({ hostname: 'under_score.example.com' })).statusCode).toBe(400)
  expect((await post({})).statusCode).toBe(400)
  // A traversal attempt is a bad label, not a path: nothing built from a hostname reaches the disk.
  expect((await post({ hostname: '../../etc/passwd' })).statusCode).toBe(400)
})

test('re-attaching to the same target is idempotent; another group is 409 and does not steal it', async () => {
  expect((await post({ hostname: 'app.example.com' })).statusCode).toBe(200)
  expect((await post({ hostname: 'app.example.com' })).statusCode).toBe(200)

  await engine.deploy(projectId, 'main', { group: 'worker', image: 'nginx', port: 80 })
  const clash = await post({ hostname: 'app.example.com', group: 'worker' })
  expect(clash.statusCode).toBe(409)
  expect(String(json(clash).error)).toContain('already attached to default')
  // The original binding is untouched.
  expect(json(await get('hostname=app.example.com')).service).toBe('default')
})

test('list returns one envelope per attached name and detach takes it back out', async () => {
  await post({ hostname: 'one.example.com' })
  await post({ hostname: 'two.example.com' })
  const list = json(await app.inject({ method: 'GET', url: `/projects/${projectId}/compute/domains` }))
  expect((list.items as { hostname: string }[]).map((i) => i.hostname).sort()).toEqual(['one.example.com', 'two.example.com'])

  const del = await app.inject({ method: 'DELETE', url: `/projects/${projectId}/compute/domain`, payload: { hostname: 'one.example.com' } })
  expect(del.statusCode).toBe(200)
  expect(json(del)).toEqual({ hostname: 'one.example.com', flyApp: 'io-demo-main-app-default', service: 'default', region: 'local' })
  expect((json(await app.inject({ method: 'GET', url: `/projects/${projectId}/compute/domains` })).items as unknown[]).length).toBe(1)
  // A second detach is a 404: the row is gone, not silently re-answered.
  expect((await app.inject({ method: 'DELETE', url: `/projects/${projectId}/compute/domain`, payload: { hostname: 'one.example.com' } })).statusCode).toBe(404)
})

// insta 0.1.0 `domain attach` reads the org's bought domains and orders first, and dies on any error there.
test('the org-scoped domain reads answer empty lists, so `insta domain attach` reaches the bring-your-own path', async () => {
  const domains = await app.inject({ method: 'GET', url: '/orgs/local/domains' })
  expect(domains.statusCode).toBe(200)
  expect(json(domains)).toEqual({ items: [] })
  const orders = await app.inject({ method: 'GET', url: '/orgs/local/domains/orders' })
  expect(orders.statusCode).toBe(200)
  expect(json(orders)).toEqual({ items: [] })
})

test('the domain marketplace is cloud-only: search, buy, bought-domain attach and records answer 501, never 404', async () => {
  const calls = [
    { method: 'GET', url: '/orgs/local/domains/search?q=myapp' },
    { method: 'POST', url: '/orgs/local/domains/orders', payload: { domainName: 'myapp.com', years: 1 } },
    { method: 'POST', url: `/projects/${projectId}/domains/myapp.com/attach`, payload: { branch: 'main', group: 'default' } },
    { method: 'GET', url: '/orgs/local/domains/myapp.com/records' },
    { method: 'POST', url: '/orgs/local/domains/myapp.com/records', payload: { type: 'A', host: '@', answer: '203.0.113.7' } },
    { method: 'PATCH', url: '/orgs/local/domains/myapp.com/records/1', payload: { ttl: 300 } },
    { method: 'DELETE', url: '/orgs/local/domains/myapp.com/records/1' },
  ] as const
  for (const c of calls) {
    const r = await app.inject({ method: c.method, url: c.url, payload: 'payload' in c ? c.payload : undefined })
    expect(r.statusCode, `${c.method} ${c.url}`).toBe(501)
    expect(String(json(r).error), c.url).toContain('cloud-only')
  }
})

test('a domain listing resolves the target once and bounds how many rows it checks at once', async () => {
  // No project-level cap on domains: a `Promise.all` over the list turned one listing into as
  // many simultaneous resolver operations as there are rows, each with its own DNS timeout, on
  // a box whose whole premise is one node. And every row independently re-resolved the same
  // `api.<domain>` target.
  const engine = makeEngine(serverConfig())
  const { project } = await engine.createProject('demo')
  await engine.deploy(project.id, 'main', { image: 'app:1', port: 3000, group: 'web' })

  let targets = 0
  let inFlight = 0
  let peak = 0
  engine.resolver = {
    resolve4: async (host: string) => {
      if (host === 'api.example.test') { targets++; return ['203.0.113.9'] }
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return ['198.51.100.1']
    },
    resolveCname: async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }) },
  }

  for (let i = 0; i < 40; i++) {
    await engine.setComputeDomain(project.id, { hostname: `d${i}.example.com`, group: 'web' })
  }
  targets = 0
  peak = 0

  const rows = await engine.listComputeDomains(project.id)

  expect(rows).toHaveLength(40)
  // ONE target lookup for the whole listing, not one per row.
  expect(targets).toBe(1)
  // ...and a ceiling on the rest.
  expect(peak).toBeLessThanOrEqual(8)
  expect(peak).toBeGreaterThan(1)          // still concurrent, just bounded
})
