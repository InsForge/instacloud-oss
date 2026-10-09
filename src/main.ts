#!/usr/bin/env -S npx tsx
// instad: the InstaCloud OSS daemon. Local mode binds 127.0.0.1 (localhost trust; no OAuth) and the stock
// `insta` CLI reaches it via INSTA_API_URL=http://127.0.0.1:8080. Boot order per contract 00 §1.1 /
// 01 §1: every region marker below sits in its FINAL position; WP1 fills the bodies, nobody moves a
// marker, every other package adds lines only inside its own region.
import { buildServer } from './server'
import { Engine } from './engine'
import { LocalPostgres } from './adapters/postgres'
import { DockerCompute } from './adapters/compute'
import { LocalGarage } from './adapters/garage'
import { LocalManagedDb } from './adapters/manageddb'
import { docker } from './docker'
import { initHostArch } from './hostarch'
import { resetAdmin } from './auth'
import { loadConfig, type Config } from './config'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { MetricsSampler } from './metrics-sampler'
import { acquireLock, initStatePath, loadState, reclaimAbandonedReservations, releaseLock } from './state'
// ---- region WP4 (data dir) ----
import { capabilitiesLine, sharedDataDir } from './datadir'
// ---- end region WP4 ----
// ---- region WP3 (scheduler) ----
import { DockerRuntime } from './scheduler'
import { Upstream } from './upstream'
// ---- end region WP3 ----
// ---- region WP5 (templates/parity) ----
import { TemplateCatalog } from './templates/catalog'
// ---- end region WP5 ----
// ---- region WP2 (router) ----
import { laneReallocator, Router } from './router'
import { SuppliedCertWatch, suppliedFiles } from './router/certs'
import { engineRouterDeps, routerUpstream } from './router/deps'
import { buildTable } from './router/table'
// ---- end region WP2 ----

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Can this process bind that address? A throwaway listener on port 0, closed again straight away.
 *
 *  `os.networkInterfaces()` cannot answer the question, and answering it from there was wrong on
 *  every Linux box: libuv hides an interface that is UP but has no carrier, and docker0 has no
 *  carrier until the first container attaches to the default bridge. instad boots before any branch
 *  container exists, so the scan missed the gateway EVERY time on a fresh box, the extra listener
 *  was skipped for the life of the process, and every container then got ECONNREFUSED on its own
 *  DATABASE_URL and on every minted hostname. The kernel answers the question we actually mean. */
function canBind(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => { resolve(false) })
    probe.listen(0, ip, () => { probe.close(() => { resolve(true) }) })
  })
}

/** Local mode on Linux only: the docker bridge gateway, so a container started with
 *  `--add-host <name>:host-gateway` reaches the daemon's own listener. On Docker Desktop
 *  host.docker.internal already forwards to host loopback, so the list stays empty there. A failure
 *  is logged once and is never fatal (decision 3). */
async function bridgeGateway(cfg: Config): Promise<string[]> {
  if (cfg.mode !== 'local' || process.platform !== 'linux') return []
  try {
    const out = await docker(['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}'])
    const ip = out.toString('utf8').trim()
    if (ip && await canBind(ip)) return [ip]
    if (ip) {
      // instad itself in a bridge-networked container sees the HOST's gateway here, and that
      // address lives in the host's namespace: `listen` fails with EADDRNOTAVAIL, and because the
      // extra listener comes up before the boot finishes it would take the whole daemon with it.
      // Only the convenience path is lost; host.docker.internal still reaches us.
      console.warn(`warn: the docker bridge gateway ${ip} cannot be bound by this process; containers reach the daemon through host.docker.internal only`)
      return []
    }
  } catch { /* no bridge network, or a docker without that template: warn and carry on */ }
  console.warn('warn: could not read the docker bridge gateway; containers reach the daemon through host.docker.internal only')
  return []
}

