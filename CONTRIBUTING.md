# Contributing to InstaCloud OSS

## Dev setup

Prereqs: Docker (running) + Node ≥ 22 (`.nvmrc`).

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # contract tests only: fake adapters, no Docker, no containers
npx tsx src/main.ts   # run the daemon locally
```

`npm test` never starts a container. The Docker suites are opt-in and must run one file at a
time, because they share container names with each other and with the end-to-end scripts:

```bash
RUN_DOCKER_TESTS=1 npx vitest run test/clone-isolation.int.test.ts
```

The end-to-end scripts drive a real daemon with the real CLI. See [e2e/README.md](e2e/README.md).

## Branch model

- `main` is the release branch: changes land via PR.
- Day-to-day work happens on `devel` (or a feature branch) and merges into `main` by PR.

## Code map

```
src/
├── main.ts              entry point: checks Docker, picks adapters, starts router + scheduler
├── config.ts            every INSTA_OSS_* setting, resolved once, run mode included
├── identity.ts          the single admin, sessions, insta_ tokens, scrypt hashing
├── auth.ts              the request guard: bearer or cookie, and the public allowlist
├── server.ts            HTTP layer (Fastify): routes + govern gating (202 flow); cloud-only 501
├── router/              one listener for everything: HTTP by Host, pg/redis/mongo by SNI,
│                        mysql per port, on-demand TLS, wake-and-hold
├── scheduler.ts         sleep and wake: the idle sweep, memory pressure, one op lock per service
├── upstream.ts          dialing a service container, readiness retries, connection splice
├── engine.ts            orchestration: project/branch lifecycle, deploy, fork, teardown
│                        with compensation, audit events
├── datadir.ts           the data directory layout, reflink probe, orphan sweep
├── fsclone.cjs          the reflink copy itself (FICLONE, cp -c, or a helper container)
├── datadir-migrate.ts   first boot after an upgrade: named volumes to bind-mounted dirs
├── govern.ts            HITL policy engine: allow/deny/approve per action, one-shot grants
├── state.ts             single-tenant persistence (state.json) with a process lock
├── types.ts             the model + adapter contracts (Database/Compute/Storage/ManagedDb)
├── manageddb.ts         managed-db catalog (images/ports/env) + the secret naming contract
├── names.ts             the platform's name grammar, shared by engine and templates
├── hostarch.ts          which CPU architecture an image must carry to run on this box
├── templates/           manifest parser, bundled catalog, deployment executor
├── observe.ts           observability shapes + parsers (docker logs/stats, DB SQL)
├── metrics-sampler.ts   samples docker stats on a timer, persisted under the data dir
├── metrics-history.ts   the kept samples, answering the 1h / 6h / 24h / 3d chart ranges
├── s3.ts                hand-rolled SigV4 S3 client (list, delete, presigned GET/POST)
├── docker.ts            the single seam to Docker: spawn the docker CLI
└── adapters/
    ├── postgres.ts      LocalPostgres: a container per branch on a bind-mounted data dir;
    │                    fork = CHECKPOINT + reflink copy, pg_basebackup fallback
    ├── garage.ts        LocalGarage: a bucket and a scoped key per storage service;
    │                    fork = object sync; server mode never runs the container itself
    ├── compute.ts       DockerCompute: your image per group; no host ports in server mode
    └── manageddb.ts     LocalManagedDb: redis/mysql/mongodb, one private container per
                         branch; a fork gets a fresh empty instance

Dockerfile               the daemon image
install.sh               the installer, and the upgrader: re-run it
e2e/                     end-to-end scripts (local and server mode)
```

## Tests

```
test/                             no Docker unless the row says so
├── server.test.ts                API contract (fake adapters, fast)
├── server-auth.test.ts           the guard: every non-public route is 401 without credentials
├── identity.test.ts              admin, sessions, insta_ tokens, scrypt
├── state-lock.test.ts            one writer per data dir
├── config.test.ts                every setting, both run modes
├── router.test.ts                Host dispatch, SNI lanes, wake-and-hold (node servers)
├── router-table.test.ts          the pure hostname to service table
├── internal.test.ts              the loopback tls/ask endpoint
├── scheduler.test.ts             sleep, wake, idle sweep, memory pressure (fake timers)
├── upstream.test.ts              dialing and readiness (docker mocked)
├── postgres-adapter.test.ts      the postgres adapter: fork order, readiness, hba (docker mocked)
├── fsclone.test.ts               the reflink copy against a temp dir
├── cgroup-memory.test.ts         the memory ceiling this process reads for itself
├── docker.test.ts                the docker seam: argv redaction and the output cap
├── domains.test.ts               the custom-domain routes over the API (fake resolver)
├── templates.test.ts             manifest parsing, variables, the bundled catalog
├── install.test.ts               install.sh: sh -n and every --print-* rendering
├── docs-lint.test.ts             docs copy rules, the docs.json nav, the e2e scripts
├── restart-policy.test.ts        long-lived containers get --restart unless-stopped
├── clone-isolation.int.test.ts   DOCKER: a forked db is copied AND isolated
├── storage.int.test.ts           DOCKER: a forked bucket is copied AND isolated
├── restart.int.test.ts           DOCKER: containers survive a docker restart
├── router.int.test.ts            DOCKER: real lanes against real containers
├── sleep-wake.int.test.ts        DOCKER: idle sleep, traffic wake, eviction
├── fork.int.test.ts              DOCKER: reflink fork and the basebackup fallback
├── datadir-migrate.int.test.ts   DOCKER: upgrading an install with named volumes
├── template-deploy.int.test.ts   DOCKER: a template deployment end to end
├── image.int.test.ts             DOCKER: the built image boots and serves
└── compose.int.test.ts           DOCKER: the compose stack comes up

