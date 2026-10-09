// Readiness probes and the shared resolve-then-wake step every lane runs (02 sections 3.4, 4, 5, 6).
// The router keeps NO wake singleflight and NO wake timer of its own: `deps.wake` is the
// scheduler's, already singleflight per key (decision 52), with `wakeTimeoutSec` bounding its
// READINESS wait and the candidate pool bounding the eviction that may precede it. What lives
// here is what happens around it: resolve the upstream, decide whether a wake is needed, re-resolve
// AFTER the wake (a deploy may have replaced the container), then probe the port until it accepts.
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Route } from './table'
import type { UpstreamAddr, UpstreamLike, ServiceState } from './deps'

export interface WakeDeps {
  upstream: UpstreamLike
  stateOf(route: Route): ServiceState
  wake(route: Route): Promise<void>
}

export class ShuttingDownError extends Error { constructor() { super('daemon shutting down') } }
export class UpstreamNotReadyError extends Error { constructor() { super('upstream not accepting connections') } }
export class NotWokenError extends Error { constructor() { super('service could not be woken') } }

export type WakeFailure = 'timeout' | 'stopped' | 'nocontainer' | 'shutdown' | 'other'

/** Classify a wake error by the scheduler's error classes (matched by name so this module has no
 *  import on src/scheduler.ts) with the message as the fallback. */
export function classifyWakeError(e: unknown): WakeFailure {
  if (e instanceof ShuttingDownError) return 'shutdown'
  const name = e instanceof Error ? (e.constructor?.name ?? e.name) : ''
  const msg = e instanceof Error ? e.message : String(e)
  // The class first; the text only when this was handed a message rather than an error. Both of
  // `WakeTimeoutError`'s messages carry `timed out` and neither says "did not become ready" any
  // more, because a caller whose budget runs out while it is queued or evicting has not reached
  // the readiness wait at all.
  if (name === 'WakeTimeoutError' || /timed out/i.test(msg)) return 'timeout'
  if (name === 'ServiceStoppedError' || /service is stopped/i.test(msg)) return 'stopped'
  if (name === 'NoContainerError' || /has no container/i.test(msg)) return 'nocontainer'
  return 'other'
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref() })

/** Dial `host:port` every 100 ms (500 ms per dial) until it accepts or `windowMs` passes. */
export async function probePort(host: string, port: number, windowMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + windowMs
  do {
    if (signal?.aborted) return false
    if (await dialOnce(host, port, 500)) return true
    await sleep(100)
  } while (Date.now() < deadline)
  return false
}

function dialOnce(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ host, port })
    const done = (ok: boolean): void => { s.destroy(); resolve(ok) }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

/** Redis readiness: `PING` answered `+PONG`, `-NOAUTH` or `-WRONGPASS` means up; `-LOADING` means
 *  the AOF is still replaying, retry. */
export async function probeRedis(host: string, port: number, windowMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + windowMs
  do {
    if (signal?.aborted) return false
    const answer = await exchange(host, port, Buffer.from('*1\r\n$4\r\nPING\r\n'), 1000)
    if (answer !== null) {
      const first = answer.toString('latin1')
      if (first.startsWith('+') || /^-(NOAUTH|WRONGPASS|ERR)/.test(first)) return true
    }
    await sleep(250)
  } while (Date.now() < deadline)
  return false
}

/** One TCP exchange: connect, write, return the first chunk (null on refusal or timeout). */
function exchange(host: string, port: number, payload: Buffer, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const s = netConnect({ host, port })
    const done = (v: Buffer | null): void => { s.destroy(); resolve(v) }
    s.setTimeout(timeoutMs, () => done(null))
    s.once('error', () => done(null))
    s.once('connect', () => s.write(payload))
    s.once('data', (d: Buffer) => done(d))
  })
}

/** Postgres SSLRequest packet (protocol 3.0: length 8, code 80877103). */
export const SSL_REQUEST: Buffer = (() => { const b = Buffer.alloc(8); b.writeUInt32BE(8, 0); b.writeUInt32BE(80877103, 4); return b })()

/** A protocol 3.0 StartupMessage for `user`/`database`. */
export function startupMessage(params: Record<string, string>): Buffer {
  const body: Buffer[] = [Buffer.from([0, 3, 0, 0])]
  for (const [k, v] of Object.entries(params)) body.push(Buffer.from(`${k}\0${v}\0`, 'utf8'))
  body.push(Buffer.from([0]))
  const payload = Buffer.concat(body)
  const out = Buffer.alloc(4 + payload.length)
  out.writeUInt32BE(out.length, 0)
  payload.copy(out, 4)
  return out
}

/** Parse the SQLSTATE (`C` field) out of a wire ErrorResponse body. */
export function errorResponseCode(msg: Buffer): string | null {
  // msg = 'E' + int32 len + fields; each field is one type byte + cstring, terminated by \0
  let i = 5
  while (i < msg.length && msg[i] !== 0) {
    const type = String.fromCharCode(msg[i])
    const end = msg.indexOf(0, i + 1)
    if (end === -1) break
    if (type === 'C') return msg.toString('utf8', i + 1, end)
    i = end + 1
  }
  return null
}

