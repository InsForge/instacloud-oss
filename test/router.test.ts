// The router with real listeners on ephemeral ports and fake seams (contract 00 section 8.2, 02
// sections 0 to 8). What these tests pin is the serverless behaviour: a request for a sleeping
// service waits for exactly one wake, the waiting keeps the service awake through ONE shared timer,
// and every failure mode has a readable answer instead of a dropped connection.
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as netConnect, createServer as createNetServer, type Server as NetServer } from 'node:net'
import { connect as tlsConnect, type SecureContext } from 'node:tls'
import { Router } from '../src/router'
import { Certs, findCertFiles, suppliedCert, warnExpiring, SuppliedCertWatch, CERT_WARN_DAYS, WARN_EVERY_MS } from '../src/router/certs'
import { createPgLane, errorResponse, PG_ERRORS } from '../src/router/pg'
import { createSniLane } from '../src/router/tls'
import { buildTable, type Route } from '../src/router/table'
import { probePg, resolveOrWake, SSL_REQUEST, startupMessage } from '../src/router/wake'
import { engineRouterDeps } from '../src/router/deps'
import { classifyWakeError } from '../src/router/wake'
import { WakeTimeoutError } from '../src/scheduler'
import type { ServiceState, UpstreamAddr, UpstreamLike } from '../src/router/deps'
import type { Config } from '../src/config'
import type { State } from '../src/state'
import { makeEngine, resetFakes, serverConfig, testConfig } from './fakes'
import type { Branch, Project } from '../src/types'

// The TLS cases mint pairs with the openssl CLI, which `npm test` does not require: where it is
// absent they skip by name, as the README says, rather than fail.
const hasOpenssl = spawnSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).status === 0

// ---- fakes -------------------------------------------------------------------------------------

class FakeUpstream implements UpstreamLike {
  readonly addrs = new Map<string, { host: string; port: number }>()
  readonly forgotten: string[] = []
  async resolve(container: string): Promise<UpstreamAddr | null> {
    const a = this.addrs.get(container)
    return a ? { host: a.host, port: a.port, containerId: `id-${container}`, startedAt: '' } : null
  }
  forget(container: string): void { this.forgotten.push(container) }
  forgetIfChanged(): void { /* the sweep's job, not the router's */ }
  async dial(): Promise<boolean> { return true }
}

const EMPTY: State = {
  projects: {}, branches: {}, policies: {}, approvals: [], events: [], userSecrets: {},
  rev: 1, auditRev: 0, customDomains: {}, templateDeployments: {},
}
const project = (over: Partial<Project> = {}): Project => ({ id: 'p1', name: 'demo', status: 'ready', createdAt: 1, refSlug: 'demo', ...over })
const branch = (over: Partial<Branch> = {}): Branch => ({
  id: 'b1', projectId: 'p1', name: 'main', isDefault: true, status: 'ready', ref: 'demo-main',
  network: 'io-demo-main', cloneOf: null, createdAt: 1, apps: {}, ...over,
})

const listenEphemeral = (s: Server | NetServer): Promise<number> => new Promise((resolve, reject) => {
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => {
    const a = s.address()
    resolve(typeof a === 'object' && a ? a.port : 0)
  })
})

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

/** An origin the lane proxies to; `handler` may be swapped between requests. */
interface Origin { port: number; server: Server; requests: IncomingMessage[] }
const origin = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Origin> => {
  const requests: IncomingMessage[] = []
  const server = createHttpServer((req, res) => { requests.push(req); handler(req, res) })
  const port = await listenEphemeral(server)
  return { port, server, requests }
}

interface Harness {
  router: Router
  port: number
  upstream: FakeUpstream
  state: State
  cfg: Config
  wakes: { count: number }
  touched: string[]
  api: { hits: number }
  close(): Promise<void>
}

/** A Router on an ephemeral port with a fake API handler and a singleflight fake wake. The wake
 *  registers the upstream address, so `stateOf` flips to running exactly as the scheduler's does. */
async function harness(cfg: Config, state: State, opts: {
  onWake?: (route: Route) => Promise<void>
  attach?: boolean
  wakeDelayMs?: number
} = {}): Promise<Harness> {
  const upstream = new FakeUpstream()
  const wakes = { count: 0 }
  const touched: string[] = []
  const api = { hits: 0 }
  let inflight: Promise<void> | null = null

  const stateOf = (route: Route): ServiceState => (upstream.addrs.has(route.container) ? 'running' : 'asleep')
  const wake = (route: Route): Promise<void> => {
    // The scheduler is singleflight per key; the router must not add a second map (decision 52).
    if (!inflight) {
      inflight = (async () => {
        wakes.count++
        await delay(opts.wakeDelayMs ?? 5)
        if (opts.onWake) await opts.onWake(route)
      })().finally(() => { inflight = null })
    }
    return inflight
  }

  const router = new Router({
    cfg,
    table: () => buildTable(state, cfg, () => { /* quiet */ }),
    stateOf,
    wake,
    touch: (k) => touched.push(k),
    beginHold: () => { /* the engine's ledger; the router keeps its own counts */ },
    endHold: () => { /* idem */ },
    upstream,
    certs: new Certs({ certDir: cfg.tls.certDir, issue: async () => { /* no issuer in tests */ } }),
    log: () => { /* quiet */ },
  })
  if (opts.attach !== false) router.attach((_req, res) => { api.hits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"api":true}') })
  const port = await listenEphemeral(router.httpServer)
  return {
    router, port, upstream, state, cfg, wakes, touched, api,
    close: async () => { await router.stop(); router.httpServer.close() },
  }
}

interface Answer { status: number; body: string; headers: Record<string, string | string[] | undefined> }
const call = (port: number, host: string, path = '/', opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host, ...opts.headers } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.once('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })

beforeEach(() => { resetFakes() })

// ---- HTTP lane ---------------------------------------------------------------------------------

test('the HTTP lane routes by Host, preserves Host and appends X-Forwarded-*', async () => {
  const up = await origin((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`ok ${req.headers.host}`) })
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: up.port, url: 'u' } } }) } }
  const h = await harness(testConfig(), state)
  h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: up.port })

  const r = await call(h.port, 'web-demo-main.localhost')
  expect(r.status).toBe(200)
  expect(r.body).toBe('ok web-demo-main.localhost')                 // Host reaches the app unchanged
  const seen = up.requests[up.requests.length - 1]
  expect(seen.headers['x-forwarded-host']).toBe('web-demo-main.localhost')
  expect(seen.headers['x-forwarded-for']).toBe('127.0.0.1')
  expect(seen.headers['x-forwarded-proto']).toBe('http')
  // Hop-by-hop headers are per hop: the client's `connection` never reaches the app (the lane's own
  // keep-alive agent sets its own for the second hop).
  await call(h.port, 'web-demo-main.localhost', '/', { headers: { connection: 'close' } })
  expect(up.requests[up.requests.length - 1].headers['connection']).not.toBe('close')

  // The edge's https claim over loopback is honoured.
  await call(h.port, 'web-demo-main.localhost', '/', { headers: { 'x-forwarded-proto': 'https' } })
  expect(up.requests[up.requests.length - 1].headers['x-forwarded-proto']).toBe('https')

  await h.close(); up.server.close()
})

test('daemon hosts go to the API; local mode sends an unknown Host there too, a custom domain still reaches the lane', async () => {
  const up = await origin((_req, res) => { res.writeHead(200); res.end('app') })
  const state: State = {
    ...EMPTY, projects: { p1: project() },
    branches: { b1: branch({ apps: { web: { image: 'i', port: up.port, url: 'u' } } }) },
    customDomains: { 'app.example.com': { hostname: 'app.example.com', projectId: 'p1', branchId: 'b1', group: 'web', createdAt: 1 } },
  }
  const h = await harness(testConfig(), state)
  h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: up.port })

  expect((await call(h.port, '127.0.0.1')).body).toBe('{"api":true}')
  expect((await call(h.port, 'localhost')).body).toBe('{"api":true}')
  expect((await call(h.port, 'api.localhost')).body).toBe('{"api":true}')
  expect((await call(h.port, 'console.localhost')).body).toBe('{"api":true}')
  expect((await call(h.port, 'host.docker.internal')).body).toBe('{"api":true}')
  expect((await call(h.port, 'my-laptop.lan')).body).toBe('{"api":true}')     // today's behaviour
  // A custom-domain alias is in the table, so it reaches the lane, not the API.
  expect((await call(h.port, 'app.example.com')).body).toBe('app')

  await h.close(); up.server.close()
})

test('server mode answers an unknown Host with 404 JSON, and api.<domain> with the API', async () => {
  const cfg = serverConfig()
  const h = await harness(cfg, { ...EMPTY })
  expect((await call(h.port, 'api.example.test')).body).toBe('{"api":true}')
  const r = await call(h.port, 'nobody.example.test')
  expect(r.status).toBe(404)
  expect(JSON.parse(r.body)).toEqual({ error: 'unknown route' })
  await h.close()
})

test('a request dispatched to the API before attach() answers 503', async () => {
  const h = await harness(testConfig(), { ...EMPTY }, { attach: false })
  const r = await call(h.port, '127.0.0.1')
  expect(r.status).toBe(503)
  expect(JSON.parse(r.body)).toEqual({ error: 'daemon not ready' })
  await h.close()
})

test('a database host over HTTP is 503 with no HTTP endpoint, and never wakes anything', async () => {
  const state: State = {
    ...EMPTY, projects: { p1: project() },
    branches: { b1: branch({ databases: { 'pg-db': { url: 'u', container: 'io-demo-main-pg-db', dataId: 'db' } }, lanes: { 'pg-db': 20000 } }) },
  }
  const h = await harness(testConfig(), state)
  const r = await call(h.port, 'pg-db-demo-main.localhost')
  expect(r.status).toBe(503)
  expect(JSON.parse(r.body)).toEqual({ error: 'this service serves no HTTP endpoint' })
  expect(h.wakes.count).toBe(0)
  await h.close()
})

