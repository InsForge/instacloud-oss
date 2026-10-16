// The router (contract 00 section 8.2; 02 sections 0 and 2). It owns every listener the daemon
// exposes: the primary HTTP server Fastify is handed through `serverFactory`, the optional bridge
// gateway copy of it in local mode, the database lanes, and the loopback listener the edge asks
// before issuing a certificate. Everything else in here is bookkeeping around one idea: a request
// for a sleeping service must wait for that service instead of failing, and the waiting itself is
// what keeps the service awake.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { SecureContext, Server as TlsServer } from 'node:tls'
import { isDaemonHost, type Config } from '../config'
import { loadState, mutate, onSave, stateRev } from '../state'
import type { ManagedDbType, ServiceKey } from '../types'
import { Certs, suppliedFiles, triggerIssuance } from './certs'
import type { ServiceState, UpstreamLike } from './deps'
import { HttpLane, sendJson } from './http'
import { createInternalServer } from './internal'
import { createPgLane } from './pg'
import { createPortLane } from './port'
import { buildTable, hostOnly, type Route, type RouteTable } from './table'
import { createSniLane } from './tls'

export type { Lane, Route, RouteKind, RouteTable } from './table'
export { buildTable, hostFor, hostOnly, labelFor } from './table'

export interface RouterDeps {
  cfg: Config
  /** Build a fresh table. The Router memoizes the result on `stateRev()`, so the request path never
   *  parses or clones state (decision 54). */
  table?(): RouteTable
  stateOf(route: Route): ServiceState
  /** `engine.wake(key, { door: 'traffic' })`: already singleflight per key, so the router keeps
   *  no second map and no second timer (decision 52). `wakeTimeoutSec` bounds the READINESS
   *  wait; the eviction that may precede it is bounded by the candidate pool instead (each
   *  victim costs one stop grace), so a wake under memory pressure can exceed it. */
  wake(route: Route): Promise<void>
  touch(key: ServiceKey): void
  beginHold(key: ServiceKey): void
  endHold(key: ServiceKey): void
  upstream: UpstreamLike
  /** Fastify's handler; in production it arrives later through `attach()`. */
  apiHandler?(req: IncomingMessage, res: ServerResponse): void
  /** The ask endpoint's answer; defaults to table membership. */
  ownsHostname?(host: string): boolean
  /** Reallocate one service's lane port when something else already holds it (02 section 0). */
  reallocLane?(route: Route): number | undefined
  certs?: Certs
  log?(msg: string): void
}

/** What the Router needs of a lane listener; `net.Server`, `tls.Server` and `http.Server` all match. */
interface LaneServer {
  listen(port: number, host: string, cb: () => void): unknown
  once(ev: 'error', cb: (e: Error) => void): unknown
  on(ev: 'connection', cb: (c: Socket) => void): unknown
  close(cb?: () => void): unknown
}

interface LaneEntry {
  id: string
  port: number
  close(): void
}

const isAddrInUse = (e: unknown): boolean => (e as { code?: string }).code === 'EADDRINUSE'

export class Router {
  readonly httpServer: Server
  private readonly cfg: Config
  private readonly log: (msg: string) => void
  private readonly certs: Certs
  private readonly abort = new AbortController()
  private readonly http: HttpLane
  private apiHandler?: (req: IncomingMessage, res: ServerResponse) => void

