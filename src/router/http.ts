// The HTTP lane (02 section 3): one listener, Host routing, hold-and-wake, WebSocket passthrough.
//
// The dispatcher in index.ts has already decided that this request belongs to a route (daemon hosts
// and, in local mode, unknown hosts went to Fastify). What happens here is the serverless part: stamp
// activity, hold the key for as long as the request lives, wake the service when it is asleep, then
// proxy. A request that woke its service retries a bodiless idempotent 502/503/504 inside the
// readiness window, because a container that just started often answers before its app binds.
import { Agent, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Config } from '../config'
import type { ServiceKey } from '../types'
import { GARAGE_S3_PORT, GARAGE_WEB_PORT, type Route } from './table'
import { splice } from './splice'
import { classifyWakeError, connectTcp, probePort, resolveOrWake, ShuttingDownError, type WakeDeps } from './wake'
import type { UpstreamAddr } from './deps'

/** Headers that describe ONE hop and must never be forwarded (RFC 9110 7.6.1). */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
])

/** Methods whose retry is safe and whose body we never consumed. */
const IDEMPOTENT: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface HttpLaneDeps extends WakeDeps {
  cfg: Config
  touch(key: ServiceKey): void
  beginHold(key: ServiceKey): void
  endHold(key: ServiceKey): void
  /** Aborted by `Router.stop()`: held requests answer 503 instead of waiting out a wake. */
  signal: AbortSignal
  log?(msg: string): void
}

export function sendJson(res: ServerResponse, code: number, body: unknown): void {
  if (res.headersSent) { res.end(); return }
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const jitter = (ms: number): number => ms * (0.75 + Math.random() * 0.5)
const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref() })