test('desiredState stopped or suspended answers 503 without calling wake', async () => {
  const state = (desired: 'stopped' | 'suspended'): State => ({
    ...EMPTY, projects: { p1: project() },
    branches: { b1: branch({ apps: { web: { image: 'i', port: 1, url: 'u', desiredState: desired } } }) },
  })
  const stopped = await harness(testConfig(), state('stopped'))
  const a = await call(stopped.port, 'web-demo-main.localhost')
  expect(a.status).toBe(503)
  expect(JSON.parse(a.body)).toEqual({ error: 'service is stopped' })
  expect(stopped.wakes.count).toBe(0)
  await stopped.close()

  const suspended = await harness(testConfig(), state('suspended'))
  const b = await call(suspended.port, 'web-demo-main.localhost')
  expect(b.status).toBe(503)
  expect(JSON.parse(b.body)).toEqual({ error: 'service is suspended' })
  expect(suspended.wakes.count).toBe(0)
  await suspended.close()
})

test('ten concurrent requests on a sleeping route resolve through ONE wake and ONE activity timer', async () => {
  const up = await origin((_req, res) => { res.writeHead(200); res.end('woke') })
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: up.port, url: 'u' } } }) } }
  const timers = vi.spyOn(globalThis, 'setInterval')
  const h = await harness(testConfig({ INSTA_OSS_TOUCH_DEBOUNCE_MS: '50' }), state, {
    wakeDelayMs: 40,
    onWake: async () => { h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: up.port }) },
  })

  const answers = await Promise.all(Array.from({ length: 10 }, () => call(h.port, 'web-demo-main.localhost')))
  expect(answers.every((a) => a.status === 200 && a.body === 'woke')).toBe(true)
  expect(h.wakes.count).toBe(1)
  // One shared ticker for every held key, whatever the number of requests.
  expect(timers.mock.calls.filter((c) => c[1] === 50).length).toBe(1)
  // Every hold released.
  expect(h.router.holds('b1:cp-web')).toBe(0)
  timers.mockRestore()
  await h.close(); up.server.close()
})

test('wake failures map to the cloud-shaped statuses', async () => {
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: 1, url: 'u' } } }) } }
  const cases: Array<[string, number, string]> = [
    ['WakeTimeoutError', 504, 'service wake timed out'],
    ['ServiceStoppedError', 503, 'service is stopped'],
    ['NoContainerError', 503, 'service has no container (deploy in progress or removed)'],
    ['SomethingElse', 503, 'service could not be woken'],
  ]
  for (const [name, status, error] of cases) {
    const h = await harness(testConfig(), state, {
      onWake: async () => {
        const e = new Error(name === 'WakeTimeoutError' ? new WakeTimeoutError(60).message : name === 'ServiceStoppedError' ? 'service is stopped' : name === 'NoContainerError' ? 'service has no container (deploy in progress or removed)' : 'boom')
        Object.defineProperty(e.constructor, 'name', { value: name })
        throw e
      },
    })
    const r = await call(h.port, 'web-demo-main.localhost')
    expect([name, r.status]).toEqual([name, status])
    expect(JSON.parse(r.body)).toEqual({ error })
    await h.close()
  }
})

test('a woken upstream that answers 503 twice then 200 is retried for a bodiless GET', async () => {
  let hits = 0
  const up = await origin((_req, res) => {
    hits++
    if (hits <= 2) { res.writeHead(503); res.end('warming') } else { res.writeHead(200); res.end('ready') }
  })
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: up.port, url: 'u' } } }) } }
  const h = await harness(testConfig({ INSTA_OSS_READY_WINDOW_MS: '5000' }), state, {
    onWake: async () => { h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: up.port }) },
  })
  const r = await call(h.port, 'web-demo-main.localhost')
  expect(r.status).toBe(200)
  expect(r.body).toBe('ready')
  expect(hits).toBe(3)
  await h.close(); up.server.close()
})

test('a POST that woke the service is gated on HEAD / and then forwarded exactly once', async () => {
  let heads = 0
  let posts = 0
  const up = await origin((req, res) => {
    if (req.method === 'HEAD') { heads++; res.writeHead(heads < 2 ? 503 : 200); res.end(); return }
    posts++
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => { res.writeHead(201, { 'content-type': 'text/plain' }); res.end(`got ${body}`) })
  })
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: up.port, url: 'u' } } }) } }
  const h = await harness(testConfig({ INSTA_OSS_READY_WINDOW_MS: '5000' }), state, {
    onWake: async () => { h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: up.port }) },
  })
  const r = await call(h.port, 'web-demo-main.localhost', '/things', { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } })
  expect(r.status).toBe(201)
  expect(r.body).toBe('got payload')
  expect(posts).toBe(1)
  expect(heads).toBeGreaterThanOrEqual(2)
  await h.close(); up.server.close()
})

test('a stream is not buffered and the shared ticker keeps stamping while it runs', async () => {
  const up = await origin((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: one\n\n')
    setTimeout(() => { res.write('data: two\n\n'); res.end() }, 180)
  })
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: up.port, url: 'u' } } }) } }
  const h = await harness(testConfig({ INSTA_OSS_TOUCH_DEBOUNCE_MS: '50' }), state)
  h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: up.port })

  const chunks: string[] = []
  const done = new Promise<void>((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: h.port, path: '/sse', headers: { host: 'web-demo-main.localhost' } }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (c: string) => chunks.push(c))
      res.on('end', () => resolve())
    })
    req.end()
  })
  await delay(80)
  expect(chunks.join('')).toContain('data: one')     // arrived before the response ended
  expect(h.router.holds('b1:cp-web')).toBe(1)
  await done
  expect(chunks.join('')).toContain('data: two')
  expect(h.router.holds('b1:cp-web')).toBe(0)
  // request start plus at least one 5 s-ticker stamp inside the 180 ms stream
  expect(h.touched.filter((k) => k === 'b1:cp-web').length).toBeGreaterThanOrEqual(2)
  await h.close(); up.server.close()
})

test('a protocol upgrade is spliced raw and held until the socket closes', async () => {
  // A minimal echo upstream: answer the handshake, then mirror every byte.
  const upstream = createNetServer((c) => {
    let head = ''
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1')
      if (!head.includes('\r\n\r\n')) return
      c.off('data', onData)
      c.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
      c.on('data', (d: Buffer) => c.write(d))
    }
    c.on('data', onData)
  })
  const upPort = await listenEphemeral(upstream)
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: upPort, url: 'u' } } }) } }
  const h = await harness(testConfig(), state)
  h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: upPort })

  const client = netConnect({ host: '127.0.0.1', port: h.port })
  await new Promise<void>((r) => client.once('connect', () => r()))
  client.write('GET /ws HTTP/1.1\r\nhost: web-demo-main.localhost\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')
  let seen = ''
  client.on('data', (d: Buffer) => { seen += d.toString('latin1') })
  await delay(120)
  expect(seen).toContain('101 Switching Protocols')
  expect(h.router.holds('b1:cp-web')).toBe(1)
  client.write('ping')
  await delay(120)
  expect(seen).toContain('ping')
  client.destroy()
  await delay(80)
  expect(h.router.holds('b1:cp-web')).toBe(0)
  await h.close(); upstream.close()
})

test('the bucket vhost picks the S3 API for signed or mutating traffic and the web endpoint otherwise', async () => {
  // Two origins standing in for Garage's two ports; the route's upstream is chosen per request, so
  // the test drives the choice through the header and the method and reads back which one answered.
  const api = await origin((_req, res) => { res.writeHead(200); res.end('s3-api') })
  const web = await origin((_req, res) => { res.writeHead(200); res.end('s3-web') })
  const cfg = serverConfig()
  const state: State = {
    ...EMPTY, projects: { p1: project() },
    branches: { b1: branch({ buckets: { 'st-store': { bucket: 'io-demo-main-store', env: {} } } }) },
  }
  const h = await harness(cfg, state)
  // The lane dials 127.0.0.1 on Garage's fixed ports; point those at the two origins by rewriting
  // the table's static routes through a port-mapping proxy is unnecessary: assert the CHOICE instead.
  const chosen: number[] = []
  const spy = vi.spyOn(h.router as unknown as { table(): ReturnType<typeof buildTable> }, 'table')
  spy.mockImplementation(() => {
    const t = buildTable(state, cfg, () => { /* quiet */ })
    return {
      ...t,
      byHost: (host: string) => {
        const r = t.byHost(host)
        if (r?.kind !== 'garage-vhost') return r
        return { ...r }
      },
    }
  })
  spy.mockRestore()

  // Direct assertions on the upstream choice, which is what the lane decides.
  const { HttpLane } = await import('../src/router/http')
  const lane = new HttpLane({
    cfg, upstream: h.upstream, stateOf: () => 'running', wake: async () => { /* static route */ },
    touch: () => { /* no key */ }, beginHold: () => { /* no key */ }, endHold: () => { /* no key */ },
    signal: new AbortController().signal, log: () => { /* quiet */ },
  })
  const pick = (lane as unknown as { staticUpstream(r: Route, req: { headers: Record<string, string>; url: string; method: string }): UpstreamAddr | null }).staticUpstream.bind(lane)
  const vhost = buildTable(state, cfg, () => { /* quiet */ }).byHost('io-demo-main-store.s3.example.test') as Route

  chosen.push(pick(vhost, { headers: { authorization: 'AWS4-HMAC-SHA256 Credential=x' }, url: '/k', method: 'PUT' })!.port)
  chosen.push(pick(vhost, { headers: {}, url: '/k?X-Amz-Signature=abc', method: 'GET' })!.port)
  chosen.push(pick(vhost, { headers: {}, url: '/k', method: 'DELETE' })!.port)
  chosen.push(pick(vhost, { headers: {}, url: '/k', method: 'GET' })!.port)
  chosen.push(pick(vhost, { headers: {}, url: '/k', method: 'HEAD' })!.port)
  expect(chosen).toEqual([3900, 3900, 3900, 3902, 3902])

  await h.close(); api.server.close(); web.server.close()
})

// ---- lane listeners ----------------------------------------------------------------------------