  private cached: { rev: number; table: RouteTable } | null = null
  private readonly extraHttp: Server[] = []
  private readonly lanes = new Map<string, LaneEntry>()
  private internal: Server | null = null
  private defaultContext: SecureContext | null = null
  /** The same certificate as bytes: what `tls.Server.setSecureContext` takes. */
  private defaultMaterial: { cert: Buffer; key: Buffer } | null = null
  /** The SNI lanes, so a certificate that arrives after they are listening can be pushed into them. */
  private readonly tlsLanes = new Set<TlsServer>()
  private readonly sockets = new Set<Duplex>()
  /** Per-key in-flight counts: one shared ticker stamps every key with a count above zero, so a
   *  thousand streaming clients cost one timer instead of a thousand (02 section 3.3). */
  private readonly held = new Map<ServiceKey, number>()
  private ticker: NodeJS.Timeout | null = null
  private stopped = false
  /** Tail of the reconcile chain: see reconcileSerial. */
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: RouterDeps) {
    this.cfg = deps.cfg
    this.log = deps.log ?? ((m) => console.warn(m))
    this.apiHandler = deps.apiHandler
    // `--tls custom`: the operator's pair is what every lane presents, and nothing is ever
    // issued. The `issue` seam is still passed for the acme and internal modes.
    const supplied = suppliedFiles(this.cfg)
    this.certs = deps.certs ?? new Certs({ certDir: this.cfg.tls.certDir, supplied, issue: triggerIssuance(this.cfg), log: this.log })
    this.http = new HttpLane({
      cfg: this.cfg, upstream: deps.upstream, stateOf: deps.stateOf, wake: deps.wake,
      touch: (k) => this.deps.touch(k), beginHold: (k) => this.hold(k), endHold: (k) => this.release(k),
      signal: this.abort.signal, log: this.log,
    })
    this.httpServer = this.newHttpServer()
    // A routing-class save from anywhere (another code path, a future writer) rebuilds the table as
    // a belt; the engine's explicit `invalidate()` is the braces.
    onSave((_s, kind) => { if (kind === 'routing' && !this.stopped) this.cached = null })
  }

  // ---- the table -------------------------------------------------------------------------------

  /** The current table, memoized on the state revision. */
  table(): RouteTable {
    const rev = stateRev()
    if (this.cached && this.cached.rev === rev) return this.cached.table
    const t = this.deps.table ? this.deps.table() : buildTable(loadState(), this.cfg, this.log)
    this.cached = { rev, table: t }
    return t
  }

  /** Rebuild NOW and reconcile the lane listeners, so a service added through the API is listening
   *  before the next request arrives. */
  invalidate(): void {
    if (this.stopped) return
    this.cached = null
    this.table()
    void this.reconcileSerial().catch((e) => this.log(`router: lane reconcile failed: ${e instanceof Error ? e.message : String(e)}`))
  }

  /** One reconcile at a time. Adding a service fires several mutates, so the passes used to overlap:
   *  both saw the lane missing, the second lost the bind race against the first, read EADDRINUSE as
   *  "a laptop handed that port to someone else", moved the service to another port and overwrote the
   *  first pass's entry in `this.lanes` — leaking a listener nothing could close, on a port no state
   *  row named, which the next allocation then handed out and could not bind. */
  private reconcileSerial(): Promise<void> {
    const next = this.chain.then(() => this.reconcile(), () => this.reconcile())
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  // ---- holds -----------------------------------------------------------------------------------

  private hold(key: ServiceKey): void {
    this.held.set(key, (this.held.get(key) ?? 0) + 1)
    this.deps.beginHold(key)
    if (!this.ticker) {
      this.ticker = setInterval(() => {
        for (const [k, n] of this.held) if (n > 0) this.deps.touch(k)
      }, this.cfg.lanes.touchDebounceMs)
      this.ticker.unref()
    }
  }

  private release(key: ServiceKey): void {
    const n = (this.held.get(key) ?? 0) - 1
    if (n <= 0) this.held.delete(key)
    else this.held.set(key, n)
    this.deps.endHold(key)
  }

  /** Test seam: in-flight requests and splices the router is holding for a key. */
  holds(key: ServiceKey): number { return this.held.get(key) ?? 0 }

  // ---- HTTP dispatch ---------------------------------------------------------------------------

  attach(handler: (req: IncomingMessage, res: ServerResponse) => void): void { this.apiHandler = handler }

  private newHttpServer(): Server {
    const s = createHttpServer((req, res) => this.dispatch(req, res))
    s.on('upgrade', (req, socket, head) => this.dispatchUpgrade(req, socket, head))
    s.on('connection', (c: Socket) => this.track(c))
    s.on('clientError', (_e, socket) => { if (!socket.destroyed) socket.destroy() })
    return s
  }

  private dispatch(req: IncomingMessage, res: ServerResponse): void {
    if (this.stopped) { sendJson(res, 503, { error: 'daemon shutting down' }); return }
    const raw = req.headers.host
    if (isDaemonHost(this.cfg, raw)) { this.toApi(req, res); return }
    const route = this.table().byHost(hostOnly(raw))
    if (route) {
      if (route.kind === 'api') { this.toApi(req, res); return }
      void this.http.handle(route, req, res)
      return
    }
    // Local mode keeps today's behaviour: any other Host on the daemon's own port is the API, so a
    // LAN name or `host.docker.internal:8080` from a container still works (decision 4).
    if (this.cfg.mode === 'local') { this.toApi(req, res); return }
    sendJson(res, 404, { error: 'unknown route' })
  }

  private dispatchUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.track(socket)
    if (this.stopped) { socket.destroy(); return }
    const route = isDaemonHost(this.cfg, req.headers.host) ? undefined : this.table().byHost(hostOnly(req.headers.host))
    if (!route || route.kind !== 'compute') { socket.destroy(); return }
    void this.http.upgrade(route, req, socket, head)
  }

  private toApi(req: IncomingMessage, res: ServerResponse): void {
    if (!this.apiHandler) { sendJson(res, 503, { error: 'daemon not ready' }); return }
    this.apiHandler(req, res)
  }

  private track(s: Duplex): void {
    this.sockets.add(s)
    s.once('close', () => this.sockets.delete(s))
  }

  // ---- start / stop ----------------------------------------------------------------------------

  /** On the daemon's sweep beat: the lanes' no-SNI default follows a renewed certificate (a
   *  replaced supplied pair, or an `api.` certificate the edge renewed) without waiting for a
   *  route change, which is all that used to run `reconcile`. Never asks the edge to issue. */
  async refreshCertificates(): Promise<void> {
    if (this.stopped) return
    try { await this.refreshDefaultContext() } catch (e) {
      this.log(`router: refreshing the default certificate failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async start(): Promise<void> {
    const server = this.cfg.mode === 'server'
    if (server) {
      // One issuance attempt here, and `reconcile` picks the certificate up later: the daemon and the
      // edge start together, so on a fresh box the store is empty AND the edge is usually not
      // answering yet when this runs, and the installer's own first request comes later still.
      await this.refreshDefaultContext(true)
      if (!this.defaultContext) this.log(`router: no certificate for api.${this.cfg.domain} yet; until the edge issues one, a TLS lane client that sends no SNI is refused`)
    }

    // The local Linux bridge gateway: containers reach the API and the HTTP lane through it.
    for (const host of this.cfg.extraListenHosts) {
      const extra = this.newHttpServer()
      await this.listen(extra, host, this.cfg.port, `extra HTTP listener ${host}:${this.cfg.port}`)
      this.extraHttp.push(extra)
    }

    if (server) {
      await this.fixedLane('pg', this.cfg.lanes.pgPort)
      await this.fixedLane('redis', this.cfg.lanes.redisPort)
      await this.fixedLane('mongodb', this.cfg.lanes.mongoPort)
      this.internal = createInternalServer({ ownsHostname: (h) => this.ownsHostname(h), log: this.log })
      this.internal.on('connection', (c: Socket) => this.track(c))
      await this.listen(this.internal, '127.0.0.1', this.cfg.internalPort, `internal listener 127.0.0.1:${this.cfg.internalPort}`)
    }
    await this.reconcileSerial()
  }

  async stop(): Promise<void> {
    this.stopped = true
    // Held requests and splices give up here rather than making app.close() wait out a 60 s wake.
    this.abort.abort()
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null }
    for (const lane of this.lanes.values()) lane.close()
    this.lanes.clear()
    this.tlsLanes.clear()
    if (this.internal) { this.internal.close(); this.internal = null }
    for (const s of this.extraHttp) s.close()
    this.extraHttp.length = 0
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
    this.http.close()
    // The primary server belongs to Fastify: `app.close()` closes it.
  }

  private listen(s: LaneServer, host: string, port: number, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error): void => reject(isAddrInUse(e) ? new Error(`${what} is already in use; free the port or set the matching INSTA_OSS_LANE_* key`) : e)
      s.once('error', onError)
      s.listen(port, host, () => resolve())
    })
  }

  // ---- lanes -----------------------------------------------------------------------------------

  private laneBinds(): string[] {
    // Server mode publishes the lanes (the edge is not in the path for raw TCP); local mode keeps
    // them on loopback plus the bridge gateway so containers can reach them too.
    return this.cfg.mode === 'server' ? [this.cfg.lanes.bind] : [this.cfg.lanes.bind, ...this.cfg.extraListenHosts]
  }

  /** The three shared server-mode lanes. A busy fixed port is fatal and names itself. */
  private async fixedLane(kind: 'pg' | ManagedDbType, port: number): Promise<void> {
    const id = `fixed:${kind}:${port}`
    const servers: LaneServer[] = []
    for (const bind of this.laneBinds()) {
      const s = kind === 'pg' ? this.pgServer(port) : this.sniServer(kind, bind, port)
      await this.listen(s, bind, port, `${kind} lane ${bind}:${port}`)
      servers.push(s)
    }
    this.lanes.set(id, { id, port, close: () => { for (const s of servers) s.close() } })
  }

  private pgServer(port: number): LaneServer {
    const s = createPgLane({
      cfg: this.cfg, upstream: this.deps.upstream, stateOf: this.deps.stateOf, wake: this.deps.wake,
      table: () => this.table(), touch: (k) => this.deps.touch(k), beginHold: (k) => this.hold(k), endHold: (k) => this.release(k),
      signal: this.abort.signal, secureContext: () => this.defaultContext, sniCallback: this.certs.sniCallback(() => this.defaultContext, (h) => this.ownsHostnameMemo(h)), log: this.log,
    }, this.cfg.lanes.bind, port)
    s.on('connection', (c: Socket) => this.track(c))
    return s
  }

  private sniServer(kind: ManagedDbType, bind: string, port: number): LaneServer {
    const s = createSniLane({
      cfg: this.cfg, upstream: this.deps.upstream, stateOf: this.deps.stateOf, wake: this.deps.wake,
      table: () => this.table(), touch: (k) => this.deps.touch(k), beginHold: (k) => this.hold(k), endHold: (k) => this.release(k),
      signal: this.abort.signal, defaultMaterial: this.defaultMaterial, sniCallback: this.certs.sniCallback(() => this.defaultContext, (h) => this.ownsHostnameMemo(h)), log: this.log,
    }, kind, bind, port)
    s.on('connection', (c: Socket) => this.track(c))
    this.tlsLanes.add(s)
    s.once('close', () => this.tlsLanes.delete(s))
    return s
  }

  /** The certificate a TLS lane presents to a client that sends NO SNI. Start is only the first
   *  attempt: on a fresh box nothing has asked the edge for `api.<domain>` yet, so every reconcile
   *  looks again and the SNI lanes already listening are updated in place. Only the start attempt
   *  asks the edge to issue; a later one reads the store, so a box whose ACME is failing does not
   *  pay a 15 s handshake on every service it adds.
   *
   *  And every look FOLLOWS a renewal. This used to return as soon as a context existed, so the
   *  no-SNI default was the certificate the process booted with, forever: a renewed supplied pair
   *  (or an ACME `api.` certificate Caddy renewed) reached every SNI client while libpq before 14
   *  and older JDBC drivers, which send no SNI, kept the old one until it expired. `certFor` is
   *  cached on the files' stamp and hands back the SAME context while nothing moved, so an
   *  identical object is the cheap "unchanged" and only a real change is pushed to the lanes. */
  private async refreshDefaultContext(issue = false): Promise<void> {
    if (this.cfg.mode !== 'server') return
    const host = `api.${this.cfg.domain}`
    if (!issue && !this.certs.certExists(host)) return
    const ctx = await this.certs.certFor(host)
    // Null (the pair became unreadable) keeps the context already held: a client still completes
    // its handshake and is told why, rather than getting an alert.
    if (!ctx || ctx === this.defaultContext) return
    // Nothing is committed until BOTH reads have succeeded. They are two reads of a pair someone
    // else replaces: committing the context first and then failing on the bytes left every later
    // beat on the "nothing moved" exit above, so pg (which reads the context) moved while redis and
    // mongo (which take the bytes) kept the old default for good. Uncommitted, a failed read is
    // simply tried again on the next beat; and if the two reads straddle a rename, the next beat
    // sees a changed context and brings both back together.
    const material = this.certs.materialFor(host)
    if (!material) return
    this.defaultContext = ctx
    this.defaultMaterial = material
    for (const s of this.tlsLanes) {
      try { s.setSecureContext(material) } catch { /* closing: a lane opened later gets it at creation */ }
    }
  }

  /** Per-service lanes: local mode every database, server mode MySQL only. */
  private wantedPerService(): Map<string, { route: Route; port: number }> {
    const out = new Map<string, { route: Route; port: number }>()
    const server = this.cfg.mode === 'server'
    for (const route of this.table().routes()) {
      if (route.listenPort === undefined) continue
      if (server && route.lane !== 'port') continue        // pg/redis/mongo share the fixed lanes
      if (!server && route.lane === 'sni') continue        // no TLS lanes in local mode
      if (route.lane !== 'pg' && route.lane !== 'port') continue
      out.set(`svc:${route.key}`, { route, port: route.listenPort })
    }
    return out
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return
    await this.refreshDefaultContext()
    const wanted = this.wantedPerService()
    for (const [id, lane] of this.lanes) {
      if (!id.startsWith('svc:')) continue
      const want = wanted.get(id)
      if (!want || want.port !== lane.port) { lane.close(); this.lanes.delete(id) }
    }
    for (const [id, want] of wanted) {
      if (this.lanes.has(id)) continue
      await this.openPerService(id, want.route)
    }
  }

  /** Open one per-service lane; a port something else already holds is reallocated (a laptop hands
   *  20000-20999 out to anyone) instead of stopping the daemon. */
  private async openPerService(id: string, route: Route): Promise<void> {
    let current = route
    for (let attempt = 0; attempt < 8; attempt++) {
      const port = current.listenPort
      if (port === undefined) return
      const servers: LaneServer[] = []
      try {
        for (const bind of this.laneBinds()) {
          const s = current.lane === 'pg' ? this.pgServer(port) : this.portServer(current, bind, port)
          await this.listen(s, bind, port, `${current.serviceId ?? current.kind} lane ${bind}:${port}`)
          servers.push(s)
        }
        this.lanes.set(id, { id, port, close: () => { for (const s of servers) s.close() } })
        return
      } catch (e) {
        for (const s of servers) s.close()
        if (!/already in use/.test(e instanceof Error ? e.message : '')) throw e
        const next = this.deps.reallocLane?.(current)
        if (next === undefined) {
          this.log(`router: lane port ${port} for ${current.serviceId ?? current.key} is in use and no replacement is available; that service has no lane`)
          return
        }
        this.log(`router: lane port ${port} for ${current.serviceId ?? current.key} was in use; moved to ${next}`)
        this.cached = null
        current = this.table().routes().find((r) => r.key === current.key) ?? { ...current, listenPort: next }
      }
    }
    throw new Error(`router: could not find a free lane port in ${this.cfg.lanes.portRange[0]}-${this.cfg.lanes.portRange[1]}`)
  }

  private portServer(route: Route, bind: string, port: number): LaneServer {
    const key = route.key
    const s = createPortLane({
      cfg: this.cfg, upstream: this.deps.upstream, stateOf: this.deps.stateOf, wake: this.deps.wake,
      touch: (k) => this.deps.touch(k), beginHold: (k) => this.hold(k), endHold: (k) => this.release(k),
      signal: this.abort.signal, log: this.log,
    }, () => this.table().routes().find((r) => r.key === key), bind, port)
    s.on('connection', (c: Socket) => this.track(c))
    return s
  }

  // ---- ownership: the ask endpoint's answer, and what may drive certificate work ----------------

  /** Every hostname this box actually serves: `hosts()` is the EXPLICIT membership set (service
   *  names, api/console, the object store and the vhost of every bucket that exists), never the
   *  wildcard. `byHost()` is deliberately wider on the object-store suffix, so that any single
   *  label under `*.s3.<domain>` reaches the store and gets its own 404 from it, and that is
   *  routing, not ownership: answering yes here would let an arbitrary name walk the certificate
   *  store and buy a 15 s issuance handshake on a public lane for the price of one packet. */
  ownsHostname(host: string): boolean {
    if (this.deps.ownsHostname) return this.deps.ownsHostname(host)
    return this.table().hosts().has(hostOnly(host))
  }

  /**
   * The same question on the TLS hot path, answered from the memoized table only.
   *
   * `ownsHostname` prefers `deps.ownsHostname`, which is the engine's version: it calls
   * `loadState()` and rebuilds the whole route table on every call. That is right for the ask
   * endpoint, which is loopback-only, low volume and wants freshness. It is wrong here. These
   * lanes listen on every interface in server mode, so an SNI scan would turn one unauthenticated
   * ClientHello into a full state clone and table rebuild, and cost the daemon far more than it
   * costs the scanner. The memoized table is already invalidated by every routing write, so it is
   * as fresh as the routes themselves.
   */
  private ownsHostnameMemo(host: string): boolean {
    return this.table().hosts().has(hostOnly(host))
  }
}

/** The lane-port allocator the engine and the router share (contract 7.1 `allocLanePort`): the lowest
 *  port in the configured range that no branch and no reservation holds and that a bind probe accepts.
 *  Exported here because the router reallocates a busy per-service lane at start (02 section 0). */
export function laneReallocator(cfg: Config, alloc: () => number): (route: Route) => number | undefined {
  return (route) => {
    if (!route.branchId || !route.serviceId) return undefined
    const port = alloc()
    const { branchId, serviceId } = route
    mutate((s) => {
      const b = s.branches[branchId]
      if (!b) return
      b.lanes = { ...(b.lanes ?? {}), [serviceId]: port }
      if (s.laneReservations) delete s.laneReservations[String(route.listenPort ?? '')]
    })
    return port
  }
}
