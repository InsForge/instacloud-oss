// The Postgres wire lane (02 section 4). One TCP listener answers the real protocol so that a stock
// client reaches a sleeping database: read the first 8 bytes, answer the SSL negotiation, pick the
// route (SNI in server mode, the local listen port in local mode), then hold, wake, probe the wire
// and splice. Every readable failure is a Postgres ErrorResponse, never a silent close: a dropped
// connection tells the user nothing, `08P01` with a sentence tells them what to change.
import { createServer, type Server, type Socket } from 'node:net'
import { TLSSocket, type SecureContext } from 'node:tls'
import type { Config } from '../config'
import type { ServiceKey } from '../types'
import type { Route, RouteTable } from './table'
import { splice } from './splice'
import { classifyWakeError, connectUpstream, probePg, type WakeDeps } from './wake'

/** Protocol codes carried in the second int32 of the startup packet. */
const SSL_REQUEST_CODE = 80877103
const GSSENC_REQUEST_CODE = 80877104
const TLS_HANDSHAKE_BYTE = 0x16

export interface PgLaneDeps extends WakeDeps {
  cfg: Config
  table(): RouteTable
  touch(key: ServiceKey): void
  beginHold(key: ServiceKey): void
  endHold(key: ServiceKey): void
  signal: AbortSignal
  /** Server mode only: the context for a client that sends no SNI, read per connection so a
   *  certificate the edge issues after the lane is listening needs no restart. */
  secureContext?: () => SecureContext | null
  sniCallback?: (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) => void
  log?(msg: string): void
}

/** A wire ErrorResponse: `E` + length + S/V/C/M fields + terminator (the shape libpq prints). */
export function errorResponse(code: string, message: string): Buffer {
  const fields = [`SFATAL`, `VFATAL`, `C${code}`, `M${message}`]
  const body = Buffer.concat([...fields.map((f) => Buffer.from(`${f}\0`, 'utf8')), Buffer.from([0])])
  const out = Buffer.alloc(5 + body.length)
  out[0] = 0x45 // 'E'
  out.writeUInt32BE(4 + body.length, 1)
  body.copy(out, 5)
  return out
}

const SSL_REQUIRED = errorResponse('08P01', 'SSL is required: add sslmode=require to your connection string')
const NO_SNI = errorResponse('08P01', 'no SNI in the TLS handshake: use libpq 14+ or a driver that sends the hostname (sslsni)')
const NO_ROUTE = errorResponse('08P01', 'no database at this hostname (SNI)')
const NO_LOCAL_TLS = errorResponse('08P01', 'TLS is not available in local mode: connect without sslmode=require')
const NOT_PG = errorResponse('08P01', 'this port serves no database')

export const PG_ERRORS = { SSL_REQUIRED, NO_SNI, NO_ROUTE, NO_LOCAL_TLS, NOT_PG }

/** Read exactly `n` bytes, or null when the peer closed or went silent for `timeoutMs`. */
export function readExactly(sock: Socket, n: number, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let have = 0
    let settled = false
    const done = (v: Buffer | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Pause BEFORE detaching. Unshifting while this handler is still attached re-enters it with
      // an ever growing buffer (a synchronous spin), and unshifting onto a flowing socket that has
      // no `data` listener left drops the bytes. Paused, the tail waits for the next reader.
      sock.pause()
      sock.off('data', onData)
      sock.off('error', onEnd)
      sock.off('end', onEnd)
      sock.off('close', onEnd)
      resolve(v)
    }
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
      have += chunk.length
      if (have < n) return
      const all = Buffer.concat(chunks)
      done(all.subarray(0, n))
      if (all.length > n) sock.unshift(all.subarray(n))
    }
    const onEnd = (): void => done(null)
    const timer = setTimeout(() => done(null), timeoutMs)
    timer.unref()
    sock.on('data', onData)
    // An earlier read on this socket left it paused (see `done`), and attaching a listener does not
    // undo an explicit pause.
    sock.resume()
    sock.once('error', onEnd)
    sock.once('end', onEnd)
    sock.once('close', onEnd)
  })
}

interface Negotiated { stream: Socket | TLSSocket; route: Route | undefined; pending: Buffer | null }

export function createPgLane(deps: PgLaneDeps, bind: string, port: number): Server {
  const log = deps.log ?? ((m: string) => console.warn(m))
  const server = createServer((c) => { void handle(c) })

  const handle = async (c: Socket): Promise<void> => {
    c.setNoDelay(true)
    c.on('error', () => c.destroy())
    let neg: Negotiated | null
    try {
      // The accepted socket knows the port this lane is actually bound to, which is what the route
      // table is keyed by; `port` may still be 0 when the caller asked the OS to pick one.
      neg = await negotiate(deps, c, c.localPort ?? port)
    } catch (e) {
      log(`router: pg lane negotiation failed: ${e instanceof Error ? e.message : String(e)}`)
      c.destroy()
      return
    }
    if (!neg) return
    const { stream, route, pending } = neg
    if (!route) { stream.end(deps.cfg.mode === 'server' ? NO_ROUTE : NOT_PG); return }
    if (route.kind !== 'postgres') { stream.end(NOT_PG); return }
    await pump(deps, route, stream, pending, log)
  }

  server.on('error', (e) => log(`router: pg lane ${bind}:${port}: ${e.message}`))
  return server
}

