// Integration (real Docker): the router's lanes against real containers (02 sections 0 to 6).
//
// `test/router.test.ts` drives the same code with real listeners and FAKE seams, which is where the
// decisions are pinned. What only real containers can answer is whether the lanes reach them at
// all, and this file is the one `test/template-deploy.int.test.ts` names when it says its injected
// health probe bypasses the HTTP lane. Five things:
//
//   1. Host routing: a request whose Host is a service's minted name reaches THAT container, and a
//      daemon host still reaches the API on the same port;
//   2. hold-and-wake: a request for a sleeping service waits for it instead of failing, and the
//      service is running when the answer comes back (both lanes: HTTP and pg wire);
//   3. the pg-wire lane end to end, with a real `psql` over TLS choosing its database by SNI, which
//      is how a developer reaches a branch database on a server-mode box;
//   4. a service the developer STOPPED answers a readable error rather than being woken by traffic;
//   5. local mode publishes nothing beyond loopback: not the app, not the database, not the lanes.
//
// Run alone, by the integrator or CI:
//
//   RUN_DOCKER_TESTS=1 npx vitest run test/router.int.test.ts
//
// Platform: nothing here skips. The one thing that genuinely differs is how the daemon reaches a
// container: server mode dials the container IP on the branch network, which works from a Linux
// host and cannot work from macOS, where Docker runs in a VM. `serverUpstream()` PROBES that rather
// than testing `process.platform`, so the server-mode lane is exercised either way and a Linux
// runner exercises the production path.
import { test, expect, beforeAll, afterAll } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { connect as netConnect, createServer as createNetServer } from 'node:net'
import { loadConfig, type Config } from '../src/config'
import { docker } from '../src/docker'
import { sharedDataDir } from '../src/datadir'
import { loadState } from '../src/state'
import { Engine } from '../src/engine'
import { Upstream } from '../src/upstream'
import { LocalPostgres } from '../src/adapters/postgres'
import { DockerCompute } from '../src/adapters/compute'
import { LocalGarage } from '../src/adapters/garage'
import { LocalManagedDb } from '../src/adapters/manageddb'
import { laneReallocator, Router } from '../src/router'
import { Certs } from '../src/router/certs'
import { engineRouterDeps } from '../src/router/deps'
import { buildTable } from '../src/router/table'
import { SSL_REQUEST, startupMessage } from '../src/router/wake'
import type { ServiceKey } from '../src/types'

const DATA = realpathSync(mkdtempSync(join(tmpdir(), 'io-rt-')))
const DOMAIN = 'router.test'
const REF = 'routerint-main'
const APP = `io-${REF}-app-web`
const PG = `io-${REF}-pg-db`
const APP_HOST = `web-${REF}.${DOMAIN}`
const PG_HOST = `pg-db-${REF}.${DOMAIN}`

/** A port nothing holds right now. Racy by nature, which is why the daemon reallocates a busy lane
 *  rather than dying on one; here it only has to survive the next second. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => resolve(port))
    })
  })
}

let cfg: Config
let engine: Engine
let router: Router
let projectId = ''
let branchId = ''
let appKey: ServiceKey = ''
let dbKey: ServiceKey = ''
let certDir = ''

const state = async (container: string): Promise<string | null> => {
  try { return (await docker(['inspect', '-f', '{{.State.Status}}', container])).toString().trim() } catch { return null }
}
const inspect = async (container: string, fmt: string): Promise<string> =>
  (await docker(['inspect', '-f', fmt, container])).toString().trim()

/** A request through the router's HTTP listener with an explicit Host, as the edge would send it.
 *  `node:http` and not `fetch`: Host is a forbidden header name in fetch, so undici silently
 *  replaces it with the address dialled, and every request in this file would reach the API. */
/**
 * A just-deployed container is RUNNING before the process inside it has bound its port, and the
 * router answers that window with a 502 because the connect really is refused. Deploy does not
 * gate on the app answering (`docs/self-hosting/sleep.mdx` says as much, and always-on is the
 * documented mitigation), so a test that asserts on its first request is asserting on the app's
 * startup rather than on routing. Give the bind a bounded wait: what these cases exist to prove is
 * that the lane reaches the container, not how fast nginx starts.
 */
