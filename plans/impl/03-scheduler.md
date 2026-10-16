# 03 WP3: scheduler and lifecycle (sleep, wake, eviction, always-on, limits, upstream discovery)

Contract: `00-contract.md` sections 3 (`sleep`), 4 (regions WP3), 7.1 (WP3), 8.1, 8.3, 9 (WP3 rows), 13. Design source: `designs/wp3.json`, adjusted to decisions 6, 10, 11, 12, 13, 14, 15, 39, 42, 48. Merge position: after WP4, before WP2.

## Scope

- `src/scheduler.ts`: in-memory activity ledger keyed by `ServiceKey`, the 30 s sweep with the cloud's conditions, memory-pressure eviction, sleep = `docker stop -t <grace>`, wake = `docker start` + readiness behind a singleflight and an op-in-flight set, boot reconcile, `Runtime` seam (`DockerRuntime` in prod, `FakeRuntime` in tests).
- `src/upstream.ts`: container address discovery (`docker inspect` IP in server mode, `docker port` in local mode) with a short-TTL cache keyed on the container id, `forget`, `forgetIfChanged` and `dial`; exported as `interface UpstreamLike` plus the `Upstream` class (decision 57); ONE instance is shared by `DockerRuntime`, the scheduler and the router (WP2) later, so `forget` from a sleep or wake invalidates the router's cache.
- Engine: service keys and targets, `wake/sleep/touch/stateOf/withOp`, the view mapping (services `runtime`, state route, runtime-health), `PUT always-on`, `GET/PUT limits`, `PATCH database/settings` (`scaleToZero`, `idleTimeout`, `cpu`, `memory`), new branches start asleep, `ensurePgAwake`/`assertPgAwake` around `db.query`.
- `service.upgrade` gated action: already in `GATED_ACTIONS` and `govern.ts` DEFAULTS since the scaffold (00 §1.1; the typed `Record<GatedAction, Decision>` forced it); WP3 adds the routes that gate on it and verifies `GET /policy` lists it.

No new dependency.

## Files

Owned: `src/scheduler.ts`, `src/upstream.ts`, `test/scheduler.test.ts`, `test/upstream.test.ts`, `test/sleep-wake.int.test.ts`.