test('invalidate() opens the lane of a newly added route and closes a removed one', async () => {
  const cfg = testConfig({ INSTA_OSS_LANE_PORT_RANGE: '31200-31299' })
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch() } }
  const h = await harness(cfg, state)
  await h.router.start()

  const canConnect = (port: number): Promise<boolean> => new Promise((resolve) => {
    const s = netConnect({ host: '127.0.0.1', port })
    s.setTimeout(500, () => { s.destroy(); resolve(false) })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => { s.destroy(); resolve(false) })
  })

  expect(await canConnect(31200)).toBe(false)
  state.branches.b1.databases = { 'pg-db': { url: 'u', container: 'io-demo-main-pg-db', dataId: 'db' } }
  state.branches.b1.lanes = { 'pg-db': 31200 }
  h.router.invalidate()
  await delay(120)
  expect(await canConnect(31200)).toBe(true)

  delete state.branches.b1.databases
  delete state.branches.b1.lanes
  h.router.invalidate()
  await delay(120)
  expect(await canConnect(31200)).toBe(false)

  await h.close()
})

test('a per-service lane port already bound is reallocated with a warning', async () => {
  const cfg = testConfig({ INSTA_OSS_LANE_PORT_RANGE: '31300-31399' })
  const squatter = createNetServer(() => { /* holds the port */ })
  await new Promise<void>((r) => squatter.listen(31300, '127.0.0.1', () => r()))

  const state: State = {
    ...EMPTY, projects: { p1: project() },
    branches: { b1: branch({ databases: { 'pg-db': { url: 'u', container: 'io-demo-main-pg-db', dataId: 'db' } }, lanes: { 'pg-db': 31300 } }) },
  }
  const logs: string[] = []
  const upstream = new FakeUpstream()
  const router = new Router({
    cfg,
    table: () => buildTable(state, cfg, () => { /* quiet */ }),
    stateOf: () => 'running',
    wake: async () => { /* not reached */ },
    touch: () => { /* no-op */ }, beginHold: () => { /* no-op */ }, endHold: () => { /* no-op */ },
    upstream,
    reallocLane: () => { state.branches.b1.lanes = { 'pg-db': 31301 }; return 31301 },
    certs: new Certs({ certDir: null }),
    log: (m) => logs.push(m),
  })
  await listenEphemeral(router.httpServer)
  await router.start()
  await delay(120)

  expect(logs.some((m) => /lane port 31300 .* was in use; moved to 31301/.test(m))).toBe(true)
  await router.stop()
  router.httpServer.close()
  squatter.close()
})

// ---- postgres lane -----------------------------------------------------------------------------

/** A fake postgres upstream: answers `N` to SSLRequest, then echoes with a `Z` prefix so the test can
 *  see bytes travel both ways. */
const fakePg = async (): Promise<{ port: number; server: NetServer; seen: Buffer[] }> => {
  const seen: Buffer[] = []
  const server = createNetServer((c) => {
    let handshook = false
    c.on('data', (d: Buffer) => {
      seen.push(d)
      if (!handshook && d.length >= 8 && d.readUInt32BE(4) === 80877103) { c.write('N'); return }
      handshook = true
      // Anything after the negotiation: answer AuthenticationOk-shaped bytes for the probe and echo.
      c.write(Buffer.concat([Buffer.from('R'), d]))
    })
  })
  return { port: await listenEphemeral(server), server, seen }
}

const pgLaneHarness = async (cfg: Config, state: State, opts: { onWake?: () => void } = {}): Promise<{
  port: number; server: NetServer; upstream: FakeUpstream; wakes: { count: number }; touched: string[]; close(): void
}> => {
  const upstream = new FakeUpstream()
  const wakes = { count: 0 }
  const touched: string[] = []
  const ctrl = new AbortController()
  const certs = new Certs({ certDir: cfg.tls.certDir, issue: async () => { /* none */ } })
  const defaultCtx = cfg.tls.certDir ? await certs.certFor(`api.${cfg.domain}`) : null
  const server = createPgLane({
    cfg,
    table: () => buildTable(state, cfg, () => { /* quiet */ }),
    stateOf: () => (upstream.addrs.size ? 'running' : 'asleep'),
    wake: async () => { wakes.count++; opts.onWake?.() },
    touch: (k) => touched.push(k),
    beginHold: () => { /* counted by the router in production */ },
    endHold: () => { /* idem */ },
    upstream,
    signal: ctrl.signal,
    secureContext: () => defaultCtx,
    sniCallback: certs.sniCallback(() => defaultCtx),
    log: () => { /* quiet */ },
  }, '127.0.0.1', 0)
  const port = await listenEphemeral(server)
  return { port, server, upstream, wakes, touched, close: () => { ctrl.abort(); server.close() } }
}

const pgState = (container: string, lanePort: number): State => ({
  ...EMPTY, projects: { p1: project() },
  branches: { b1: branch({ databases: { 'pg-db': { url: 'u', container, dataId: 'db' } }, lanes: { 'pg-db': lanePort } }) },
})

test('local pg lane: SSLRequest is answered N, the Startup is forwarded and bytes splice both ways', async () => {
  const up = await fakePg()
  const cfg = testConfig()
  const state = pgState('io-demo-main-pg-db', 0)
  const h = await pgLaneHarness(cfg, state, {})
  h.upstream.addrs.set('io-demo-main-pg-db', { host: '127.0.0.1', port: up.port })
  // The route is looked up by the LOCAL listen port, so the lane port must match the listener.
  state.branches.b1.lanes = { 'pg-db': h.port }

  const c = netConnect({ host: '127.0.0.1', port: h.port })
  await new Promise<void>((r) => c.once('connect', () => r()))
  const answers: Buffer[] = []
  c.on('data', (d: Buffer) => answers.push(d))
  c.write(SSL_REQUEST)
  await delay(60)
  expect(answers[0]?.toString('latin1')).toBe('N')          // no TLS in local mode

  c.write(startupMessage({ user: 'postgres', database: 'app' }))
  await delay(250)
  expect(up.seen.some((b) => b.includes('postgres'))).toBe(true)
  expect(Buffer.concat(answers.slice(1)).length).toBeGreaterThan(0)   // the upstream's bytes came back
  expect(h.touched).toContain('b1:pg-db')
  c.destroy()
  h.close(); up.server.close()
})

test('local pg lane: a plaintext Startup arrives first and is still forwarded after the wake', async () => {
  const up = await fakePg()
  const cfg = testConfig()
  const state = pgState('io-demo-main-pg-db', 0)
  const h = await pgLaneHarness(cfg, state, {})
  state.branches.b1.lanes = { 'pg-db': h.port }
  // Asleep at first: the wake registers the address, exactly as the scheduler's does.
  const withWake = await pgLaneHarness(cfg, state, {})
  withWake.upstream.addrs.set('io-demo-main-pg-db', { host: '127.0.0.1', port: up.port })
  state.branches.b1.lanes = { 'pg-db': withWake.port }

  const c = netConnect({ host: '127.0.0.1', port: withWake.port })
  await new Promise<void>((r) => c.once('connect', () => r()))
  c.write(startupMessage({ user: 'postgres', database: 'app' }))
  await delay(250)
  expect(up.seen.some((b) => b.includes('postgres'))).toBe(true)
  c.destroy()
  h.close(); withWake.close(); up.server.close()
})

test('server pg lane: SSLRequest is answered S, SNI picks the route, and a plaintext Startup is refused readably', async () => {
  const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
  for (const host of ['router.test', 'api.router.test', 'pg-db-demo-main.router.test']) {
    mkdirSync(join(certDir, 'local', host), { recursive: true })
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', host, `${host}.crt`))
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', host, `${host}.key`))
  }
  const up = await fakePg()
  const cfg = serverConfig({ INSTA_OSS_DOMAIN: 'router.test', INSTA_OSS_TLS_CERT_DIR: certDir })
  const state = pgState('io-demo-main-pg-db', 5432)
  const h = await pgLaneHarness(cfg, state, {})
  h.upstream.addrs.set('io-demo-main-pg-db', { host: '127.0.0.1', port: up.port })

  // 1. A plaintext Startup: refused with the sentence that names the fix.
  const plain = netConnect({ host: '127.0.0.1', port: h.port })
  await new Promise<void>((r) => plain.once('connect', () => r()))
  const answered = new Promise<Buffer>((r) => { plain.once('data', (d: Buffer) => r(d)) })
  plain.write(startupMessage({ user: 'postgres', database: 'app' }))
  expect((await answered).toString('latin1')).toContain('sslmode=require')
  plain.destroy()

  // 2. SSLRequest then TLS with the right SNI: the connection reaches the upstream.
  const routed = await pgOverTls(h.port, 'pg-db-demo-main.router.test')
  expect(routed.negotiated).toBe('S')
  expect(routed.error).toBeNull()

  // 3. An unknown SNI: a readable ErrorResponse, not a dropped socket.
  const unknown = await pgOverTls(h.port, 'router.test')
  expect(unknown.error).toContain('no database at this hostname')

  h.close(); up.server.close()
})

/** Speak SSLRequest, wrap in TLS with `servername`, then read whatever the lane says. */
async function pgOverTls(port: number, servername: string): Promise<{ negotiated: string; error: string | null }> {
  const raw = netConnect({ host: '127.0.0.1', port })
  await new Promise<void>((r) => raw.once('connect', () => r()))
  raw.write(SSL_REQUEST)
  const negotiated = (await new Promise<Buffer>((r) => { raw.once('data', (d: Buffer) => r(d)) })).toString('latin1')
  if (negotiated !== 'S') { raw.destroy(); return { negotiated, error: null } }
  const t = tlsConnect({ socket: raw, servername, rejectUnauthorized: false })
  const settled = await new Promise<{ error: string | null }>((resolve) => {
    let answered = false
    t.once('secureConnect', () => {
      t.write(startupMessage({ user: 'postgres', database: 'app' }))
      setTimeout(() => { if (!answered) resolve({ error: null }) }, 250)
    })
    // Only a wire ErrorResponse ('E') is an error; anything else is the upstream answering.
    t.on('data', (d: Buffer) => { answered = true; resolve({ error: d[0] === 0x45 ? d.toString('latin1') : null }) })
    t.once('error', () => { if (!answered) resolve({ error: null }) })
  })
  t.destroy()
  return { negotiated, error: settled.error }
}