async function viaHostReady(host: string, path = '/', within = 30_000): Promise<{ status: number; body: string }> {
  const deadline = Date.now() + within
  let last = await viaHost(host, path)
  while (last.status === 502 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    last = await viaHost(host, path)
  }
  return last
}

function viaHost(host: string, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: cfg.port, path, method: 'GET', headers: { host } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (d: Buffer) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    req.setTimeout(120_000, () => { req.destroy(new Error(`no answer for Host ${host} within 120 s`)) })
    req.once('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  const port = await freePort()
  cfg = loadConfig({
    INSTA_OSS_MODE: 'local',
    INSTA_OSS_DOMAIN: DOMAIN,
    INSTA_OSS_PORT: String(port),
    INSTA_OSS_DATA_DIR: DATA,
    INSTA_OSS_STATE: join(DATA, 'state.json'),
    INSTA_OSS_SCHEDULER: '0',
    INSTA_OSS_CREATE_GRACE_SEC: '0',
    INSTA_OSS_RAM_FLOOR_PCT: '0',
  }, [])
  const data = sharedDataDir(cfg)
  await data.probe()
  const storage = new LocalGarage({ configPath: cfg.garageConfigPath, hostEndpoint: cfg.s3HostEndpoint, mode: cfg.mode, domain: cfg.domain })
  engine = new Engine(new LocalPostgres({ cfg, data }), new DockerCompute(), storage, new LocalManagedDb(), { cfg, data })

  router = new Router({
    cfg,
    table: () => buildTable(loadState(), cfg, () => { /* quiet */ }),
    upstream: engine.upstream,
    reallocLane: laneReallocator(cfg, () => engine.allocLanePort()),
    certs: new Certs({ certDir: cfg.tls.certDir, issue: async () => { /* no edge in a test */ } }),
    log: () => { /* quiet */ },
    ...engineRouterDeps(engine),
  })
  engine.router = router
  router.attach((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"api":true}') })
  await new Promise<void>((resolve, reject) => {
    router.httpServer.once('error', reject)
    router.httpServer.listen(cfg.port, cfg.listenHost, () => resolve())
  })
  await router.start()

  const { project } = await engine.createProject('routerint')
  projectId = project.id
  await engine.addDbService(projectId, 'db')
  await engine.deploy(projectId, 'main', { image: 'nginx:alpine', port: 80, group: 'web' })
  branchId = engine.listBranches(projectId).find((b) => b.name === 'main')!.id
  appKey = `${branchId}:cp-web`
  dbKey = `${branchId}:pg-db`
}, 900_000)

afterAll(async () => {
  try { await router.stop() } catch { /* best effort */ }
  try { if (projectId) await engine.destroyProject(projectId) } catch { /* best effort */ }
  rmSync(DATA, { recursive: true, force: true })
  if (certDir) rmSync(certDir, { recursive: true, force: true })
})

test('Host routing reaches the real container, and a daemon host still reaches the API', async () => {
  // The minted name is what the engine recorded on the row, not something this test invents.
  const branch = loadState().branches[branchId]
  expect(branch.apps.web.host).toBe(APP_HOST)
  expect(branch.databases?.['pg-db']?.host).toBe(PG_HOST)

  const res = await viaHostReady(APP_HOST)
  expect(res.status).toBe(200)
  // nginx's own index, so the bytes really came from that container and not from Fastify.
  expect(res.body).toContain('Welcome to nginx')
  // The upstream the lane dialled is the app's published loopback port, and the proxy told the app
  // who asked: an app's redirects and cookie domains depend on the Host arriving unchanged.
  const forwarded = await viaHost(APP_HOST, '/nope')
  expect(forwarded.status).toBe(404)

  // Same listener, a daemon host: the API, not the lane (decision 4).
  expect((await viaHost(`api.${DOMAIN}`)).body).toBe('{"api":true}')
  expect((await viaHost('localhost')).body).toBe('{"api":true}')

  // An unknown host in local mode is also the API, which is what keeps a LAN name working.
  expect((await viaHost('something-else.invalid')).body).toBe('{"api":true}')
}, 120_000)

test('a request for a sleeping service waits for it instead of failing', async () => {
  expect(await engine.scheduler.sleep(appKey, 'idle')).toBe(true)
  expect(await state(APP)).toBe('exited')
  expect(engine.stateOf(appKey)).toBe('asleep')

  const t0 = Date.now()
  const res = await viaHost(APP_HOST)
  expect(res.status).toBe(200)
  expect(res.body).toContain('Welcome to nginx')
  // The wake happened on the request's own thread: the answer came back only once the container
  // was up, which is the whole point of holding rather than 502-ing.
  expect(await state(APP)).toBe('running')
  expect(engine.stateOf(appKey)).toBe('running')
  expect(Date.now() - t0).toBeLessThan(cfg.sleep.wakeTimeoutSec * 1000)
}, 180_000)

test('a service the developer stopped answers a readable error and is NOT woken by traffic', async () => {
  await engine.lifecycle(projectId, 'cp-web', 'stop')
  expect(await state(APP)).toBe('exited')
  expect(loadState().branches[branchId].apps.web.desiredState).toBe('stopped')

  const res = await viaHost(APP_HOST)
  expect(res.status).toBe(503)
  expect(JSON.parse(res.body)).toEqual({ error: 'service is stopped' })
  // Still down: traffic must not resurrect something a person switched off.
  expect(await state(APP)).toBe('exited')

  await engine.lifecycle(projectId, 'cp-web', 'start')
  expect(await state(APP)).toBe('running')
  // An explicit start returns when the container is running, which is earlier than the app inside
  // it accepting, so this is the same bind window as the first case.
  expect((await viaHostReady(APP_HOST)).status).toBe(200)
}, 180_000)

/** Speak the first two moves of the Postgres protocol over the lane and return the message type the
 *  server answers with. `R` is an AuthenticationRequest, which only a real postmaster sends. */
async function pgWireHello(port: number, timeoutMs = 90_000): Promise<string> {
  const sock = netConnect({ host: '127.0.0.1', port })
  const read = (): Promise<Buffer> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer from the lane within ${timeoutMs} ms`)), timeoutMs)
    sock.once('data', (d: Buffer) => { clearTimeout(timer); resolve(d) })
    sock.once('error', (e) => { clearTimeout(timer); reject(e) })
    sock.once('close', () => { clearTimeout(timer); reject(new Error('the lane closed the connection')) })
  })
  try {
    await new Promise<void>((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject) })
    // libpq always offers SSL first; the local lane has no TLS and answers `N`.
    sock.write(SSL_REQUEST)
    expect((await read()).toString('latin1')).toBe('N')
    sock.write(startupMessage({ user: 'postgres', database: 'app' }))
    return String.fromCharCode((await read())[0])
  } finally {
    sock.destroy()
  }
}

test('the local pg lane wakes a sleeping database and splices a real client to it', async () => {
  const lanePort = loadState().branches[branchId].lanes?.['pg-db']
  expect(lanePort).toBeTypeOf('number')
  // Local mode gives every database its own loopback port, and the DSN the CLI prints is that port.
  expect(engine.credentials(projectId, 'pg-db', 'main').DATABASE_URL).toContain(`127.0.0.1:${lanePort}/app`)

  expect(await engine.scheduler.sleep(dbKey, 'idle')).toBe(true)
  expect(await state(PG)).toBe('exited')

  // One connection through the lane: it holds, wakes the container, waits for the wire to answer,
  // then splices. `R` is the authentication challenge from the real postmaster.
  expect(await pgWireHello(lanePort!)).toBe('R')
  expect(await state(PG)).toBe('running')
  expect(engine.stateOf(dbKey)).toBe('running')
}, 300_000)

test('local mode publishes nothing beyond loopback', async () => {
  // The lanes bind loopback only; the extra hosts are the docker bridge gateway on Linux, which is
  // how a container reaches its own database, and is not the LAN either (decision 3).
  expect(cfg.lanes.bind).toBe('127.0.0.1')
  expect(cfg.listenHost).toBe('127.0.0.1')

  // Every published container port is bound to 127.0.0.1, never 0.0.0.0.
  for (const container of [APP, PG]) {
    const bindings = JSON.parse(await inspect(container, '{{json .HostConfig.PortBindings}}')) as Record<string, Array<{ HostIp: string }>>
    const ips = Object.values(bindings).flat().map((b) => b.HostIp)
    expect(ips.length).toBeGreaterThan(0)
    expect(ips.every((ip) => ip === '127.0.0.1')).toBe(true)
  }

  // And nothing answers on a routable address of this box: not the API, not the app's published
  // port, not the database lane.
  const lanePort = loadState().branches[branchId].lanes!['pg-db']
  const appPort = loadState().branches[branchId].apps.web.hostPort!
  const routable = Object.values(networkInterfaces()).flat()
    .filter((n): n is NonNullable<typeof n> => !!n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address)
    .filter((ip) => !cfg.extraListenHosts.includes(ip))
  for (const port of [cfg.port, appPort, lanePort]) {
    // Live on loopback FIRST, so a refusal below means "bound to loopback" and not "nothing is
    // listening at all", which is what would make this whole test vacuous.
    expect(await accepts('127.0.0.1', port), `nothing is listening on 127.0.0.1:${port}`).toBe(true)
    for (const ip of routable) {
      expect(await accepts(ip, port), `${ip}:${port} accepted a connection`).toBe(false)
    }
  }
}, 120_000)

/** True when something accepts a TCP connection there within a second. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ host, port })
    const done = (ok: boolean): void => { s.destroy(); resolve(ok) }
    s.setTimeout(1000, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

/** Can this process reach a container IP on the branch network? A Linux daemon shares the host
 *  netns and can; on macOS docker runs in a VM and nothing on the host can. The answer decides
 *  which Upstream the server-mode router gets, so the lane itself is tested either way. */
async function serverUpstream(serverCfg: Config): Promise<{ upstream: Upstream; direct: boolean }> {
  const ip = await inspect(PG, `{{(index .NetworkSettings.Networks "io-${REF}").IPAddress}}`)
  const direct = ip !== '' && await accepts(ip, 5432)
  // `direct`: the production path, container IP on the branch network. Otherwise the loopback port
  // local mode published for the same container, which is the only address this host can dial.
  return { upstream: new Upstream(direct ? serverCfg : cfg), direct }
}

test('the pg-wire lane end to end: a real psql picks its database by SNI over TLS', async () => {
  // Server mode is where the wire lane carries TLS: one public port, the database chosen by the
  // servername the client sends. The local-mode router goes first so the two never share a port.
  await router.stop()

  certDir = mkdtempSync(join(tmpdir(), 'io-rtcerts-'))
  for (const host of [`api.${DOMAIN}`, PG_HOST]) {
    mkdirSync(join(certDir, 'local', host), { recursive: true })
    for (const ext of ['crt', 'key']) {
      cpSync(join('test', 'fixtures', 'local', DOMAIN, `${DOMAIN}.${ext}`), join(certDir, 'local', host, `${host}.${ext}`))
    }
  }
  const [lanePgPort, laneRedisPort, laneMongoPort, internalPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
  const serverCfg = loadConfig({
    INSTA_OSS_MODE: 'server',
    INSTA_OSS_DOMAIN: DOMAIN,
    INSTA_OSS_SECRET: 's'.repeat(32),
    INSTA_OSS_DATA_DIR: DATA,
    INSTA_OSS_STATE: join(DATA, 'state.json'),
    INSTA_OSS_SCHEDULER: '0',
    INSTA_OSS_TLS_CERT_DIR: certDir,
    INSTA_OSS_LANE_PG_PORT: String(lanePgPort),
    INSTA_OSS_LANE_REDIS_PORT: String(laneRedisPort),
    INSTA_OSS_LANE_MONGO_PORT: String(laneMongoPort),
    INSTA_OSS_INTERNAL_PORT: String(internalPort),
  }, [])
  const { upstream, direct } = await serverUpstream(serverCfg)
  const tls = new Router({
    cfg: serverCfg,
    table: () => buildTable(loadState(), serverCfg, () => { /* quiet */ }),
    upstream,
    reallocLane: laneReallocator(serverCfg, () => engine.allocLanePort()),
    certs: new Certs({ certDir, issue: async () => { /* the edge already issued, into certDir */ } }),
    log: () => { /* quiet */ },
    ...engineRouterDeps(engine),
  })
  engine.router = tls
  try {
    await tls.start()
    // Server mode shares ONE port across every branch database; the servername is the routing key.
    expect(serverCfg.lanes.bind).toBe('0.0.0.0')

    // Asleep again, so this measures the whole path: TLS, SNI, wake, wire readiness, splice.
    expect(await engine.scheduler.sleep(dbKey, 'idle')).toBe(true)
    expect(await state(PG)).toBe('exited')

    const password = new URL(loadState().branches[branchId].databases!['pg-db'].url).password
    // A real client: libpq 16, `sslmode=require`, and the SNI it sends is the hostname in the DSN,
    // which `--add-host` points back at this box. Exactly what a developer runs against a server.
    const out = await docker(['run', '--rm', '--add-host', `${PG_HOST}:host-gateway`, 'postgres:16-alpine',
      'psql', `postgres://postgres:${password}@${PG_HOST}:${lanePgPort}/app?sslmode=require`,
      '-tAc', "select 'through-the-lane-' || count(*) from pg_database"])
    expect(out.toString()).toContain('through-the-lane-')

    expect(await state(PG)).toBe('running')
    expect(engine.stateOf(dbKey)).toBe('running')
    // The branch above was on a capability, so pin the capability: `direct` means this host really
    // can dial the container IP on the branch network (the production server-mode path), and its
    // absence means the only reachable address is the loopback port local mode published.
    const ip = await inspect(PG, `{{(index .NetworkSettings.Networks "io-${REF}").IPAddress}}`)
    expect(ip).not.toBe('')
    if (direct) expect(await accepts(ip, 5432)).toBe(true)
    else expect(await inspect(PG, '{{json .NetworkSettings.Ports}}')).toContain('127.0.0.1')

    // An UNAUTHENTICATED client that sends the eight negotiation bytes, reads the `S`, and then
    // says nothing more. The negotiation's own timer is cleared by those eight bytes, so before
    // the handshake deadline this held a descriptor, a socket, TLS state and an unresolved
    // promise until the peer went away or the daemon restarted -- on a port published to the
    // internet, for the price of eight bytes and no credentials.
    const stalled = await new Promise<{ closed: boolean; ms: number }>((resolve) => {
      const t0 = Date.now()
      const s = netConnect({ host: '127.0.0.1', port: lanePgPort })
      const giveUp = setTimeout(() => { s.destroy(); resolve({ closed: false, ms: Date.now() - t0 }) }, 25_000)
      s.once('connect', () => {
        const req = Buffer.alloc(8)
        req.writeUInt32BE(8, 0)
        req.writeUInt32BE(80877103, 4)      // SSLRequest
        s.write(req)
      })
      s.on('data', () => { /* the `S`, and then we stall on purpose */ })
      s.once('error', () => { /* a destroy from the far end can surface as ECONNRESET */ })
      s.once('close', () => { clearTimeout(giveUp); resolve({ closed: true, ms: Date.now() - t0 }) })
    })
    expect(stalled.closed).toBe(true)
    // ...and it was the DEADLINE that closed it, not an immediate refusal of the negotiation.
    expect(stalled.ms).toBeGreaterThan(5_000)
    expect(stalled.ms).toBeLessThan(25_000)
  } finally {
    await tls.stop()
  }
}, 600_000)
