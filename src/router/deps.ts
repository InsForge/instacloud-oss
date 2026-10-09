// The router's seams onto the rest of the daemon (contract 00 sections 8.1 and 8.2).
//
// `UpstreamLike` mirrors src/upstream.ts (WP3, decision 57) so this package compiles in a tree where
// the scheduler has not landed; TypeScript is structural, so WP3's `Upstream` satisfies it unchanged
// and the integrator points the import at src/upstream.ts when both are on the branch.
//
// `engineRouterDeps` reads the WP3 seams (touch, stateOf, beginHold, endHold) off the engine
// optionally: before WP3 lands every service reads `running`, stamps go nowhere and holds are
// counted by the router alone; after WP3 lands the same call sites drive the scheduler.
import { connect as netConnect } from 'node:net'
import type { Config } from '../config'
import { docker } from '../docker'
import type { ServiceKey } from '../types'
import type { Route } from './table'

export type ServiceState = 'running' | 'asleep' | 'stopped' | 'paused' | 'starting' | 'none'

export interface UpstreamAddr { host: string; port: number; containerId: string; startedAt: string }
export interface UpstreamLike {
  resolve(container: string, network: string, port: number): Promise<UpstreamAddr | null>
  forget(container: string): void
  forgetIfChanged(container: string, containerId: string): void
  dial(container: string, network: string, port: number, timeoutMs?: number): Promise<boolean>
}

/** What the router needs from the engine (WP3 members optional so the scaffold engine qualifies). */
export interface RouterEngine {
  wake(key: ServiceKey, opts: { door: 'traffic' | 'api' | 'deploy' }): Promise<void>
  ownsHostname(host: string): boolean
  touch?(key: ServiceKey): void
  stateOf?(key: ServiceKey): ServiceState
  beginHold?(key: ServiceKey): void
  endHold?(key: ServiceKey): void
}

export interface EngineRouterDeps {
  stateOf(route: Route): ServiceState
  wake(route: Route): Promise<void>
  touch(key: ServiceKey): void
  beginHold(key: ServiceKey): void
  endHold(key: ServiceKey): void
  ownsHostname(host: string): boolean
}

export function engineRouterDeps(engine: RouterEngine): EngineRouterDeps {
  return {
    // `none`, not `running`. The seam is optional (the scaffold engine predates WP3), and the
    // one consumer reads `!== 'running'` as "take the wake path", so a fallback of `running` made
    // an engine that cannot report state say the service is up: with a cached upstream address
    // the lane then dials straight past the wake. The fallback has to be a value that cannot
    // skip the wake, and the wake is the cheap side of the trade (it takes the operation lock,
    // re-reads the live container and no-ops when there is nothing to do).
    stateOf: (route) => engine.stateOf?.(route.key) ?? 'none',
    wake: (route) => engine.wake(route.key, { door: 'traffic' }),
    touch: (key) => engine.touch?.(key),
    beginHold: (key) => engine.beginHold?.(key),
    endHold: (key) => engine.endHold?.(key),
    ownsHostname: (host) => engine.ownsHostname(host),
  }
}

/** The ONE Upstream of decision 57 is built by main.ts in region WP3 (upstream) and shared with the
 *  scheduler; this reads it back off the engine when that region has landed and otherwise falls
 *  back to the docker-CLI twin below so a tree without WP3 still routes. The integrator replaces
 *  the call with the shared instance at merge 5 (09) and deletes `DockerCliUpstream`. */
export function routerUpstream(engine: object, cfg: Config): UpstreamLike {
  const shared = (engine as { upstream?: UpstreamLike }).upstream
  if (shared && typeof shared.resolve === 'function') return shared
  return new DockerCliUpstream(cfg)
}

/** Temporary twin of src/upstream.ts (WP3): server mode dials the container IP on the branch
 *  network from `docker inspect`; local mode dials the loopback port `docker port` reports. */
export class DockerCliUpstream implements UpstreamLike {
  private cache = new Map<string, { addr: UpstreamAddr; expiresAt: number }>()
  constructor(private cfg: Config) {}

  async resolve(container: string, network: string, port: number): Promise<UpstreamAddr | null> {
    const hit = this.cache.get(container)
    if (hit && hit.expiresAt > Date.now()) return hit.addr
    try {
      const fmt = `{{(index .NetworkSettings.Networks "${network}").IPAddress}}\t{{.Id}}\t{{.State.StartedAt}}\t{{.State.Running}}`
      const [ip, id, startedAt, running] = (await docker(['inspect', '-f', fmt, container])).toString().trim().split('\t')
      if (running !== 'true') return null
      let addr: UpstreamAddr
      if (this.cfg.mode === 'server') {
        if (!ip) return null
        addr = { host: ip, port, containerId: id, startedAt }
      } else {
        const line = (await docker(['port', container, `${port}/tcp`])).toString().trim().split('\n')[0] ?? ''
        const m = /:(\d+)$/.exec(line)
        if (!m) return null
        addr = { host: '127.0.0.1', port: Number(m[1]), containerId: id, startedAt }
      }
      this.cache.set(container, { addr, expiresAt: Date.now() + this.cfg.lanes.touchDebounceMs })
      return addr
    } catch { return null }
  }

  forget(container: string): void { this.cache.delete(container) }

  forgetIfChanged(container: string, containerId: string): void {
    const hit = this.cache.get(container)
    if (hit && hit.addr.containerId !== containerId) this.cache.delete(container)
  }

  async dial(container: string, network: string, port: number, timeoutMs = 1000): Promise<boolean> {
    const addr = await this.resolve(container, network, port)
    if (!addr) return false
    return new Promise((resolve) => {
      const s = netConnect({ host: addr.host, port: addr.port })
      const done = (ok: boolean): void => { s.destroy(); resolve(ok) }
      s.setTimeout(timeoutMs, () => done(false))
      s.once('connect', () => done(true))
      s.once('error', () => done(false))
    })
  }
}