Shared (append in region): `src/engine.ts` region WP3 + edit points (`deployLocked` limits/start/afterDeploy, `createBranch` withOp/startAsleep/sleepNewBranch, `provisionBranch` `scheduler.register`, `lifecycleLocked`, `liveState` (body becomes `scheduler.stateOf(key)` mapped by contract §13; the adapter call goes away, decision 53), `services()` `rowRuntime`/`always_on`, `runtimeHealth()` `healthOverlay`, db.query callers, `dbInstance`/`dbSettings`, teardown `scheduler.forget`; the hook bodies already exist as identities from the scaffold); `src/server.ts` region C (delete the limits/always-on 501 stubs the scaffold moved into region C and add GET/PUT limits and PUT always-on; each `/services/:sid/*` route resolves its branch with WP5's `resolveSid(req)` (decision 49: a `<branchId>:<serviceId>` id names the branch, else `?branch`, else the default) and passes the BARE serviceId to `setAlwaysOn`/`serviceLimits`/`setServiceLimits`, whose `serviceSettings` keys are project-level; the existing state and start/stop/suspend/restart routes already go through `resolveSid` when WP3 lands; the two named in-place edits of contract 1.2: extend the `PATCH database/settings` body parse and map `/sleeping/` to 503 in `obsCode`); `src/types.ts` region WP3 (scaffold has it; WP3 DELETES `ComputeAdapter.state`); `src/govern.ts` (nothing to add: `'service.upgrade': 'allow'` landed with the scaffold, verify only); `src/adapters/compute.ts` at its `// ---- args WP3 ----` line (`--init` so docker's tini forwards SIGTERM to an app behind a shell PID 1, decision 60; `--cpus`, `--memory <mb>m`, `--memory-swap <mb>m` when `limits`; `stop(ref, group, { graceSec })` -> `docker stop -t`; the `state()` method is deleted); `src/adapters/postgres.ts` and `manageddb.ts` at their `// ---- args WP3 ----` lines (limits flags on run); `src/main.ts` regions `WP3 (upstream)` before the engine (`upstream = new Upstream(cfg)`, `runtime = new DockerRuntime(cfg, upstream)`, both passed into `new Engine(..., { cfg, upstream, ... })`; the engine builds `new Scheduler(runtime, cfg, () => this.serviceTargets(), hooks, upstream)` unstarted as its `EngineOptions.scheduler` default, contract §7), `WP3 (start)` after listen (`engine.scheduler.start()`), `WP3 (stop)` on signals AFTER `router.stop()`; `test/server.test.ts` region WP3 plus the allowed existing-assertion edit at lines 475-489 (`state: 'running'` after a stop becomes `state: 'stopped'`, because the fake now reports the real store); `test/fakes.ts` region WP3 (`FakeRuntime` as the single fake state store, `FakeUpstream`, `makeEngine` wiring an unstarted scheduler on both; the fake compute adapter's `deploy/start/stop/suspend/destroy` update `FakeRuntime.containers` and its `state` member is deleted; `compute.stop` records `graceSec`; `deploy.limits` recorder).

## Algorithm

### Definitions

- `key = ${branchId}:${serviceId}`; `target = engine.targetOf(key)` per contract 8.3 `ServiceTarget`.
- Containers: `cp-<g>` -> `io-<ref>-app-<g>` (port `apps[g].port`), `pg-<name>` -> `databases[id].container` (5432), managed -> `managedContainerName` (catalog port).
- `idleSec(target)`: compute `cfg.sleep.idleComputeSec`; postgres `databases[id].idleTimeoutSec ?? cfg.sleep.idleDbSec`; managed `cfg.sleep.idleDbSec`; 0 = never swept.
- `alwaysOn(target)`: compute/managed `project.serviceSettings[sid]?.alwaysOn ?? cfg.sleep.alwaysOnDefault`; postgres `!(databases[id].scaleToZero ?? true)`.
- Ledger: `Map<ServiceKey, { lastActiveAt; wokeAt?; lastRssBytes? }>`, in memory only. There is NO `createdAt` in the ledger: the create grace reads `target.createdAt` (the row's creation time, decision 10), otherwise every daemon restart would hand every running service a fresh 10-minute grace on top of its idle window. `sleptAt` is read from and written to state through `hooks.markSlept(key, at)` (an audit-class write, decision 54).
- `ops: Map<key, { chain: Promise<void>; count: number; done: Promise<void> }>`: the per-key OPERATION LOCK (decision 52). `chain` is the exclusive queue (`withOp` appends `fn` to the chain of every key it names, in sorted key order, and runs `fn` once every chain has reached it); `count` = holders plus waiters (the sweep's "in flight" test); `done` settles when `count` returns to 0. `owned = new AsyncLocalStorage<Set<ServiceKey>>()`: `withOp` runs `fn` inside `owned.run(new Set([...inherited, ...keys]))` and skips keys the current async context already owns, so nested calls (`lifecycle start` -> `wake`, `createBranch` -> `deployLocked` -> `wake(srcKey)`, `ensurePgAwake` -> `wake` -> `db.query`) re-enter without a second acquisition. `tryWithOp(keys, fn)` returns `null` without touching the chain when any key has `count > 0`. `wakes: Map<key, Promise>` (singleflight), `holds: Map<key, number>` (router in-flight requests and splices via `beginHold/endHold`), `stateCache: Map<container, { state; id }>`, `sleeping: Set<key>` (set while a sleep holds the lock; `stateOf` reads it).

### Stamp writers

`touch(key)`: `rec.lastActiveAt = now()` (register on first sight). `onUp(key)`: stamp, `wokeAt = now`, `markSlept(key, null)`, `stateCache = running`, `upstream.forget(container)`. `onAsleep(key, reason)`: `markSlept(key, now)`, `stateCache = exited|created`, `upstream.forget`. `onStopped(key)`: `markSlept(key, null)` (a user stop is not sleep), `stateCache = exited`. `onPaused(key)`: `stateCache = paused`. `register(key)`: `lastActiveAt = now` when absent (the ready stamp; nothing else). `forget(keys)`, `rekey(from, to)`.

### Boot reconcile (`start()`)

1. `targets = targets()`; `containers = runtime.containers()`.
2. Every target gets `register(key)` (a full idle window after a restart, the cloud's ready stamp; the create grace is NOT reset because it comes from the row). Target with `sleptAt` set but a running container -> `markSlept(null)` + stamp. Exited without `sleptAt` stays as is (reads crashed or stopped).
3. `runtime.memory() === null` -> log once `memory-pressure eviction disabled (no /proc/meminfo and no INSTA_OSS_MEM_BUDGET_MB)`.
4. `if (cfg.sleep.enabled) setInterval(sweep, sweepSec*1000).unref()`; a tick is skipped while a sweep runs. NO pressure pass at boot: the first one runs on the first sweep tick, after `docker stats` has a sample and stamps have had a window (a boot pass with every `lastActiveAt` equal to boot time would stop arbitrary running services on a busy box). The sweep is inert while `engine.booting` (WP4 migration).

### Sweep

1. `containers = runtime.containers()` (`{ state, id }` per name); `stateCache = containers`; for every container whose `id` differs from the cached one call `upstream.forgetIfChanged(name, id)` (a self-restarted container may hold a new IP); `rss = runtime.stats()` when anything runs; record `lastRssBytes`.
2. Candidates: `containers.get(container)?.state === 'running'`, `!alwaysOn`, `desiredState === 'running'`, `idleSec > 0 && now - lastActiveAt >= idleSec*1000`, `now - target.createdAt >= createGraceSec*1000`, no op/wake/sleep in flight.
3. `sleep(key, 'idle')` oldest stamp first, concurrency 4; errors logged, retried next pass.
4. `evictForRoom(0, new Set())`.

### sleep(key, reason) -> boolean

`tryWithOp([key], body)` (decision 52): the key held or queued by a deploy, lifecycle op, wake or another sleep -> `false` immediately (a stop never queues behind a deploy; by the time it ran the container would be the one just deployed). Inside `body`, holding the lock: `sleeping.add(key)` FIRST (so `stateOf` reports `asleep` and a wake that arrives now queues behind this stop and then starts the container, instead of dialling a stopping one); `state = live containers().get(container)?.state` (re-read under the lock): `paused` -> false; not running: `created` -> `onAsleep` (a never-started clone) and true, else false; running -> `runtime.stop(container, reason === 'memory' ? stopGraceSec : kind === 'compute' ? stopGraceSec : stopGraceDbSec)`; `onAsleep(key, reason)`; `hooks.emit(key, 'service.sleep', { service, branch, reason })` (`service` = the bare serviceId, `branch` = the branch name); true. `finally sleeping.delete(key)`. `desiredState` untouched.

### evictForRoom(needBytes, exclude)

`mem = runtime.memory()`; null -> return. `floor = total * ramFloorPct / 100`. While `available - needBytes < floor`: pool = running, `!alwaysOn`, desired running, not paused, not excluded, nothing in flight, AND all of these HARD guards (never preferences): `now - wokeAt >= wakeProtectSec*1000` (a just-woken service is never the victim, so two services that do not fit together cannot ping-pong on every request), `holds(key) === 0` (no in-flight HTTP request or TCP splice), `now - lastActiveAt >= 2 * touchDebounceMs` (nothing stamped in the last 10 s: a service under load is not a victim even below the floor); empty pool -> log once per sweep and return (the wake proceeds; the kernel is the last resort); victim = oldest `lastActiveAt` (tie: larger RSS); `sleep(victim, 'memory')` (compute stop grace); re-read `mem`.

### wake(key, { door })

1. No target -> NotFound. `door === 'traffic' && kind === 'compute' && desiredState !== 'running'` -> `ServiceStoppedError('service is stopped')`.
2. Singleflight: existing promise in `wakes` -> return it; else `wakes.set(key, withOp([key], body))` (BLOCKING acquisition of the per-key lock, decision 52: a deploy's `docker rm -f` + `docker create`, a lifecycle op or a `docker stop` in flight on the same container name finishes first; re-entrant when the caller already owns the key, e.g. `lifecycle start` or `ensurePgAwake`). Steps 3 to 5 run inside `body`, holding the lock.
3. Re-read `target = targets().find(key)` (removed -> NotFound; door and desiredState re-checked) and `state = live containers().get(container)?.state`: `undefined` (absent from `docker ps -a`) -> throw `NoContainerError('service has no container (deploy in progress or removed)')`, never `runtime.start`; `running` and `probe` true -> `touch` (and `markSlept(null)` if set), done (a deploy that just ended in `onUp` makes the wake a no-op); `paused` (door api only) -> `unpause`; `exited|created|dead` -> `need = lastRssBytes ?? limits?.memoryMb*MiB ?? DEFAULT_RSS[kind]` (compute 256 MiB, postgres 128 MiB, managed 256 MiB), then `Promise.all([evictForRoom(need, {key}), runtime.start(container)])` (the victim's `docker stop` no longer adds its grace to the hold; `evictForRoom` uses `tryWithOp` per victim, so it never blocks on a held key); `restarting` -> readiness.
4. Readiness: every 250 ms `runtime.probe(target)`; container `exited|dead` mid-wake -> `Error('service exited during wake')`; deadline `wakeTimeoutSec` -> `WakeTimeoutError` (container left running). `probe`: postgres `docker exec <c> pg_isready -h 127.0.0.1 -U postgres -d app`; others `upstream.dial(container, network, port, 1000)`.
5. `onUp(key)`; `emit('service.wake', { service, branch, door, ms })` (`service` = bare serviceId); finally `wakes.delete(key)` (the lock releases when `body` settles).

`stateOf(key)`: `sleeping.has(key)` -> `asleep` (deterministic: the lanes take the wake path, which queues behind the stop, instead of dialling a stopping container); `wakes.has(key)` -> `starting`; else the §13 mapping over `stateCache`, `sleptAt`, `desiredState`. A key whose lock is held by a deploy reports the cached docker state (the deploy's `afterDeploy` updates it), and a wake arriving then queues behind the deploy.

### Op bookkeeping

`engine.withOp(keys, fn)` = `scheduler.withOp(keys, fn)` and is THE mutual exclusion for container work (decision 52): it wraps `deployLocked` (cp key; `deploy()`/`restart()` call `withOp([key], () => this.deployLocked(...))` where today they call `serialize(${b.id}:${group})`, and the scaffold's `withOp` body IS that serialize chain per key until WP3 lands), `lifecycleLocked`, `restartLocked`, `createBranch` (all keys of both branches; the new branch's id is minted BEFORE `provisionBranch`, 05 §4, so `keysOf(new)` is computable here), `destroyBranch/destroyProject`, managed/db/storage service add/remove/rename (keys of the service on every branch), volume ops, the `ensurePgAwake` callers for the duration of the query, `setServiceLimits`. Semantics: keys are de-duplicated and sorted before acquisition (no deadlock between multi-key ops); a key already owned by the current async context (`owned` AsyncLocalStorage) is skipped (re-entrancy: `lifecycle start` -> `wake`, `createBranch` -> `deployLocked` -> `wake(srcKey, door api)` from the fork's `ensureSourceRunning`, `ensurePgAwake` -> `wake` -> `db.query`); `ops[key].count` covers holders and waiters (the sweep's in-flight test and `tryWithOp`'s refusal); `done` settles at 0. The scheduler's own `wake` takes the lock blocking and `sleep`/`evictForRoom` non-blocking, so the router (which never takes it: `deps.wake` does) is fenced against deploys, lifecycle ops and stops, and the sweep never stops a container mid-op. The engine's `serialize()` helper survives only for the engine-wide `serialize('provision')` chain of decision 51 (reservations), which is not per key. The full transition table is contract §13.

### New branch starts asleep

In `createBranch` (WP5's skeleton calls the hooks): `provisionBranch` brings pg + managed up; compute clones deploy with `startAsleep: this.startAsleepFor(project, target, group)`, whose scaffold body is `false` and whose WP3 body is `!effectiveAlwaysOn(project, target, 'cp-' + group)` (`start: false`, `afterDeploy` -> `onAsleep(key, 'branch-create')`); `sleepNewBranch` sleeps pg and managed keys unless always-on; the scaffold's `SchedulerLike` stub (`register/forget/rekey`) becomes the real `Scheduler`. New records have `createdAt = now`.

### View mapping

Implemented once in `rowRuntime(key)` / `liveState(key)` / `healthOverlay` per the contract section 13 table, ALL reading `scheduler.stateOf(key)`; `Runtime.containers()` is the single docker read (decision 53). `services()` drops the `docker ps` read at engine.ts:426; `liveState` drops the `compute.state` call (engine.ts:709-710) and `ComputeAdapter.state` is deleted from the interface and the fakes; rows gain `always_on` (compute + managed) and `runtime: 'asleep'`. Consequence for the existing suite: after `compute.stop` the fake store reports `exited` with no `sleptAt`, so `test/server.test.ts:475-489` expects `state: 'stopped'` where it expected `state: 'running'` (the fake used to lie); this is WP3's listed existing-assertion edit.

### Limits

`validate(memoryMb, cpu?)`: `cpu ?? SHARED_CPU_LADDER.find(c => memoryMb <= c*2048)` (none -> 400 `no vCPU size can carry N MB of memory`); cpu in `[1,2,4,6,8]`; `memoryMb` integer multiple of 256 within `[256*cpu, 2048*cpu]` (messages from specs.ts:131-141 with `to` instead of the dash); raising past `8 / 8192` -> 400 `limits exceed this plan's ceiling (8 vCPU / 8192 MB)`. Apply `runtime.update(container, limits)` = `docker update --cpus <cpu> --memory <mb>m --memory-swap <mb>m` on every branch container of the service (legal on created/exited); any failure -> 502 `resize failed on the compute provider: <reason> (applied to k/n machines; the stored ceiling is unchanged)`; success -> persist `project.serviceSettings[sid].limits`; `changed` drives the `service.limits` event. `GET limits` unset -> effective host ceiling snapped to the grid (`cpu = largest ladder value <= min(8, os.cpus().length)`, `memoryMb = min(8192, floor(totalmem/256MiB)*256)` clamped to the band); `cap = { cpu: 8, memoryMb: 8192, volumeGib: 100 }`; `volume` when `computeVolumes[group]` exists. Postgres via `PATCH database/settings { cpu: '2'|'2500m', memory: '4Gi'|'2048Mi' }`: parse quantities (cpu ceil to the ladder, memory to MB), same grid, persist `databases[id].limits`, `runtime.update(container)`.

### Always-on

`setAlwaysOn(projectId, sid, enabled)`: `serviceOf(sid).type` compute or managed else 400 `alwaysOn is only supported for compute and managed database services`; persist `serviceSettings[sid].alwaysOn`; emit `service.alwaysOn`; no container action; return `{ service: row }`. Postgres: `PATCH database/settings { scaleToZero }` persists `databases[id].scaleToZero`; `dbInstance` echoes `scaleToZero` and `idleTimeoutSecs`.

### Observability never wakes

`dbMetricsSnapshot`, `dbActivity`, `dbQueryStats`, `dbInsight` call `assertPgAwake` first: `stateOf(pgKey) !== 'running'` -> throw `database is sleeping: it wakes on the next connection`; `server.ts` `obsCode` maps `/sleeping/` -> 503. Management calls (`dbSetPassword`, `dbListDatabases`, `dbCreateDatabase`, `dbDeleteDatabase`, `dbExtensions`, `dbPatchExtensions`) call `ensurePgAwake` (door `api`).

### `src/upstream.ts`

`export interface UpstreamLike { resolve; forget; forgetIfChanged; dial }` and `export class Upstream implements UpstreamLike` (decision 57). `resolve(container, network, port)`: server `docker inspect -f '{{(index .NetworkSettings.Networks "<net>").IPAddress}}\t{{.Id}}\t{{.State.StartedAt}}' <c>` (empty/error -> null); local `docker port <c> <port>/tcp` -> `127.0.0.1:<n>` plus the same inspect for id and startedAt (error/empty -> null). Cache per container with `expiresAt = now + cfg.lanes.touchDebounceMs` (5 s; resolve costs about 10 ms, so the TTL is unmeasurable) and the `containerId`; `forget(container)`; `forgetIfChanged(container, id)` drops the entry when the cached id differs (the sweep calls it from `docker ps -a`'s `{{.ID}}` column). Why: on a user-defined bridge a container that restarts by itself (`--restart unless-stopped` after a crash, `docker restart`) can get a new IP and its old IP can be handed to another container on the same network (Garage joins every branch network), and a fork inherits its source's password, so a stale address could splice a `feat` client into `main`'s postgres and authenticate. `dial(container, network, port, timeoutMs = 1000)`: resolve (null -> false), `net.connect`, true on connect, false on error/timeout, always destroy.

### DockerRuntime

`new DockerRuntime(cfg, upstream: UpstreamLike)`. `containers`: `docker ps -a --format '{{.Names}}\t{{.State}}\t{{.ID}}'` -> `Map<name, { state, id }>`. `stats`: `docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}'` parsed with `observe.parseSize`. `memory`: `cfg.sleep.memBudgetMb` when set (available = budget minus summed RSS of running `io-*` containers) else `/proc/meminfo` `MemAvailable`/`MemTotal`; ENOENT -> null. `start/stop/unpause/update` as named. `probe` uses the injected `upstream.dial`. Every docker call wrapped in a 20 s timeout; the sweep skips the tick on timeout.

## Tests

`test/scheduler.test.ts` (FakeRuntime, fake timers):
- `sweep table: each of running, alwaysOn, desiredState, stamp age, create grace, op/wake/sleep in flight flips the outcome independently`
- `windows: compute 300 s, pg 600 s, managed 600 s, per-database idleTimeoutSec override, 0 disables; a service sleeps between 300 and 330 s after its last stamp`
- `touch resets the clock; onUp stamps and clears sleptAt through hooks.markSlept`
- `wake singleflight: 25 concurrent wake() calls -> one runtime.start; all resolve after the probe flips true`
- `wake refuses door traffic for desiredState stopped/suspended with ServiceStoppedError; door api proceeds`
- `wake timeout -> WakeTimeoutError, container left running, sleptAt untouched; container exiting mid-wake -> error`
- `eviction: LRU by lastActiveAt; skips alwaysOn, paused, user-stopped, in-flight, excluded, held (holds > 0); stops once available-need >= floor; memory() null disables; memBudgetMb synthetic total works`
- `eviction hard guards: two services that do not fit together do not ping-pong within wakeProtectSec (the second wake proceeds with an empty pool and a log line, no stop); a service stamped 3 s ago is never a victim; a key with holds > 0 is never a victim`
- `boot performs no eviction: start() with memory below the floor issues no runtime.stop until the first sweep tick`
- `create grace comes from the row: a target with createdAt 20 min ago sleeps one idle window after a boot reconcile, not create grace + window; a target created 1 min ago is not swept`
- `wake needs room: evictForRoom and runtime.start run concurrently (start is called before the victim's stop resolves)`
- `wake during sleep queues behind the stop (runtime.start is called only after runtime.stop resolves), then starts; stateOf reports asleep while the sleep holds the lock`
- `wake during withOp waits for the op and does not call runtime.start when the op ended in onUp (deploy replaced the container and it runs); when the op left a created container (startAsleep) the wake starts it; a container absent from containers() after the lock is taken throws NoContainerError and never calls runtime.start`
- `deploy or lifecycle op arriving during a wake (withOp on the same key) runs only after the wake settles; sleep() during a held key returns false without queueing (tryWithOp) and the sweep candidate filter skips a key with count > 0`
- `re-entrancy: withOp([k], () => wake(k)) and withOp([a, b], () => withOp([b], fn)) run fn once and never deadlock; two multi-key ops on {a, b} and {b, a} acquire in sorted order and complete`
- `hooks.emit for service.sleep and service.wake carries the bare serviceId, never the branch-qualified form`
- `boot reconcile: running container with sleptAt -> cleared; unknown keys registered with a fresh idle window; booting=true makes the sweep inert`
- `rekey/forget move and drop records`
- `sleep on a created container marks asleep without docker stop; sleep on paused returns false`
- `sweep calls upstream.forgetIfChanged for a container whose id changed between ticks`

`test/upstream.test.ts` (docker mocked, fake timers): `server mode resolves the network IP, id and startedAt from one inspect; local mode parses docker port; not running -> null; forget invalidates; an entry expires after the TTL (5 s) and re-resolves; forgetIfChanged drops the entry only when the id differs; dial returns false on refused`.

`test/server.test.ts` region WP3 (FakeRuntime-backed scheduler, ticker not started):
- `PUT always-on -> 200 {service.always_on:true}; 400 for pg-db and st-store; 404 unknown; event service.alwaysOn recorded; PUT /services/<featId>:cp-web/limits and always-on (the id GET /services?branch=feat returned) write serviceSettings['cp-web'] (bare key) and apply runtime.update to every branch container (decision 49)`
- `services rows carry always_on on compute and managed rows only`
- `GET limits: shape with cap 8/8192/100 and volume when attached; PUT limits derives cpu; 400 for cpu 3, memoryMb 300, 8192 on 1 vCPU, over-cap raise; runtime.update called once per branch container with exact args; 502 and stored value unchanged when one update fails; 202 when policy service.upgrade=approve then approve -> 200; no event on a no-op re-submit`
- `GET /policy lists service.upgrade`
- `after scheduler.sleep: GET state {desiredState:'running', state:'suspended'}, services runtime 'asleep', runtime-health 'standby'; after user stop 'stopped'; exited without sleptAt -> runtime-health 'crashed'`
- `start verb on an asleep service calls runtime.start + probe and lands runtime 'online'`
- `branch create: non-alwaysOn compute clone deployed with start:false (deploy.nostart recorded) and reads asleep; pg and managed slept with reason branch-create; alwaysOn services stay running`
- `db management routes (databases, extensions, password) wake an asleep pg first (runtime.start recorded before db.query); db metrics/activity/query-stats/insight on a sleeping pg -> 503 /sleeping/ and no db.query`
- `PATCH database/settings {scaleToZero:false, idleTimeout:120} persisted and echoed by GET database/instance; cpu/memory quantities validated on the grid`
- existing lifecycle tests (lines 475-662) green with exactly one allowed edit: lines 475-489 expect `state: 'stopped'` (not `'running'`) after `compute stop`, because `liveState` now reads the FakeRuntime store the fake `compute.stop` updates (decision 53)
- two further existing-assertion edits WP3 made, recorded here because the tree carries them: the
  services row `db.runtime` moves from `'stopped'` to `'online'` (both the routes and the scheduler
  read ONE FakeRuntime store, decision 53, contract:590), and `GET /projects/:id/database/instance`
  answers host `127.0.0.1` with a lane port and a `routeKey` instead of host `io-demo-main-pg`
  (`dbInstance` reads `laneAddress`, contract:759 and :595), the `?group=analytics` variant included
- the local-mode startup banner is FOUR lines, not three: WP4's data-dir capabilities line
  (`data dir <path> reflink=... engine=... mode=local`) prints before the three CLI lines, and on a
  box with no `/proc/meminfo` and no `INSTA_OSS_MEM_BUDGET_MB` the boot reconcile adds one warning
  after them (suppressed when `INSTA_OSS_RAM_FLOOR_PCT=0`, where eviction is off by request)

`test/restart-policy.test.ts`: `provision/deploy carry --cpus/--memory/--memory-swap when limits are given and none when absent; compute create carries --init; stop passes -t <grace>`.

`test/sleep-wake.int.test.ts` (integrator only, names `sleepint-`): postgres container: write a row, `scheduler.sleep` -> state exited and the log tail contains `database system is shut down`; `wake` -> `pg_isready` within 15 s, row present. `nginx:alpine` created with `start:false`, wake -> running and port probe true within 5 s. `docker update --cpus 2 --memory 512m` lands in `HostConfig.NanoCpus` and `Memory` on a stopped container. Sleep of a running nginx with grace 10 completes under 2 s.

## Done when

- [ ] All suites above green; existing Docker suites run with `INSTA_OSS_SCHEDULER=0` (ticker off; the idle knobs alone leave the pressure pass running, which on a low-RAM runner stops the containers under test) and stay green; `test/sleep-wake.int.test.ts` runs the ticker with `INSTA_OSS_RAM_FLOOR_PCT=0` except its eviction case (`INSTA_OSS_MEM_BUDGET_MB`).
- [ ] Local mode: deploy `traefik/whoami`, wait 5.5 min with `INSTA_OSS_IDLE_COMPUTE_SEC=300`, `docker ps` shows the container exited (never paused); `insta compute status` shows `desired=running` and not `live=running`; `insta compute start` wakes it; `insta compute stop` then `start` behave as today.
- [ ] `insta compute always-on on web` and `insta compute limits web --memory 512mb` work against the daemon; `docker inspect` shows `HostConfig.Memory` 536870912.
- [ ] 501 sweep in `test/server.test.ts:218` updated by deleting exactly the limits and always-on rows.
- [ ] Docs facts handed to WP8.

## Docs facts for WP8

- Idle rules copied from the cloud: stamp at request start and every 5 s while a handler runs; every non-empty read on a database connection; nothing else counts (CPU, outbound, disk). Sweep every 30 s; defaults 5 min compute, 10 min databases; create grace 10 min; a service sleeps 5 to 5.5 min after its last request.
- Memory pressure: least recently active non-always-on service sleeps first when free RAM drops below 15 percent or a wake needs room; a service woken in the last 60 s, one that answered a request in the last 10 s, or one with a request or connection in flight is never the victim; `INSTA_OSS_RAM_FLOOR_PCT`; disabled on macOS local mode (no /proc/meminfo) unless `INSTA_OSS_MEM_BUDGET_MB` is set. A daemon restart does not restart the 10-minute create grace.
- Sleep is `docker stop` with a 10 s grace (30 s for databases); apps get SIGTERM through docker's `--init` (tini) even when their entrypoint is a shell, then SIGKILL after the grace; `insta compute suspend` stays a pause.
- Wake doors: a request or connection on any lane (held up to 60 s), `insta compute start`, a deploy. A stopped service is never woken by traffic.
- Always-on: `insta compute always-on on|off <name>`, `services add compute --always-on`, manifest `alwaysOn: true`; `insta db always-on on|off` for postgres. Self-host default for new compute is scale-to-zero; the cloud's default is always-on (divergence).
- Limits: `insta compute limits <name> --memory 512mb [--cpu 2]` maps to `--cpus/--memory`; grid 1,2,4,6,8 vCPU, memory multiple of 256 within 256 to 2048 MB per vCPU; cap 8 vCPU / 8192 MB.
- Runtime vocabulary: `services` shows `asleep`; `compute status` shows `suspended` with desired `running`; runtime-health shows `standby`.
- Database observability pages report `sleeping` (503) instead of waking the instance; management commands wake it.
- Knobs: `INSTA_OSS_IDLE_COMPUTE_SEC`, `INSTA_OSS_IDLE_DB_SEC`, `INSTA_OSS_SWEEP_SEC`, `INSTA_OSS_CREATE_GRACE_SEC`, `INSTA_OSS_STOP_GRACE_SEC`, `INSTA_OSS_STOP_GRACE_DB_SEC`, `INSTA_OSS_WAKE_TIMEOUT_SEC`, `INSTA_OSS_RAM_FLOOR_PCT`, `INSTA_OSS_MEM_BUDGET_MB`, `INSTA_OSS_ALWAYS_ON_DEFAULT`, `INSTA_OSS_SCHEDULER`.
- New event kinds: `service.sleep`, `service.wake`, `service.alwaysOn`, `service.limits`; `GATED_ACTIONS` gains `service.upgrade` (default allow).