async function main(): Promise<void> {
  // config (WP1: --reset-admin runs here and exits)
  let cfg = loadConfig()
  if (process.argv.includes('--reset-admin')) process.exit(resetAdmin(cfg))
  mkdirSync(cfg.dataDir, { recursive: true })
  // state path
  initStatePath(cfg.statePath)
  // lock (WP1: instad.lock in the data dir, 20 s heartbeat; a FRESH lock is retried for up to
  // 60 s so a compose restart whose predecessor was SIGKILLed still boots)
  acquireLock(cfg.dataDir)
  process.on('exit', releaseLock)
  // Holding the lock means no other daemon is running, so any reservation still standing belongs to
  // a create this process's predecessor was killed in the middle of. Drop those before serving:
  // otherwise the claim outlives its creator and every retry of that branch name, lane port or
  // hostname refuses as a duplicate for the life of the install.
  const reclaimed = reclaimAbandonedReservations()
  const reclaimedTotal = reclaimed.branches.length + reclaimed.lanes.length + reclaimed.hosts.length
  if (reclaimedTotal > 0) {
    console.warn(`warning: released ${reclaimedTotal} reservation(s) left by an interrupted create` +
      `${reclaimed.branches.length ? ` (branches: ${reclaimed.branches.join(', ')})` : ''}`)
  }
  // docker check. The same probe reads the daemon's architecture, which decides whether a
  // template's image can run here at all: dockerd is what pulls, so its answer is the authority,
  // not this process's. Appended to the existing format string rather than a second `docker`
  // call, and a blank second field just leaves the process-architecture fallback in place.
  try {
    const version = (await docker(['version', '--format', '{{.Server.Version}} {{.Server.Arch}}'])).toString().trim()
    initHostArch(version.split(/\s+/)[1] ?? null)
  }
  catch { console.error('error: Docker is required and must be running (InstaCloud OSS provisions branches as containers)'); process.exit(1) }
  // extraListenHosts (local + linux: the docker bridge gateway) on a frozen copy of cfg; the
  // primary listener stays cfg.listenHost and WP2's lanes bind the extras (decision 3).
  cfg = Object.freeze({ ...cfg, extraListenHosts: await bridgeGateway(cfg) })

  // ---- region WP4 (probe) ----
  // The data directory, plus one clone attempt to learn whether this filesystem reflinks. An
  // unwritable data dir is fatal; a filesystem that cannot clone costs one warning and slower forks
  // (decision 23). `INSTA_OSS_FORK=reflink` is the operator asking to fail instead.
  const data = sharedDataDir(cfg)
  const caps = await data.probe()
  if (cfg.data.fork === 'reflink' && !caps.reflink) {
    console.error(`error: INSTA_OSS_FORK=reflink but ${cfg.dataDir} does not support reflinks`)
    process.exit(1)
  }
  console.log(capabilitiesLine(cfg, caps))
  if (caps.warning) console.warn(`warning: ${caps.warning}`)
  // ---- end region WP4 (probe) ----
  // ---- region WP3 (upstream) ----
  // ONE Upstream for the whole daemon (decision 57): the runtime probes through it, the scheduler
  // invalidates it after every sleep and wake, and the router reads it back off the engine, so no
  // lane can dial an address the container no longer owns.
  const upstream = new Upstream(cfg)
  const runtime = new DockerRuntime(cfg, upstream)
  // ---- end region WP3 (upstream) ----
  // ---- region WP5 (catalog) ----
  // The bundled template registry. Reads no file until a route asks, so a missing or unreadable
  // templates directory costs an empty catalog rather than a failed boot.
  const templates = new TemplateCatalog(cfg.templatesDir)
  // ---- end region WP5 (catalog) ----

  const storage = new LocalGarage({ configPath: cfg.garageConfigPath, hostEndpoint: cfg.s3HostEndpoint, mode: cfg.mode, domain: cfg.domain })
  const engine = new Engine(new LocalPostgres(), new DockerCompute(), storage, new LocalManagedDb(), { cfg, templates, upstream, runtime })

  // ---- region WP4 (migrate) ----
  // One boot migration of installs that stored data in docker volumes, BEFORE the router and the
  // scheduler start (contract 1.1): it stops and re-creates containers, so nothing may be watching
  // them or waking them meanwhile. `booting` keeps the sleep sweep inert until it finishes.
  engine.setDataCapabilities(caps)
  engine.booting = true
  try { await engine.migrateLegacyData() }
  catch (e) { console.warn(`warning: data migration did not finish: ${e instanceof Error ? e.message : String(e)}`) }
  finally { engine.booting = false }
  // ---- end region WP4 (migrate) ----
  // ---- region WP5 (executor) ----
  // A `running` deployment record cannot have a live executor behind it after a restart: mark those
  // failed with the message that tells the operator a retry with the same deploymentId resumes.
  const abandoned = engine.executor.abandonStale()
  if (abandoned.length) console.warn(`warning: ${abandoned.length} template deployment(s) were interrupted by a restart; retry them with the same deploymentId`)
  // Best-effort repair of a legacy `io-<ref>-pg` container name for an install that skipped the
  // data migration above (which renames while it moves the bytes). A no-op otherwise.
  await engine.migrateLegacyContainers().catch((e) => {
    console.warn(`warning: could not rename a legacy postgres container: ${e instanceof Error ? e.message : String(e)}`)
  })
  // ---- end region WP5 (executor) ----
  // ---- region WP2 (router) ----
  // The router owns the node:http server; Fastify receives it through `serverFactory` and hands its
  // request handler back inside that call (`attach`), which is the only place Fastify exposes it.
  // Dispatch is by Host: daemon names to the API, minted names and custom domains to the HTTP lane
  // (decision 4). `engine.router = router` closes the loop, so every mutate that changes a hostname
  // or a lane rebuilds the table and reconciles the listeners.
  const router = new Router({
    cfg,
    table: () => buildTable(loadState(), cfg),
    upstream: routerUpstream(engine, cfg),
    reallocLane: laneReallocator(cfg, () => engine.allocLanePort()),
    ...engineRouterDeps(engine),
  })
  engine.router = router
  // ---- end region WP2 (router) ----

  // One watch: `/healthz` answers from it and the beat below refreshes it, so the public
  // endpoint never reads the file itself.
  const certWatch = new SuppliedCertWatch(suppliedFiles(cfg)?.crt ?? null)
  const app = buildServer(engine, cfg, { certWatch, serverFactory: (handler) => { router.attach(handler); return router.httpServer } })
  await app.listen({ host: cfg.listenHost, port: cfg.port })

  // ---- region WP2 (start) ----
  // Extra listeners come up only after the primary one is bound: a lane that answers before the API
  // does would hold a wake against a daemon that cannot serve it.
  await router.start()
  // ---- end region WP2 (start) ----
  // ---- region WP3 (start) ----
  // Last: the boot reconcile stamps every service with a full idle window and the ticker begins.
  // After the lanes, so a wake it triggers has somewhere to answer (and after the data migration,
  // which `engine.booting` kept the sweep out of).
  engine.scheduler.start()
  // ---- end region WP3 (start) ----
  // CPU, memory and network history for the dashboard's 1h / 6h / 24h / 3d charts: `docker stats`
  // is a reading of now, so the daemon samples it every 30 s and keeps 3 days on disk.
  const metricsSampler = new MetricsSampler(engine.metricsHistory, {
    file: join(cfg.dataDir, 'metrics-history.json'),
    log: (message) => console.warn(`warning: ${message}`),
  })
  metricsSampler.start()

  // A supplied certificate (`--tls custom`) is the one certificate in this stack that nothing
  // renews, so it is the one whose expiry would otherwise be announced by a browser. Said at
  // boot and then on the sweep's own beat, and only when it is close: the number itself is on
  // `healthz` unconditionally for a monitor to read. This starts nothing and changes nothing.
  if (suppliedFiles(cfg)) {
    certWatch.maybeWarn()
    // This beat is also what `/healthz` answers from: the request path reads no file and makes
    // no syscall, so an unauthenticated poll costs nothing however fast it comes, and the
    // reported certificate follows a renewal within one interval.
    const timer = setInterval(() => { certWatch.refresh(); certWatch.maybeWarn() }, cfg.sleep.sweepSec * 1000)
    timer.unref?.()
  }
  // The same beat moves the database lanes' no-SNI default onto a renewed certificate. Without it
  // that default was whatever the process booted with until a route happened to change, so an
  // old libpq or JDBC client got an opaque alert after the original expired instead of being told
  // to send SNI. Every mode: Caddy renews an ACME `api.` certificate too.
  if (cfg.mode === 'server') {
    const certTimer = setInterval(() => { void router.refreshCertificates() }, cfg.sleep.sweepSec * 1000)
    certTimer.unref?.()
  }

  if (cfg.mode === 'server') {
    console.log(`instad ${cfg.version} mode=server api=${cfg.apiUrl} console=${cfg.consoleUrl} data=${cfg.dataDir}`)
    if (!loadState().identity?.admin) console.log(`setup: ${cfg.consoleUrl}/setup`)
  } else {
    console.log(`InstaCloud OSS daemon listening on http://${cfg.listenHost}:${cfg.port}`)
    console.log('point the insta CLI here (this is its default):')
    console.log('  insta project create <name>   # then branch/deploy/secrets/manifest as usual')
  }
  // ---- region WP6 ----
  // version banner: server mode only (the image bakes INSTA_OSS_VERSION; instad.env sets the tag the
  // stack runs). Local mode prints nothing extra so `npm run dev` output stays byte-identical.
  if (cfg.mode === 'server') {
    console.log(`instacloud image ${cfg.version}: re-run install.sh to upgrade (add --version vX.Y.Z to pin); templates ${cfg.templatesDir}`)
  }
  // ---- end region WP6 ----

  // signals: shut down inside the compose stop_grace_period (30 s) and never leave a fresh lock
  // behind. Order matters: stop accepting traffic, then the scheduler, then a BOUNDED app.close()
  // (SSE, WebSocket and pg splices share these sockets, so an unbounded close could outlast the
  // grace, get SIGKILLed, skip releaseLock and make the replacement container refuse the lock).
  let stopping = false
  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    // ---- region WP2 (stop) ----
    // The lanes stop accepting first: a lane socket spliced to a container would otherwise outlive
    // the bounded app.close() below.
    await router.stop()
    // ---- end region WP2 (stop) ----
    // ---- region WP3 (stop) ----
    // After the lanes, before app.close(): the ticker stops and an in-flight sweep is awaited, so
    // no `docker stop` is left running into the compose grace. BOUNDED, like app.close() below: a
    // sweep can be holding four docker stops with a 30 s database grace each, which would blow the
    // compose stop_grace_period, and a SIGKILL there skips releaseLock() and leaves the replacement
    // container refusing the lock. stop() clears the ticker synchronously, and docker finishes the
    // stops it already started on its own.
    await Promise.race([engine.scheduler.stop(), sleep(5_000)])
    // ---- end region WP3 (stop) ----
    // Save the metrics history, bounded like the scheduler: a tick in progress waits on docker.
    await Promise.race([metricsSampler.stop(), sleep(5_000)])
    await Promise.race([app.close(), sleep(10_000)])
    releaseLock()
    process.exit(0)
  }
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