ui/src/lib/*.test.ts              dashboard helpers (run by npm test)
```

Every Docker file uses its own project name and sets `INSTA_OSS_SCHEDULER=0` unless the sleep
behavior is what it tests, so a low-RAM runner never stops the containers under test.

**How a request flows:** CLI/MCP/dashboard → `server.ts` (route + govern gate) → `engine.ts`
(orchestration + state + events) → an adapter (`src/adapters/*`) → `docker.ts` → Docker. Traffic
from the outside world flows `router/` → `scheduler.ts` (wake if asleep) → `upstream.ts` → the
container. The engine never talks to Docker for resources except through the adapter contracts.

## Where to extend

- **Different database/storage/compute backend**: implement the matching interface from
  `types.ts` as a new file in `src/adapters/`, wire it in `main.ts`. Nothing else changes:
  the engine, server, tests, and CLI are provider-agnostic.
- **New endpoint**: don't, with one sanctioned exception. The surface mirrors the standard `insta`
  CLI (see [COMPATIBILITY.md](COMPATIBILITY.md)); additions belong in the shared CLI/platform
  contract first. The exception is a capability the cloud architecturally cannot offer but a single
  self-hosted node genuinely can: such a self-hosted-only endpoint is allowed when it is recorded as a
  divergence in COMPATIBILITY.md and carries a maintainer sign-off on the PR. The native git
  push-to-deploy (`/projects/:id/services/:sid/git`, `/webhooks/git/:id`) is the first case: the
  cloud's builder is a multi-tenant GitHub App the daemon cannot run, so the box builds from its own
  HMAC-verified webhook instead (see the spec's builder note, updated 2026-09-21).

## Guidelines

- **Keep CLI parity**: the daemon implements the standard `insta` command surface. Don't add
  daemon-only commands or endpoints, except a capability the cloud architecturally cannot provide
  (see the "New endpoint" exception above): those are allowed with a COMPATIBILITY.md divergence entry
  and a maintainer sign-off. Response shapes must keep the stock CLI working unchanged.
- **Every behavior change needs a test**: contract tests (fake adapters, fast) for API shapes,
  integration tests (real Docker) for anything touching containers or clone isolation.
- **Never orphan resources**: provisioning failures must compensate (destroy what was created).
- **Docs copy uses no em dashes.** Commas, colons and periods instead. Enforced by
  `test/docs-lint.test.ts` for the README, COMPATIBILITY, CONTRIBUTING, `docs/` and `e2e/`.
- **One Docker suite at a time.** The Docker tests and the e2e scripts share container names
  (`io-<ref>-*` and `io-garage`), dockerd's address pool and the default state file, so running two
  at once makes both flaky. `vitest.config.ts` enforces it for `RUN_DOCKER_TESTS=1` runs by turning
  `fileParallelism` off, so `RUN_DOCKER_TESTS=1 npm test` is safe; an e2e script running beside one
  is still on you.
- Match the existing style: small focused modules, comments only for non-obvious constraints.

## Reporting issues

Include: OS, Docker + Node versions, the daemon log, and the failing `insta` command.

## Docs and plans

- `docs/` is the Mintlify source for https://docs.instacloud.com. Navigation lives in `docs/docs.json`; a page missing from it still builds (reachable by URL, searchable) but does not appear in the sidebar, so list every page you add. `test/docs-lint.test.ts` fails when a page is unlisted. Preview with `cd docs && npx mint dev`.
- Internal planning notes live in `plans/`, not under `docs/`.
