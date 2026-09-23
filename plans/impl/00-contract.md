# 00 Integration contract: single-node serverless

Reconciled from the eight work-package designs (`plans/impl/designs/wp1.json` .. `wp8.json`) against the spec `plans/2026-09-08-single-node-serverless-spec.md`, insta-oss origin/main ad0de09, insta-platform origin/main 9f0c0d3, insta-cli origin/main 869d7a1, insta-compute origin/main f9f5242 (`docs/sleep-and-wake.md`). Cloud line numbers are as of those commits.

Every implementer codes against THIS file. Where a design JSON and this file disagree, this file wins. Section 2 is the decisions register: every conflict and every open question from the designs has one line here with the decision and the rationale. The per-package plans (`01` to `08`) restate only what each package builds; `09` is the merge order.

The ten fixed decisions from the task (no endpoint the cloud lacks; two run modes on one code path; sleep = docker stop with the cloud's idle rules and memory eviction; `<service>-<ref>.<domain>` hostnames; container-per-branch with bind mounts and reflink forks; bundled templates through the cloud's routes; no builder, no migrate routes; `test/server.test.ts` is the contract suite; minimal deps; no competitor names, no em dashes in docs) are not restated as decisions; they are premises.

## 1. Ownership, shared files, regions, scaffold

### 1.1 Scaffold (integrator, before any implementer starts)

One commit on `feat/single-node-serverless`, made by the integrator, that every worktree branches from. It contains no behaviour change and today's tests pass on it. Exact contents are in `09-integration-order.md` step 0. Summary:

- `src/config.ts` exactly as section 3 (type, `loadConfig`, `isDaemonHost`, `CONFIG_KEYS`) plus `test/config.test.ts`. WP1 owns the file afterwards; the scaffold exists so every package reads one `Config` from day one.
- `src/types.ts` final (section 4) and the mechanical adaptation of `src/engine.ts`, `src/adapters/*.ts` and the fakes to the new adapter signatures with today's semantics (postgres `fork` = provision then dump/restore; `volume: { hostPath }` computed as today's named-volume name is NOT possible, so the scaffold keeps a named volume by passing `hostPath` = today's `io-<ref>-data-<id>` string and the compute adapter mounts it verbatim; WP4 replaces this with real host paths). Because section 4's `GATED_ACTIONS` carries `service.upgrade`, `src/govern.ts` `DEFAULTS` (typed `Record<GatedAction, Decision>`, govern.ts:9) gains `'service.upgrade': 'allow'` in the same commit or the scaffold does not typecheck; this is the scaffold's one visible change (`GET /policy` lists the new action) and WP3 only verifies it.
- `test/fakes.ts` (section 6) extracted from today's `test/server.test.ts`, which then imports it. Every fake records the same strings it records today so no existing assertion moves.
- Region markers in `src/engine.ts`, `src/server.ts`, `src/types.ts`, `src/state.ts`, `src/main.ts`, `src/manageddb.ts`, `test/server.test.ts`, `ui/src/api.ts`.
- `Engine` constructor gains `opts?: EngineOptions` with `cfg`, `data` (default: a no-op `DataDirOps` constant in region WP4, so WP5's `data.ensureDir`/`data.remove` calls compile and do nothing until WP4 lands) and `router` (default `{ invalidate() {} }`; the field is assignable because WP2's `main.ts` sets `engine.router = router` after construction). `buildServer(engine, cfg = loadConfig(), opts: { serverFactory?: FastifyServerFactory } = {})` passes `serverFactory` straight into `Fastify()` (undefined until WP2). `upstream`, `scheduler`, `templates` are added to `EngineOptions` by WP3/WP5 in their regions.
- The engine HOOK SKELETON (decision 33 hooks, so WP2/WP3/WP4 fill bodies from day one instead of re-applying edits at rebase): every `// filled by WPn` identity hook exists in its owner's region returning today's value. The complete list, mirrored in 05 "Done when" and 09 step 3b: WP2 `allocLanes` (returns `{}`), `releaseLanes` (no-op), `assertHostFree` (no-op), `laneAddress` (returns the stored container host and port, `tls: false`, so DSNs stay in today's container-host form), `serviceUrl` (today's `http://localhost:<hostPort>` from the deploy result), `mintedHost` (returns `undefined`, so `apps[g].host` is not written until WP2), `containerize` (identity), `hostAliasesFor` (`[]`), `localHostPort` (today's allocator), `rowNetwork` (today's `endpoint`), `releaseDomainsFor` (no-op); WP3 `withOp` (today's per-app `serialize()` chain applied to each key, so container ops stay mutually exclusive from day one; WP3 swaps the body for the scheduler's per-key lock, decision 52), `serviceKey` (`${branch.id}:${serviceId}`, already final), `wake` (resolves immediately), `startAsleepFor` (returns `false`, so clones start running as today; WP3's body is `!effectiveAlwaysOn(...)`), `afterDeploy` (no-op), `sleepNewBranch` (no-op), `rowRuntime` (today's `docker ps` derived value), `healthOverlay` (today's runtime-health computation), `limitsFor` (`undefined`), plus `readonly scheduler: SchedulerLike` where `SchedulerLike = { register(keys): void; forget(keys): void; rekey(from, to): void }` is a no-op stub that WP3 replaces with the real `Scheduler`; WP4 `layout()` (every path `''`), `volumeMount` (today's `{ hostPath: 'io-<ref>-data-<id>' }`), `forkVolumes` (`[]`). `deployLocked` already builds the 7.2 argument object through those hooks. WP5's later rewrite touches registrations, `provisionBranch`, `createBranch`, `services()` only; the hook calls are already in place.
- `src/main.ts` boot skeleton with every region marker in its FINAL order (01 §1); most packages need the engine, so each has up to three marked blocks: config, state path, lock, docker check, `// region WP4 (probe)` (DataDir + `probe()`), `// region WP3 (upstream)` (`Upstream` + `DockerRuntime`), `// region WP5 (catalog)` (`TemplateCatalog`), engine (`new Engine(..., { cfg, data, upstream, templates })`, the engine builds its own unstarted scheduler), `// region WP4 (migrate)` (`engine.booting`, `migrateLegacyData`), `// region WP5 (executor)` (executor, `abandonStale`, `migrateLegacyContainers`), `// region WP2 (router)` (`new Router(...)` needs engine methods), server (`buildServer(engine, cfg, { serverFactory })`), listen, `// region WP2 (start)` (`router.start()`), `// region WP3 (start)` (`scheduler.start()`), banner, `// region WP6`, signals with two inner lines `// region WP2 (stop)` then `// region WP3 (stop)` before `app.close()` (the scaffold leaves the whole signal block as a commented skeleton, so Ctrl-C keeps today's default signal exit; WP1 lands the handlers); WP1 fills bodies, nobody moves a marker.
- `src/state.ts` final SHAPE (section 5: `initStatePath`, `statePath`, `stateRev`, `rev`, `auditRev`, `loadState`, `saveState`, `mutate`, `acquireLock`/`releaseLock`, `touchLater`, `migrateState` stub, `EVENTS_CAP`) with today's bodies where behaviour exists and stubs elsewhere; WP1 fills bodies.
- `// ---- args WP2 ----`, `// ---- args WP3 ----`, `// ---- args WP4 ----` marker lines inside `deploy()` in `src/adapters/compute.ts` and `provision()` in `src/adapters/postgres.ts` and `src/adapters/manageddb.ts` (each package adds its flags at its line; WP4's postgres rewrite preserves the WP2 and WP3 lines).
- `export const API_PREFIXES: string[]` in `src/server.ts` (today's `isApiPath` list) with one marked `// WP1` and one marked `// WP5` line to append to (`/api`, `/auth`, `/tls` for WP1; `/templates`, `/template-deployments` for WP5); `isApiPath` reads the array.
- The 501 stubs that later become real routes are MOVED, with no behaviour change, into the region that will replace them: `/me` + `/tokens` (server.ts:55-60) into region A, limits + always-on (503-505) into region C, `compute/domain` (509-511) into region B. Each owner then edits only inside its region.
- The 501 sweep array in `test/server.test.ts:218` is split into per-region sub-arrays (`NOT_CLOUD_WP1`, `NOT_CLOUD_WP2`, `NOT_CLOUD_WP3`, `NOT_CLOUD_REST`) concatenated into the same test; each package deletes rows only from its own sub-array.
- `.github/workflows/ci.yml` ends with anchor comments `# ---- WP4 ----` and `# ---- WP6 ----` (in that order) so the two appends never share a hunk.
- `vitest.config.ts`: `exclude: process.env.RUN_DOCKER_TESTS ? [] : ['test/**/*.int.test.ts']`; `.github/workflows/ci.yml` sets `RUN_DOCKER_TESTS=1` and `INSTA_OSS_SCHEDULER=0` on the `npm test` step (decision 12).

### 1.2 Ownership table

| Package | Owns exclusively (create or rewrite) | May only append to (inside its marked region) |
|---|---|---|
| WP1 identity/config | `src/config.ts` (after the scaffold), `src/identity.ts`, `src/auth.ts`, `src/state.ts` (rewrite), `src/main.ts` (rewrite: boot order; every other WP adds lines only inside its region), `test/identity.test.ts`, `test/server-auth.test.ts`, `test/state-lock.test.ts`, `test/config.test.ts` (after the scaffold) | `src/server.ts` (region A, plus three named in-place edits: the `Fastify()` options object, the `registerAuth(app, cfg)` call after the content-type parser at line 33, and the dashboard-serving block at 668-681 which becomes the shell injection), `src/types.ts` (region WP1), `test/server.test.ts` (region WP1), `test/fakes.ts` (region WP1) |
| WP2 router | `src/router/*` (`table.ts`, `index.ts`, `http.ts`, `pg.ts`, `tls.ts`, `port.ts`, `splice.ts`, `wake.ts`, `certs.ts`, `internal.ts`, `domains.ts`), `src/adapters/compute.ts` deploy args at its `// ---- args WP2 ----` line (`-p`, `--add-host`; WP3 and WP4 add their args at their own lines), `test/router.test.ts`, `test/router-table.test.ts`, `test/internal.test.ts`, `test/router.int.test.ts`, `test/fixtures/local/router.test/router.test.crt` + `.key` (self-signed, long-lived, CN `router.test`, laid out as Caddy's store under `test/fixtures`; generated once by the integrator with the command documented in 02) | `src/engine.ts` (region WP2 + edit points in 7.2), `src/server.ts` (region B), `src/types.ts` (region WP2), `src/state.ts` (region WP2), `src/manageddb.ts` (region WP2: `bundle(host, port, password, tls)`, `sni`), `src/adapters/postgres.ts` (`publishLoopback` arg only), `src/adapters/manageddb.ts` (`publishLoopback` only), `src/main.ts` (region WP2), `test/server.test.ts` (region WP2), `test/fakes.ts` (region WP2), `test/restart-policy.test.ts` (append) |
| WP3 scheduler | `src/scheduler.ts`, `src/upstream.ts` (container address discovery + cache, consumed by the router too), `test/scheduler.test.ts`, `test/upstream.test.ts`, `test/sleep-wake.int.test.ts` | `src/engine.ts` (region WP3 + edit points), `src/server.ts` (region C, plus two named in-place edits: the `PATCH database/settings` body parse gains `scaleToZero`/`idleTimeout`/`cpu`/`memory`, and `obsCode` gains the `/sleeping/` -> 503 line), `src/types.ts` (region WP3; deletes `ComputeAdapter.state`, decision 53), `src/govern.ts` (nothing: the scaffold landed `'service.upgrade': 'allow'`, 1.1; WP3 verifies), `src/adapters/compute.ts` (`// ---- args WP3 ----` line: limits, `--init`, stop grace), `src/adapters/postgres.ts` (`// ---- args WP3 ----`: limits), `src/adapters/manageddb.ts` (`// ---- args WP3 ----`: limits), `src/main.ts` (region WP3), `test/server.test.ts` (region WP3), `test/fakes.ts` (region WP3), `test/restart-policy.test.ts` (append) |
| WP4 branching/data dir | `src/datadir.ts`, `src/fsclone.cjs`, `src/datadir-migrate.ts`, `src/adapters/postgres.ts` (rewrite; WP2/WP3 add args only), `test/fsclone.test.ts`, `test/postgres-adapter.test.ts`, `test/datadir-migrate.test.ts`, `test/fork.int.test.ts`, `test/datadir-migrate.int.test.ts`, `test/clone-isolation.int.test.ts` (edit), `.github/workflows/ci.yml` (XFS loop step) | `src/engine.ts` (region WP4 + edit points), `src/types.ts` (region WP4), `src/manageddb.ts` (region WP4: `dataPaths`), `src/adapters/manageddb.ts` (bind mounts), `src/adapters/compute.ts` (volume hostPath line), `src/main.ts` (region WP4), `test/server.test.ts` (region WP4), `test/fakes.ts` (region WP4) |
| WP5 templates/parity | `src/templates/manifest.ts`, `src/templates/catalog.ts`, `src/templates/executor.ts`, `src/adapters/garage.ts` (rewrite: per-service buckets, constructor opts, server-mode ensure), `test/templates.test.ts`, `test/template-deploy.int.test.ts`, `test/storage.int.test.ts` (edit), `package.json` (`yaml` dependency line) | `src/engine.ts` (region WP5 + the structural rewrite listed in 7.2), `src/server.ts` (region D, plus these named in-place edits: `resources: []` at line 150, the pg/storage `services add` block 288-298, the rename 501 guard 378-380, the DELETE handler 622-628, one `resolveSid(req)` line at the top of every existing `/projects/:id/services/:sid/*` handler, and `?group=` on every existing `/database/*` route), `src/types.ts` (region WP5), `src/state.ts` (region WP5: `templateDeployments`, `migrateState`), `src/manageddb.ts` (region WP5: `parseServiceId`, `CANONICAL_KEYS`), `src/main.ts` (region WP5), `test/server.test.ts` (region WP5 + the listed existing-assertion edits), `test/fakes.ts` (region WP5) |
| WP6 packaging | `Dockerfile`, `.dockerignore`, `install.sh`, `.github/workflows/release-image.yml`, `test/install.test.ts`, `test/image.int.test.ts`, `test/compose.int.test.ts`, `package.json` (scripts + `tsx` move) | `.github/workflows/ci.yml` (append two steps), `src/main.ts` (region WP6: version banner), `src/adapters/garage.ts` (server-mode `ensure()` branch, coordinated with WP5) |
| WP7 dashboard | everything under `ui/` (pages, components, `api.ts` after the scaffold, `hooks.ts`, `App.tsx`, `vite.config.ts`, `ui/src/lib/*` and tests), `vitest.config.ts` (add the ui lib include) | nothing outside `ui/` and `vitest.config.ts` |
| WP8 docs/e2e | `README.md`, `COMPATIBILITY.md`, `CONTRIBUTING.md`, `docs/**`, `e2e/**`, `.github/workflows/e2e.yml`, `test/docs-lint.test.ts` | nothing else. Other packages hand WP8 facts in their plan's "docs facts" section; they do not edit docs |

### 1.3 Region markers

The scaffold puts these markers in every shared file. A package appends only between its own pair; the scaffold's markers are never moved.

```
// ---- region WP1 (identity/config) ----
// ---- end region WP1 ----
// ---- region WP2 (router) ----
// ---- end region WP2 ----
// ---- region WP3 (scheduler) ----
// ---- end region WP3 ----
// ---- region WP4 (data dir) ----
// ---- end region WP4 ----
// ---- region WP5 (templates/parity) ----
// ---- end region WP5 ----
```

In `src/server.ts` the regions are lettered A (WP1), B (WP2), C (WP3), D (WP5) and sit right before today's dashboard-serving block (line 668); new routes go there, and the 501 stubs they replace were already moved into the same region by the scaffold (1.1), so the owner deletes them inside its own region. `API_PREFIXES` carries one marked line per package. In `src/adapters/compute.ts`, `postgres.ts` and `manageddb.ts` the `// ---- args WPn ----` lines inside `deploy()`/`provision()` are the only shared edit points. In `.github/workflows/ci.yml` the anchors `# ---- WP4 ----` and `# ---- WP6 ----` are the append points. In `src/engine.ts` the regions sit at the end of the class body; edits inside EXISTING methods are allowed only at the edit points in 7.2. In `src/types.ts` the regions sit after the existing interfaces (the scaffold already carries the final text of section 4, so packages only add comments or fields they discover they need, and must update this file first). In `test/server.test.ts` regions sit at the end of the file. In `ui/src/api.ts` a single `// ---- region WP7 ----` marks where types and methods are appended (WP7 owns the file; the marker is for the dashboard-side contract tests other packages read).

### 1.4 Merge order

`WP1 -> WP5 -> WP4 -> WP3 -> WP2 -> WP6 -> WP7 -> WP8`. Rationale: WP1 fixes config, auth and state discipline; WP5 performs the structural engine rewrite (registrations, provisionBranch, services rows) everyone else hooks into; WP4 fills the adapter bodies; WP3 lands the scheduler and `src/upstream.ts` with no router dependency; WP2 then wires the lanes to `engine.touch/wake/stateOf` and consumes `upstream.ts`; WP6 needs WP2's `internal.ts` and `ownsHostname`; WP7 needs every route; WP8 documents what shipped. Every implementer rebases onto `main` whenever an earlier package lands; details and per-merge checks are in `09`.

## 2. Decisions register

Each line: topic, who disagreed, the decision, one-line rationale.

1. Config module. WP1 (`loadConfig` injected) vs WP2 (`export const cfg` singleton) vs WP4/WP6 (`config`, `CONFIG_KEYS`). Decision: `src/config.ts` exports `loadConfig(env, argv): Config` and a frozen `Config` object is INJECTED (`buildServer(engine, cfg)`, `new Engine(..., { cfg })`, `new Scheduler(runtime, cfg, ...)`). No module-level singleton: tests need distinct configs per case. `CONFIG_KEYS` is exported for the installer test.
2. Env names. Every knob is `INSTA_OSS_*`; durations are `_SEC` integers except sub-second router windows (`_MS`); the RAM floor is `INSTA_OSS_RAM_FLOOR_PCT`; lane ports `INSTA_OSS_LANE_*`; internal listener `INSTA_OSS_INTERNAL_PORT` (8081). Stack-only keys `INSTA_OSS_IMAGE`, `INSTA_OSS_VERSION`, `INSTA_OSS_TLS` (`acme|internal`), `INSTA_OSS_ACME_EMAIL`, `INSTA_OSS_CA_FILE` live in the same `instad.env`; the daemon ignores keys it does not read. WP8's `INSTA_OSS_MEM_FLOOR_PCT`, `INSTA_OSS_TLS=selfsigned` and `INSTA_OSS_ROUTER_PORT` do not exist. The full list is section 15.
3. Listener. WP1 (0.0.0.0 in server) vs WP2 (127.0.0.1). Decision: the HTTP listener binds `127.0.0.1:<port>` in both modes (the edge is the only remote client in server mode); in LOCAL mode on Linux it additionally binds the docker bridge gateway IP (`docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'`) so containers reach it through `--add-host ...:host-gateway`; on Docker Desktop `host.docker.internal` already forwards to host loopback. Lanes bind `0.0.0.0` in server mode, `127.0.0.1` plus the bridge gateway on Linux in local mode. `INSTA_OSS_LISTEN_HOST` overrides the primary address only.
4. One HTTP listener per mode. WP2 (Fastify `serverFactory`, Host dispatch) vs WP8's separate router port. Decision: the router owns the `node:http` server(s); Fastify receives the primary one through `serverFactory`, whose handler the router captures with `router.attach(handler)` (Fastify hands it over inside `serverFactory`, after the router exists). Dispatch by Host: `isDaemonHost(cfg, host)` -> Fastify's handler; else `table.byHost(host)` -> the HTTP lane (minted names and custom-domain aliases, both modes); else server mode 404 `{error:'unknown route'}`, LOCAL mode Fastify's handler (today's behaviour: any Host reaching the daemon's own port is the API, so `curl 127.0.0.1:8080` with a LAN name or `host.docker.internal:8080` from a container keeps working, and a local-mode custom domain still routes through its alias, decision 25). Local mode uses `*.localhost` names on the same `127.0.0.1:8080`. No `INSTA_OSS_ROUTER_HTTP_PORT`.
5. How apps reach the router. Spec (router joins branch networks with aliases) vs WP2 (`--add-host <fqdn>:host-gateway`) vs WP6 (`--add-host <fqdn>:<bridge gateway>` + `socket.localAddress`). Decision: WP2's `--add-host <fqdn>:host-gateway` for every hostname minted on the branch plus `host.docker.internal:host-gateway`. A `network_mode: host` container cannot join bridge networks, so the alias design is impossible; `host-gateway` is the portable host address from any bridge network and needs no per-branch gateway lookup.
6. How the daemon reaches containers. Server mode: dial the container IP from `docker inspect` on the branch network (the daemon is in the host netns). Local mode: containers publish `-p 127.0.0.1::<port>` (ephemeral) and the daemon dials the port from `docker port` (macOS cannot route to container IPs). One module, `src/upstream.ts` (WP3), implements both with a cache and `forget(container)`; the router and the scheduler's probe both use it.
7. Hostname scheme with several services per type. Spec (`pg-<ref>`), WP2 (`pg-<ref>`, `<type>-<name>-<ref>`), WP5/WP8 (the name must appear). Decision: `hostFor(kind, name, ref)`: compute `<group>-<ref>`; postgres `pg-<name>-<ref>`; managed `redis-<name>-<ref>`, `mysql-<name>-<ref>`, `mongodb-<name>-<ref>`; the legacy postgres named `db` becomes `pg-db-<ref>`. Database labels carry a type prefix so a compute group and a database may share a name (the cloud has no cross-type rule). Reserved labels `api`, `console`, `s3`; every minted label is checked with `assertHostFree` at branch create, service add and rename (409 on collision).
8. Setup and login paths. WP1 (Better Auth mount paths, cloud `/auth/login|refresh|logout` wrappers, `/auth/signup` 501) vs WP7 (`/auth/signup` for setup, cookie `instad_session`, `/me` 401 `setup required`). Decision: WP1. The dashboard calls `/api/auth/*`; the CLI calls `/auth/login` and `/tokens`; `/auth/signup` answers 501 pointing at `/setup`. Cookie name and format are Better Auth's. `/me` 401 body stays the cloud's `{error:'unauthorized'}`; the setup-required flag reaches the SPA through `window.__INSTA_OSS__` injected into `index.html` (Vite dev: `VITE_INSTA_MODE`).
9. Public routes in server mode. Decision: allowlist = `/healthz`, `/api/auth/*`, `/auth/*`, `GET /templates`, `GET /templates/:code` (cloud `security: []`, openapi.yaml:7702, 7727), static assets and the SPA shell (`GET` on non-API paths). Everything else needs a session or bearer.
10. Activity stamps and sleep marks. WP1 (never in state.json), WP2 (in memory), WP3 (`activity.json`), WP7 (`sleptAt` on the app record). Decision: `lastActiveAt`, `wokeAt`, RSS samples and the wake singleflight live in memory in `src/scheduler.ts`; a restart stamps every service at boot (the cloud's ready-stamp behaviour) but the CREATE grace is measured from the row's creation time (`ServiceTarget.createdAt` from `serviceSettings[sid].createdAt ?? apps[g].updatedAt`, `dbServices[].createdAt`, `managedServices[].createdAt`, else the branch `createdAt`), never from the in-memory ledger, so a daemon restart does not grant every service a fresh 10-minute grace. `sleptAt` is written once per sleep/wake into state.json (`Branch.apps[g].sleptAt`, `Branch.databases[id].sleptAt`, `Branch.managed[id].sleptAt`) so runtime-health can tell standby from crashed after a restart. No `activity.json`.
11. Service key. WP2 `${branchId}:${serviceId}` vs WP3 `${branchRef}/${serviceId}`. Decision: `ServiceKey = ${branchId}:${serviceId}` (ids are stable; refs are frozen but the id is what every route resolves).
12. Scheduler in local mode. WP1 (off) vs WP3 (on). Decision: on in both modes with the same defaults; `INSTA_OSS_SCHEDULER=0` disables the ticker (the idle sweep and the pressure pass it ends with; wake and sleep on demand keep working, and a wake still asks eviction for room), and `INSTA_OSS_RAM_FLOOR_PCT=0` is the off switch for memory-pressure eviction itself: `evictForRoom` returns on a floor of 0 before it reads memory, so neither the sweep nor a wake can stop anything. Docker integration tests and every e2e step that does not test sleep set `INSTA_OSS_SCHEDULER=0` (the idle knobs at 0 disable only the idle candidates, not the pressure pass, which on a low-RAM CI runner would stop the containers under test) and add `INSTA_OSS_RAM_FLOOR_PCT=0` when a wake could fire on a runner under the floor; `test/sleep-wake.int.test.ts` runs the ticker with `INSTA_OSS_RAM_FLOOR_PCT=0` unless it tests eviction, where it uses `INSTA_OSS_MEM_BUDGET_MB`. One code path, and the RAM promise holds on a laptop too. What stays byte-identical in local mode: auth (none), bind (127.0.0.1), port (8080), the CLI flow.
13. Database stop grace. Spec 10 s vs WP3 30 s. Decision: compute 10 s (`INSTA_OSS_STOP_GRACE_SEC`), databases 30 s (`INSTA_OSS_STOP_GRACE_DB_SEC`). A Postgres fast shutdown can exceed 10 s under load and SIGKILL costs crash recovery on the next wake.
14. always-on default. Decision: `false` (`INSTA_OSS_ALWAYS_ON_DEFAULT`); the cloud's default is true since 2026-09-07 (platform config.ts:204). Documented divergence; templates declaring `alwaysOn: true` are honoured.
15. Limits when unset. Decision: report the effective host ceiling snapped to the grid; cap fixed at 8 vCPU / 8192 MB / 100 GiB.
16. Postgres data directory key. WP4 (`pg/<ref>/<svcKey>`) vs WP5 (`pg/<ref>/<name>`). Decision: immutable `dataId` per postgres service (`Project.dbServices[].dataId`; legacy `db` gets the literal `db`); directory `pg/<ref>/<dataId>`. Names are renamable, directories are not.
17. Postgres container name. WP5 `io-<ref>-pg-<name>` vs legacy `io-<ref>-pg`. Decision: `io-<ref>-pg-<name>`; the handle is READ from `Branch.databases[id].container`, never derived; WP4's boot migration recreates legacy containers under the new name while moving their data to bind mounts, so WP5 needs no separate rename pass.
18. Postgres password. WP6 flagged the constant `insta` on a public lane. Decision: `provision` mints `randomBytes(24).toString('base64url')`; a fork inherits the source's files and therefore its password; `dbSetPassword` keeps working.
19. Adapter signatures. WP2, WP3, WP4, WP5 each changed them. The single signature is section 4; the scaffold lands it. WP5 owns the engine call sites, WP4 the postgres body, WP5 the garage body, WP2/WP3/WP4 the compute and manageddb bodies by marked lines.
20. Storage endpoint. Decision: server mode `AWS_ENDPOINT_URL_S3 = https://s3.<domain>` (one string for host and containers; `s3.<domain>` routes to Garage 127.0.0.1:3900). `<bucket>.s3.<domain>` is ONE hostname serving two kinds of traffic and the router picks the upstream per request: a request carrying `Authorization: AWS4-HMAC-SHA256 ...`, or `X-Amz-Signature`/`X-Amz-Algorithm` in the query, or any method other than GET/HEAD goes to the S3 API 127.0.0.1:3900 (SDKs default to virtual-hosted addressing, so signed PUT/GET/LIST arrive on the bucket vhost; Garage's `[s3_api] root_domain = .s3.<domain>` accepts them); everything else (anonymous GET/HEAD) goes to the web endpoint 127.0.0.1:3902 (public buckets). Both addressing styles therefore work from apps. Local mode keeps `http://io-garage:3900` in-container and `http://127.0.0.1:3900` host-facing; `containerize()` maps between them. The `s3.<domain>` and `<bucket>.s3.<domain>` router routes exist in SERVER mode only: local mode's garage.toml (written once, only when absent, garage.ts:38-53) keeps `root_domain = ".s3.garage.localhost"` / `".web.garage.localhost"`, so public reads stay at today's `http://<bucket>.web.garage.localhost:3902` and the router serves no bucket vhost there. Garage stays attached to branch networks in both modes (rclone reaches it by name).
21. TLS for the database lanes. WP2 (openssl self-signed) vs WP6 (Caddy's store). Decision: read Caddy's certificate store only (`INSTA_OSS_TLS_CERT_DIR`); a hostname with no certificate yet gets one by the router opening a TLS handshake to `127.0.0.1:443` with that servername (Caddy on-demand issues, falling back to its internal issuer). No openssl in the daemon; local mode has no TLS lanes. `INSTA_OSS_TLS=internal` makes Caddy use only its internal CA and the installer copies the root to `<dataDir>/edge/ca.pem` so curl, psql and the CLI can trust the box.
22. Ask endpoint. WP1 (`INSTA_OSS_EDGE_ASK_LISTEN`), WP2 (`/ask` on 8079), WP6 (`/tls/ask` on 8081, `src/internal.ts`). Decision: `GET http://127.0.0.1:${INSTA_OSS_INTERNAL_PORT}/tls/ask?domain=<host>` on a loopback `node:http` listener owned by WP2 (`src/router/internal.ts`); never registered on Fastify. Also serves `GET /healthz`. Server mode only.
23. Copy engine for forks. Spec (`cp --reflink`) vs WP4 (`fs.copyFile` + `COPYFILE_FICLONE_FORCE`). Decision: three engines chosen by platform and privilege. Linux as root (the server container): Node's `fs.copyFile` with `COPYFILE_FICLONE_FORCE` in-process. Linux unprivileged (local mode as a docker-group user): the `node:22-alpine` helper container running the same `fsclone.cjs`. macOS (local mode): Apple's `/bin/cp -c -a` (clonefile) with ONE spawn per top-level PGDATA entry and one for a whole volume tree, never one per file (measured: `cp -c -R` clones a 344 MiB, 301-file tree in 58 ms against 385 ms for a plain copy), because libuv answers `ENOSYS` to `COPYFILE_FICLONE_FORCE` on darwin and the non-force flag silently byte-copies. `cp -c` itself falls back to `copyfile(2)` silently when the target filesystem has no clonefile (its man page says so), so on darwin `reflink: true` requires BOTH the data dir's filesystem to be `apfs` (longest mount-point prefix in `/sbin/mount` output) AND `cp -c` exiting 0; `--reflink=always` pre-checks the filesystem and exits 75 on anything else. `ENOSYS` joins `ENOTSUP|EXDEV|EINVAL|EOPNOTSUPP` as "no reflink" on every platform. The boot probe is NEVER fatal for a failed clone attempt: any error, listed or not, degrades to `reflink: false` with one logged warning naming the code, forks then stream `pg_basebackup` (postgres) and plain-copy (volumes, `method: 'copy'`); only an unwritable data dir (the probe's `mkdir`/write itself failing) or an explicit `INSTA_OSS_FORK=reflink` on a box without reflinks stops the boot. No coreutils dependency in the image; the image base stays `node:22-bookworm-slim` for glibc and the docker CLI, not for GNU cp.
24. Legacy migration timing. Decision: one boot migration (`INSTA_OSS_DATA_MIGRATE`, default on), resumable, run before the router and scheduler start; `createBranch` from an unmigrated branch throws with a clear message. Every step reads its own evidence: a container's bytes are copied only after docker has said that container is NOT RUNNING, a source is removed only after its copy is verified, and `dataVersion: 1` is written only on a positive answer, so an unreadable or uncooperative docker leaves the branch exactly as it found it for the next boot.
25. Custom domains. Decision: WP2 owns the four hidden cloud routes (`compute/domain` POST/GET/DELETE, `compute/domains` GET) and emits the envelope the CLI renders cleanly (`insta-cli compute.ts:98-228`): NO `ssl`, `origin`, `edgeOrigin`, `originOk` or `originStatus` field in either mode (sending `ssl` makes the CLI expect an `origin` and an ownership TXT and print `UNCONFIRMED`); the verdict lives in `configured` (server mode: the routing record resolves to us AND the certificate exists in the store; local mode: the record resolves), `dns[].status` is one of the cloud's `ok | missing | mismatch | unchecked` (never `pending`), `status` is `pending | ready | not added`. Local mode answers the routes too (Host aliases work); the dashboard hides the Domains section by `window.__INSTA_OSS__.mode === 'local'`, not by probing 501.
26. Credentials route. WP2 and WP5 both proposed it. Decision: WP5 implements `engine.credentials()` and the route; WP2's `laneAddress` feeds the DSN host.
27. Template dependency. Decision: add `yaml@^2` (justification: the platform's authoritative parser and the CLI's twin both use it, so `manifestDigest` matches byte for byte and inline YAML manifests on `POST /template-deployments` parse identically). No `js-yaml`.
28. Per-type service cap. Decision: 5 (`INSTA_OSS_MAX_SERVICES_PER_TYPE`), the cloud free tier (config.ts:473).
29. Template logo. Decision: `logoUrl` is a `data:` URI built from `templates/<code>/logo.svg|png` (offline, self-contained); the UI tolerates null and any URL.
30. `insta login` bare, `--device`, `--oauth`. Decision (superseded): `--device` is now implemented against the daemon (RFC 8628: `POST /api/auth/device/code` issues a code, `POST /api/auth/device/token` polls it, and the console's `/device` page approves it, minting an `insta_` key on collection); bare `insta login` and `--oauth` stay 501 (hosted-identity flows are cloud-only). All under the cloud's `/api/auth/*` wildcard, so contract-safe.
31. Dashboard ownership. WP1 and WP7 both proposed Setup/Login/Tokens pages. Decision: WP7 owns everything under `ui/`; WP1 owns the shell injection in `server.ts`.
32. Docs ownership. Decision: WP8 owns README, COMPATIBILITY, CONTRIBUTING and docs; every other package lists "docs facts" in its plan for WP8 to fold in.
33. Engine edits. Decision: append-only regions plus the named edit points in 7.2. `provisionBranch`, `createBranch`, `deployLocked`, `services`, `runtimeHealth`, `liveState`, `lifecycleLocked`, `destroyBranch`, `destroyProject`, `removeComputeService`, `removeServiceVolume`, the `db.query` callers, `dbInstance`, `dbSettings` are the only existing methods with edit points, and each edit is a single call into a hook the owning package adds in its region.
34. Postgres readiness (#34). Decision: WP4's TCP readiness (`pg_isready -h 127.0.0.1` then `psql -h 127.0.0.1 -c 'select 1'`) and retry-on-connect in `query()`.
35. Compute group `default`. Decision: literal label `default-<ref>`.
36. Session TTL. Decision: Better Auth defaults (7 d, 1 d sliding). `insta_` tokens default to no expiry.
37. `empty: true` on branch create. Decision: accepted and ignored (as today). Out of scope.
38. MySQL external lane. Decision: a per-service port from `INSTA_OSS_LANE_PORT_RANGE` on `0.0.0.0` in server mode (plaintext; MySQL greets first so SNI is impossible). The installer opens no extra firewall ports for it; docs say so.
39. Event kinds. Decision: `service.sleep {service, branch, reason}`, `service.wake {service, branch, door, ms}`, `branch.created {from, db:{method,ms}, volumes:[{group,method,ms}]}`, `template.deploy`, `template.deploy.succeeded|failed`, `service.alwaysOn`, `service.limits`. Events are free-form kinds on an existing route.
40. Compute `endpoint` field. WP7 proposed a full URL. Decision: keep `endpoint` as `host[:port]` (a script may read it), `domain` = bare hostname; the UI builds the link from `domain` plus the mode.
41. Second-copy naming, copy ladder, health gate, partial/failed semantics, resume: WP5 mirrors the cloud executor exactly.
42. Merge order and the upstream module. Original draft WP1, WP5, WP4, WP2, WP3. Decision: WP1, WP5, WP4, WP3, WP2, WP6, WP7, WP8, and container address discovery moves to `src/upstream.ts` owned by WP3, so the scheduler's readiness probe has no router dependency and the router consumes a landed module.
43. Scaffold. Decision: the integrator lands the scaffold (1.1) before implementers start; every worktree branches from it. Parallel work with a shared `types.ts` and shared fakes is otherwise a merge-time rewrite.
44. Docker tests in `npm test`. Decision: `vitest.config.ts` excludes `test/**/*.int.test.ts` unless `RUN_DOCKER_TESTS=1`; CI and the integrator set it. An implementer's `npm test` never starts containers.
45. Template deploy gates. Cloud gates `service.add + secrets.write + deploy` (+ `service.upgrade` for volumes). Decision: the same three, plus `service.upgrade` when the manifest declares a volume, since WP3 adds `service.upgrade` to `GATED_ACTIONS`.
46. Compose container names. Decision: `io-instad`, `io-edge`, `io-garage` (the last must equal `GARAGE` in garage.ts:15).
47. Fresh-branch default for template deploys. Decision: synchronous `engine.createBranch` inside the POST (forks are fast after WP4); the CLI always names a branch anyway.
48. Observability never wakes. Decision: `dbMetricsSnapshot`, `dbActivity`, `dbQueryStats`, `dbInsight`, `runtimeLogs`, `runtimeMetrics` do not wake a sleeping service; the four SQL reads throw `database is sleeping: it wakes on the next connection` and `server.ts` maps `/sleeping/` to 503. Management reads and writes (`dbListDatabases`, `dbCreateDatabase`, `dbDeleteDatabase`, `dbExtensions`, `dbPatchExtensions`, `dbSetPassword`) DO wake (door `api`): they are explicit operations.
49. Branch-qualified service ids. The CLI lists `/services?branch=<b>` to pick an id and then calls `/services/:sid/credentials`, `/state`, `/start|stop|suspend|restart` with NO branch (insta-cli db.ts:241-257, compute.ts:357-370: the cloud's ids are per-branch rows). oss ids are branch-stable, so a bare `pg-db` would resolve the default branch and `insta db url --branch feat` would print main's DSN. Decision: rows returned by `GET /projects/:id/services?branch=<b>` carry the id `<branchId>:<serviceId>` (the ServiceKey form, path-safe, opaque to the CLI) when `<b>` is NOT the default branch, and the bare id on the default branch (today's ids stay byte-identical there). Every `/projects/:id/services/:sid/*` route resolves the branch from the sid first, then `?branch`, then the default; `manageddb.parseServiceId` strips the qualifier so `serviceSettings`, limits and always-on keys stay project-level. Section 10 has the rule.
50. `DELETE /projects/:id/services/:sid` body. Decision: `200 { teardown: { destroyed, failed } }` for every type (AMENDED, round 18: `409` with the same envelope plus an `error` string when `failed > 0`, because the row is kept at `cleanup-failed` and a 200 tells a client the thing is gone; COMPATIBILITY records it on all three rows) (cp-, managed, pg-, st-), counting containers, buckets and directories removed and failed on the branch the removal resolved to (platform server.ts:1761-1770 `TeardownSummary`). It counted across branches while removal fanned out project-wide; branch-scoped removal (dbf47b2, c774561, 19e48d0) made that false for all four types; today's `{}` (server.ts:628) goes away. The cloud returns the SAME envelope from `DELETE /projects/:id` (platform server.ts:1300) and `DELETE /projects/:id/branches/:bid` (server.ts:1387), so those two routes return `{ teardown }` as well (section 9 rows), and the existing assertions at `test/server.test.ts:138` (branch delete), `169` (project delete) and `291` (service delete) become WP5's allowed edits.
51. Provisioning is linear. `allocLanes` and `assertHostFree` were check-then-act across awaits. Decision: the engine holds one `serialize('provision')` chain around `createProject`, `provisionBranch` (hence `createBranch`), `addDbService`, `addStorageService`, `addManagedService`, `addComputeService` and the renames; the branch id is minted BEFORE provisioning and `allocLanes` writes `state.laneReservations[port] = branchId` in one synchronous `mutate` before any await (released by the compensation path, superseded by the branch row's `lanes`); `assertHostFree` and the registration push happen in that same `mutate`. `buildTable` never throws at request time: a duplicate host or port is logged and the first route wins.
52. One per-key operation lock. A traffic wake raced `deployLocked`'s `docker rm -f` + `docker create`, a lifecycle op and a `docker stop` in flight on the same container name (router wakes never entered the per-app `serialize()` chain, and `opsInFlight` was a counter nobody could await). Decision: `Scheduler.withOp(keys, fn)` IS the lock, and it is the only one for container work: exclusive per `ServiceKey`, keys acquired in sorted order (multi-key ops such as `createBranch` cannot deadlock), re-entrant inside the acquiring async context (`AsyncLocalStorage` from `node:async_hooks`, so `lifecycle start` -> `wake`, `createBranch` -> `deployLocked` -> `wake(srcKey)` and `ensurePgAwake` -> `wake` nest without a second acquisition), sweep-visible (a held or queued key is never a sleep candidate) and awaitable. Takers: engine `deploy`/`restart` (cp key), `lifecycle`, `createBranch` (both branches' keys), `destroyBranch`/`destroyProject`, service add/remove/rename, volume ops, `setServiceLimits`, `ensurePgAwake` + its query, and the scheduler's own `wake()` (blocking: it waits for the deploy, lifecycle op or stop to finish, then re-reads the target and live container state, so a deploy that ended in `onUp` makes the wake a no-op and a stop that just completed makes it a start) and `sleep()` (non-blocking `tryWithOp`: a held key answers `false`, a stop never queues behind a deploy). The per-app `serialize()` chain survives only as the engine-wide `serialize('provision')` of decision 51. A container absent from `containers()` after the lock is taken throws `NoContainerError` (`service has no container (deploy in progress or removed)`, router 503), never `runtime.start`; `stateOf(key)` reports `asleep` while a sleep holds the lock and `starting` while a wake does, so the lanes take the wake path instead of dialling a stopping container. EXCLUSIVITY IS NOT ATOMICITY: an operation whose external mutations span several branches (the renames) still has to answer for a failure partway, so it undoes the container moves it had already made and reports what it could not undo alongside the original error, and its per-branch step is decided from the container rather than assumed, so re-running it finishes from wherever it stands. Transitions are the table in section 13.
53. One runtime state source. `liveState` used the adapter's `docker inspect` while the scheduler kept its own cache. Decision: `Engine.liveState(key)` = `scheduler.stateOf(key)` mapped by section 13; `ComputeAdapter.state` is deleted from the interface and the fakes by WP3 (`Runtime.containers()` is the single docker read); in tests `FakeRuntime` is the single fake state store, the fake compute adapter's `deploy/start/stop/suspend/destroy` update it, and the existing assertions at `test/server.test.ts:475-489` change from `state: 'running'` to `state: 'stopped'` after a stop (WP3's allowed edit, listed in 03 and 09).
54. State revisions. Every proxied request called `loadState()` (a full `structuredClone`) to compare `rev`. Decision: `state.ts` exports `stateRev()` (no clone) and `onSave(cb)`; the router keys its table cache on `stateRev()` and stores `desiredState` on each `Route` at build time, so the request path clones nothing. Writes are two classes: routing-relevant (`mutate(fn)`) bump `rev`; audit-class (`emit`, `touchLater`, `markSlept`, via `mutate(fn, { audit: true })`) bump `auditRev` only. `events` is capped at `EVENTS_CAP = 5000` newest rows (documented in COMPATIBILITY).
55. Hostname labels are bounded, not rejected. A cloud-legal 39-char service name plus a 41-char ref exceeds 63 chars. Decision: `hostFor` truncates the readable prefix and appends `-` + 6 hex of `sha256(fullLabel)` when the label would exceed 63 chars (deterministic, unique); the minted host is RECORDED on the row (`apps[g].host`, `databases[id].host`, `managed[id].host`) and never re-derived. The 400 stays only for operator-supplied custom-domain hostnames.
56. Data binds use `--mount type=bind`. `-v <hostPath>:<dst>` makes dockerd CREATE a missing host directory, so after a reboot where the XFS loop image failed to mount, dockerd's `--restart unless-stopped` would start every Postgres on an empty directory on the root filesystem before the daemon's PG_VERSION guard runs. Decision: every data bind (pg, vol, md) is `--mount type=bind,src=<hostPath>,dst=<containerPath>` (a missing source fails the start), and the installer's fstab line carries `x-systemd.required-by=docker.service,x-systemd.before=docker.service` so docker.service does not start without the data mount. The scaffold interim (named volume) keeps `-v`; WP4 switches it.
57. Upstream seam. Decision: `src/upstream.ts` exports `interface UpstreamLike { resolve; forget; forgetIfChanged; dial }` (section 8.1); `RouterDeps.upstream`, `Scheduler` (fifth constructor argument) and `DockerRuntime(cfg, upstream)` are typed on it; `EngineOptions.upstream?` lets `main.ts` hand ONE `Upstream` to all three (the scheduler's `forget` must hit the router's cache). Cache entries carry a 5 s TTL and the container id; the sweep forgets containers whose id changed. `test/fakes.ts` gets `FakeUpstream`.
58. Template health probe never leaves the box. Decision: the default `httpProbe` is `http.request` to `127.0.0.1:<cfg.port>` (the router's HTTP lane) with `Host: <service host>` and `X-Forwarded-Proto: https`, so it needs neither DNS, hairpin routing nor the internal CA (`INSTA_OSS_TLS=internal` would otherwise fail every deploy at `health_check`). The same-origin check stays on the manifest URL.
59. CSRF belt. Decision: the guard rejects a cookie-authenticated non-GET only when `Origin` (or `Referer`) is PRESENT and its host differs from `req.headers.host`, or `Sec-Fetch-Site` is present and `cross-site`; a request with neither header (curl, the headless setup recipe, the server e2e) passes, matching Better Auth's allow-list-on-presented-Origin behaviour.
60. Compute containers get `--init`. Decision: `docker create --init` for compute containers so docker's tini forwards SIGTERM to an app whose PID 1 is a shell (the cloud interposes a forwarding PID 1 for the same reason); sleep then completes within the grace instead of ending in SIGKILL. Never override `STOPSIGNAL` on the postgres container (the image's `SIGINT` is its fast shutdown).

## 3. `src/config.ts` (scaffold writes; WP1 owns)

```ts
// src/config.ts
export type RunMode = 'local' | 'server'
export type ForkMode = 'auto' | 'reflink' | 'basebackup'

export interface Config {
  mode: RunMode
  version: string                 // INSTA_OSS_VERSION | package.json version
  listenHost: string              // INSTA_OSS_LISTEN_HOST      127.0.0.1 (both modes)
  extraListenHosts: string[]      // local + linux: [docker bridge gateway ip]; else []  (resolved by main.ts, not loadConfig)
  port: number                    // INSTA_OSS_PORT | --port    8080
  dataDir: string                 // INSTA_OSS_DATA_DIR         local ~/.insta-oss | server /var/lib/instacloud (absolute HOST path)
  statePath: string               // INSTA_OSS_STATE            <dataDir>/state.json
  garageConfigPath: string        // INSTA_OSS_GARAGE_CONFIG    local <dataDir>/garage.toml | server <dataDir>/garage/garage.toml
  s3HostEndpoint: string          // INSTA_OSS_S3_HOST_ENDPOINT local http://127.0.0.1:3900 | server https://s3.<domain>
  uiDist: string                  // INSTA_OSS_UI_DIST          <repo>/ui/dist
  templatesDir: string            // INSTA_OSS_TEMPLATES_DIR    <repo>/templates
  domain: string                  // INSTA_OSS_DOMAIN           local 'localhost' | server REQUIRED (lowercase, /^[a-z0-9.-]+$/)
  apiUrl: string                  // INSTA_OSS_API_URL          local http://127.0.0.1:<port> | server https://api.<domain>
  consoleUrl: string              // INSTA_OSS_CONSOLE_URL      local = apiUrl | server https://console.<domain>
  publicIp: string | null         // INSTA_OSS_PUBLIC_IP        null (installer writes it; custom-domain hints)
  trustProxy: boolean             // INSTA_OSS_TRUST_PROXY      local false | server true
  internalPort: number            // INSTA_OSS_INTERNAL_PORT    8081 (server only: /tls/ask + /healthz on 127.0.0.1)
  auth: {
    enabled: boolean              // INSTA_OSS_AUTH             local false | server true
    secret: string                // INSTA_OSS_SECRET           else <dataDir>/secret (created, 0600); >= 32 chars; '' when auth disabled
    sessionTtlSec: number         // INSTA_OSS_SESSION_TTL_SEC  604800
    sessionUpdateAgeSec: number   // constant 86400
    cookieSecure: boolean         // derived: consoleUrl starts with https://
    cookieName: string            // derived: (cookieSecure ? '__Secure-' : '') + 'better-auth.session_token'
  }
  lanes: {
    bind: string                  // INSTA_OSS_LANE_BIND        local 127.0.0.1 | server 0.0.0.0
    pgPort: number                // INSTA_OSS_LANE_PG_PORT     5432 (server; local uses portRange)
    redisPort: number             // INSTA_OSS_LANE_REDIS_PORT  6379
    mongoPort: number             // INSTA_OSS_LANE_MONGO_PORT  27017
    portRange: [number, number]   // INSTA_OSS_LANE_PORT_RANGE  '20000-20999' (local-mode DB lanes; server-mode mysql)
    idleSec: number               // INSTA_OSS_LANE_IDLE_SEC    900 (silent TCP connection cut)
    probeWindowMs: number         // INSTA_OSS_PROBE_WINDOW_MS  8000
    readyWindowMs: number         // INSTA_OSS_READY_WINDOW_MS  30000
    touchDebounceMs: number       // INSTA_OSS_TOUCH_DEBOUNCE_MS 5000
  }
  tls: {
    certDir: string | null        // INSTA_OSS_TLS_CERT_DIR     server <dataDir>/caddy/data/caddy/certificates | local null
    edgePort: number              // INSTA_OSS_EDGE_PORT        443 (the router handshakes here to trigger issuance)
  }
  sleep: {
    enabled: boolean              // INSTA_OSS_SCHEDULER        true (ticker); wake/sleep on demand work regardless
    idleComputeSec: number        // INSTA_OSS_IDLE_COMPUTE_SEC 300 (0 disables the sweep for compute)
    idleDbSec: number             // INSTA_OSS_IDLE_DB_SEC      600 (0 disables for databases)
    sweepSec: number              // INSTA_OSS_SWEEP_SEC        30
    createGraceSec: number        // INSTA_OSS_CREATE_GRACE_SEC 600
    stopGraceSec: number          // INSTA_OSS_STOP_GRACE_SEC   10
    stopGraceDbSec: number        // INSTA_OSS_STOP_GRACE_DB_SEC 30
    wakeTimeoutSec: number        // INSTA_OSS_WAKE_TIMEOUT_SEC 60 (router hold bound and scheduler readiness bound)
    wakeProtectSec: number        // INSTA_OSS_WAKE_PROTECT_SEC 60
    ramFloorPct: number           // INSTA_OSS_RAM_FLOOR_PCT    15 (0..90; 0 disables the pressure pass, on the sweep and on the wake path)
    memBudgetMb: number | null    // INSTA_OSS_MEM_BUDGET_MB    null (synthetic total for tests/e2e; null = /proc/meminfo)
    alwaysOnDefault: boolean      // INSTA_OSS_ALWAYS_ON_DEFAULT false
  }
  data: {
    helperImage: string           // INSTA_OSS_HELPER_IMAGE     node:22-alpine
    fork: ForkMode                // INSTA_OSS_FORK             auto
    migrate: boolean              // INSTA_OSS_DATA_MIGRATE     true
    sweepOrphans: boolean         // INSTA_OSS_SWEEP_ORPHANS    false (boot deletes data dirs whose ref matches no branch; the installer never sets it, 04 §G)
  }
  services: { maxPerType: number } // INSTA_OSS_MAX_SERVICES_PER_TYPE 5
  templates: {
    volumeGib: number             // INSTA_OSS_TEMPLATE_VOLUME_GIB 10
    healthTimeoutMs: number       // INSTA_OSS_TEMPLATE_HEALTH_TIMEOUT_MS 90000
    healthPollMs: number          // INSTA_OSS_TEMPLATE_HEALTH_POLL_MS 3000
  }
}

/** Pure over env/argv, except: in server mode with INSTA_OSS_SECRET unset it reads or creates <dataDir>/secret. Throws on invalid values. Never mutates process.env. Returns a frozen object. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): Config
/** Which daemon host a Host header names: 'api' for api.<domain> (and, in local mode, 127.0.0.1 / localhost / [::1] / host.docker.internal / the bridge gateway / any IP literal, with or without port), 'console' for console.<domain>, else null. Strips :port and a trailing dot, lowercases. The router's local-mode fallback for a Host that is neither a daemon host nor in the route table is ALSO Fastify (decision 4); isDaemonHost itself stays strict. */
export function isDaemonHost(cfg: Config, hostHeader: string | undefined): 'api' | 'console' | null
/** Every INSTA_OSS_* key loadConfig reads (test/install.test.ts asserts install.sh writes each). */
export const CONFIG_KEYS: readonly string[]
```

Precedence for `port`: `INSTA_OSS_PORT`, then `--port <n>`, then 8080 (today's `src/main.ts:12-13`). `bool()` accepts `1|true|0|false`. Unknown `INSTA_OSS_*` keys are ignored. `extraListenHosts` is filled by `main.ts` (it runs `docker network inspect`), never by `loadConfig`.

## 4. `src/types.ts` (final; the scaffold lands this text)

```ts
// src/types.ts
export type Decision = 'allow' | 'deny' | 'approve'
// ---- region WP3 (scheduler): 'service.upgrade' added (cloud gates PUT limits on it, platform server.ts:2024 comment + agent guard) ----
export const GATED_ACTIONS = ['secrets.read', 'secrets.write', 'storage.read', 'storage.write', 'storage.delete', 'deploy', 'project.delete', 'branch.delete', 'service.add', 'service.remove', 'service.setAccess', 'service.rename', 'service.upgrade'] as const
export type GatedAction = (typeof GATED_ACTIONS)[number]
export const isGatedAction = (a: string): a is GatedAction => (GATED_ACTIONS as readonly string[]).includes(a)

export type ManagedDbType = 'redis' | 'mysql' | 'mongodb'
export type ObservedComponent = 'db' | 'compute' | ManagedDbType

// ---- region WP3 (scheduler) ----
export type ServiceKind = 'compute' | 'postgres' | 'managed'
/** `${branchId}:${serviceId}` e.g. `<uuid>:cp-web`, `<uuid>:pg-db`, `<uuid>:rd-cache`. */
export type ServiceKey = string
export interface ServiceLimits { cpu: number; memoryMb: number }
/** Project-level per-service settings keyed by service id (cp-<group> | rd-/my-/mo-<name>). Postgres settings are per branch (Branch.databases[id]). */
export interface ServiceSettings {
  alwaysOn?: boolean            // undefined = cfg.sleep.alwaysOnDefault
  limits?: ServiceLimits        // undefined = no cgroup ceiling
  createdAt?: number
  port?: number                 // WP5: default listen port recorded by services add / template deploy
  templateDeploymentId?: string // WP5
  templateCode?: string         // WP5
  templateModified?: boolean    // WP5
}
// ---- end region WP3 ----

export interface Project {
  id: string; name: string; status: string; createdAt: number; computeGroups?: string[]
  refSlug?: string
  computeVolumes?: Record<string, { id: string; sizeGib: number }>
  managedServices?: Array<{ id: string; type: ManagedDbType; name: string; createdAt: number; dataId?: string }>   // dataId: WP4 (8 hex, minted at add, backfilled by migration)
  // ---- region WP5 (templates/parity) ----
  dbServices?: Array<{ id: string; name: string; dataId: string; createdAt: number; templateDeploymentId?: string }>        // id = `pg-${name}`; oldest gets the canonical DATABASE_URL alias
  storageServices?: Array<{ id: string; name: string; createdAt: number; public?: boolean }>                             // id = `st-${name}`
  // ---- end region WP5 ----
  // ---- region WP3 (scheduler) ----
  serviceSettings?: Record<string, ServiceSettings>
  // ---- end region WP3 ----
}

export interface UserSecret { name: string; value: string; branch: string | null; service?: string | null }

export interface Branch {
  id: string; projectId: string; name: string; isDefault: boolean; status: string
  ref?: string
  network: string
  // DEPRECATED (WP5): dbUrl, bucket, s3, storagePublic are migrated into databases/buckets by state.migrateState and never read afterwards.
  dbUrl?: string; bucket?: string; s3?: Record<string, string>; storagePublic?: boolean
  cloneOf: string | null
  createdAt: number
  dbVolumeGib?: number
  apps: Record<string, {
    image: string; port: number
    hostPort?: number             // LOCAL mode only (loopback-published); absent in server mode
    url: string                   // router URL: https://<host> | http://<host>:<port>
    host?: string                 // WP2: bare minted hostname (bounded label, decision 55); recorded at deploy, never re-derived
    updatedAt?: number
    desiredState?: 'running' | 'stopped' | 'suspended'
    sleptAt?: number | null       // WP3: set when the scheduler stopped it (idle | memory | branch-create); cleared on wake/start/deploy
  }>
  managed?: Record<string, { password: string; sleptAt?: number | null; host?: string /* WP2: minted lane hostname, recorded at provision */ }>
  // ---- region WP5 (templates/parity) ----
  databases?: Record<string, {    // keyed by service id (pg-<name>)
    url: string                   // container-host form: postgres://postgres:<pw>@<container>:5432/app (the engine rewrites host:port to the lane at read time)
    container: string             // io-<ref>-pg-<name> (legacy: io-<ref>-pg until migrated)
    dataId: string                // directory key under <dataDir>/pg/<ref>/
    host?: string                 // WP2: minted lane hostname (bounded label, decision 55), recorded at provision
    sleptAt?: number | null       // WP3
    scaleToZero?: boolean         // WP3: default true; PATCH database/settings {scaleToZero}
    idleTimeoutSec?: number       // WP3: PATCH {idleTimeout}; undefined = cfg.sleep.idleDbSec; 0 = never
    limits?: ServiceLimits        // WP3: PATCH {cpu, memory}
  }>
  buckets?: Record<string, { bucket: string; env: Record<string, string>; public?: boolean }>   // keyed by st-<name>; bucket = io-<ref>-<name> (legacy io-<ref>)
  bindings?: Array<{ envName: string; target: string; source: string; sourceName: string }>    // target 'compute/<group>', source '<type>/<name>'
  // ---- end region WP5 ----
  // ---- region WP2 (router) ----
  lanes?: Record<string, number>  // serviceId -> host listen port (local mode every DB; server mode mysql only)
  // ---- end region WP2 ----
  // ---- region WP4 (data dir) ----
  dataVersion?: 1                 // undefined = legacy docker-volume layout, migrated at boot
  // ---- end region WP4 ----
}

export interface Approval { id: string; projectId: string; action: GatedAction; status: 'pending' | 'granted' | 'denied' | 'consumed'; requestedAt: string; decidedAt: string | null }
export interface AuditEvent { id: string; projectId: string; branch: string | null; source: 'agent' | 'resource' | 'govern'; kind: string; payload: unknown; dedupKey: string | null; createdAt: string }

// ---- region WP2 (router) ----
export interface CustomDomainEntry { hostname: string; projectId: string; branchId: string; group: string; createdAt: number }
// ---- end region WP2 ----

// ---- region WP5 (templates/parity) ----
export interface TemplateDeploymentRecord {
  id: string; projectId: string; branchId: string
  templateCode: string; templateVersion: string; templateSource: string
  status: 'running' | 'succeeded' | 'failed' | 'partial'
  step: 'create_services' | 'write_variables' | 'deploy' | 'health_check'
  services: Record<string, {
    serviceName: string; serviceId?: string; type: 'web' | 'postgres'
    image?: string; port?: number; healthcheck?: string; volumeGib?: number; alwaysOn?: boolean
    env: Record<string, { source: 'fixed' | 'generated' | 'platform' | 'required' | 'optional'; generator?: string; value?: string; ref?: string }>
    url?: string; state: 'pending' | 'created' | 'deployed' | 'healthy' | 'failed'
  }>
  manifestDigest: string; digestEpoch: 2; claimToken: string
  error?: string; logsTail?: string
  createdAt: string; updatedAt: string
}
// ---- end region WP5 ----

// ---- adapters (single signature; owners: postgres body WP4, garage body WP5, compute/manageddb bodies WP2+WP3+WP4 by marked lines) ----
export interface PgTarget { container: string; network: string; dataDir: string }
export interface DatabaseAdapter {
  /** Fresh instance (initdb) on an EMPTY dataDir; returns the container-host URL with a freshly minted password. */
  provision(t: PgTarget, opts?: { publishLoopback?: boolean; limits?: ServiceLimits }): Promise<{ url: string }>
  /** File-level fork: CHECKPOINT (when running) + reflink copy, or pg_basebackup fallback (wakes the source through ensureSourceRunning). Returns the clone's URL (source password preserved). */
  fork(src: PgTarget & { url: string }, dst: PgTarget, opts?: { publishLoopback?: boolean; limits?: ServiceLimits; ensureSourceRunning?: () => Promise<void> }): Promise<{ url: string; method: 'reflink' | 'basebackup'; ms: number }>
  query(container: string, sql: string): Promise<string>
  /** Container only (rm -f -v); the engine removes the directory. */
  destroy(container: string): Promise<void>
  rename?(container: string, to: string): Promise<void>
}

export interface ComputeAdapter {
  supportsVolumes?: boolean
  deploy(ref: string, opts: {
    image: string; port: number; envVars: Record<string, string>; network?: string; group: string; start?: boolean
    hostPort?: number                 // LOCAL mode only: publish 127.0.0.1:<hostPort>:<port>; undefined = publish nothing
    hostAliases?: string[]            // each becomes --add-host <name>:host-gateway
    volume?: { hostPath: string }     // WP4: `--mount type=bind,src=<hostPath>,dst=/data` (decision 56); scaffold interim: a docker named-volume name mounted with `-v <name>:/data`
    limits?: ServiceLimits            // --cpus / --memory / --memory-swap
  }): Promise<{ url: string }>        // informational; the engine records the router URL. The container is created with `--init` (decision 60).
  destroy(ref: string): Promise<void>
  start?(ref: string, group: string): Promise<void>
  stop?(ref: string, group: string, opts?: { graceSec?: number }): Promise<void>
  suspend?(ref: string, group: string): Promise<void>
  // ---- region WP3 (scheduler): `state?` exists in the scaffold for today's liveState only; WP3 DELETES it (decision 53) and liveState reads scheduler.stateOf ----
  state?(ref: string, group: string): Promise<string>
  // ---- end region WP3 ----
  rename?(ref: string, from: string, to: string): Promise<void>
}

export interface ManagedDbTarget { container: string; network: string; type: ManagedDbType; name: string; password: string; dataDir: string }
export interface ManagedDbAdapter {
  provision(t: ManagedDbTarget, opts?: { publishLoopback?: boolean; limits?: ServiceLimits }): Promise<void>
  destroy(container: string): Promise<void>
  rename(container: string, to: string): Promise<void>
}

export type ObjectListing = { objects: Array<{ key: string; size: number; lastModified: string; etag: string }>; nextCursor?: string }
export interface StorageAdapter {
  provision(ref: string, network: string, name: string): Promise<{ bucket: string; env: Record<string, string> }>
  cloneInto(srcBucket: string, dstBucket: string, network: string): Promise<void>
  destroy(bucket: string, network: string): Promise<void>
  setAccess?(bucket: string, network: string, isPublic: boolean): Promise<void>
  listBucketObjects?(env: Record<string, string>, opts: { prefix?: string; cursor?: string; limit: number }): Promise<ObjectListing>
  presignObjectGet?(env: Record<string, string>, key: string, disposition: 'attachment' | 'inline'): Promise<{ url: string; expiresAt: string }>
  presignObjectPost?(env: Record<string, string>, key: string, contentType: string, size: number): Promise<{ url: string; fields: Record<string, string>; expiresAt: string }>
  removeObject?(env: Record<string, string>, key: string): Promise<void>
  removeObjects?(env: Record<string, string>, keys: string[]): Promise<{ deleted: number; failed: Array<{ key: string; message: string }> }>
}

// ---- region WP4 (data dir) ----
/** Every method runs in-process first and falls back to the helper container (`fsclone.cjs` verbs probe | clone | rm | stat | isempty) on EACCES|EPERM on Linux: a PGDATA chowned 0700 to the image's postgres uid is unreadable to an unprivileged daemon, so `hasPgData`/`isEmptyOrMissing` need the helper exactly like `clonePostgres`/`remove`. On darwin the copy engine is `/bin/cp -c -a` (decision 23). `probe()` throws only when the data dir itself is unwritable; a failed clone attempt of any kind yields `reflink: false` plus `warning` (decision 23). */
export interface DataDirOps {
  probe(): Promise<{ dataDir: string; reflink: boolean; engine: 'inprocess' | 'helper' | 'cp-c'; warning?: string }>
  ensureDir(path: string, mode: number): Promise<void>
  clonePostgres(src: string, dst: string): Promise<{ method: 'reflink'; ms: number }>   // throws NoReflinkError
  cloneTree(src: string, dst: string): Promise<{ method: 'reflink' | 'copy'; ms: number }>
  remove(path: string): Promise<void>
  copyFromContainerVolume(source: { container?: string; volume?: string }, containerPath: string, dst: string): Promise<void>
  hasPgData(dir: string): Promise<boolean>        // helper fallback on EACCES (verb `stat`)
  isEmptyOrMissing(dir: string): Promise<boolean> // helper fallback on EACCES (verb `isempty`)
}
export class NoReflinkError extends Error {}
// ---- end region WP4 ----
```

## 5. `src/state.ts` (WP1 rewrites; regions for WP2 and WP5)

```ts
// src/state.ts
export interface IdentityState {
  admin: { id: string; email: string; name: string; passwordHash: string; createdAt: string; updatedAt: string } | null
  previousAdminId?: string
  sessions: Array<{ id: string; tokenHash: string; userId: string; createdAt: string; updatedAt: string; expiresAt: string; ipAddress: string; userAgent: string }>
  tokens: Array<{ id: string; name: string; prefix: 'insta_'; keyHash: string; orgId: null; scopes: string[]; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string }>
}
export const EMPTY_IDENTITY: IdentityState

export interface State {
  projects: Record<string, Project>
  branches: Record<string, Branch>
  policies: Record<string, Partial<Record<GatedAction, Decision>>>
  approvals: Approval[]
  events: AuditEvent[]
  userSecrets: Record<string, UserSecret[]>
  identity?: IdentityState                                   // WP1: absent in local mode and before setup
  rev: number                                                // WP2: bumped by every ROUTING-class saveState (router table cache key; decision 54)
  auditRev: number                                           // WP1: bumped by audit-class writes (emit, touchLater, markSlept); the router ignores it
  customDomains: Record<string, CustomDomainEntry>           // WP2: key = normalized hostname
  laneReservations?: Record<string, string>                  // WP2: lane port -> branchId, written synchronously by allocLanes before provisioning awaits; released by compensation, superseded by branch.lanes (decision 51)
  templateDeployments: Record<string, TemplateDeploymentRecord> // WP5
}

export const EVENTS_CAP = 5000                                 // WP1: emit keeps the newest EVENTS_CAP events (decision 54)
export function initStatePath(p: string): void                 // main.ts, --reset-admin, and test/fakes.ts resetFakes()/makeEngine() call it before the first loadState; INSTA_OSS_STATE env stays the fallback. One state path per test process (vitest pool 'forks' isolates files); two configs in one test file share statePath.
export function statePath(): string
export function stateRev(): number                             // WP1: current rev WITHOUT cloning (stat-keyed like loadState); the router's table cache key
export function onSave(cb: (s: State, kind: 'routing' | 'audit') => void): void   // WP1: called after every saveState; the router subscribes to rebuild its table and reconcile listeners
export function loadState(): State                             // stat-keyed parse cache; applies migrateState (WP5) to the parsed document; returns a structuredClone (never on the request path: the router uses stateRev() + Route fields)
export function saveState(s: State, opts?: { audit?: boolean }): void   // tmp + rename; bumps rev (default) or auditRev (audit: true)
export function mutate<T>(fn: (s: State) => T, opts?: { audit?: boolean }): T   // throws if fn returns a thenable
export function acquireLock(dataDir: string): void             // <dataDir>/instad.lock heartbeat (20 s utimes, stale at 60 s); a fresh lock is retried every 2 s for up to 60 s before throwing (container restart case)
export function releaseLock(): void
export function touchLater(fn: (s: State) => void): void       // coalesced 30 s buffer for low-rate audit fields (token lastUsedAt, session slide); flushes with { audit: true }
export function migrateState(s: State): State                  // WP5: pure; legacy dbUrl/bucket/s3/storagePublic -> dbServices/storageServices/databases/buckets (ids pg-db, st-store, container io-<ref>-pg, dataId 'db')
```

Rules: activity stamps, in-flight markers, RSS samples, rate-limiter buckets and wake singleflight maps never touch state.json. `mutate()` callbacks are synchronous. Every write goes through `saveState`. Audit-class writes (`emit`, `touchLater`, `sleptAt` via `markSlept`) pass `{ audit: true }` and bump `auditRev` only, so they never force a router table rebuild; `emit` trims `events` to the newest `EVENTS_CAP`. `--reset-admin` takes the lock like a boot (01 §8).

## 6. `test/fakes.ts` (scaffold writes; every fake-adapter test imports it; each WP appends recorders in its region)

```ts
// test/fakes.ts
import type { DatabaseAdapter, ComputeAdapter, StorageAdapter, ManagedDbAdapter, DataDirOps } from '../src/types'
import type { Config } from '../src/config'
import { loadConfig } from '../src/config'
import { Engine, type EngineOptions } from '../src/engine'

export const calls: string[] = []
export const db: DatabaseAdapter = {
  provision: async (t) => { calls.push(`db.provision:${t.container}`); return { url: `postgres://postgres:pw@${t.container}:5432/app` } },
  fork: async (src, dst) => { calls.push(`db.fork:${src.container}->${dst.container}`); return { url: src.url.replace(src.container, dst.container), method: 'reflink', ms: 1 } },
  query: async (container, sql) => { /* today's canned answers (server.test.ts:19-36), keyed by container instead of ref */ },
  destroy: async (container) => { calls.push(`db.destroy:${container}`) },
  rename: async (container, to) => { calls.push(`db.rename:${container}->${to}`) },
}
export const compute: ComputeAdapter = {
  supportsVolumes: true,
  deploy: async (ref, o) => {
    calls.push(`deploy:${ref}:${o.group}:${o.image}:s3=${o.envVars.BUCKET_NAME ?? 'none'}:p=${o.port}->${o.hostPort}`)
    if (o.start === false) calls.push(`deploy.nostart:${ref}:${o.group}`)
    if (o.volume) calls.push(`deploy.volume:${ref}:${o.group}:${o.volume.hostPath}`)
    if (o.hostAliases?.length) calls.push(`deploy.aliases:${ref}:${o.group}:${o.hostAliases.join(',')}`)
    if (o.limits) calls.push(`deploy.limits:${ref}:${o.group}:${o.limits.cpu}/${o.limits.memoryMb}`)
    return { url: `http://localhost:${o.hostPort}` }
  },
  destroy, start, stop (records `compute.stop:<ref>:<group>:<graceSec ?? ''>`), suspend, rename,
  // scaffold interim only: `state: async () => 'running'`; WP3 deletes it (decision 53) and makes deploy/start/stop/suspend/destroy update FakeRuntime.containers (deploy -> running or created when start === false; start -> running; stop -> exited; suspend -> paused; destroy -> removed), so liveState reads the same store the scheduler reads
}
export const storage: StorageAdapter = { provision: async (ref, _n, name) => { calls.push(`st.provision:${ref}:${name}`); return { bucket: `io-${ref}-${name}`, env: {...today's bundle with BUCKET_NAME io-<ref>-<name>} } }, cloneInto(srcBucket, dstBucket) records `st.clone:<src>-><dst>`, destroy(bucket), setAccess(bucket) records `st.access:<bucket>:<bool>`, object ops as today }
export const managed: ManagedDbAdapter = { provision: async (t) => { calls.push(`md.provision:${t.container}`) }, destroy(container) records `md.destroy:<container>`, rename(container, to) }
export const data: DataDirOps = { probe: async () => ({ dataDir: '/tmp/fake', reflink: true, engine: 'inprocess' }), ensureDir records `data.ensure:<path>`, clonePostgres records `data.clone:<src>-><dst>`, cloneTree records `data.cloneTree:<src>-><dst>`, remove records `data.remove:<path>`, copyFromContainerVolume, hasPgData: async () => true, isEmptyOrMissing: async () => true }
export function testConfig(over: Record<string, string> = {}): Config   // loadConfig({ INSTA_OSS_MODE: 'local', INSTA_OSS_DATA_DIR: tmp, INSTA_OSS_STATE: tmp/state.json, INSTA_OSS_SCHEDULER: '0', ...over }, [])
export function serverConfig(over = {}): Config                        // mode server, INSTA_OSS_DOMAIN example.test, INSTA_OSS_SECRET 's'.repeat(32), INSTA_OSS_AUTH 1
export class FakeRuntime implements Runtime { containers: Map<string, { state; id }>; ... }   // WP3 region: the single fake state store (containers, stats, memory, probe results)
export class FakeUpstream implements UpstreamLike { addrs: Map<container, { host; port }>; resolve; forget (records `upstream.forget:<container>`); dial }   // WP3 region
export function makeEngine(cfg = testConfig(), extra: Partial<EngineOptions> = {}): Engine   // initStatePath(cfg.statePath); new Engine(db, compute, storage, managed, { cfg, data, upstream: new FakeUpstream(), scheduler: FakeRuntime-backed unstarted scheduler sharing that upstream (WP3 region), ...extra })
export function resetFakes(): void   // calls.length = 0, fresh tmp state, initStatePath(<tmp>/state.json), FakeRuntime/FakeUpstream cleared
```

`test/server.test.ts` keeps its tests; the scaffold replaces the inline fakes with `import { calls, makeEngine, ... } from './fakes'` and `app = buildServer(makeEngine())`. Handles replace refs in the recorded strings (`db.provision:<container>` for today's `db.provision:<ref>`, `db.fork:<src>-><dst>` for `db.clone`, `st.provision:<ref>:<name>`, `st.clone:<srcBucket>-><dstBucket>`, `st.access:<bucket>:<bool>`, `md.provision:<container>`, `md.rename:<container>-><to>`, `md.destroy:<container>`), so the scaffold updates exactly these existing assertions and nothing else (line numbers are the pre-scaffold file's): 116 `db.provision:io-demo-main-pg-db`, 117 `st.provision:demo-main:store`, 126 `db.fork:io-demo-main-pg-db->io-demo-feat-pg-db`, 127 `st.clone:io-demo-main-store->io-demo-feat-store`, 688 `st.access:io-demo-main-store:true`, 959 and 1003 `md.provision:io-demo-main-rd-cache` / `io-demo-feat-rd-cache`, 1034-1035 `md.rename:io-demo-main-rd-cache->io-demo-main-rd-kv` (and feat), 1055-1056 `md.destroy:io-demo-main-rd-kv` (and feat), 1272 `db.fork:io-demo-main-pg-db->io-demo-feat-pg-db` (the fake `fork` records only `db.fork`, never a `db.provision` of the destination); the postgres container name: 354 endpoint `io-demo-main-pg-db:5432`, 1214 docker-ps mock row `io-demo-main-pg-db\trunning`; the fake DSN in §6 form: 145 and 1269 `postgres://postgres:pw@io-demo-main-pg-db:5432/app`, 1240 `postgres://postgres:pw@io-demo-feat-pg-db:5432/app`; the fake `BUCKET_NAME` = bucket handle: 146 `io-demo-main-store`, 129 and 342 `s3=io-demo-feat-store`, 466 `s3=io-demo-main-store`, 1072 `st.list:io-demo-main-store:...`, 1086 `io-demo-feat-store/a.txt`, 1088 `st.presignGet:io-demo-feat-store:...`, 1098 `st.presignPost:io-demo-main-store:...`, 1109 `st.rm:io-demo-main-store:a.txt`; the 501 sweep: 208 drops `/tokens` from the ad-hoc loop and 224 `NOT_CLOUD_WP1` gains `['GET', '/tokens']` so WP1 owns every `/tokens` row. `deploy.volume:<ref>:<group>:io-<ref>-data-<id>` strings are unchanged (the interim `hostPath` is the named-volume name). WP5 later updates the assertions its structural change breaks (listed in 05). Nobody else edits existing assertions except at their listed lines.

## 7. Engine seams

Constructor: `new Engine(db, compute, storage, managedDb, opts?: EngineOptions)` with

```ts
export interface EngineOptions {
  cfg?: Config                       // default loadConfig()                       (scaffold)
  data?: DataDirOps                  // scaffold default: a no-op DataDirOps constant; WP4 default: new DataDir(cfg) (lazy; no I/O at construction)   (scaffold field, WP4 body)
  upstream?: UpstreamLike            // default new Upstream(cfg); ONE instance shared by DockerRuntime, Scheduler and Router (decision 57)   (WP3)
  scheduler?: Scheduler              // default new Scheduler(new DockerRuntime(cfg, upstream), cfg, () => this.serviceTargets(), hooks, upstream) NOT started   (WP3)
  router?: { invalidate(): void }    // default no-op; the engine calls it after every mutate that changes hosts or lanes (decision 54, 02 §0); `engine.router` is a public assignable field because main.ts constructs the Router after the engine and sets it   (scaffold field, WP2 use)
  templates?: TemplateCatalog        // default new TemplateCatalog(cfg.templatesDir) (WP5)
}
```

Naming helpers (WP5 region, shared by all): `pgContainerName(ref, name) = io-<ref>-pg-<name>`, `bucketName(ref, name) = io-<ref>-<name>`, `managedContainerName` as today, `appContainerName(ref, group) = io-<ref>-app-<group>`. Handles are READ from state when present (`databases[id].container`, `buckets[id].bucket`), derived only at provision.

### 7.1 Signatures per package (each in its own engine region)

WP2 (router):
```ts
hostFor(kind: 'compute' | 'postgres' | ManagedDbType, name: string, ref: string): string   // FQDN = labelFor(...) + '.' + cfg.domain (delegates to table.ts hostFor(kind, name, ref, cfg.domain)); the label is bounded to 63 chars by truncation + '-' + 6 hex sha256 (decision 55); the result is recorded on the row (apps[g].host, databases[id].host, managed[id].host) and read from there afterwards
labelFor(kind, name, ref): string                                                           // the bare bounded label only (what assertHostFree takes); table.ts exports the same function
laneAddress(project: Project, branch: Branch, serviceId: string): { host: string; port: number; tls: boolean }
serviceUrl(project: Project, branch: Branch, group: string): string                       // https://<host> | http://<host>:<port>; deterministic before deploy
mintedHost(project: Project, branch: Branch, group: string): string | undefined            // the bare minted hostname deployLocked records on apps[g].host (labelFor(...) + '.' + cfg.domain, decision 55); scaffold: undefined
allocLanePort(): number                                                                    // lowest port in cfg.lanes.portRange that is free in every branch.lanes AND state.laneReservations AND passes a bind probe (net.createServer().listen then close); skips busy ports
allocLanes(project: Project, branchId: string, serviceIds: string[]): Record<string, number>   // called by provisionBranch under serialize('provision'); writes state.laneReservations[port] = branchId in ONE synchronous mutate before any await (decision 51); releaseLanes(branchId) on compensation
releaseLanes(branchId: string): void                                                       // drops every laneReservations entry owned by branchId (compensation path); the branch row's `lanes` supersedes the reservations on success
containerize(env: Record<string, string>): Record<string, string>                          // local: 127.0.0.1 -> host.docker.internal in DSN/endpoint values; server: identity
hostAliasesFor(project: Project, branch: Branch): string[]                                 // server mode: every minted FQDN on the branch + `api.<domain>` + `s3.<domain>` + `<bucket>.s3.<domain>` for every bucket of the branch + custom domains of its groups + host.docker.internal, all `:host-gateway` (an app's AWS_ENDPOINT_URL_S3 and INSTA_API_URL must resolve to the box from inside a container, which public DNS cannot guarantee on sslip.io, NAT or private IPs); local mode: minted FQDNs + host.docker.internal as before
localHostPort(branch: Branch, group: string, opts: { hostPort?: number; port: number }): number | undefined   // local mode: today's allocator; server: undefined
assertHostFree(label: string): void                                                        // 409 on collision; runs inside the reservation mutate (decision 51)
assertHostLabel(label: string): void                                                       // 400; operator-supplied custom-domain hostnames ONLY (minted labels are bounded, never rejected)
setComputeDomain / computeDomainStatus / listComputeDomains / removeComputeDomain(projectId, { hostname, branch?, group? })
releaseDomainsFor(projectId: string, branchId?: string, group?: string): void
ownsHostname(host: string): boolean                                                        // table.hosts() membership (ask endpoint)
rowNetwork(project, branch, row): { domain?: string; endpoint?: string }                   // services() helper
```

WP3 (scheduler):
```ts
readonly scheduler: Scheduler
serviceKey(branch: Branch, serviceId: string): ServiceKey
targetOf(key: ServiceKey): ServiceTarget | undefined
serviceTargets(): ServiceTarget[]
effectiveAlwaysOn(project: Project, branch: Branch, serviceId: string): boolean
wake(key: ServiceKey, opts: { door: 'traffic' | 'api' | 'deploy' }): Promise<void>       // throws ServiceStoppedError | WakeTimeoutError
sleep(key: ServiceKey, reason: 'idle' | 'memory' | 'branch-create'): Promise<boolean>
touch(key: ServiceKey): void
stateOf(key: ServiceKey): 'running' | 'asleep' | 'stopped' | 'paused' | 'starting' | 'none'   // 'asleep' while a sleep promise is pending (decision 52)
liveState(key: ServiceKey): 'running' | 'stopped' | 'suspended' | 'none'                  // = stateOf mapped by section 13; the ONLY runtime-state read the routes use (decision 53)
withOp<T>(keys: ServiceKey[], fn: () => Promise<T>): Promise<T>                            // THE per-key operation lock (decision 52): exclusive per key, sorted acquisition, re-entrant within the acquiring async context, sweep-visible; delegates to scheduler.withOp. Wraps deploy/restart/lifecycle/createBranch/teardown/service add-remove-rename/volume ops/setServiceLimits/ensurePgAwake; the scaffold body is today's serialize() per key
holds(key: ServiceKey): number                                                             // in-flight HTTP requests + TCP splices on the key (router bookkeeping via beginHold/endHold); evictForRoom never picks a key with holds > 0
beginHold(key: ServiceKey): void; endHold(key: ServiceKey): void
afterDeploy(key: ServiceKey, o: { started: boolean; startAsleep?: boolean }): void       // onUp / onAsleep / onStopped
sleepNewBranch(project: Project, branch: Branch): Promise<void>                            // pg + managed keys, unless always-on
healthOverlay(dockerState: string | undefined, desired: string, sleptAt: number | null | undefined, key: ServiceKey): { status: string; machines: number; failing: number }
rowRuntime(key: ServiceKey): string | undefined                                            // services() runtime column
limitsFor(project: Project, serviceId: string): ServiceLimits | undefined
setAlwaysOn(projectId, serviceId, enabled): Promise<{ service }>
serviceLimits(projectId, serviceId): { limits: ServiceLimits; cap: { cpu: 8; memoryMb: 8192; volumeGib: 100 }; volume?: { sizeGib; mountPath: '/data' } }
setServiceLimits(projectId, serviceId, { memoryMb, cpu? }): Promise<{ service; limits; cap; changed: boolean }>
private ensurePgAwake(project: Project, branch: Branch, serviceId: string): Promise<void>  // wake(door 'api') before a management db.query
private assertPgAwake(project: Project, branch: Branch, serviceId: string): void            // throws 'database is sleeping: ...' before an observability db.query
```

WP4 (data dir):
```ts
readonly data: DataDirOps
layout(): { pg(ref, dataId): string; vol(ref, volId): string; md(ref, type, dataId): string; branchRoots(ref): string[] }
volumeMount(project: Project, branch: Branch, group: string): { hostPath: string } | undefined   // ensureDir 0o777 first
forkVolumes(project: Project, source: Branch, target: Branch): Promise<Array<{ group: string; method: 'reflink' | 'copy'; ms: number }>>
migrateLegacyData(): Promise<{ migrated: string[]; skipped: string[]; failed: Array<{ ref: string; error: string }> }>
dataCapabilities(): { dataDir: string; reflink: boolean; engine: 'inprocess' | 'helper' | 'cp-c'; warning?: string }   // = the boot probe result (decision 23); `warning` set when the probe degraded to copy
booting: boolean   // true while migrateLegacyData runs; the sweep is inert
```

WP5 (templates/parity):
```ts
addDbService(projectId, name, opts?: { templateDeploymentId?: string }): Promise<ServiceRow>
removeDbService(projectId, serviceId): Promise<void>
renameDbService(projectId, serviceId, newName): Promise<ServiceRow>
addStorageService(projectId, name, opts?: { public?: boolean }): Promise<ServiceRow>
removeStorageService(projectId, serviceId): Promise<void>
renameStorageService(projectId, serviceId, newName): Promise<ServiceRow>
addComputeService(projectId, name, volumeGib?, opts?: { alwaysOn?: boolean; port?: number; templateDeploymentId?: string; templateCode?: string }): ServiceRow
dbTarget(projectId, branchName?, group?): { project; branch; serviceId; container; url }   // sole postgres, or ?group=, 400 'multiple postgres services - specify one: a, b', 404 with the services-add hint
credentials(projectId, serviceId, branchName?): Record<string, string>                     // canonical bundle of one service on one branch (lane-form DSN)
envFor(project: Project, branch: Branch, group: string): Record<string, string>            // minted (suffixed + canonical) + user secrets + bindings, before containerize
setBinding(projectId, branchName, b): void; unsetBinding(projectId, branchName, envName, target): void; listBindings(projectId, branchName, target?): Binding[]
serviceOf(projectId, sid): { type; name }                                                  // via manageddb.parseServiceId (qualifier stripped) + registrations
resolveSid(projectId, sid, branchQuery?): { branch: Branch; serviceId: string }             // decision 49: `<branchId>:<serviceId>` names the branch (404 when gone or foreign), else ?branch, else the default; used by EVERY /services/:sid/* route
qualifiedId(branch: Branch, serviceId: string): string                                    // services() row id: bare on the default branch, `<branchId>:<serviceId>` elsewhere
migrateLegacyContainers(): Promise<void>                                                   // no-op after WP4 (WP4's boot migration renames); kept as a best-effort docker rename for installs that skip the data migration
private dbSecretsFor / storageSecretsFor / bindingsFor
```

### 7.2 Edit points inside existing methods (the only allowed in-method edits)

| Method | Edit | Owner |
|---|---|---|
| `provisionBranch(project, name, isDefault, source: Branch \| null, branchId: string)` | WP5 rewrites the method, which runs inside `serialize('provision')` (decision 51); `branchId` is minted by the caller (`createProject`/`createBranch`) so `withOp` and the lane reservation have an owner from the start; network; one synchronous `mutate`: `assertHostFree` for every label the branch will mint + `lanes = this.allocLanes(project, branchId, ids)` (WP2 hook, returns `{}` until WP2; writes `laneReservations`); for each `dbServices` entry: `dataDir = this.layout().pg(ref, dataId)` (WP4 hook; scaffold interim returns `''`); `source` null -> `db.provision({container, network, dataDir}, { publishLoopback: cfg.mode === 'local', limits: this.limitsFor(...) })`, else `db.fork({...srcHandle, url: source.databases[id].url}, dst, { ..., ensureSourceRunning: () => this.wake(srcKey, {door:'api'}) })`; then buckets (`storage.provision(ref, network, name)` + `setAccess` when public), then managed (`managedDb.provision({..., dataDir: layout.md(...)})`); compensation removes containers and directories (`data.remove`) and `releaseLanes(branchId)`; row gets `id: branchId`, `databases`, `buckets`, `lanes`, `dataVersion: 1` (the same mutate drops the branch's `laneReservations` entries); then `scheduler.register(keys)` (WP3 hook); `router.invalidate()` (WP2). A docker `network create` failure whose stderr matches `non-overlapping IPv4 address pool` throws the 507 message in 05 §4 | WP5 writes; calls WP2 `allocLanes`, WP4 `layout()/data.*`, WP3 `scheduler.register` |
| `createBranch` | WP5 rewrites: `branchId = randomUUID()` first; `withOp(keysOf(src) ∪ keysOf(dst, branchId))` (WP3 hook); `provisionBranch(project, name, false, source, branchId)`; `forkVolumes(project, source, target)` (WP4 hook) BEFORE the redeploy loop; `storage.cloneInto` per bucket; redeploy loop with `startAsleep: this.startAsleepFor(project, target, group)` (WP3 hook: scaffold body `false`, WP3 body `!effectiveAlwaysOn(project, target, 'cp-' + group)`); bindings + user secrets copy; `sleepNewBranch(project, target)` (WP3 hook); emit `branch.created` with `{from, db:{method,ms}, volumes:[...]}` | WP5 writes; hooks from WP2/WP3/WP4 |
| `deployLocked` | `deploy()`/`restart()` enter it through `withOp([cpKey], ...)` instead of `serialize(${b.id}:${group})` (decision 52; the scaffold's `withOp` body is that same chain, WP3 swaps it for the scheduler's lock); inside, replace the inline `compute.deploy` argument object with: `hostPort: this.localHostPort(b, group, opts)` (WP2), `hostAliases: this.hostAliasesFor(project, b)` (WP2), `volume: this.volumeMount(project, b, group)` (WP4), `limits: this.limitsFor(project, 'cp-'+group)` (WP3), `envVars: this.containerize(this.envFor(project, b, group))` (WP5 `envFor`, WP2 `containerize`), `start: standing !== 'stopped' && !opts.startAsleep`; after the call record `url: this.serviceUrl(project, b, group)`, `host: this.mintedHost(project, b, group)` (WP2; omitted while undefined); then `this.afterDeploy(key, { started, startAsleep })` (WP3); `this.router.invalidate()` (WP2) | WP5 lands the skeleton with every hook as an identity/no-op; WP2, WP3, WP4 replace their hook bodies in their regions |
| `services()` | WP5 rewrites rows from registrations; row fields `domain`/`endpoint` from `rowNetwork` (WP2), `runtime` and `always_on` from `rowRuntime`/`effectiveAlwaysOn` (WP3), `template_*`, `image`, `port`, `pg_version` (WP5) | WP5 writes; WP2/WP3 fill the two helpers |
| `runtimeHealth()` | keep one docker read; per row call `healthOverlay(...)` (WP3); rows per `dbServices` entry (WP5) | WP3 hook body; WP5 row list |
| `liveState()` | body becomes `scheduler.stateOf(key)` mapped by section 13 (`running -> running`, `paused -> suspended`, `asleep -> suspended`, `stopped -> stopped`, `starting -> suspended`, `none -> none`); the adapter `state` call and `ComputeAdapter.state` are deleted (decision 53); callers pass a key instead of `(ref, group)` | WP3 |
| `lifecycleLocked()` | entered through `withOp([key], ...)` (decision 52; re-entrant, so the nested `wake` takes no second lock); `start`: mutate desiredState first, then `this.wake(key, {door:'api'})`, which is re-entrant and therefore waits for the wake rather than being bounded; `stop` and `suspend`: the adapter call is the gate, and only after it succeeds are `desiredState` and `scheduler.onStopped`/`onPaused` written -- a refusal writes neither and answers 409, because those hooks put a state into the snapshot the sweep and the eviction pass reason from | WP3 |
| `destroyBranch()` / `destroyProject()` | after containers: `data.remove(root)` for each `layout().branchRoots(ref)` (WP4); `scheduler.forget(keys)` (WP3); `releaseDomainsFor(...)` (WP2) | WP4, WP3, WP2 one line each |
| `removeComputeService()` / `removeServiceVolume()` | `docker volume rm` -> `data.remove(layout().vol(ref, id))` | WP4 |
| every `db.query` caller | management calls: `await this.ensurePgAwake(project, branch, serviceId)` first; observability calls: `this.assertPgAwake(...)` first; `this.db.query(container, sql)` | WP5 changes the argument (container from `dbTarget`); WP3 adds the awake line |
| `dbInstance()` / `dbSettings()` | real `scaleToZero`, `idleTimeoutSecs`, `cpuMilli`/`memoryMib`, `routeKey` = pg label, `host`/`port` = lane | WP3 (+WP2 host/port) |

## 8. Router, scheduler and upstream interfaces

### 8.1 `src/upstream.ts` (WP3)

```ts
export interface UpstreamAddr { host: string; port: number; containerId: string; startedAt: string }
export interface UpstreamLike {
  resolve(container: string, network: string, port: number): Promise<UpstreamAddr | null>
  forget(container: string): void
  forgetIfChanged(container: string, containerId: string): void   // the sweep calls it with the id from `docker ps -a --format '{{.Names}}\t{{.State}}\t{{.ID}}'`
  dial(container: string, network: string, port: number, timeoutMs?: number): Promise<boolean>
}
export class Upstream implements UpstreamLike {
  constructor(cfg: Config)
  /** server: docker inspect (IP on `network`, .Id, .State.StartedAt in ONE call); local: docker port <container> <port>/tcp -> 127.0.0.1:<n> plus the same inspect. null when the container is not running. Cached per container with a TTL of cfg.lanes.touchDebounceMs (5 s; resolve costs about 10 ms, so the TTL is free): a container that restarts on its own (`--restart unless-stopped`, operator `docker restart`) can take a different IP and its old IP can be reused by another container on the same network (Garage is on every branch network), and a fork inherits its source's password, so a stale entry could authenticate against the wrong branch. */
  resolve(container: string, network: string, port: number): Promise<UpstreamAddr | null>
  forget(container: string): void                         // called by the scheduler after every sleep/wake and by the router on dial errors
  forgetIfChanged(container: string, containerId: string): void
  dial(container: string, network: string, port: number, timeoutMs?: number): Promise<boolean>   // resolve + TCP connect + destroy; false on null/refused/timeout
}
```

`RouterDeps.upstream`, `Scheduler` and `DockerRuntime` are typed on `UpstreamLike` so `test/router.test.ts` and `test/scheduler.test.ts` inject `FakeUpstream` (decision 57).

### 8.2 Router (`src/router/index.ts`, WP2)

```ts
export type RouteKind = 'compute' | 'postgres' | ManagedDbType | 'api' | 'garage' | 'garage-web'
export type Lane = 'http' | 'pg' | 'sni' | 'port'
export interface Route {
  key: ServiceKey | 'api' | 'garage' | 'garage-web'
  host: string; aliases: string[]
  kind: RouteKind; lane: Lane
  projectId?: string; branchId?: string; serviceId?: string; group?: string
  container: string; network: string; port: number
  listenPort?: number; tls: boolean
  desiredState: 'running' | 'stopped' | 'suspended'    // copied from state at build time (compute: apps[g].desiredState ?? 'running'; databases: 'running'), so the request path never calls loadState (decision 54)
}
export interface RouteTable { byHost(host: string): Route | undefined; byPort(port: number): Route | undefined; hosts(): Set<string>; routes(): Route[] }
export function buildTable(state: State, cfg: Config): RouteTable     // never throws: a duplicate host or port is logged and the FIRST route wins (decision 51); the `s3.<domain>` and `*.s3.<domain>` static routes are built in server mode only (decision 20)
export function labelFor(kind, name, ref): string                     // bounded bare label (decision 55)
export function hostFor(kind, name, ref, domain): string              // `${labelFor(kind, name, ref)}.${domain}`
export function hostOnly(hostHeader: string | undefined): string

export interface RouterDeps {
  cfg: Config
  table(): RouteTable                                   // cached on stateRev(); rebuilt by invalidate()
  stateOf(route: Route): ReturnType<Engine['stateOf']>
  wake(route: Route): Promise<void>                     // engine.wake(key, { door: 'traffic' }); already singleflight and bounded by wakeTimeoutSec in the scheduler (the router keeps no second map or timer)
  touch(key: ServiceKey): void                          // engine.touch
  beginHold(key: ServiceKey): void; endHold(key: ServiceKey): void   // engine.holds bookkeeping (one shared 5 s ticker touches every held key)
  upstream: UpstreamLike                                // src/upstream.ts (FakeUpstream in tests)
  apiHandler?(req: IncomingMessage, res: ServerResponse): void   // Fastify's handler; in production it arrives later through attach() (Fastify only exposes it inside serverFactory), tests may pass it here
}
export class Router {
  constructor(deps: RouterDeps)
  readonly httpServer: http.Server                      // primary; handed to Fastify via serverFactory
  attach(handler: (req: IncomingMessage, res: ServerResponse) => void): void   // called from buildServer's serverFactory: `serverFactory: (h) => { router.attach(h); return router.httpServer }`; a request dispatched to the API before attach() answers 503
  start(): Promise<void>; stop(): Promise<void>         // extra HTTP listeners (local linux), lanes, internal listener; stop() destroys lane sockets and answers held requests 503 / ErrorResponse 57P03 so app.close() is not blocked
  invalidate(): void                                    // rebuilds the table NOW and reconciles lane listeners (add missing, close removed); also subscribed to state.onSave for routing-class saves
}
```

### 8.3 Scheduler (`src/scheduler.ts`, WP3)

```ts
export interface ServiceTarget { key: ServiceKey; kind: ServiceKind; container: string; network: string; port: number; projectId: string; branchId: string; serviceId: string; alwaysOn: boolean; desiredState: 'running' | 'stopped' | 'suspended'; idleSec: number; limits?: ServiceLimits; managedType?: ManagedDbType; sleptAt: number | null; createdAt: number }
export type ContainerState = 'running' | 'paused' | 'exited' | 'created' | 'restarting' | 'dead'
export interface Runtime {
  containers(): Promise<Map<string, { state: ContainerState; id: string }>>   // `docker ps -a --format '{{.Names}}\t{{.State}}\t{{.ID}}'`; the id feeds upstream.forgetIfChanged
  stats(): Promise<Map<string, number>>                                 // RSS bytes per container
  memory(): { availableBytes: number; totalBytes: number } | null       // /proc/meminfo or cfg.sleep.memBudgetMb; null = eviction disabled
  start(container): Promise<void>; stop(container, graceSec): Promise<void>; unpause(container): Promise<void>
  update(container, limits: ServiceLimits): Promise<void>
  probe(t: ServiceTarget): Promise<boolean>                             // postgres: docker exec pg_isready -h 127.0.0.1; else upstream.dial
}
export class ServiceStoppedError extends Error {}   // 'service is stopped'
export class WakeTimeoutError extends Error {}      // 'the wake timed out after <n> s: ...' (readiness) | 'this request timed out after <n> s waiting ...' (a caller's own bound; the wake continues). Both carry `timed out`, which is what `classifyWakeError` falls back to
export class NoContainerError extends Error {}      // 'service has no container (deploy in progress or removed)' (router: 503)
export class Scheduler {
  constructor(runtime: Runtime, cfg: Config, targets: () => ServiceTarget[], hooks: { markSlept(key, at: number | null): void; emit(key, kind, payload): void }, upstream: UpstreamLike)
  start(): void; stop(): Promise<void>
  touch(key): void; register(key): void; forget(keys): void; rekey(from, to): void
  onUp(key): void; onAsleep(key, reason): void; onStopped(key): void; onPaused(key): void
  stateOf(key): 'running' | 'asleep' | 'stopped' | 'paused' | 'starting' | 'none'   // 'asleep' while a sleep holds the key's lock (sleeping.has(key)); 'starting' while a wake does (wakes.has(key))
  wake(key, opts: { door }): Promise<void>; sleep(key, reason): Promise<boolean>   // wake = singleflight, then withOp([key]) BLOCKING (waits for a deploy, lifecycle op or stop on the key), then re-read; sleep = tryWithOp([key]) (held -> false) (decision 52)
  withOp<T>(keys, fn): Promise<T>                                                 // the per-key operation lock: sorted acquisition, re-entrant via AsyncLocalStorage, `ops.get(key)` = { holders + waiters count, done } for the sweep's in-flight test
  tryWithOp<T>(keys, fn): Promise<T | null>                                       // null without running fn when any key is held or queued; used by sleep() so a stop never queues behind a deploy
  sweep(): Promise<void>; evictForRoom(needBytes, exclude: Set<ServiceKey>): Promise<void>
  holds(key): number; beginHold(key): void; endHold(key): void       // router in-flight bookkeeping; a held key is never an eviction victim
}
```

## 9. Routes added or changed (all exist on the cloud)

Cloud evidence is `insta-platform origin/main 9f0c0d3` unless noted. Local-mode differences are stated per row. "501 today" cites `src/server.ts` at ad0de09.

| Method, path | Request | Response | Cloud evidence | Owner |
|---|---|---|---|---|
| GET /healthz | none | `{ok:true}`; public both modes | openapi.yaml:2562; platform server.ts:357; today server.ts:54 | unchanged |
| GET /me | bearer (session or `insta_`) or cookie | local: `{user:{id:'local',email:null,name:'local'}}` unchanged; server: `{user: PublicUser, via:'jwt'\|'api'}`, 401 `{error:'unauthorized'}` + `WWW-Authenticate: Bearer` | openapi.yaml:3188; platform server.ts:767-785; CLI auth.ts `applyApiKeyLogin` | WP1 |
| POST /api/auth/sign-up/email | `{name?, email, password>=8}`; public; only while no admin | 200 `{token, user: {id,name,email,emailVerified:true,image:null,createdAt,updatedAt}}` + Set-Cookie; 422 `{code:'USER_ALREADY_EXISTS'}` once an admin exists; 400 `{code:'INVALID_EMAIL'\|'PASSWORD_TOO_SHORT'}` | openapi.yaml:2579 (`/api/auth/{path}`, security []); platform server.ts:404-407; betterauth.ts (`minPasswordLength: 8`) | WP1 |
| POST /api/auth/sign-in/email | `{email, password, rememberMe?}`; public; 10 failures / 15 min / IP | 200 `{redirect:false, token, user}` + Set-Cookie + `set-auth-token`; 401 `{code:'INVALID_EMAIL_OR_PASSWORD'}`; 429 `{code:'TOO_MANY_REQUESTS'}` | same mount; betterauth.ts comment (console signs in on the raw mount) | WP1 |
| GET /api/auth/get-session | cookie or bearer session | 200 `{session:{id,token,userId,expiresAt,createdAt,updatedAt,ipAddress,userAgent}, user}` or body `null` | same mount | WP1 |
| POST /api/auth/sign-out | cookie or bearer | 200 `{success:true}`; clears cookie | same mount | WP1 |
| POST /api/auth/device/code | any | 200 device authorization (RFC 8628): `{device_code,user_code,verification_uri,verification_uri_complete,expires_in,interval}`, 429 when the store or per-IP cap is full | paired with POST /api/auth/device/token (poll) and the guarded POST /device/approve | WP1 |
| POST /auth/login | `{email, password}`; public | 200 `{accessToken, refreshToken (same), expiresIn, user: PublicUser}`; 400 `{error:'invalid email'}`; 401 `{error:'invalid credentials'}` (the cloud's text, auth/service.ts:164; the guard's 401 on every other route stays `{error:'unauthorized'}`) | openapi.yaml:2902; platform server.ts:647-667; auth/service.ts:164; CLI auth.ts `login` | WP1 |
| POST /auth/refresh | `{refreshToken}` | 200 AuthResult (same token, no rotation); 401 | openapi.yaml:2943; platform server.ts:669-685; CLI api.ts `refresh` | WP1 |
| POST /auth/logout | `{refreshToken?}` | 200 `{ok:true}` always | openapi.yaml:2974; platform server.ts:687-704 | WP1 |
| POST /auth/signup | any | 501 `{error:'email-verification signup is cloud-only; create the admin at <consoleUrl>/setup'}` (server); not registered in local | openapi.yaml:2803; platform server.ts:594-623 | WP1 |
| POST /agent/sessions | `{projectId?, client, publicKey}`; authed in server mode, open in local (the mode has no guard) | 201 `{token: 'agsess_' + 32 hex, agentSessionId, projectId\|null, expiresAt}` + `cache-control: no-store`; exactly the cloud's four keys. The receipt is not a credential here: one box has one admin, the bearer already carries full access, and the daemon does not verify the Ed25519 assertion the CLI signs with the id. Without the route a 404 kills EVERY command run from an agent shell, `insta login` included | platform govern/agent-routes.ts:355 `issueAgentSession`; openapi.yaml `/agent/sessions`; CLI agent.ts `issueAgentSession` (called before the first authenticated call whenever CLAUDECODE, CODEX_THREAD_ID or CURSOR_AGENT is set) | WP1 |
| GET /tokens | authed | local 501 unchanged (today server.ts:58); server `{tokens: ApiToken[]}` newest first, revoked included | openapi.yaml:12624; platform server.ts:4619-4630; ApiToken openapi.yaml:242-273 | WP1 |
| POST /tokens | `{name (1..100), orgId?: null, scopes?, expiresInDays?: 1..3650}` | 201 `{token: 'insta_' + 64 [A-Za-z], record}`; 400 | openapi.yaml:12647; platform server.ts:4633-4659; betterauth.ts apiKey plugin (`defaultPrefix 'insta_'`, `maxExpiresIn 3650`) | WP1 |
| DELETE /tokens/:tokenId | authed | 200 `{ok:true}`; 404 `{error:'token not found'}` | openapi.yaml:12690; platform server.ts:4661-4676 | WP1 |
| POST /projects/:id/compute/domain | `{hostname, branch?, group?}`; gated deploy | 200 ComputeDomainResult `{hostname, flyApp: <container>, configured, status: 'pending'\|'ready', dns:[{type:'CNAME', name, value:'api.<domain>', note?, status: 'ok'\|'missing'\|'mismatch'\|'unchecked'}], service, region:'local'}`; NO `ssl`/`origin`/`edgeOrigin`/`originOk`/`originStatus` key in either mode (decision 25: the CLI renders `ssl` as a plane answer and demands `origin` + an ownership TXT); `configured` = record resolves to us (+ cert in the store in server mode); 409 foreign binding; 400 own suffix/invalid; 501 today server.ts:509 | platform server.ts:2740-2747 (hidden); deploy.ts:45-49 ComputeDomainResult (all extra fields optional); adapters/types.ts:271 DnsRecordCheck; CLI compute.ts:98-228 `domainStatusLines` | WP2 |
| GET /projects/:id/compute/domain | `?hostname&branch&group` | 200 result (same envelope); unbound -> `{hostname, flyApp, configured:false, status:'not added', dns:[], service, region}`; 501 today server.ts:510 | platform server.ts:2748-2753; deploy.ts:600; CLI compute.ts `checkDomain` | WP2 |
| GET /projects/:id/compute/domains | `?branch&group` | 200 `{items: [...]}`; bare 404 today | platform server.ts:2756-2760 | WP2 |
| DELETE /projects/:id/compute/domain | `{hostname, branch?, group?}`; gated deploy | 200 `{hostname, flyApp, service, region}`; 404; 501 today server.ts:511 | platform server.ts:2761-2766; CLI compute.ts `removeDomain` | WP2 |
| PUT /projects/:id/services/:sid/always-on | `{enabled}` | 200 `{service}` (row carries `always_on`); 400 for postgres/storage `'alwaysOn is only supported for compute and managed database services'`; 404; 501 today server.ts:505 | openapi.yaml:6802; platform server.ts:2143-2166; CLI compute.ts `computeAlwaysOn` | WP3 |
| GET /projects/:id/services/:sid/limits | none | `{limits:{cpu,memoryMb}, cap:{cpu:8,memoryMb:8192,volumeGib:100}, volume?}`; 400 postgres/storage; 501 today server.ts:503 | openapi.yaml:6344; platform server.ts:1983-2001; CLI compute.ts `computeLimits` | WP3 |
| PUT /projects/:id/services/:sid/limits | `{memoryMb (multiple of 256), cpu? in 1,2,4,6,8}`; gated service.upgrade | 200 `{service, limits, cap}`; 202; 400 grid messages (specs.ts:130-141 wording with `to` instead of the dash); 502 partial apply; 501 today server.ts:504 | openapi.yaml:6420; platform server.ts:2004-2037; specs.ts:112-141 | WP3 |
| PATCH /projects/:id/database/settings | `{scaleToZero?, idleTimeout?, cpu?, memory?, volumeSize?}` `?branch&group` | 200 DbInstanceInfo with real `scaleToZero`, `idleTimeoutSecs`, `cpuMilli`, `memoryMib`, `routeKey`, lane `host`/`port` | openapi.yaml:8331; DbInstanceInfo; CLI db.ts `dbAlwaysOn` sends `{scaleToZero}` | WP3 (+WP5 `group`, WP2 host/port) |
| GET /templates | `?query&category`; public | `{templates: TemplateListItem[]}`; `cache-control: public, max-age=300` | openapi.yaml:7680 (security []); platform server.ts:2585-2607; CLI template.ts `templateList` | WP5 |
| GET /templates/:code | public | `{template: TemplateDetail}`; 404 `{error:'template not found: <code>'}` (drafts 404) | openapi.yaml:7715; platform server.ts:2609-2631; CLI template.ts `templateInfo` | WP5 |
| POST /projects/:id/template-deployments | `{templateCode\|code\|manifest, templateVersion?, branchId?\|branch?, variables?, deploymentId?}`; gates service.add, secrets.write, deploy (+ service.upgrade with a volume) | 202 `{deploymentId, deployment}` or approval envelope; 400 `{error:'missing_variables', missing:[{name,key,description}]}`; 404; 409 | openapi.yaml:7748; platform server.ts:2650-2719; CLI template.ts `templateDeploy` | WP5 |
| GET /template-deployments/:id | none | TemplateDeployment (unwrapped); 404 `{error:'template deployment not found'}` | openapi.yaml:7899; platform server.ts:2721-2735; CLI template.ts `watchDeployment` | WP5 |
| GET /projects/:id/services/:sid/credentials | `?branch` optional; the branch is resolved from a branch-qualified `sid` FIRST (`<branchId>:pg-db`, decision 49), then `?branch`, then the default; gated secrets.read | `{credentials: {...}}` (postgres `{DATABASE_URL}` lane form; storage 5 keys; managed bundle; compute `{}`); 202; 404 | openapi.yaml:7144 (`?branch` "defaults to the service's branch"); platform server.ts:2323-2338; CLI db.ts:241-257 `resolveDbUrl` (list with `?branch`, then credentials with NO branch) | WP5 |
| POST /orgs/:id/projects | `{name}` | 201 `{project, defaultBranch, resources: []}` (today returns three kinds, server.ts:150) | openapi.yaml:4010; provisioning/service.ts `provisionProject` returns `resources: []` | WP5 |
| POST /projects/:id/services | `{type: postgres\|storage\|compute\|redis\|mysql\|mongodb, name, branch?, public?, image?, port?, alwaysOn?, volumeGib?}`; gated service.add | 201 `{service}`; 409 `'service already exists on this branch'`; 400 `'branch has reached this plan's limit of <cap> <type> services (INSTA_OSS_MAX_SERVICES_PER_TYPE)'` (the cloud's prefix, provisioning/services.ts:684-686, minus its dash and upgrade hint); 507 `'docker has no free network subnets; see docs/self-hosting/install (default-address-pools)'` when `docker network create` fails on `non-overlapping IPv4 address pool` (today pg/storage idempotent, server.ts:288-298) | openapi.yaml:4659; config.ts:473 (cap 5); services.ts:684 | WP5 (+WP3 `alwaysOn`) |
| DELETE /projects/:id/services/:sid (every type) | gated service.remove | 200 `{ teardown: { destroyed, failed } }`, or 409 with the same envelope plus `error` when `failed > 0` (decision 50 as amended) counting containers, buckets and directories on the resolved branch (decision 50; today `{}` server.ts:628 and 501 for pg-/st- at 622-624); 404 | openapi.yaml:5430; platform server.ts:1761-1770; provisioning/services.ts:1022, 1091 | WP5 (all three delete paths) |
| DELETE /projects/:id/branches/:bid | gated branch.delete | 200 `{ teardown: { destroyed, failed } }`, or 409 with the same envelope plus `error` when `failed > 0` (decision 50 as amended) (today `{}`; existing assertion `test/server.test.ts:138` is WP5's allowed edit); 409 too for the default-branch refusal and for lock-set exhaustion, since both name a branch that WAS found; 404 only when it was not | platform server.ts:1387 (`200: { teardown?: TeardownSummary }`); event `branch.delete` carries the summary | WP5 |
| DELETE /projects/:id | gated project.delete | 200 `{ teardown: { destroyed, failed } }`, or 409 with the same envelope plus `error` when `failed > 0` (decision 50 as amended) (today `{}`; existing assertion `test/server.test.ts:169` is WP5's allowed edit) | platform server.ts:1300 | WP5 |
| POST /projects/:id/services/:sid/rename (pg-/st-) | `{name}`; gated service.rename | 200 `{service}`; 409 (today 501 server.ts:378-380) | openapi.yaml:5636 | WP5 |
| GET /projects/:id/services (shape) | `?branch` | rows gain `domain` (bare host), `endpoint` (`host[:port]`), `always_on` (compute + managed), `runtime: 'asleep'` (oss-additive), `image`, `port`, `template_deployment_id`, `template_code`, `pg_version: 16`; row `id` is `<branchId>:<serviceId>` when `?branch` names a NON-default branch, the bare id on the default branch (decision 49) | Service schema openapi.yaml:326-455; CLI db.ts:255-257, compute.ts:357-370 (ids from the list are used bare on the follow-up call) | WP2, WP3, WP5 |
| GET /projects/:id/runtime-health | `?branch` | `standby` for asleep, `starting` during wake, `crashed` only when exited with no `sleptAt` | openapi.yaml:6894 | WP3 |
| GET /projects/:id/services/:sid/state | `?branch` optional; branch from a qualified `sid` first (decision 49) | asleep -> `{desiredState:'running', state:'suspended'}` | openapi.yaml:6986; CLI compute.ts:369-370 | WP3 (+WP5 sid resolution) |
| POST /projects/:id/services/:sid/start\|stop\|suspend\|restart | `?branch` optional; branch from a qualified `sid` first (decision 49) | unchanged shape; `start` sets desiredState running then wakes (door api) and waits for it, since it holds the key; a `stop` or `suspend` the runtime refuses answers 409 with nothing recorded | openapi.yaml:5911 ('brings it back up and clears any stop intent'); CLI compute.ts:359-361 | WP3 (+WP5 sid resolution) |
| every other /projects/:id/services/:sid/* (rename, secrets, access, volume, limits, always-on, objects/*) | same sid resolution: qualified sid, then `?branch`, then default; `parseServiceId` strips the qualifier so project-level keys (`serviceSettings`, limits, always-on) stay branch-free | unchanged | decision 49 | WP5 (`parseServiceId` + one `resolveSid(req)` helper in region D used by every route) |
| GET /projects/:id/database/metrics, activity, query-stats, insight | `?branch&group` | unchanged, plus 503 `{error:'database is sleeping: it wakes on the next connection'}` when asleep (never wakes) | openapi.yaml:10529, 10638, 10701, 10592 | WP3 (+WP5 `group`) |
| POST /projects/:id/branches | unchanged | unchanged; clone now forks files and starts asleep | openapi.yaml:4272 | WP4/WP5 |
| Internal (NOT an API route): `GET http://127.0.0.1:<internalPort>/tls/ask?domain=<host>` | | 200 `ok` when `ownsHostname`; 404; 400 malformed. `GET /healthz` 200 | Caddy `on_demand_tls { ask }`; loopback only | WP2 |

Routes that stay 501 (today's text): billing, usage, orgs, members, invitations, `scale`, `upgrade`, `PATCH services/:sid`, `deploy-token`, `images/inspect`, backups, `deploy-events` (not-yet), `/auth/signup`. (`/api/auth/device/code` was here but is now the real device-authorization flow.) `test/server.test.ts:218` (the 501 sweep) loses exactly the rows that become real: limits (2), always-on, compute/domain (3), tokens (POST, DELETE) in server mode only (local mode keeps tokens 501).

## 10. Service ids, hostnames, URLs

Service ids (oss, branch-stable): `pg-<name>`, `st-<name>`, `cp-<group>`, `rd-<name>`, `my-<name>`, `mo-<name>`. Legacy `pg-db`, `st-store` are byte-identical to the new scheme for names `db`/`store`. `manageddb.parseServiceId(sid)` (WP5) resolves every prefix and STRIPS a branch qualifier; the CLI treats ids as opaque and resolves by `(type, name)` (insta-cli services.ts `resolveSoleService`).

Branch-qualified ids (decision 49): `GET /projects/:id/services?branch=<b>` returns `id = <branchId>:<serviceId>` (the ServiceKey form; `:` is path-safe and the CLI never parses ids) when `<b>` is not the default branch, and the bare id on the default branch. Every `/projects/:id/services/:sid/*` route calls `resolveSid(req)`: a qualified sid names the branch (404 when the branch is gone or belongs to another project), else `?branch`, else the default branch; the bare `serviceId` is what registrations, `serviceSettings`, limits, always-on and events use. Rationale: the CLI picks an id from the branch-scoped list and calls credentials/state/start/stop with NO branch (db.ts:241-257, compute.ts:357-370), so a bare id would silently act on the default branch (`insta db url --branch feat` printing main's DSN).

Hostname labels (`hostFor`): compute `<group>-<ref>`, postgres `pg-<name>-<ref>`, managed `<type>-<name>-<ref>` with type in `redis|mysql|mongodb`. `ref` = frozen `<projectSlug>-<branchSlug>` (engine.ts:45-48). Static: `api.<domain>`, `console.<domain>`, `s3.<domain>`, `<bucket>.s3.<domain>`. A label that would exceed 63 chars (a 39-char cloud-legal service name beside a 41-char ref reaches 84) is BOUNDED, not rejected (decision 55): keep the first `63 - 7` chars of the readable form, then `-` + 6 hex of `sha256(<full label>)`; deterministic and unique, minted once and recorded on the row (`apps[g].host`, `databases[id].host`, `managed[id].host`), read from there afterwards. Every label is not `api|console|s3` and is absent from the table when minted (409 otherwise). The 400 of `assertHostLabel` applies only to operator-supplied custom-domain hostnames.

| Thing | Server mode | Local mode |
|---|---|---|
| App URL (`apps[g].url`, deploy response, `${services.x.url}`) | `https://<group>-<ref>.<domain>` | `http://<group>-<ref>.localhost:<port>` |
| Services row `domain` / `endpoint` (compute) | `<group>-<ref>.<domain>` / same | `<group>-<ref>.localhost` / `<group>-<ref>.localhost:<port>` |
| DATABASE_URL (secrets, credentials, env) | `postgres://postgres:<pw>@pg-<name>-<ref>.<domain>:5432/app?sslmode=require` (one string everywhere) | host-facing `postgres://postgres:<pw>@127.0.0.1:<lanePort>/app`; in-container `...@host.docker.internal:<lanePort>/app` (`containerize`) |
| Postgres row `domain` / `endpoint` | `pg-<name>-<ref>.<domain>` / `...:5432` | `pg-<name>-<ref>.localhost` / `127.0.0.1:<lanePort>` |
| Redis / Mongo bundle | `rediss://default:<pw>@redis-<n>-<ref>.<domain>:6379/0`; mongo `...:27017/admin?authSource=admin&tls=true` | plaintext `127.0.0.1:<lanePort>` host-facing, `host.docker.internal:<lanePort>` in-container |
| MySQL bundle | `mysql://insta:<pw>@mysql-<n>-<ref>.<domain>:<lanePort>/app` (plaintext, per-service port) | `127.0.0.1:<lanePort>` / `host.docker.internal:<lanePort>` |
| AWS_ENDPOINT_URL_S3 | `https://s3.<domain>` (both) | host `http://127.0.0.1:3900`; in-container `http://io-garage:3900` (unchanged) |
| Public bucket / bucket vhost | `https://<bucket>.s3.<domain>`: anonymous GET/HEAD -> Garage web 127.0.0.1:3902; signed (SigV4 header or `X-Amz-*` query) or non-GET -> Garage S3 API 127.0.0.1:3900 (decision 20, virtual-hosted SDK requests) | unchanged from today: public reads at `http://<bucket>.web.garage.localhost:3902`, path-style API at `http://127.0.0.1:3900`; the router serves no `s3.`/bucket vhost in local mode (decision 20) |
| Container-to-router path | `--add-host <name>:host-gateway` for every minted host of the branch, `api.<domain>`, `s3.<domain>`, `<bucket>.s3.<domain>` per bucket of the branch, the groups' custom domains, plus `host.docker.internal:host-gateway`; port 443 reaches Caddy, DB ports reach the lanes | minted names + `host.docker.internal`; port 8080 reaches the HTTP listener bound on the bridge gateway (Linux) or via Desktop's forwarder (macOS) |
| DB instance `host`/`port`/`routeKey` | lane host / 5432 / `pg-<name>-<ref>` | `127.0.0.1` / lanePort / label |

## 11. Run-mode matrix

| Concern | local | server |
|---|---|---|
| Process | `npm run dev` / `npx tsx src/main.ts` on the host | container `io-instad` (`network_mode: host`, `/var/run/docker.sock`, `<dataDir>` bind-mounted at the same path) |
| HTTP listener | 127.0.0.1:8080 (+ docker bridge gateway IP on Linux); API, console and HTTP lane by Host | 127.0.0.1:8080 behind the edge (Caddy 2, host mode, 80/443) |
| Internal listener | none | 127.0.0.1:8081 (`/tls/ask`, `/healthz`) |
| Auth | none; `/me` = local; `/tokens` 501; no cookie; no guard | guard on every route but the allowlist; admin via `/setup`; sessions + `insta_` tokens |
| Domain | `localhost` (`*.localhost` names) | `INSTA_OSS_DOMAIN` (installer: `<ip-dashes>.sslip.io`) |
| TLS | none | edge per-host certs (ACME or internal issuer); pg/redis/mongo lanes terminate TLS with the edge's certs |
| Lanes | per-service plaintext ports on 127.0.0.1 (+ bridge gateway) from `INSTA_OSS_LANE_PORT_RANGE`; pg answers `N` to SSLRequest | 0.0.0.0:5432 (SNI), :6379 (SNI), :27017 (SNI), mysql per-service port |
| Compute publish | `-p 127.0.0.1:<hostPort>:<port>` (allocator kept, loopback-bound) | none |
| Database publish | `-p 127.0.0.1::<port>` (ephemeral, found via `docker port`) | none (router and probe dial the container IP from `docker inspect`) |
| Data dir | `~/.insta-oss` (state.json, garage.toml, pg/, vol/, md/) | `/var/lib/instacloud` on XFS reflink (installer) |
| Garage | daemon-started container with named volumes and `-p 127.0.0.1:3900/3902` as today | compose service `io-garage` on bind dirs; the daemon only initialises the layout |
| Scheduler | on (same defaults) | on |
| Copy engine | `/bin/cp -c -a` per top-level entry on APFS (macOS, decision 23; `reflink: false` with a logged warning on any other filesystem) or helper container (unprivileged Linux); in-process FICLONE when running as root | in-process FICLONE (root in the container); without reflinks the daemon still boots and forks stream `pg_basebackup` |
| Postgres readiness / password | TCP readiness; random password | same |
| Custom domains | routes work (Host alias); no `ssl` field, `configured` reflects the record resolving (decision 25); UI hides the section | routes + edge issuance; `configured` also requires the certificate in the store |

## 12. Data directory layout

```
<dataDir>/
  state.json  instad.lock  secret            (secret: server mode only)
  garage.toml                                (local mode; server: garage/garage.toml)
  garage/{garage.toml, meta/, data/}         (server mode, compose bind mounts)
  caddy/{data/, config/}                     (server mode; certificates under data/caddy/certificates/<issuer>/<host>/<host>.crt|.key; internal root at data/caddy/pki/authorities/local/root.crt)
  edge/ca.pem                                (server mode with INSTA_OSS_TLS=internal; copied by install.sh)
  pg/<ref>/<dataId>/                         PGDATA bind mount (0700; owned by the image's postgres user: uid 70 on postgres:16-alpine, uid 999 on the debian variants; the entrypoint chowns on start, the daemon never chowns)
  vol/<ref>/<volId>/                         compute /data bind mount (0777; parent tree 0700)
  md/<ref>/<prefix>-<dataId>/<sub>/          managed db data (redis data; mysql mysql; mongodb db, configdb)
  .probe/                                    reflink probe scratch
```

Directories are keyed by immutable ids, never by user-renamable names. Every data bind is `--mount type=bind,src=<hostPath>,dst=<containerPath>` (decision 56): with `-v`, dockerd would CREATE a missing host directory and, after a reboot where the loop image failed to mount, its own `--restart unless-stopped` would run initdb on the root filesystem before the daemon's PG_VERSION guard ever ran; with `--mount` the start fails instead. The daemon-side guard stays as the second belt (Postgres starts only when `PG_VERSION` exists, or the dir is empty at provision), and the installer's fstab line makes docker.service depend on the data mount (06 §E.5).

## 13. Sleep and wake state machine

Per service (key `${branchId}:${serviceId}`), inputs: docker state (`running|paused|exited|created|restarting|dead|none`), `desiredState` (compute only; databases always `running`), `sleptAt` (state.json), in-memory `lastActiveAt`, `wokeAt`, ops in flight, wake in flight.

Stamp writers: HTTP lane at request start and every 5 s while in flight (including upgraded sockets); TCP lanes on every non-empty read either direction; `onUp` after a deploy or wake. Nothing else stamps (no probes, no docker stats, no dashboard polling, no observability reads).

Sweep every 30 s: sleep when ALL hold: OBSERVED running by a docker read less than `2 * sweepSec` old, not alwaysOn, desiredState running, `now - lastActiveAt >= idleSec*1000` with idleSec > 0, `now - target.createdAt >= createGraceSec*1000` (the ROW's creation time, decision 10), no op or wake or sleep in flight. Then the pressure pass: while `available - need < total * ramFloorPct/100`, sleep the least recently active running service from the pool that is: OBSERVED running by a docker read less than `2 * sweepSec` old (a fact this daemon cannot date is not a fact it stops a container on; every full `containers()` read re-dates the whole snapshot, so a pass whose turns each burn a stop grace stays sighted to its end), not alwaysOn, desiredState running, not paused, not in flight, not excluded, `holds(key) === 0` (no in-flight request or splice), `now - lastActiveAt >= 2 * touchDebounceMs` (no traffic right now) and `now - wokeAt >= wakeProtectSec*1000` (HARD protection, never a preference: two services that do not fit together must not ping-pong). An empty pool logs once per sweep and lets the wake proceed (the kernel is the last resort); "no service can be evicted" and "this daemon cannot tell what is running" are logged as the different answers they are. No pressure pass runs at boot; the first one runs on the first sweep tick after `docker stats` has a sample.

Sleep = `docker stop -t <grace>` (compute 10 s, databases 30 s; eviction victims use the compute grace), then `sleptAt = now`, event `service.sleep`. Never `docker pause` (the user's `suspend` verb stays a pause). `desiredState` untouched. Compute containers carry `--init` so SIGTERM reaches an app behind a shell PID 1 (decision 60).

Wake doors: `traffic` (any lane; refused with `ServiceStoppedError` when compute desiredState is not running), `api` (`insta compute start` sets desiredState running first and is never refused; database management calls), `deploy` (a deploy starts the replacement). Wake = singleflight per key (the scheduler's map is the only one; the router keeps none), then take the key's operation lock (blocking: a deploy, lifecycle op or stop in flight finishes first, decision 52), re-read the target and the live container state, then `evictForRoom(need)` is AWAITED and a failure to make room rethrows as `could not make room to wake <container>` (rounds eleven and twelve: eviction and `docker start` used to fire concurrently, which crossed the RAM floor the pass exists to hold, and a start that raced its own eviction is the case the floor cannot survive), then `docker start`, then readiness (postgres `pg_isready -h 127.0.0.1`; others TCP dial via `Upstream.dial`). `wakeTimeoutSec` bounds the whole wait of a caller that ACQUIRED the key here -- the lanes, i.e. the held client connections the bound is for -- from the moment it starts waiting and across all three phases, not readiness alone; past it that caller gets `WakeTimeoutError` while the wake keeps the lock and runs to completion. A RE-ENTRANT wake (the three callers named in decision 52) is not bounded: it holds no acquisition of its own, so a timer there would release the outer engine operation and leave the wake running outside every lock. A container absent from `containers()` throws `NoContainerError` (router 503); `sleptAt = null`, stamp, `upstream.forget(container)`, event `service.wake`.

Operation lock (decision 52). One lock per key, `Scheduler.withOp`, taken by every container-mutating path; `wake` takes it blocking, the sweep's `sleep` takes it non-blocking. Transitions, with the lock column saying how the event enters:

| From (docker, sleptAt, desired) | Event | Lock | Action | To |
|---|---|---|---|---|
| running, idle past the window | sweep (idle or memory) | try; held or queued -> skip this tick | `docker stop -t <grace>`; `sleptAt = now`; `service.sleep` | asleep |
| running | wake (any door) | blocking; after acquire re-read: running and probe true | `touch`; no docker call | running |
| asleep (exited or created, sleptAt set, desired running) | traffic, api or deploy door | blocking | `evictForRoom` awaited (a failure to make room fails the wake), then `docker start`; readiness; `onUp` (`sleptAt = null`, stamp, `wokeAt`) | starting -> running |
| asleep, desired stopped or suspended | traffic | none | `ServiceStoppedError` (503) | unchanged |
| stopping (sleep holds the lock) | traffic | wake queues behind the stop | after the stop lands: as the asleep row | starting -> running |
| stopped (exited, no sleptAt, desired stopped) | traffic | none | `ServiceStoppedError` | stopped |
| stopped or asleep | api `start` | blocking (lifecycle) | `desiredState = running` (mutate), then `wake` (re-entrant) | running |
| running | api `stop` | blocking (lifecycle) | `docker stop -t <grace>` FIRST; only then `desiredState = stopped` and `onStopped`. A stop the runtime refuses writes neither and answers 409 | stopped, or unchanged on 409 |
| running | api `suspend` | blocking (lifecycle) | `docker pause` first, then `onPaused`; a refused pause writes nothing and answers 409 | paused, or unchanged on 409 |
| paused | api `start` | blocking (lifecycle) | `docker unpause`; `onUp` | running |
| paused | traffic | none | 503 `service is suspended` | paused |
| any | deploy or restart | blocking | `docker rm -f` + `docker create` (+ start unless `startAsleep` or desired stopped); a standing stopped or suspended intent is re-asserted on the replacement ONCE, by the deploy, and a failure to re-assert answers 409 naming the verb to retry; `afterDeploy` -> `onUp`, `onAsleep`, `onStopped` | running, asleep or stopped |
| deploying (deploy holds the lock) | traffic | wake queues behind the deploy | after it: running -> no-op; created (`startAsleep`) -> start | running |
| deploying or starting | sweep | held -> skip | | unchanged |
| starting (wake holds the lock) | traffic | joins the singleflight promise | | running |
| starting | deploy or lifecycle | blocks until the wake settles | | as the rows above |
| none (no container after the lock is taken) | wake | blocking; re-read absent | `NoContainerError` (503); never `docker start` | none |
| starting, container exits mid-wake | readiness | held | `Error('service exited during wake')` (503); `sleptAt` untouched | crashed |

Multi-key ops (`createBranch`, `destroyBranch`, service add/remove/rename) acquire their keys in sorted order and hold them for the whole op; a wake on any of those keys queues behind the op and re-reads afterwards (a removed service answers NotFound).

View mapping (services `runtime` / state route / runtime-health):

| docker | sleptAt | desired | runtime | state | health |
|---|---|---|---|---|---|
| running | any | running | online | running | healthy |
| paused | any | suspended | suspended | suspended | standby |
| exited/created | set | running | asleep | suspended | standby |
| exited/created | unset | stopped/suspended | stopped | stopped | standby |
| exited/dead | unset | running | stopped | stopped | crashed |
| restarting or wake in flight | any | any | asleep | suspended | starting |
| none | | | none | none | none |

New branch: compute clones `docker create`d and not started (asleep from birth), pg and managed provisioned, readied, then slept, unless always-on.

## 14. Test strategy

Fake-adapter (no Docker; every implementer runs `npm test`): `test/server.test.ts` (contract, must keep passing and grow by region), `test/server-auth.test.ts`, `test/identity.test.ts`, `test/state-lock.test.ts`, `test/config.test.ts`, `test/router.test.ts` (node servers on ephemeral ports, fake deps), `test/router-table.test.ts`, `test/internal.test.ts`, `test/scheduler.test.ts` (FakeRuntime + fake timers), `test/upstream.test.ts` (docker mocked), `test/postgres-adapter.test.ts` (docker mocked), `test/fsclone.test.ts` (tmp dir), `test/datadir-migrate.test.ts` (docker mocked), `test/templates.test.ts`, `test/install.test.ts`, `test/docs-lint.test.ts`, `ui/src/lib/*.test.ts`.

Docker (integrator only, one file at a time, never concurrently with another Docker file or the e2e; `RUN_DOCKER_TESTS=1`): `test/clone-isolation.int.test.ts`, `test/storage.int.test.ts`, `test/restart.int.test.ts` (existing), `test/router.int.test.ts`, `test/sleep-wake.int.test.ts`, `test/fork.int.test.ts`, `test/datadir-migrate.int.test.ts`, `test/template-deploy.int.test.ts`, `test/image.int.test.ts`, `test/compose.int.test.ts`. Every Docker file uses a distinct project name (`citest`, `sttest`, `restartint`, `routerint`, `sleepint`, `forktest`, `migtest`, `tplint`, `imagetest`) and sets `INSTA_OSS_SCHEDULER=0` (ticker off: no idle sweep and no pressure pass from it, so a low-RAM runner never stops the containers under test; wake/sleep on demand still work, and `INSTA_OSS_RAM_FLOOR_PCT=0` is what stops a wake asking for room too) unless it tests sleep; `test/sleep-wake.int.test.ts` runs the ticker with `INSTA_OSS_RAM_FLOOR_PCT=0` except in its eviction case, which uses `INSTA_OSS_MEM_BUDGET_MB` (decision 12).

Cross-package guard tests the integrator reruns after every merge: the 401 sweep (`test/server-auth.test.ts`: every route from `app.printRoutes()` outside the allowlist answers 401 without credentials), the 501 sweep (`test/server.test.ts:218`), local-mode `/me` byte parity, the Host-dispatch test in `test/router.test.ts`, and `npm run typecheck && npm run lint`.

## 15. Environment variables (complete)

| Key | Default local | Default server | Reader |
|---|---|---|---|
| INSTA_OSS_MODE | local | server (image ENV) | config |
| INSTA_OSS_VERSION | package.json | image ARG | config |
| INSTA_OSS_LISTEN_HOST | 127.0.0.1 | 127.0.0.1 | config |
| INSTA_OSS_PORT / --port | 8080 | 8080 | config |
| INSTA_OSS_DATA_DIR | ~/.insta-oss | /var/lib/instacloud | config |
| INSTA_OSS_STATE | <dataDir>/state.json | same | config/state |
| INSTA_OSS_GARAGE_CONFIG | <dataDir>/garage.toml | <dataDir>/garage/garage.toml | config/garage |
| INSTA_OSS_S3_HOST_ENDPOINT | http://127.0.0.1:3900 | https://s3.<domain> | config/garage |
| INSTA_OSS_UI_DIST | <repo>/ui/dist | /app/ui/dist | config/server |
| INSTA_OSS_TEMPLATES_DIR | <repo>/templates | /app/templates | config/catalog |
| INSTA_OSS_DOMAIN | localhost | required | config |
| INSTA_OSS_API_URL / INSTA_OSS_CONSOLE_URL | http://127.0.0.1:<port> | https://api.<d> / https://console.<d> | config |
| INSTA_OSS_PUBLIC_IP | unset | installer | config/domains |
| INSTA_OSS_TRUST_PROXY | false | true | config/fastify |
| INSTA_OSS_INTERNAL_PORT | unused | 8081 | router/internal |
| INSTA_OSS_AUTH | 0 | 1 | auth |
| INSTA_OSS_SECRET | unused | <dataDir>/secret | identity |
| INSTA_OSS_SESSION_TTL_SEC | 604800 | 604800 | identity |
| INSTA_OSS_LANE_BIND | 127.0.0.1 | 0.0.0.0 | router |
| INSTA_OSS_LANE_PG_PORT / _REDIS_PORT / _MONGO_PORT | unused | 5432 / 6379 / 27017 | router |
| INSTA_OSS_LANE_PORT_RANGE | 20000-20999 | 20000-20999 | router/engine |
| INSTA_OSS_LANE_IDLE_SEC | 900 | 900 | router |
| INSTA_OSS_PROBE_WINDOW_MS / READY_WINDOW_MS / TOUCH_DEBOUNCE_MS | 8000 / 30000 / 5000 | same | router |
| INSTA_OSS_TLS_CERT_DIR | unset | <dataDir>/caddy/data/caddy/certificates | router/certs |
| INSTA_OSS_EDGE_PORT | unused | 443 | router/certs |
| INSTA_OSS_SCHEDULER | 1 | 1 | scheduler |
| INSTA_OSS_IDLE_COMPUTE_SEC / IDLE_DB_SEC / SWEEP_SEC / CREATE_GRACE_SEC | 300 / 600 / 30 / 600 | same | scheduler |
| INSTA_OSS_STOP_GRACE_SEC / STOP_GRACE_DB_SEC | 10 / 30 | same | scheduler |
| INSTA_OSS_WAKE_TIMEOUT_SEC / WAKE_PROTECT_SEC | 60 / 60 | same | scheduler + router |
| INSTA_OSS_RAM_FLOOR_PCT / MEM_BUDGET_MB | 15 / unset | same | scheduler |
| INSTA_OSS_ALWAYS_ON_DEFAULT | false | false | scheduler |
| INSTA_OSS_HELPER_IMAGE / FORK / DATA_MIGRATE / SWEEP_ORPHANS | node:22-alpine / auto / 1 / 0 | same | datadir |
| INSTA_OSS_MAX_SERVICES_PER_TYPE | 5 | 5 | engine |
| INSTA_OSS_TEMPLATE_VOLUME_GIB / HEALTH_TIMEOUT_MS / HEALTH_POLL_MS | 10 / 90000 / 3000 | same | templates |
| Stack-only (compose/install.sh): INSTA_OSS_IMAGE, INSTA_OSS_TLS (acme\|internal), INSTA_OSS_ACME_EMAIL, INSTA_OSS_CA_FILE (<dataDir>/edge/ca.pem, informational), INSTA_OSS_DATA_IMG_GIB (installer loop-image size) | | | install.sh, compose |