/** The budget for the whole negotiation: the eight bytes AND, when they ask for TLS, the
 *  handshake that follows. One number, because they are one exchange from the client's side. */
const NEGOTIATION_MS = 10_000

/** Answer the SSL negotiation and pick the route. Returns null when the connection is finished. */
async function negotiate(deps: PgLaneDeps, c: Socket, listenPort: number): Promise<Negotiated | null> {
  const server = deps.cfg.mode === 'server'
  for (;;) {
    const head = await readExactly(c, 8, NEGOTIATION_MS)
    if (!head) { c.destroy(); return null }
    const code = head.readUInt32BE(4)

    if (head[0] === TLS_HANDSHAKE_BYTE) {
      // PG17 `sslnegotiation=direct`: those 8 bytes are already the ClientHello, so put them back
      // BEFORE the TLS socket reads from us.
      if (!server) { c.end(NO_LOCAL_TLS); return null }
      c.unshift(head)
      return await terminate(deps, c)
    }
    if (code === GSSENC_REQUEST_CODE) { c.write('N'); continue }
    if (code === SSL_REQUEST_CODE) {
      if (!server) {
        c.write('N')
        return { stream: c, route: deps.table().byPort(listenPort), pending: null }
      }
      c.write('S')
      return await terminate(deps, c)
    }
    // A plaintext StartupMessage.
    if (server) { c.end(SSL_REQUIRED); return null }
    return { stream: c, route: deps.table().byPort(listenPort), pending: head }
  }
}

/** Wrap the socket in TLS with the edge's certificates and route by the servername. */
function terminate(deps: PgLaneDeps, c: Socket): Promise<Negotiated | null> {
  return new Promise((resolve) => {
    // An ABSOLUTE deadline across the HANDSHAKE, which is the part the negotiation's own timer
    // does not cover: `readExactly` clears its timer the moment the eight bytes arrive, so a
    // client that sent `SSLRequest`, read the `S` and then said nothing more held a descriptor,
    // a socket, TLS state and an unresolved promise until it disconnected or the daemon
    // restarted. Unauthenticated, on a port published to the internet, for the price of eight
    // bytes -- and it exhausts the daemon before authentication or routing is ever reached.
    //
    // It destroys BOTH ends: destroying the TLSSocket alone can leave the underlying socket and
    // its descriptor behind, which leaks the same thing more quietly. It settles the promise on
    // that path too, since an unresolved promise is the other half of what leaked. And it is
    // cleared on `secure` AND on `error`, so a finished handshake leaves no timer holding a
    // reference to any of it.
    const deadline = setTimeout(() => {
      tls.destroy()
      c.destroy()
      resolve(null)
    }, NEGOTIATION_MS)
    const settle = (v: Negotiated | null): void => { clearTimeout(deadline); resolve(v) }
    const tls = new TLSSocket(c, {
      isServer: true,
      // The default context is `api.<domain>`, which the installer's first request creates: a client
      // that sends no SNI still completes the handshake and can be told why (decision 21). Read per
      // connection, because the router starts before the edge has issued anything.
      secureContext: deps.secureContext?.() ?? undefined,
      SNICallback: deps.sniCallback,
      minVersion: 'TLSv1.2',
    })
    tls.once('error', () => { clearTimeout(deadline); tls.destroy(); c.destroy(); resolve(null) })
    tls.once('secure', () => {
      const name = (tls.servername || '').toString().toLowerCase().replace(/\.$/, '')
      if (!name) { settle(null); tls.end(NO_SNI); return }
      settle({ stream: tls, route: deps.table().byHost(name), pending: null })
    })
  })
}

/** Hold, wake, probe the wire, then splice, stamping on every chunk either way. */
async function pump(deps: PgLaneDeps, route: Route, stream: Socket | TLSSocket, pending: Buffer | null, log: (m: string) => void): Promise<void> {
  const key = route.key
  deps.touch(key)
  deps.beginHold(key)
  let released = false
  const release = (): void => { if (!released) { released = true; deps.endHold(key) } }
  stream.once('close', release)
  try {
    const { sock } = await connectUpstream(deps, route, {
      probe: (addr) => probePg(addr.host, addr.port, deps.cfg.lanes.probeWindowMs, deps.signal),
      signal: deps.signal,
    })
    if (stream.destroyed) { sock.destroy(); release(); return }
    // The StartupMessage the client already sent (local mode, plaintext) opens the upstream session.
    if (pending && pending.length) sock.write(pending)
    splice(stream, sock, {
      idleMs: deps.cfg.lanes.idleSec * 1000,
      onBytes: () => deps.touch(key),
      onClose: release,
    })
  } catch (e) {
    const kind = classifyWakeError(e)
    const body = kind === 'timeout' ? errorResponse('57P03', 'the database is waking up; retry')
      : kind === 'nocontainer' ? errorResponse('08006', 'the database has no container (deploy in progress or removed)')
        : kind === 'stopped' ? errorResponse('57P03', 'the database is stopped')
          : kind === 'shutdown' ? errorResponse('57P03', 'daemon shutting down')
            : errorResponse('08006', 'the database could not be reached')
    if (kind === 'other') log(`router: pg lane could not reach ${route.host}: ${e instanceof Error ? e.message : String(e)}`)
    if (!stream.destroyed) stream.end(body)
    release()
  }
}
