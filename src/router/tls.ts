// TLS-SNI lanes for redis and mongodb, server mode only (02 section 5). Both protocols are opaque
// binary streams whose clients support TLS with a hostname, so one public port per type carries every
// service on the box and the servername picks the route. MySQL is absent on purpose: the server
// greets first, so there is no ClientHello to read a hostname from (decision 38).
import { createServer, type Server as TlsServer, type SecureContext, type TLSSocket } from 'node:tls'
import type { Config } from '../config'
import type { ServiceKey } from '../types'
import type { ManagedDbType } from '../types'
import type { Route, RouteTable } from './table'
import { splice } from './splice'
import { connectUpstream, probePort, probeRedis, type WakeDeps } from './wake'

export interface SniLaneDeps extends WakeDeps {
  cfg: Config
  table(): RouteTable
  touch(key: ServiceKey): void
  beginHold(key: ServiceKey): void
  endHold(key: ServiceKey): void
  signal: AbortSignal
  /** The certificate the lane presents when the ClientHello carries NO SNI, as bytes. It is not a
   *  `SecureContext`, because `tls.createServer` IGNORES a `secureContext` option: `tls.Server`
   *  builds its own default from cert/key and `setSecureContext` is the only way to replace it.
   *  Null on a box the edge has not issued `api.<domain>` for yet; the Router pushes it in later. */
  defaultMaterial?: { cert: Buffer; key: Buffer } | null
  sniCallback?: (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) => void
  log?(msg: string): void
}

/** The handshake budget, matching the pg lane's negotiation budget. */
const HANDSHAKE_MS = 10_000

/** One SNI lane. `kind` is the managed type this port serves; a servername belonging to any other
 *  lane is closed after the handshake (a clean close beats a TLS alert: the client sees the port). */
export function createSniLane(deps: SniLaneDeps, kind: ManagedDbType, bind: string, port: number): TlsServer {
  const log = deps.log ?? ((m: string) => console.warn(m))
  // The default certificate is `api.<domain>`, so a client with no SNI completes the handshake and
  // gets a close instead of an opaque handshake failure (decision 21). It has to go in through
  // `setSecureContext`; the Router calls the same method again for a certificate that arrives after
  // the lane is already listening (refreshDefaultContext).
  // `handshakeTimeout` because these lanes are published on the internet too and node's default
  // is two minutes: a client that opens a connection and never sends a ClientHello holds a
  // descriptor for that long, which is the same shape as the pg lane's finding (`terminate` in
  // `pg.ts`), just already bounded. Ten seconds is the same budget the pg negotiation uses.
  const server = createServer({ SNICallback: deps.sniCallback, minVersion: 'TLSv1.2', handshakeTimeout: HANDSHAKE_MS })
  if (deps.defaultMaterial) server.setSecureContext(deps.defaultMaterial)
  server.on('secureConnection', (sock: TLSSocket) => { void handle(sock) })
  server.on('tlsClientError', () => { /* a scanner or a client with no trust: nothing to log per packet */ })
  server.on('error', (e) => log(`router: ${kind} lane ${bind}:${port}: ${e.message}`))

  const handle = async (sock: TLSSocket): Promise<void> => {
    sock.setNoDelay(true)
    sock.on('error', () => sock.destroy())
    const name = (sock.servername || '').toString().toLowerCase().replace(/\.$/, '')
    const route: Route | undefined = name ? deps.table().byHost(name) : undefined
    if (!route || route.kind !== kind) { sock.destroy(); return }
    const key = route.key
    deps.touch(key)
    deps.beginHold(key)
    let released = false
    const release = (): void => { if (!released) { released = true; deps.endHold(key) } }
    sock.once('close', release)
    try {
      const { sock: up } = await connectUpstream(deps, route, {
        probe: (addr) => (kind === 'redis'
          ? probeRedis(addr.host, addr.port, deps.cfg.lanes.probeWindowMs, deps.signal)
          : probePort(addr.host, addr.port, deps.cfg.lanes.probeWindowMs, deps.signal)),
        signal: deps.signal,
      })
      if (sock.destroyed) { up.destroy(); release(); return }
      splice(sock, up, { idleMs: deps.cfg.lanes.idleSec * 1000, onBytes: () => deps.touch(key), onClose: release })
    } catch (e) {
      log(`router: ${kind} lane could not reach ${route.host}: ${e instanceof Error ? e.message : String(e)}`)
      sock.destroy()
      release()
    }
  }

  return server
}
