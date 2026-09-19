// Container address discovery: where does the daemon dial a service's container? (contract 00
// section 8.1, decision 6.)
//
// Server mode the daemon shares the host netns, so it dials the container IP on the branch network
// straight from `docker inspect`. Local mode (macOS especially) cannot route to container IPs at
// all, so every database and app publishes an EPHEMERAL loopback port and the answer comes from
// `docker port`.
//
// ONE instance is shared by DockerRuntime, the Scheduler and the Router (decision 57): a sleep or a
// wake calls `forget`, and the router's next request must not reuse the address of the container
// that just went away. Entries carry the container id so the sweep can drop an address whose
// container restarted underneath it (`forgetIfChanged`): on a user-defined bridge a container that
// restarts by itself can take a new IP, its old IP can be handed to another container on the same
// network (Garage joins every branch network), and a forked database inherits its source's
// password, so a stale address could authenticate a `feat` client against `main`'s postgres.
import { connect as netConnect } from 'node:net'
import type { Config } from './config'
import { docker } from './docker'

export interface UpstreamAddr { host: string; port: number; containerId: string; startedAt: string }

export interface UpstreamLike {
  resolve(container: string, network: string, port: number): Promise<UpstreamAddr | null>
  forget(container: string): void
  forgetIfChanged(container: string, containerId: string): void
  dial(container: string, network: string, port: number, timeoutMs?: number): Promise<boolean>
}

/** The cache key: one container may serve two ports and local mode maps each to a different host
 *  port, so the port is part of the identity. `forget` drops every port of the container. */
const keyOf = (container: string, port: number): string => `${container}#${port}`

/** How long a just-accepted local-mode connection must stay open before it counts as a listener. */
const PROXY_HANGUP_MS = 100

export class Upstream implements UpstreamLike {
  private cache = new Map<string, { addr: UpstreamAddr; expiresAt: number }>()
  constructor(private cfg: Config) {}

  /** The container's dialable address, or null when it is not running (or docker cannot say).
   *  Cached for `cfg.lanes.touchDebounceMs` (5 s): one resolve costs about 10 ms, so the TTL is
   *  free, and it bounds how long a stale entry can survive an unobserved restart. */
  async resolve(container: string, network: string, port: number): Promise<UpstreamAddr | null> {
    const key = keyOf(container, port)
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.addr
    const addr = await this.lookup(container, network, port)
    if (!addr) { this.cache.delete(key); return null }
    this.cache.set(key, { addr, expiresAt: Date.now() + this.cfg.lanes.touchDebounceMs })
    return addr
  }

  /** Drop every cached address of one container (called after every sleep, wake and dial error). */
  forget(container: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${container}#`)) this.cache.delete(key)
  }

  /** Drop the container's addresses when the id the sweep just saw is not the one they belong to. */
  forgetIfChanged(container: string, containerId: string): void {
    for (const [key, entry] of this.cache) {
      if (key.startsWith(`${container}#`) && entry.addr.containerId !== containerId) this.cache.delete(key)
    }
  }

  /** True when the address accepts a TCP connection and holds it. The socket is always destroyed. */
  async dial(container: string, network: string, port: number, timeoutMs = 1000): Promise<boolean> {
    const addr = await this.resolve(container, network, port)
    if (!addr) return false
    return new Promise((resolve) => {
      const s = netConnect({ host: addr.host, port: addr.port })
      let settled = false
      const done = (ok: boolean): void => { if (settled) return; settled = true; s.destroy(); resolve(ok) }
      s.setTimeout(timeoutMs, () => done(false))
      s.once('error', () => done(false))
      s.once('connect', () => {
        if (this.cfg.mode === 'server') { done(true); return }
        // local mode reaches docker-proxy, which accepts with nothing behind it and then hangs up
        const held = setTimeout(() => done(true), PROXY_HANGUP_MS)
        s.once('end', () => { clearTimeout(held); done(false) })
        s.once('close', () => { clearTimeout(held); done(false) })
      })
    })
  }

  /** One `docker inspect` for the IP, the id, the start time and whether it runs at all; local mode
   *  adds one `docker port` for the published loopback port. Any failure is a null answer: a
   *  container that is gone or unreadable has no address, which is exactly what the caller needs. */
  private async lookup(container: string, network: string, port: number): Promise<UpstreamAddr | null> {
    try {
      const fmt = `{{(index .NetworkSettings.Networks "${network}").IPAddress}}\t{{.Id}}\t{{.State.StartedAt}}\t{{.State.Running}}`
      const [ip, id, startedAt, running] = (await docker(['inspect', '-f', fmt, container])).toString().trim().split('\t')
      if (running !== 'true') return null
      if (this.cfg.mode === 'server') {
        if (!ip) return null
        return { host: ip, port, containerId: id ?? '', startedAt: startedAt ?? '' }
      }
      // Local mode: `docker port <c> <port>/tcp` prints one line per binding (`127.0.0.1:49154`,
      // and on some daemons an IPv6 twin); the first mapped port is the loopback one the adapters
      // asked for with `-p 127.0.0.1::<port>`.
      const line = (await docker(['port', container, `${port}/tcp`])).toString().trim().split('\n')[0] ?? ''
      const m = /:(\d+)$/.exec(line.trim())
      if (!m) return null
      return { host: '127.0.0.1', port: Number(m[1]), containerId: id ?? '', startedAt: startedAt ?? '' }
    } catch {
      return null
    }
  }
}