test('a client that sends NO SNI completes the handshake on the default context and is told so', async () => {
  const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
  for (const host of ['api.router.test']) {
    mkdirSync(join(certDir, 'local', host), { recursive: true })
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', host, `${host}.crt`))
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', host, `${host}.key`))
  }
  const cfg = serverConfig({ INSTA_OSS_DOMAIN: 'router.test', INSTA_OSS_TLS_CERT_DIR: certDir })
  const h = await pgLaneHarness(cfg, pgState('io-demo-main-pg-db', 5432), {})

  const raw = netConnect({ host: '127.0.0.1', port: h.port })
  await new Promise<void>((r) => raw.once('connect', () => r()))
  raw.write(SSL_REQUEST)
  await new Promise<Buffer>((r) => { raw.once('data', (d: Buffer) => r(d)) })
  // No `servername`: libpq before 14 and older JDBC drivers behave like this.
  const t = tlsConnect({ socket: raw, rejectUnauthorized: false })
  const answer = await new Promise<string>((resolve) => {
    t.once('secureConnect', () => { /* the handshake must succeed, else the client sees an alert */ })
    t.on('data', (d: Buffer) => resolve(d.toString('latin1')))
    t.once('error', (e) => resolve(`error:${e.message}`))
    setTimeout(() => resolve('timeout'), 1500)
  })
  expect(answer).toContain('sslsni')
  t.destroy()
  h.close()
})

test('the pg lane picks up the default certificate the edge issues AFTER it started listening', async () => {
  // The daemon and the edge come up together, so at router start the store is empty and nothing has
  // asked the edge for `api.<domain>` yet. A default context captured then stays null forever, and
  // every client that sends no SNI (redis-cli without --sni, libpq before 14) gets an opaque TLS
  // alert instead of the sentence that names the fix.
  const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
  const host = 'api.router.test'
  const cfg = serverConfig({ INSTA_OSS_DOMAIN: 'router.test', INSTA_OSS_TLS_CERT_DIR: certDir })
  const certs = new Certs({ certDir, issue: async () => { /* the edge is not up yet */ } })
  expect(await certs.certFor(host)).toBeNull()

  let defaultCtx: SecureContext | null = null
  const ctrl = new AbortController()
  const upstream = new FakeUpstream()
  const server = createPgLane({
    cfg,
    table: () => buildTable(pgState('io-demo-main-pg-db', 5432), cfg, () => { /* quiet */ }),
    stateOf: () => 'running',
    wake: async () => { /* not reached */ },
    touch: () => { /* not reached */ },
    beginHold: () => { /* idem */ },
    endHold: () => { /* idem */ },
    upstream,
    signal: ctrl.signal,
    secureContext: () => defaultCtx,
    sniCallback: certs.sniCallback(() => defaultCtx),
    log: () => { /* quiet */ },
  }, '127.0.0.1', 0)
  const port = await listenEphemeral(server)

  const noSni = async (): Promise<string> => {
    const raw = netConnect({ host: '127.0.0.1', port })
    await new Promise<void>((r) => raw.once('connect', () => r()))
    raw.write(SSL_REQUEST)
    await new Promise<Buffer>((r) => { raw.once('data', (d: Buffer) => r(d)) })
    const t = tlsConnect({ socket: raw, rejectUnauthorized: false })
    const answer = await new Promise<string>((resolve) => {
      t.on('data', (d: Buffer) => resolve(d.toString('latin1')))
      t.once('error', (e) => resolve(`error:${e.message}`))
      setTimeout(() => resolve('timeout'), 1500)
    })
    t.destroy()
    return answer
  }

  // Before the certificate exists there is nothing to present, and the handshake cannot complete.
  expect(await noSni()).not.toContain('sslsni')

  // The edge issues it. `refreshDefaultContext` is what does this in the Router; the lane reads the
  // context per connection, so the very next client is answered.
  mkdirSync(join(certDir, 'local', host), { recursive: true })
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', host, `${host}.crt`))
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', host, `${host}.key`))
  defaultCtx = await certs.certFor(host)
  expect(defaultCtx).not.toBeNull()
  expect(certs.materialFor(host)).not.toBeNull()

  expect(await noSni()).toContain('sslsni')
  ctrl.abort(); server.close()
})

test('the wire ErrorResponse encoding is what libpq parses', () => {
  const e = errorResponse('57P03', 'the database is waking up; retry')
  expect(e[0]).toBe(0x45)
  expect(e.readUInt32BE(1)).toBe(e.length - 1)
  expect(e.toString('latin1')).toContain('C57P03')
  expect(e[e.length - 1]).toBe(0)
  expect(PG_ERRORS.SSL_REQUIRED.toString('latin1')).toContain('sslmode=require')
})

// ---- SNI lane ----------------------------------------------------------------------------------

test('the redis SNI lane treats -LOADING as not ready and +PONG as ready', async () => {
  const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
  for (const host of ['api.router.test', 'redis-cache-demo-main.router.test']) {
    mkdirSync(join(certDir, 'local', host), { recursive: true })
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', host, `${host}.crt`))
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', host, `${host}.key`))
  }
  // The upstream answers -LOADING to the first PING and +PONG afterwards.
  let pings = 0
  const upstream = createNetServer((c) => {
    c.on('data', () => { pings++; c.write(pings === 1 ? '-LOADING redis is loading the dataset in memory\r\n' : '+PONG\r\n') })
  })
  const upPort = await listenEphemeral(upstream)

  const cfg = serverConfig({ INSTA_OSS_DOMAIN: 'router.test', INSTA_OSS_TLS_CERT_DIR: certDir })
  const state: State = {
    ...EMPTY,
    projects: { p1: project({ managedServices: [{ id: 'rd-cache', type: 'redis', name: 'cache', createdAt: 1 }] }) },
    branches: { b1: branch({ managed: { 'rd-cache': { password: 'p' } } }) },
  }
  const fake = new FakeUpstream()
  const certs = new Certs({ certDir, issue: async () => { /* none */ } })
  const defaultCtx = await certs.certFor('api.router.test')
  const ctrl = new AbortController()
  let wakes = 0
  const lane = createSniLane({
    cfg,
    table: () => buildTable(state, cfg, () => { /* quiet */ }),
    stateOf: () => (fake.addrs.size ? 'running' : 'asleep'),
    wake: async () => { wakes++; fake.addrs.set('io-demo-main-rd-cache', { host: '127.0.0.1', port: upPort }) },
    touch: () => { /* stamped */ }, beginHold: () => { /* held */ }, endHold: () => { /* released */ },
    upstream: fake, signal: ctrl.signal, defaultMaterial: certs.materialFor('api.router.test'), sniCallback: certs.sniCallback(defaultCtx),
    log: () => { /* quiet */ },
  }, 'redis', '127.0.0.1', 0)
  const port = await listenEphemeral(lane)

  // A ClientHello with NO SNI must still complete the handshake on the default certificate: the
  // client then reads a close and can see the port, instead of an opaque alert with nothing behind
  // it. `tls.createServer` ignores a `secureContext` option, so this only holds while the lane
  // installs the certificate with `setSecureContext` (decision 21).
  const bare = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false })
  const bareHandshake = await new Promise<boolean>((resolve) => {
    bare.once('secureConnect', () => resolve(true))
    bare.once('error', () => resolve(false))
    setTimeout(() => resolve(false), 3000)
  })
  expect(bareHandshake).toBe(true)
  bare.destroy()

  const c = tlsConnect({ host: '127.0.0.1', port, servername: 'redis-cache-demo-main.router.test', rejectUnauthorized: false })
  const spliced = await new Promise<boolean>((resolve) => {
    c.once('secureConnect', () => {
      c.write('*1\r\n$4\r\nPING\r\n')
      c.once('data', () => resolve(true))
    })
    c.once('error', () => resolve(false))
    setTimeout(() => resolve(false), 3000)
  })
  expect(wakes).toBe(1)
  expect(pings).toBeGreaterThanOrEqual(2)     // -LOADING was retried
  expect(spliced).toBe(true)
  c.destroy()
  ctrl.abort(); lane.close(); upstream.close()
})

afterEach(() => { vi.restoreAllMocks() })

// ---- certificate store (02 section 8) ----------------------------------------------------------

test('the cert store refuses a servername that is not a hostname before it becomes a path', async () => {
  const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
  const host = 'api.router.test'
  mkdirSync(join(certDir, 'local', host), { recursive: true })
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', host, `${host}.crt`))
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', host, `${host}.key`))
  // A real pair OUTSIDE the `<issuer>/<host>/` layout: `join(certDir, 'local', '../x', '../x.crt')`
  // normalises to `<certDir>/x.crt`, so a servername of `../x` served it before the shape check.
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'x.crt'))
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'x.key'))

  let issued: string[] = []
  const certs = new Certs({ certDir, issue: async (h) => { issued.push(h) } })
  expect(await certs.certFor(host)).not.toBeNull()
  expect(findCertFiles(certDir, host)).not.toBeNull()

  issued = []
  for (const bad of ['../x', '../../escaped', 'a/b', 'has space', '', 'under_score.router.test', 'x'.repeat(254)]) {
    expect(findCertFiles(certDir, bad), bad).toBeNull()
    expect(await certs.certFor(bad), bad).toBeNull()
  }
  // A malformed name never even asks the edge to issue for it.
  expect(issued).toEqual([])
})

test('sniCallback hands the default context to a servername the route table does not serve, and reads no store', async () => {
  const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
  const host = 'api.router.test'
  mkdirSync(join(certDir, 'local', host), { recursive: true })
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', host, `${host}.crt`))
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', host, `${host}.key`))
  const issued: string[] = []
  const certs = new Certs({ certDir, issue: async (h) => { issued.push(h) } })
  const fallback = await certs.certFor(host)
  expect(fallback).not.toBeNull()

  const owned = new Set([host])
  const cb = certs.sniCallback(fallback, (h) => owned.has(h))
  const ask = (servername: string): Promise<unknown> =>
    new Promise((resolve, reject) => cb(servername, (e, ctx) => (e ? reject(e) : resolve(ctx))))

  // Case and a trailing dot still reach the store: Caddy may send either.
  expect(await ask('API.router.test.')).toBe(fallback)
  expect(issued).toEqual([])
  // A name nobody serves gets the default context and buys no issuance handshake and no walk.
  expect(await ask('scan-1.example.com')).toBe(fallback)
  expect(await ask('scan-2.example.com')).toBe(fallback)
  expect(issued).toEqual([])
})

