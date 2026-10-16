// Plaintext per-port lanes (02 section 6): local mode gives every database service its own loopback
// port, and server mode does the same for MySQL, whose server greets first and therefore cannot be
// routed by SNI (decision 38). The client is paused until the upstream is connected, so a greeting
// is never dropped on the floor while the container is still waking.
import { createServer, type Server, type Socket } from 'node:net'
import type { Config } from '../config'
import type { ServiceKey } from '../types'
import type { Route } from './table'
import { splice } from './splice'
import { connectUpstream, probePort, probeRedis, type WakeDeps } from './wake'

export interface PortLaneDeps extends WakeDeps {
  cfg: Config
  touch(key: ServiceKey): void
  beginHold(key: ServiceKey): void
  endHold(key: ServiceKey): void
  signal: AbortSignal
  log?(msg: string): void
}

/** One listener for ONE route. The route object is re-read from the table on reconcile, so the
 *  Router closes and re-opens a listener whose route changed rather than mutating it here. */
export function createPortLane(deps: PortLaneDeps, route: () => Route | undefined, bind: string, port: number): Server {
  const log = deps.log ?? ((m: string) => console.warn(m))
  const server = createServer((c) => { void handle(c) })

  const handle = async (c: Socket): Promise<void> => {
    c.setNoDelay(true)
    c.on('error', () => c.destroy())
    // MySQL and mongo speak first from the server side: hold the client silent until we have a peer.
    c.pause()
    const r = route()
    if (!r) { c.destroy(); return }
    const key = r.key
    deps.touch(key)
    deps.beginHold(key)
    let released = false
    const release = (): void => { if (!released) { released = true; deps.endHold(key) } }
    c.once('close', release)
    try {
      const { sock: up } = await connectUpstream(deps, r, {
        probe: (addr) => (r.kind === 'redis'
          ? probeRedis(addr.host, addr.port, deps.cfg.lanes.probeWindowMs, deps.signal)
          : probePort(addr.host, addr.port, deps.cfg.lanes.probeWindowMs, deps.signal)),
        signal: deps.signal,
      })
      if (c.destroyed) { up.destroy(); release(); return }
      splice(c, up, { idleMs: deps.cfg.lanes.idleSec * 1000, onBytes: () => deps.touch(key), onClose: release })
    } catch (e) {
      log(`router: ${r.kind} lane could not reach ${r.host}: ${e instanceof Error ? e.message : String(e)}`)
      c.destroy()
      release()
    }
  }

  server.on('error', (e) => log(`router: port lane ${bind}:${port}: ${e.message}`))
  return server
}