export class HttpLane {
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 256, keepAliveMsecs: 10_000 })
  private readonly log: (msg: string) => void

  constructor(private readonly deps: HttpLaneDeps) {
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  close(): void { this.agent.destroy() }

  /** Step 1: the static object-store routes carry no service key, so they neither stamp nor wake. */
  private staticUpstream(route: Route, req: IncomingMessage): UpstreamAddr | null {
    if (route.kind === 'garage') return { host: '127.0.0.1', port: GARAGE_S3_PORT, containerId: '', startedAt: '' }
    if (route.kind !== 'garage-vhost') return null
    // ONE hostname, two upstreams, chosen per request (decision 20): anything signed, and anything
    // that is not a plain read, is the S3 API; the rest is the web endpoint for public buckets.
    const auth = String(req.headers.authorization ?? '')
    const q = req.url && req.url.includes('?') ? new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1)) : null
    const signed = auth.startsWith('AWS4-HMAC-SHA256') || q?.has('X-Amz-Signature') === true || q?.has('X-Amz-Algorithm') === true
    const method = (req.method ?? 'GET').toUpperCase()
    const api = signed || (method !== 'GET' && method !== 'HEAD')
    return { host: '127.0.0.1', port: api ? GARAGE_S3_PORT : GARAGE_WEB_PORT, containerId: '', startedAt: '' }
  }

  async handle(route: Route, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const staticUp = this.staticUpstream(route, req)
    if (staticUp) { await this.proxy(route, staticUp, req, res, { retryUntil: 0 }); return }
    if (route.kind !== 'compute') { sendJson(res, 503, { error: 'this service serves no HTTP endpoint' }); return }
    // Step 2: the desired state was copied onto the route at build time, so this costs no state read.
    if (route.desiredState === 'stopped') { sendJson(res, 503, { error: 'service is stopped' }); return }
    if (route.desiredState === 'suspended') { sendJson(res, 503, { error: 'service is suspended' }); return }

    const key = route.key
    // Step 3: stamp now and hold the key until the response closes; the router's one shared ticker
    // re-stamps every held key every touchDebounceMs.
    this.deps.touch(key)
    this.deps.beginHold(key)
    let released = false
    const release = (): void => { if (!released) { released = true; this.deps.endHold(key) } }
    res.on('close', release)

    try {
      const { up, woke } = await resolveOrWake(this.deps, route, {
        probe: (addr) => probePort(addr.host, addr.port, this.deps.cfg.lanes.probeWindowMs, this.deps.signal),
        signal: this.deps.signal,
      })
      if (req.destroyed || res.writableEnded) return
      const retryUntil = woke ? Date.now() + this.deps.cfg.lanes.readyWindowMs : 0
      await this.proxy(route, up, req, res, { retryUntil })
    } catch (e) {
      this.failed(e, res)
    } finally {
      // A response that is still streaming (SSE, chunked, a slow body) keeps the hold: `pipe()`
      // returns as soon as the bytes start flowing, and the `close` handler above is what releases.
      if (res.writableEnded || res.destroyed) release()
    }
  }

  /** WebSocket and any other protocol upgrade: the same hold-and-wake, then a raw byte splice. */
  async upgrade(route: Route, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (route.kind !== 'compute') { socket.destroy(); return }
    if (route.desiredState !== 'running') { socket.end('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n'); return }
    const key = route.key
    this.deps.touch(key)
    this.deps.beginHold(key)
    let released = false
    const release = (): void => { if (!released) { released = true; this.deps.endHold(key) } }
    socket.on('close', release)
    try {
      const { up } = await resolveOrWake(this.deps, route, {
        probe: (addr) => probePort(addr.host, addr.port, this.deps.cfg.lanes.probeWindowMs, this.deps.signal),
        signal: this.deps.signal,
      })
      if (socket.destroyed) { release(); return }
      const upSock = await connectTcp(up.host, up.port)
      upSock.write(this.requestHead(route, req))
      if (head.length) upSock.write(head)
      // idleMs 0: an idle WebSocket is legitimate, and the hold keeps the service awake anyway.
      splice(socket, upSock, { idleMs: 0, onBytes: () => { /* the hold's ticker stamps */ }, onClose: release })
    } catch (e) {
      this.log(`router: upgrade on ${route.host} failed: ${e instanceof Error ? e.message : String(e)}`)
      if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n')
      release()
    }
  }

  /** The request head as bytes, for the upgrade path (Host preserved, hop-by-hop dropped). */
  private requestHead(route: Route, req: IncomingMessage): string {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    const headers = this.forwardHeaders(route, req)
    headers['connection'] = 'Upgrade'
    if (req.headers.upgrade) headers['upgrade'] = String(req.headers.upgrade)
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)
    return `${lines.join('\r\n')}\r\n\r\n`
  }

  private forwardHeaders(route: Route, req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue
      out[k] = Array.isArray(v) ? v.join(', ') : String(v)
    }
    // Host stays exactly as sent (an app's absolute redirects and cookie domains depend on it).
    const remote = req.socket.remoteAddress ?? ''
    const priorFor = req.headers['x-forwarded-for']
    out['x-forwarded-for'] = priorFor ? `${Array.isArray(priorFor) ? priorFor.join(', ') : priorFor}, ${remote}` : remote
    out['x-forwarded-host'] = String(req.headers.host ?? route.host)
    out['x-forwarded-proto'] = this.proto(req)
    return out
  }

  /** `https` only when the edge, over loopback, said so: a public client cannot forge it. */
  private proto(req: IncomingMessage): string {
    const claimed = req.headers['x-forwarded-proto']
    const remote = req.socket.remoteAddress ?? ''
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (claimed && loopback) {
      const first = String(Array.isArray(claimed) ? claimed[0] : claimed).split(',')[0].trim().toLowerCase()
      if (first === 'https' || first === 'http') return first
    }
    return 'http'
  }

  private async proxy(route: Route, up: UpstreamAddr, req: IncomingMessage, res: ServerResponse, opts: { retryUntil: number }): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase()
    const bodiless = IDEMPOTENT.has(method) && req.headers['content-length'] === undefined && req.headers['transfer-encoding'] === undefined
    let addr = up
    let refusedRetryUsed = false

    // Step 6, bodied half: a request we cannot replay waits on `HEAD /` until the app answers, then
    // is forwarded exactly once.
    if (opts.retryUntil > Date.now() && !bodiless) await this.gate(addr, opts.retryUntil)

    let backoff = 200
    for (;;) {
      let upRes: IncomingMessage
      try {
        upRes = await this.once(route, addr, req, res, bodiless)
      } catch (e) {
        const code = (e as { code?: string }).code ?? ''
        if (['ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) this.deps.upstream.forget(route.container)
        // A CACHED address that refuses gets exactly one re-resolve through the wake path.
        if (!refusedRetryUsed && route.kind === 'compute' && ['ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code)) {
          refusedRetryUsed = true
          try {
            const again = await resolveOrWake(this.deps, route, {
              probe: (a) => probePort(a.host, a.port, this.deps.cfg.lanes.probeWindowMs, this.deps.signal),
              signal: this.deps.signal, forceWake: true,
            })
            addr = again.up
            continue
          } catch (e2) { this.failed(e2, res); return }
        }
        if (res.destroyed) return
        sendJson(res, 502, { error: 'upstream request failed' })
        return
      }
      const status = upRes.statusCode ?? 502
      const retryable = bodiless && (status === 502 || status === 503 || status === 504) && Date.now() + backoff < opts.retryUntil
      if (!retryable) { this.pipe(upRes, res); return }
      upRes.resume()
      upRes.destroy()
      await wait(jitter(backoff))
      backoff = Math.min(backoff * 2, 1000)
      if (res.destroyed) return
    }
  }

  /** Wait for the app to answer anything but a 5xx, bounded by the readiness window. */
  private async gate(addr: UpstreamAddr, until: number): Promise<void> {
    let backoff = 200
    while (Date.now() < until) {
      const code = await this.head(addr)
      if (code !== null && code < 500) return
      await wait(jitter(backoff))
      backoff = Math.min(backoff * 2, 1000)
    }
  }

  private head(addr: UpstreamAddr): Promise<number | null> {
    return new Promise((resolve) => {
      const r = httpRequest({ host: addr.host, port: addr.port, method: 'HEAD', path: '/', agent: this.agent, timeout: 5000 }, (up) => {
        up.resume()
        resolve(up.statusCode ?? null)
      })
      r.once('error', () => resolve(null))
      r.once('timeout', () => { r.destroy(); resolve(null) })
      r.end()
    })
  }

  private once(route: Route, addr: UpstreamAddr, req: IncomingMessage, res: ServerResponse, bodiless: boolean): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const upReq = httpRequest({
        host: addr.host, port: addr.port, method: req.method, path: req.url,
        headers: this.forwardHeaders(route, req), agent: this.agent,
      }, resolve)
      upReq.once('error', reject)
      res.once('close', () => { if (!res.writableEnded) upReq.destroy() })
      if (bodiless) upReq.end()
      else {
        req.pipe(upReq)
        req.once('aborted', () => upReq.destroy())
      }
    })
  }

  private pipe(upRes: IncomingMessage, res: ServerResponse): void {
    if (res.destroyed) { upRes.destroy(); return }
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue
      headers[k] = v
    }
    res.writeHead(upRes.statusCode ?? 502, headers)
    // No buffering anywhere on this path: an SSE or chunked stream reaches the client as it arrives.
    upRes.pipe(res)
    upRes.once('error', () => res.destroy())
  }

  private failed(e: unknown, res: ServerResponse): void {
    if (res.destroyed) return
    switch (classifyWakeError(e)) {
      case 'timeout': return sendJson(res, 504, { error: 'service wake timed out' })
      case 'stopped': return sendJson(res, 503, { error: 'service is stopped' })
      case 'nocontainer': return sendJson(res, 503, { error: 'service has no container (deploy in progress or removed)' })
      case 'shutdown': return sendJson(res, 503, { error: 'daemon shutting down' })
      default:
        if (!(e instanceof ShuttingDownError)) this.log(`router: wake failed: ${e instanceof Error ? e.message : String(e)}`)
        return sendJson(res, 503, { error: 'service could not be woken' })
    }
  }
}