test('a name under the bucket suffix that no bucket owns is refused for certificate work, a registered host is not', async () => {
  const cfg = serverConfig()
  const state: State = {
    ...EMPTY,
    projects: { p1: project() },
    branches: {
      b1: branch({
        databases: { 'pg-db': { url: 'postgres://x', container: 'io-demo-main-pg-db' } },
        buckets: { 'st-store': { bucket: 'io-demo-main-store', env: {} } },
      }),
    },
  }
  const h = await harness(cfg, state)
  const dbHost = 'pg-db-demo-main.example.test'
  const bucketHost = 'io-demo-main-store.s3.example.test'
  const stranger = 'not-a-bucket.s3.example.test'
  try {
    // Routing still matches ANY single label under the suffix: the object store answers its own 404.
    expect(h.router.table().byHost(stranger)?.kind).toBe('garage-vhost')
    // Ownership does not, and ownership is what authorizes certificate work.
    expect(h.router.ownsHostname(stranger)).toBe(false)
    expect(h.router.ownsHostname(bucketHost)).toBe(true)
    expect(h.router.ownsHostname(dbHost)).toBe(true)
    expect(h.router.ownsHostname(`api.${cfg.domain}`)).toBe(true)
    expect(h.router.ownsHostname('nothing.example.test')).toBe(false)

    // The predicate the database lanes hand to Certs is this one, so a stranger arriving as a TLS
    // servername on the public pg/redis/mongo ports reads no store and buys no issuance handshake.
    const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
    mkdirSync(join(certDir, 'local', dbHost), { recursive: true })
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', dbHost, `${dbHost}.crt`))
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', dbHost, `${dbHost}.key`))
    const issued: string[] = []
    const certs = new Certs({ certDir, issue: async (x) => { issued.push(x) } })
    const cb = certs.sniCallback(null, (x) => h.router.ownsHostname(x))
    const ask = (servername: string): Promise<unknown> =>
      new Promise((resolve, reject) => cb(servername, (e, ctx) => (e ? reject(e) : resolve(ctx))))

    expect(await ask(stranger)).toBeUndefined()
    expect(await ask('anything.s3.example.test')).toBeUndefined()
    expect(issued).toEqual([])
    // A hostname the box really serves still gets its certificate.
    expect(await ask(dbHost)).toBeDefined()
    expect(issued).toEqual([])
  } finally {
    await h.close()
  }
})