/** Postgres wire readiness (the equivalent of pg_isready without a docker exec per 250 ms): connect,
 *  offer SSLRequest (the image answers `N` by default; on `S` wrap in TLS), send a Startup for
 *  postgres/postgres, then read the first message. An ALLOWLIST, like `probeRedis` next door:
 *  `R` (authentication) = ready; `E` = the server is up and talking, unless its code says it is
 *  still starting; anything else, including a first byte this protocol does not define and an
 *  empty read, = retry. It used to end with a bare `done('ready')`, so a wake was declared
 *  finished by whatever arrived on the socket. */
/** `cannot_connect_now`: the postmaster is up but still recovering, which is the one error that
 *  means "ask again" rather than "it is answering". */
const PG_STARTING_UP = '57P03'

export async function probePg(host: string, port: number, windowMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + windowMs
  do {
    if (signal?.aborted) return false
    const verdict = await pgHandshakeOnce(host, port, 2000)
    if (verdict === 'ready') return true
    await sleep(250)
  } while (Date.now() < deadline)
  return false
}

function pgHandshakeOnce(host: string, port: number, timeoutMs: number): Promise<'ready' | 'retry'> {
  return new Promise((resolve) => {
    let sock: Socket = netConnect({ host, port })
    let settled = false
    const done = (v: 'ready' | 'retry'): void => { if (settled) return; settled = true; sock.destroy(); resolve(v) }
    const timer = setTimeout(() => done('retry'), timeoutMs)
    timer.unref()
    const startup = (): void => {
      sock.write(startupMessage({ user: 'postgres', database: 'postgres' }))
      sock.once('data', (msg: Buffer) => {
        if (msg.length === 0) return done('retry')
        const type = String.fromCharCode(msg[0])
        if (type === 'R') return done('ready')
        if (type === 'E') return done(errorResponseCode(msg) === PG_STARTING_UP ? 'retry' : 'ready')
        done('retry')
      })
    }
    sock.once('error', () => done('retry'))
    sock.once('connect', () => {
      sock.write(SSL_REQUEST)
      sock.once('data', (d: Buffer) => {
        if (d[0] === 0x53 /* S */) {
          const t = tlsConnect({ socket: sock, rejectUnauthorized: false })
          t.once('error', () => done('retry'))
          t.once('secureConnect', () => { sock = t; startup() })
        } else startup()
      })
    })
  })
}

/** The shared step 4 of every lane: resolve the upstream; when it is missing or the service is not
 *  running (or `forceWake` says a cached address just refused), wake it (through the scheduler, which
 *  owns singleflight and the 60 s bound), re-resolve, then probe until the port accepts. A plain cache
 *  hit is NOT probed: the lane dials it directly and a refusal takes the one bounded retry through
 *  this function with `forceWake`. Throws the scheduler's error on wake failure, UpstreamNotReadyError
 *  when the probe window passes, NotWokenError when the container still has no address after the wake. */
export async function resolveOrWake(
  deps: WakeDeps, route: Route,
  opts: { probe: (addr: UpstreamAddr) => Promise<boolean>; signal?: AbortSignal; forceWake?: boolean },
): Promise<{ up: UpstreamAddr; woke: boolean }> {
  let up = opts.forceWake ? null : await deps.upstream.resolve(route.container, route.network, route.port)
  let woke = false
  if (!up || deps.stateOf(route) !== 'running') {
    woke = true
    if (opts.signal?.aborted) throw new ShuttingDownError()
    await raceAbort(deps.wake(route), opts.signal)
    // re-resolve AFTER the wake, never before: the op the wake waited behind may have replaced the container
    deps.upstream.forget(route.container)
    up = await deps.upstream.resolve(route.container, route.network, route.port)
    if (!up) throw new NotWokenError()
    if (!(await opts.probe(up))) {
      deps.upstream.forget(route.container)
      throw new UpstreamNotReadyError()
    }
  }
  return { up, woke }
}

/** A plain TCP connect that settles once: the socket on connect, an error on refusal or timeout. */
export function connectTcp(host: string, port: number, timeoutMs = 5000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host, port })
    s.setNoDelay(true)
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`connect ${host}:${port} timed out`)) }, timeoutMs)
    timer.unref()
    s.once('connect', () => { clearTimeout(timer); s.removeAllListeners('error'); resolve(s) })
    s.once('error', (e) => { clearTimeout(timer); s.destroy(); reject(e) })
  })
}

/** The TCP lanes' upstream dial: resolve-or-wake, connect; a refused CACHED address is forgotten and
 *  retried exactly once through the wake path (a stale entry after a restart or an eviction). */
export async function connectUpstream(
  deps: WakeDeps, route: Route,
  opts: { probe: (addr: UpstreamAddr) => Promise<boolean>; signal?: AbortSignal },
): Promise<{ sock: Socket; woke: boolean }> {
  let r = await resolveOrWake(deps, route, opts)
  try {
    return { sock: await connectTcp(r.up.host, r.up.port), woke: r.woke }
  } catch (e) {
    if (r.woke) throw e
    deps.upstream.forget(route.container)
    r = await resolveOrWake(deps, route, { ...opts, forceWake: true })
    return { sock: await connectTcp(r.up.host, r.up.port), woke: true }
  }
}

function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new ShuttingDownError())
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v) }, (e) => { signal.removeEventListener('abort', onAbort); reject(e) })
  })
}