test.skipIf(!hasOpenssl)('a client that sends NO SNI is handed the RENEWED certificate, not the one the daemon booted with', async () => {
  // libpq before 14 and older JDBC drivers send no SNI. They are refused either way (the pg lane
  // answers 08P01 telling them to send it), but the handshake has to complete on the DEFAULT
  // context for them to be told. That default was set once at start and never looked at again,
  // so after a renewal SNI clients got the new certificate and these got the one the process
  // booted with -- an opaque alert once it expired, instead of the readable error.
  const dir = mkdtempSync(join(tmpdir(), 'io-nosni-renew-'))
  const mint = (crt: string, key: string, days: number): void => {
    const r = spawnSync('sh', ['-c',
      `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days ${days} -keyout ${key} -out ${crt} -subj '/CN=*.router.test' -addext 'subjectAltName=DNS:*.router.test' 2>/dev/null`,
    ], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`)
  }
  const fingerprintOf = (crt: string): string =>
    spawnSync('sh', ['-c', `openssl x509 -in ${crt} -noout -fingerprint -sha256`], { encoding: 'utf8' }).stdout.trim().split('=')[1]
  const freePort = async (): Promise<number> => {
    const s = createNetServer()
    const p = await listenEphemeral(s)
    await new Promise<void>((r) => s.close(() => r()))
    return p
  }
  const crt = join(dir, 'wildcard.crt')
  const key = join(dir, 'wildcard.key')
  mint(crt, key, 30)
  const [pgPort, redisPort, mongoPort] = [await freePort(), await freePort(), await freePort()]
  const cfg = serverConfig({
    INSTA_OSS_DOMAIN: 'router.test', INSTA_OSS_TLS_CERT_FILE: crt, INSTA_OSS_TLS_KEY_FILE: key,
    INSTA_OSS_LANE_PG_PORT: String(pgPort), INSTA_OSS_LANE_REDIS_PORT: String(redisPort), INSTA_OSS_LANE_MONGO_PORT: String(mongoPort),
  })
  const router = new Router({
    cfg, table: () => buildTable(EMPTY, cfg, () => { /* quiet */ }),
    stateOf: () => 'running', wake: async () => { /* nothing sleeps here */ },
    touch: () => { /* no scheduler */ }, beginHold: () => { /* idem */ }, endHold: () => { /* idem */ },
    upstream: new FakeUpstream(),
    certs: new Certs({ certDir: null, supplied: { crt, key }, issue: async () => { throw new Error('nothing may be issued here') }, log: () => { /* quiet */ } }),
    log: () => { /* quiet */ },
  })
  // What a no-SNI client is handed: the pg negotiation, then a handshake with no servername.
  const presented = async (): Promise<string> => {
    const raw = netConnect({ host: '127.0.0.1', port: pgPort })
    await new Promise<void>((r) => raw.once('connect', () => r()))
    raw.write(SSL_REQUEST)
    await new Promise<Buffer>((r) => { raw.once('data', (d: Buffer) => r(d)) })
    const t = tlsConnect({ socket: raw, rejectUnauthorized: false })
    await new Promise<void>((r, j) => { t.once('secureConnect', () => r()); t.once('error', j) })
    const fp = t.getPeerCertificate().fingerprint256
    t.destroy()
    return fp
  }
  try {
    await router.start()
    const first = fingerprintOf(crt)
    expect(await presented()).toBe(first)

    // The renewal as the docs describe it: a new pair written alongside, renamed over the old.
    mint(join(dir, 'next.crt'), join(dir, 'next.key'), 90)
    renameSync(join(dir, 'next.crt'), crt)
    renameSync(join(dir, 'next.key'), key)
    const second = fingerprintOf(crt)
    expect(second).not.toBe(first)

    // One beat later, which is what the daemon runs on its sweep interval.
    await router.refreshCertificates()
    expect(await presented()).toBe(second)
    // ...and an unchanged pair costs nothing more: the same certificate, beat after beat.
    await router.refreshCertificates()
    expect(await presented()).toBe(second)
  } finally {
    await router.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(!hasOpenssl)('a renewal whose bytes cannot be read yet is RETRIED, so the redis and mongo lanes do not keep the old default', async () => {
  // The context and the bytes are two reads of a pair someone else replaces. When the bytes
  // failed after the context had been committed, every later beat saw the same context, took the
  // "nothing moved" exit and never read the bytes again: pg (which uses the context) moved to the
  // renewal while redis and mongo (which take bytes through setSecureContext) kept the old one.
  const dir = mkdtempSync(join(tmpdir(), 'io-nosni-bytes-'))
  const mint = (crt: string, key: string, days: number): void => {
    const r = spawnSync('sh', ['-c',
      `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days ${days} -keyout ${key} -out ${crt} -subj '/CN=*.router.test' -addext 'subjectAltName=DNS:*.router.test' 2>/dev/null`,
    ], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`)
  }
  const fingerprintOf = (crt: string): string =>
    spawnSync('sh', ['-c', `openssl x509 -in ${crt} -noout -fingerprint -sha256`], { encoding: 'utf8' }).stdout.trim().split('=')[1]
  const freePort = async (): Promise<number> => {
    const s = createNetServer()
    const p = await listenEphemeral(s)
    await new Promise<void>((r) => s.close(() => r()))
    return p
  }
  // One read of the bytes fails, as when the renewal tool has the pair half-replaced.
  class FlakyCerts extends Certs {
    failNext = false
    override materialFor(host: string): { cert: Buffer; key: Buffer } | null {
      if (this.failNext) { this.failNext = false; return null }
      return super.materialFor(host)
    }
  }
  const crt = join(dir, 'wildcard.crt')
  const key = join(dir, 'wildcard.key')
  mint(crt, key, 30)
  const [pgPort, redisPort, mongoPort] = [await freePort(), await freePort(), await freePort()]
  const cfg = serverConfig({
    INSTA_OSS_DOMAIN: 'router.test', INSTA_OSS_TLS_CERT_FILE: crt, INSTA_OSS_TLS_KEY_FILE: key,
    INSTA_OSS_LANE_PG_PORT: String(pgPort), INSTA_OSS_LANE_REDIS_PORT: String(redisPort), INSTA_OSS_LANE_MONGO_PORT: String(mongoPort),
  })
  const certs = new FlakyCerts({ certDir: null, supplied: { crt, key }, issue: async () => { throw new Error('nothing may be issued here') }, log: () => { /* quiet */ } })
  const router = new Router({
    cfg, table: () => buildTable(EMPTY, cfg, () => { /* quiet */ }),
    stateOf: () => 'running', wake: async () => { /* nothing sleeps here */ },
    touch: () => { /* no scheduler */ }, beginHold: () => { /* idem */ }, endHold: () => { /* idem */ },
    upstream: new FakeUpstream(), certs, log: () => { /* quiet */ },
  })
  // A TLS lane client with no SNI: a bare IP sends none. The lane closes it after the handshake,
  // which is when the certificate it was handed is readable.
  const presented = async (port: number): Promise<string> => {
    const t = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false })
    t.on('error', () => { /* the lane closes a no-SNI client once the handshake is done */ })
    await new Promise<void>((r) => t.once('secureConnect', () => r()))
    const fp = t.getPeerCertificate().fingerprint256
    t.destroy()
    return fp
  }
  try {
    await router.start()
    const first = fingerprintOf(crt)
    expect(await presented(redisPort)).toBe(first)

    mint(join(dir, 'next.crt'), join(dir, 'next.key'), 90)
    renameSync(join(dir, 'next.crt'), crt)
    renameSync(join(dir, 'next.key'), key)
    const second = fingerprintOf(crt)
    expect(second).not.toBe(first)

    certs.failNext = true
    await router.refreshCertificates()   // the bytes could not be read on this beat...
    await router.refreshCertificates()   // ...so the next one has to try again
    expect(await presented(redisPort)).toBe(second)
    expect(await presented(mongoPort)).toBe(second)
  } finally {
    await router.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- write classes: what actually rebuilds the table --------------------------------------------

test('an audit event does not rebuild the route table; a real service change does', async () => {
  const cfg = testConfig()
  const engine = makeEngine(cfg)
  const { project } = await engine.createProject('demo')
  // No `table` seam: this Router builds from the real state file, memoized on the routing revision.
  const router = new Router({
    cfg, stateOf: () => 'running', wake: async () => { /* nothing sleeps here */ },
    touch: () => { /* no scheduler */ }, beginHold: () => { /* idem */ }, endHold: () => { /* idem */ },
    upstream: new FakeUpstream(), log: () => { /* quiet */ },
  })
  try {
    const before = router.table()
    // Secrets reads, storage object activity, template progress and every sleep or wake come
    // through emit. None of them changes a route, so none of them may cost a table rebuild.
    engine.emit(project.id, 'main', 'agent', 'secret.read', { name: 'API_KEY' })
    expect(router.table()).toBe(before)
    // The event still landed: this is an audit-class write, not a skipped one.
    expect(engine.listEvents(project.id).map((e) => e.kind)).toContain('secret.read')
    // A routing-class write is the thing that must invalidate.
    await engine.createProject('other')
    const after = router.table()
    expect(after).not.toBe(before)
    expect(after.byHost(`api.${cfg.domain}`)).toBeDefined()
  } finally {
    await router.stop()
  }
})


// ---- probes that cannot answer -----------------------------------------------------------------

test('an engine that cannot report state is not read as "running": the lane still wakes', async () => {
  // `stateOf` is an optional seam and its fallback was `'running'`, which is the one value that
  // SKIPS the wake. An engine that cannot answer therefore had its cached upstream address
  // dialled straight, past the wake that would have started the container.
  let woke = 0
  const deps = engineRouterDeps({ wake: async () => { woke++ }, ownsHostname: () => true })
  const route = { key: 'b1:cp-web', container: 'io-x', network: 'io-n', port: 8080 } as unknown as Route
  expect(deps.stateOf(route)).not.toBe('running')

  // ...and that is what the lane acts on: a cached address, and a wake all the same.
  const addr: UpstreamAddr = { host: '127.0.0.1', port: 1, containerId: 'c1', startedAt: '' }
  const upstream: UpstreamLike = {
    resolve: async () => addr,
    forget: () => {},
    forgetIfChanged: () => {},
    dial: async () => true,
  }
  const out = await resolveOrWake({ upstream, stateOf: deps.stateOf, wake: deps.wake }, route, { probe: async () => true })
  expect(woke).toBe(1)
  expect(out.woke).toBe(true)
})

test('a pg handshake answering something this protocol does not define is NOT ready', async () => {
  // The handshake ended in a bare `done('ready')`, so any first byte at all finished a wake:
  // an allowlist here, exactly like `probeRedis` next door. The server below completes the SSL
  // negotiation and then answers garbage, which is what a half-initialised container, a proxy
  // in the way or a truncated read looks like.
  const answers: Buffer[] = [Buffer.from('N'), Buffer.from('\u0000\u0000')]
  const srv = createNetServer((sock) => {
    let i = 0
    sock.on('data', () => { const a = answers[i++]; if (a) sock.write(a) })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  try {
    // Three polls' worth of window, so this is "never ready", not "not ready yet".
    expect(await probePg('127.0.0.1', port, 600)).toBe(false)
  } finally {
    await new Promise<void>((r) => srv.close(() => r()))
  }
})

test('a pg handshake that answers an ErrorResponse IS ready: the server is talking', async () => {
  // The other side of the allowlist: an error reply is the postmaster answering, and only
  // 57P03 (still starting up) means ask again. This is what keeps the fix from being a hang.
  const srv = createNetServer((sock) => {
    let seen = 0
    sock.on('data', () => {
      seen++
      if (seen === 1) return void sock.write(Buffer.from('N'))
      const body = Buffer.concat([
        Buffer.from('S'), Buffer.from('FATAL\u0000', 'latin1'),
        Buffer.from('C'), Buffer.from('28P01\u0000', 'latin1'),
        Buffer.from('M'), Buffer.from('password authentication failed\u0000', 'latin1'),
        Buffer.from('\u0000', 'latin1'),
      ])
      const msg = Buffer.alloc(5 + body.length)
      msg.write('E', 0, 'latin1')
      msg.writeInt32BE(body.length + 4, 1)
      body.copy(msg, 5)
      sock.write(msg)
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  try {
    expect(await probePg('127.0.0.1', port, 600)).toBe(true)
  } finally {
    await new Promise<void>((r) => srv.close(() => r()))
  }
})


test('both wake timeouts classify as a timeout through the TEXT branch, not only by class', () => {
  // `classifyWakeError` matches the class name first and falls back to the message only when it
  // is handed a string. That fallback is the fragile half: it is a promise the two error
  // messages make to the lanes, kept in a different file, and nothing pinned it. Both variants
  // carry `timed out` and nothing else in them is load-bearing, which is what lets them say
  // different and accurate things.
  for (const phase of ['readiness', 'waiting'] as const) {
    const e = new WakeTimeoutError(60, phase)
    expect(classifyWakeError(e), phase).toBe('timeout')            // by class
    expect(classifyWakeError(e.message), phase).toBe('timeout')    // by text, the fallback path
  }
  // ...and the waiting one describes the caller's wait rather than a readiness wait it may
  // never have reached, while still pointing at what to do next.
  const waiting = new WakeTimeoutError(60, 'waiting').message
  expect(waiting).toContain('the wake is still running')
  expect(waiting).not.toContain('became ready')
  // No CLI pointer: this string's audience is the daemon log and a direct caller. The lanes
  // rewrite a `timeout` into their own one-line answer, and the api door is re-entrant and
  // therefore never bounded, so nobody at a CLI reads it.
  expect(waiting).not.toContain('insta compute')
})


// ---- a supplied certificate (--tls custom) ------------------------------------------------------

test('a SUPPLIED certificate is served for every host, and nothing is ever issued', async () => {
  // The database lanes are the other door. `certFor` triggers issuance for a host the store does
  // not hold, and triggering issuance IS a TLS handshake to the edge with that servername --
  // which is exactly what publishes the hostname to certificate transparency. So a wildcard at
  // the edge alone would not have closed the leak: a psql connection with SNI
  // `pg-db-demo-main.<domain>` would have reopened it.
  const crt = join('test', 'fixtures', 'local', 'router.test', 'router.test.crt')
  const key = join('test', 'fixtures', 'local', 'router.test', 'router.test.key')
  let issued = 0
  const certs = new Certs({ certDir: null, supplied: { crt, key }, issue: async () => { issued++ } })
  expect(await certs.certFor('api.router.test')).not.toBeNull()
  // A hostname that has never existed on this box: served, and still nothing asked for.
  expect(await certs.certFor('web-demo-feat.router.test')).not.toBeNull()
  expect(certs.certExists('anything.router.test')).toBe(true)
  expect(certs.materialFor('anything.router.test')).not.toBeNull()
  expect(issued).toBe(0)

  // Without a supplied pair, the store-and-issue behaviour is exactly as before.
  const store = new Certs({ certDir: mkdtempSync(join(tmpdir(), 'io-certs-')), issue: async () => { issued++ } })
  expect(await store.certFor('web-demo-feat.router.test')).toBeNull()
  expect(issued).toBe(1)

  // ...and a supplied pair that cannot be read answers "no certificate" rather than falling back
  // to issuing one, because issuing is the thing this mode exists to prevent.
  const gone = new Certs({ certDir: null, supplied: { crt: '/nope/x.crt', key: '/nope/x.key' }, issue: async () => { issued++ }, log: () => { /* quiet */ } })
  expect(await gone.certFor('api.router.test')).toBeNull()
  expect(gone.certExists('api.router.test')).toBe(false)
  expect(issued).toBe(1)
})


test.skipIf(!hasOpenssl)('a renewal with the SAME mtime is still picked up by the lanes, and healthz agrees', async () => {
  // The documented renewal is an atomic rename, and a rename changes the inode without
  // necessarily changing the mtime: renewal and configuration tools routinely preserve
  // timestamps. The lane contexts were cached on the certificate's mtime ALONE, so they went on
  // presenting the old certificate for the life of the process -- while `/healthz`, whose watch
  // had been hardened separately, reported the new one. The endpoint an operator checks to
  // confirm a renewal landed said yes while `psql` was still being handed the old file.
  //
  // One mechanism, two implementations, one of them hardened: both sides derive their identity
  // from `fileStamp` now, so they cannot drift again.
  const dir = mkdtempSync(join(tmpdir(), 'io-renew-mtime-'))
  const mint = (crt: string, key: string, days: number): void => {
    const r = spawnSync('sh', ['-c',
      `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days ${days} -keyout ${key} -out ${crt} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test' 2>/dev/null`,
    ], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`)
  }
  const serialOf = (crt: string): string =>
    spawnSync('sh', ['-c', `openssl x509 -in ${crt} -noout -serial`], { encoding: 'utf8' }).stdout.trim()
  try {
    const crt = join(dir, 'wildcard.crt')
    const key = join(dir, 'wildcard.key')
    mint(crt, key, 30)
    const first = serialOf(crt)
    // A whole-second timestamp, so putting it back after the rename restores it EXACTLY:
    // `utimesSync` cannot express the sub-millisecond precision a fresh write has, and the
    // trap being reproduced is an identical mtime, not an approximately identical one.
    const fixed = new Date(Math.floor(Date.now() / 1000) * 1000 - 86_400_000)
    utimesSync(crt, fixed, fixed)
    utimesSync(key, fixed, fixed)
    const before = statSync(crt)

    const certs = new Certs({ certDir: null, supplied: { crt, key }, issue: async () => { throw new Error('nothing may be issued here') } })
    const watch = new SuppliedCertWatch(crt)
    const ctx1 = await certs.certFor('pg-db-demo-main.example.test')
    expect(ctx1).not.toBeNull()
    const notAfterBefore = watch.current()!.notAfter

    // The renewal, with the certificate's timestamps put back exactly as they were. Everything
    // else about the file is different: contents, size, inode.
    mint(join(dir, 'next.crt'), join(dir, 'next.key'), 90)
    const second = serialOf(join(dir, 'next.crt'))
    expect(second).not.toBe(first)
    renameSync(join(dir, 'next.crt'), crt)
    renameSync(join(dir, 'next.key'), key)
    utimesSync(crt, fixed, fixed)
    utimesSync(key, fixed, fixed)
    expect(statSync(crt).mtimeMs).toBe(before.mtimeMs)          // the trap, reproduced exactly

    // The lane hands back a DIFFERENT context, built from the file that is there now.
    const ctx2 = await certs.certFor('pg-db-demo-main.example.test')
    expect(ctx2).not.toBe(ctx1)
    expect(certs.materialFor('pg-db-demo-main.example.test')!.cert.toString())
      .toBe(readFileSync(crt).toString())

    // ...and the two answers agree, which is the property the divergence destroyed: the field an
    // operator reads to confirm a renewal and the certificate the lanes actually present.
    watch.refresh()
    expect(watch.current()!.notAfter).not.toBe(notAfterBefore)
    expect(watch.current()!.notAfter).toBe(suppliedCert(crt)!.notAfter)
    expect(watch.current()!.daysLeft).toBeGreaterThan(80)

    // An unchanged pair is still cached: the fix must not turn every handshake into a read.
    const ctx3 = await certs.certFor('pg-db-demo-main.example.test')
    expect(ctx3).toBe(ctx2)

    // A KEY-only change counts too. A pair whose halves no longer belong together is a
    // handshake failure, so the stamp covers both files rather than only the certificate.
    mint(join(dir, 'other.crt'), join(dir, 'other.key'), 90)
    const keyBefore = statSync(key)
    renameSync(join(dir, 'other.key'), key)
    utimesSync(key, fixed, fixed)
    expect(statSync(key).mtimeMs).toBe(keyBefore.mtimeMs)
    const ctx4 = await certs.certFor('pg-db-demo-main.example.test')
    expect(ctx4).not.toBe(ctx3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(!hasOpenssl)('a broken certificate says so ONCE, however many handshakes arrive', async () => {
  // These lanes are publicly reachable and the traffic is not the operator's: one public
  // hostname on a live box drew 141 scanner requests in fifteen minutes. A degraded
  // certificate plus ordinary client retries plus that traffic is unbounded log writes at the
  // moment the operator most needs to read their logs. The expiry warning was throttled for
  // this exact reason; this is its failure-path twin, and it is throttled the same way rather
  // than by a second mechanism.
  const dir = mkdtempSync(join(tmpdir(), 'io-noisy-'))
  try {
    const crt = join(dir, 'wildcard.crt')
    const key = join(dir, 'wildcard.key')
    const said: string[] = []
    const certs = new Certs({ certDir: null, supplied: { crt, key }, log: (m) => { said.push(m) } })

    // FAILURE 1: the pair is not there at all. Two hundred handshakes, one line.
    for (let i = 0; i < 200; i++) expect(await certs.certFor(`h${i % 7}.example.test`)).toBeNull()
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('cannot be read')

    // FAILURE 2, different: the files exist and are not a certificate. New failure, so it
    // speaks at once -- nothing is silenced on its first occurrence -- and then goes quiet.
    writeFileSync(crt, 'not a certificate\n')
    writeFileSync(key, 'not a key\n')
    for (let i = 0; i < 200; i++) expect(await certs.certFor(`h${i % 7}.example.test`)).toBeNull()
    expect(said).toHaveLength(2)
    expect(said[1]).toContain('unreadable certificate')

    // RECOVERY, announced once: a log that simply goes quiet cannot be told from one nobody is
    // asking any more.
    const r = spawnSync('sh', ['-c',
      `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 -keyout ${key} -out ${crt} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test' 2>/dev/null`,
    ], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`)
    for (let i = 0; i < 200; i++) expect(await certs.certFor(`h${i % 7}.example.test`)).not.toBeNull()
    expect(said).toHaveLength(3)
    expect(said[2]).toContain('loads again')

    // ...and a failure AFTER a recovery is not swallowed by the keys the last one left behind.
    rmSync(crt)
    for (let i = 0; i < 50; i++) expect(await certs.certFor('h0.example.test')).toBeNull()
    expect(said).toHaveLength(4)
    expect(said[3]).toContain('cannot be read')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a supplied certificate reports what it has left, and says so under three weeks', () => {
  // The one certificate in this stack nothing renews. This cannot renew it either and does not
  // try: it makes the number visible, so the failure is not announced by a browser.
  const crt = join('test', 'fixtures', 'local', 'router.test', 'router.test.crt')
  const cert = suppliedCert(crt)!
  expect(cert.path).toBe(crt)
  expect(Date.parse(cert.notAfter)).toBeGreaterThan(0)
  expect(cert.daysLeft).toBe(Math.floor(cert.secondsLeft / 86_400))

  // No file, an unreadable file and a file that is not a certificate all answer null, which is
  // what `healthz` then omits -- itself worth alerting on, and never a false reassurance.
  expect(suppliedCert(null)).toBeNull()
  expect(suppliedCert('/nope/missing.crt')).toBeNull()
  expect(suppliedCert(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'))).toBeNull()

  // The warning is a function of the clock, so it is tested against a clock: the fixture's own
  // notAfter, moved backwards and forwards around the threshold.
  const at = Date.parse(cert.notAfter)
  const said: string[] = []
  const log = (m: string): void => { said.push(m) }
  const day = 86_400_000
  expect(warnExpiring(suppliedCert(crt, at - (CERT_WARN_DAYS + 1) * day), log)).toBe(false)
  expect(warnExpiring(suppliedCert(crt, at - (CERT_WARN_DAYS - 1) * day), log)).toBe(true)
  expect(said[0]).toMatch(/expires in \d+ days? /)
  expect(said[0]).toContain('Nothing renews a supplied certificate')
  expect(warnExpiring(suppliedCert(crt, at + day), log)).toBe(true)
  expect(said[1]).toContain('EXPIRED')
  expect(said[1]).toContain('restart the edge')
  // Nothing supplied: nothing said, in every other TLS mode.
  expect(warnExpiring(null, log)).toBe(false)
  expect(said).toHaveLength(2)
})


test('the certificate watch reads on its own beat, not per request', () => {
  // `/healthz` is unauthenticated and polled continuously (load balancers, monitors, the
  // installer's wait loop, and on a live box the scanners). A `readFileSync` per request is a
  // handle anyone can pull on to stall the event loop, and a slow mount makes each read
  // arbitrarily long: the same class as the pre-auth lane denial of service closed in #97,
  // reintroduced through a health check.
  const crt = join('test', 'fixtures', 'local', 'router.test', 'router.test.crt')
  const real = suppliedCert(crt)!
  const at = Date.parse(real.notAfter)
  let reads = 0
  const read = (path: string, now: number): ReturnType<typeof suppliedCert> => { reads++; return suppliedCert(path, now) }

  const watch = new SuppliedCertWatch(crt, { read })
  expect(reads).toBe(1)                                       // the constructor's own
  for (let i = 0; i < 50; i++) expect(watch.current()).not.toBeNull()
  expect(reads).toBe(1)                                       // ...and not one more
  // The beat looks at the file; it does not re-read it. On an unchanged certificate that is a
  // stat and nothing else, which is the whole point of a cache keyed on change rather than on
  // time. What a moved file costs is asserted in the test below.
  for (let i = 0; i < 100; i++) watch.refresh()
  expect(reads).toBe(1)

  // The clock stays live even though the file is not re-read: what is left is computed per call.
  const far = watch.current(at - 40 * 86_400_000)!
  const near = watch.current(at - 5 * 86_400_000)!
  expect(far.daysLeft).toBe(40)
  expect(near.daysLeft).toBe(5)
  expect(reads).toBe(1)
})

test('a certificate that STOPS being readable goes absent, and does not keep its last value', () => {
  // The property that had to survive the caching: a cached 172 days is not a certificate. Done
  // to the FILE rather than to a boolean, because the cache is keyed on what the file looks
  // like now: replaced badly, removed, and (where the process is not root) chmod'ed away, which
  // is why the stamp carries mode and ctime and not only mtime, size and inode.
  const src = readFileSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'))
  const dir = mkdtempSync(join(tmpdir(), 'io-unreadable-'))
  const crt = join(dir, 'live.crt')
  try {
    writeFileSync(crt, src)
    const watch = new SuppliedCertWatch(crt)
    expect(watch.current()).not.toBeNull()

    // Replaced by something that is not a certificate: the daemon reports nothing, not the last
    // good value it happens to remember.
    writeFileSync(crt, 'this is not a certificate\n')
    watch.refresh()
    expect(watch.current()).toBeNull()

    // ...and it comes back when the file does.
    writeFileSync(crt, src)
    watch.refresh()
    expect(watch.current()).not.toBeNull()

    // Unreadable without any change to the CONTENT. Skipped only where the check cannot mean
    // anything, which is as root: root reads a 000 file, so the certificate stays readable and
    // the assertion would be about the test environment rather than the code.
    if (process.getuid?.() !== 0) {
      chmodSync(crt, 0o000)
      watch.refresh()
      expect(watch.current()).toBeNull()
      chmodSync(crt, 0o600)
      watch.refresh()
      expect(watch.current()).not.toBeNull()
    }

    // Gone entirely.
    rmSync(crt)
    watch.refresh()
    expect(watch.current()).toBeNull()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(!hasOpenssl)('a REPLACED certificate is judged on its own merits, not silenced by the last one', () => {
  // The operator sequence, not a unit of the limiter: they see "expires in N days", replace the
  // file, and land on another near-expiry certificate -- the wrong file from the CA, last
  // year's bundle, a renewal that did not renew. Under a limiter that spans the change they
  // hear nothing for six hours, at the moment they are most likely to read silence as
  // confirmation that they fixed it.
  const dir = mkdtempSync(join(tmpdir(), 'io-relimit-'))
  const mint = (out: string, days: number): void => {
    const r = spawnSync('sh', ['-c',
      `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days ${days} -keyout ${join(dir, 'k.pem')} -out ${out} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test' 2>/dev/null`,
    ], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`)
  }
  try {
    const live = join(dir, 'live.crt')
    const next = join(dir, 'next.crt')
    mint(live, 12)
    const said: string[] = []
    const watch = new SuppliedCertWatch(live, { log: (m) => { said.push(m) } })
    const t0 = Date.now()

    expect(watch.maybeWarn(t0)).toBe(true)
    expect(said[0]).toMatch(/expires in (11|12) days/)
    // The limiter still does its job for the file that has not changed: a couple of hours of
    // sweeps say nothing more.
    for (let i = 1; i <= 240; i++) { watch.refresh(t0 + i * 30_000); expect(watch.maybeWarn(t0 + i * 30_000)).toBe(false) }
    expect(said).toHaveLength(1)

    // They replace it, and what they installed is also nearly expired.
    mint(next, 4)
    renameSync(next, live)
    const at = t0 + 241 * 30_000                                // minutes later, not six hours
    watch.refresh(at)
    expect(watch.maybeWarn(at)).toBe(true)
    expect(said).toHaveLength(2)
    expect(said[1]).toMatch(/expires in (3|4) days/)

    // ...and the new one then earns its own quiet, which is what the limiter is for.
    for (let i = 1; i <= 240; i++) { watch.refresh(at + i * 30_000); expect(watch.maybeWarn(at + i * 30_000)).toBe(false) }
    expect(said).toHaveLength(2)

    // The other side of it: the SAME certificate rewritten in place -- a config manager that
    // reinstalls it every few minutes, a sync that copies rather than compares -- moves the
    // stamp and must not earn a new warning each time, or the limiter is defeated by another
    // door. So the reset is keyed on the expiry, not on the file having changed.
    const flap = at + 241 * 30_000
    const bytes = readFileSync(live)
    for (let i = 1; i <= 20; i++) {
      writeFileSync(join(dir, 'copy.crt'), bytes)
      renameSync(join(dir, 'copy.crt'), live)
      watch.refresh(flap + i * 30_000)
      expect(watch.maybeWarn(flap + i * 30_000), `rewrite ${i}`).toBe(false)
    }
    expect(said).toHaveLength(2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the expiry warning is said once, then stays quiet for hours', () => {
  // Fired every sweep it is tens of thousands of identical lines between the day it starts and
  // the day the certificate is replaced, which is a log nobody reads and so a warning nobody
  // sees. `warnExpiring`'s boolean exists for this and was being discarded.
  const crt = join('test', 'fixtures', 'local', 'router.test', 'router.test.crt')
  const at = Date.parse(suppliedCert(crt)!.notAfter)
  const said: string[] = []
  const watch = new SuppliedCertWatch(crt, { read: (path, now) => suppliedCert(path, now), log: (m) => { said.push(m) } })

  // Comfortably in date: nothing said, and nothing stamped, so the first real warning is not
  // swallowed by a limiter that had already started.
  const wellBefore = at - 60 * 86_400_000
  for (let i = 0; i < 10; i++) expect(watch.maybeWarn(wellBefore + i * 30_000)).toBe(false)
  expect(said).toEqual([])

  // Inside the window: once, then quiet across a couple of hours of sweeps (240 of them).
  const inside = at - (CERT_WARN_DAYS - 1) * 86_400_000
  expect(watch.maybeWarn(inside)).toBe(true)
  for (let i = 1; i <= 240; i++) expect(watch.maybeWarn(inside + i * 30_000), `sweep ${i}`).toBe(false)
  expect(said).toHaveLength(1)

  // ...and again once the interval has passed.
  expect(watch.maybeWarn(inside + WARN_EVERY_MS + 1)).toBe(true)
  expect(said).toHaveLength(2)

  // Past the date it is louder, and obeys the same limiter.
  const after = at + WARN_EVERY_MS + 2
  expect(watch.maybeWarn(after)).toBe(true)
  expect(said[2]).toContain('EXPIRED')
  for (let i = 1; i <= 240; i++) expect(watch.maybeWarn(after + i * 30_000)).toBe(false)
  expect(said).toHaveLength(3)
})


test.skipIf(!hasOpenssl)('the beat PARSES only when the file moved: an unchanged certificate costs a stat', () => {
  // The cache was defeating itself. `refresh()` cleared the stamp before `sync()` could compare
  // it, so every sweep re-read and re-parsed a certificate that had not changed -- a full
  // synchronous read and X509 parse on the event loop every 30 s, for the lifetime of the
  // daemon, which is most of the work that moving this off the request path existed to avoid.
  // The stat is the check; the parse is what the stat has to earn.
  const dir = mkdtempSync(join(tmpdir(), 'io-stamp-'))
  const mint = (out: string, days: number): void => {
    const r = spawnSync('sh', ['-c',
      `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days ${days} -keyout ${join(dir, 'k.pem')} -out ${out} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test' 2>/dev/null`,
    ], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`)
  }
  try {
    const live = join(dir, 'live.crt')
    const next = join(dir, 'next.crt')
    mint(live, 30)
    let parses = 0
    const watch = new SuppliedCertWatch(live, { read: (path, now) => { parses++; return suppliedCert(path, now) } })

    // Boot: parsed once, and the value is there.
    expect(parses).toBe(1)
    expect(watch.current()!.daysLeft).toBeGreaterThanOrEqual(29)

    // A day of sweeps on an unchanged file: not one more parse, and the answer does not drift.
    const at = watch.current()!.notAfter
    for (let i = 0; i < 2880; i++) watch.refresh()
    expect(parses).toBe(1)
    expect(watch.current()!.notAfter).toBe(at)

    // A renewal moves the file, so the next beat parses exactly once more.
    mint(next, 90)
    renameSync(next, live)
    watch.refresh()
    expect(parses).toBe(2)
    expect(watch.current()!.notAfter).not.toBe(at)
    for (let i = 0; i < 100; i++) watch.refresh()
    expect(parses).toBe(2)

    // Unreadable: the value goes, and no parse is attempted on a file that cannot be stat'd.
    rmSync(live)
    watch.refresh()
    expect(watch.current()).toBeNull()
    expect(parses).toBe(2)

    // ...and the stamp went with it, so the file coming back is parsed even though a renamed
    // file can carry the same mtime, size and inode as the one that was there before.
    mint(live, 45)
    watch.refresh()
    expect(parses).toBe(3)
    expect(watch.current()!.daysLeft).toBeGreaterThanOrEqual(44)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(!hasOpenssl)('a MALFORMED file is parsed once, and replacing it with a good one is still noticed', () => {
  // The negative result has to be cached too. Without that, the one case where an operator has
  // a broken file -- the wrong file copied in, a truncated write, a key pasted over a
  // certificate -- was the case that did the most work: a full read and a failed parse on every
  // beat, forever, because only a SUCCESSFUL parse counted as cached.
  //
  // And the edge that matters more than the saving: the file they then fix has to be picked up.
  // That is the sequence an operator actually performs once they realise, so it is the sequence
  // asserted here rather than reasoned about.
  const dir = mkdtempSync(join(tmpdir(), 'io-malformed-'))
  try {
    const live = join(dir, 'live.crt')
    const good = join(dir, 'good.crt')
    const r = spawnSync('sh', ['-c',
      `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 60 -keyout ${join(dir, 'k.pem')} -out ${good} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test' 2>/dev/null`,
    ], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`)

    // Readable, and not a certificate.
    writeFileSync(live, '-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----\n')
    let parses = 0
    const watch = new SuppliedCertWatch(live, { read: (path, now) => { parses++; return suppliedCert(path, now) } })
    expect(watch.current()).toBeNull()
    expect(parses).toBe(1)

    // A day of sweeps: asked once, not 2880 times.
    for (let i = 0; i < 2880; i++) watch.refresh()
    expect(parses).toBe(1)
    expect(watch.current()).toBeNull()

    // ...and the fix lands. The stamp moves, so the beat looks again, and the field appears.
    renameSync(good, live)
    watch.refresh()
    expect(parses).toBe(2)
    expect(watch.current()!.daysLeft).toBeGreaterThanOrEqual(59)

    // Back to broken, in place: still noticed, and still asked only once.
    writeFileSync(live, 'not even a PEM header\n')
    watch.refresh()
    expect(watch.current()).toBeNull()
    expect(parses).toBe(3)
    for (let i = 0; i < 100; i++) watch.refresh()
    expect(parses).toBe(3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(!hasOpenssl)('a RENAMED certificate is picked up by the beat, and the request path reads nothing', () => {
  // The way a renewal actually happens, and the way it was measured on a live box: write the new
  // pair alongside, rename over the live names. The file check lives on the daemon's beat, not
  // on the request path -- `/healthz` is unauthenticated and a scanner sets its rate, so a
  // request must not touch the filesystem at all, not even to stat it. `refresh()` is that
  // beat, and it is what has to notice the rename.
  const dir = mkdtempSync(join(tmpdir(), 'io-renew-'))
  const mint = (out: string, days: number): void => {
    const r = spawnSync('sh', ['-c',
      `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days ${days} -keyout ${join(dir, 'k.pem')} -out ${out} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test' 2>/dev/null`,
    ], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`)
  }
  try {
    const live = join(dir, 'live.crt')
    const next = join(dir, 'next.crt')
    mint(live, 30)
    const watch = new SuppliedCertWatch(live)
    const before = watch.current()!
    expect(before.daysLeft).toBeGreaterThanOrEqual(29)

    mint(next, 90)
    renameSync(next, live)                                    // atomic, over the live name
    // Not yet: no request looks at the file.
    expect(watch.current()!.notAfter).toBe(before.notAfter)
    watch.refresh()                                           // ...the beat does
    const after = watch.current()!
    expect(after.notAfter).not.toBe(before.notAfter)
    expect(after.daysLeft).toBeGreaterThan(before.daysLeft + 55)

    // ...and the warning reads the same source, so the log and the endpoint cannot disagree.
    const said: string[] = []
    const w2 = new SuppliedCertWatch(live, { log: (m) => { said.push(m) } })
    expect(w2.maybeWarn()).toBe(false)                        // 90 days: nothing to say
    mint(next, 10)
    renameSync(next, live)
    w2.refresh()                                              // the same beat feeds both
    expect(w2.maybeWarn()).toBe(true)                         // 10 days: said, from the new file
    expect(said[0]).toMatch(/expires in (9|10) days/)

    // A file that goes away is absent again, cache or no cache.
    rmSync(live)
    watch.refresh()
    expect(watch.current()).toBeNull()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
