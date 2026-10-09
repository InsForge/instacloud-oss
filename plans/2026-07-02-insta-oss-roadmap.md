# insta-oss — Capabilities & Roadmap Plan

> **Dated design archive (2026-07-02).** This records the plan as designed at the time.
> Checkboxes and component names are not kept up to date as work ships (e.g. `LocalMinio`
> below became `LocalGarage`; most unchecked phases have since shipped). Read it for the
> *why* behind decisions; read the README and code for current state.

> **For agentic workers:** execute phases top-to-bottom with superpowers:executing-plans; each phase is independently shippable. Steps use `- [ ]`.

**Goal:** the open-source, self-hostable Instacloud runtime — same API surface as insta-platform, on local Docker, single-tenant, no billing — so the stock `insta` CLI / MCP / skills work unchanged.

**Architecture:** `instad` (Fastify daemon on 127.0.0.1) → Engine (project/branch lifecycle, provider-agnostic) → local adapters (`LocalPostgres` · `DockerCompute` · `LocalMinio`) + govern (HITL gates) + events, state in `~/.insta-oss/state.json`.

---

## ✅ v1 — DONE (verified 2026-07-02)

What it can do today, all proven by tests (12/12) + driving it with the **stock cloud CLI unchanged**:

- [x] **Daemon** serving the platform's endpoint shapes (`/me`, `/orgs`, `/orgs/:id/projects`, `/projects/:id` + branches/deploy/secrets/policy/approvals/events); builtin `local` org/user; no OAuth (localhost trust); clean 501s for cloud-only surfaces (usage/billing/tokens/metrics/logs).
- [x] **Project create** → provisions `main`: Postgres container + MinIO bucket (+ compute on deploy).
- [x] **Branch = full clone**: new Postgres (pg_dump→restore) + bucket copy (mc mirror) + re-deploy of every app group — fully isolated (verified: clone writes never touch the source, db and bucket).
- [x] **Deploy (image mode)**: user's image as custom compute per group, wired with `DATABASE_URL` + S3 bundle; redeploy = replace.
- [x] **Secret seam**: `insta secrets` → `DATABASE_URL`, `AWS_ACCESS_KEY_ID/SECRET`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `BUCKET_NAME` (cloud-shaped keys).
- [x] **Governance**: gates `secrets.read | deploy | project.delete | branch.delete` → allow/deny/approve; 202 + approvalId; one-shot grants; `approve --always`; per-project policy.
- [x] **Events timeline**: resource + govern events; agent ingest (`POST /events`) with dedup_key — observe-hook compatible.
- [x] **Teardown with compensation** — no orphaned containers (db destroyed if storage provision fails).
- [x] **CLI parity table** in README, verified against every registered `insta` command.
- [x] Wired into the superrepo as `oss/` submodule (insta-cloud PR #7).

Shared MinIO note: one persistent `io-minio` container holds all branch buckets — by design, not a leak.

---

## Phase 1.5 — services-model parity (drift found by live test, 2026-07-04)

The platform/CLI moved to the **services model** (`insta services add|list|remove|scale|upgrade`,
projects start empty, named per-service creds, `insta secrets set/unset`, org-level `usage`).
Tested insta-oss with CLI v0.0.4: core flow green (create/secrets/deploy/branch/manifest/govern),
but the new surfaces 404:

- [x] `insta services list/add/remove` → `/projects/:id/services` routes: list reports the fixed
      postgres (`db`) + storage (`store`) pair and every compute group; `add compute <name>` registers
      a group (materializes on first `deploy --group`); `remove` destroys the group's containers on
      every branch. `add/remove postgres|storage` → clean 501 (one of each per project locally);
      gated `service.add`/`service.remove`.
- [x] `insta secrets set/unset` → user secrets in state (project-wide + branch-scoped override),
      merged into the bundle + deploy env; reserved names rejected; branch-scoped secrets clone with
      the branch; gated `secrets.write`.
- [x] `insta usage` (org path) → friendly cloud-only 501. **Decision: oss does NOT replicate cloud
      usage** — the cloud's usage is the billing pipeline (5-dimension rate card, cost snapshots,
      billing-cycle windows, Stripe reconciliation), meaningless without billing. Local visibility =
      `manifest` today + Phase 2 docker-stats metrics/logs (real telemetry, no fake billing shape).
- [x] Starter resources: keep auto-provisioning postgres+storage on `project create` locally
      (zero-ceremony local UX; the cloud's empty-project semantics stay a cloud behavior) — documented.

## Architecture decision (2026-07-07) — the self-host substrate

Recorded from design review; supersedes "one Postgres container per branch" as the end-state.

**Branching must never require creating containers.** Only *data* branches; data lives in shared
engines and branches by CoW *inside* them:

- **Postgres**: ONE shared `io-pg` (PostgreSQL 18). Branch = `CREATE DATABASE <ref> TEMPLATE
  <src> STRATEGY FILE_COPY` with `file_copy_method = clone` — a reflink CoW clone inside the same
  container's volume (~200ms for 100GB on xfs/btrfs/zfs). Probe at startup: reflink unsupported →
  same statement via `WAL_LOG` (real copy, identical semantics) → dump/restore as last resort.
  Today's container-per-branch `LocalPostgres` stays as an explicit `--isolation=container` mode.
- **Storage**: ONE shared `io-minio`, bucket per branch (already true).
- **Compute**: the user's image. Docker already gives its *storage* CoW for free (all branch apps
  share the same image layers; each container adds only a thin write layer), and compute is
  stateless by doctrine (state belongs in db/bucket; redeploy = replace) — so branch compute is
  "run another instance with that branch's env", and its only real per-branch cost is RAM, which
  Phase 3's reaper reclaims by suspending idle branch apps.

**Truly self-hostable = a predefined stack.** `docker-compose.yml`: `instad` (in a container,
docker socket mounted, spawns branch apps as *siblings* — the Coolify/Dokploy pattern) + `io-pg` +
`io-minio`. Three fixed containers; app containers only for active branches. The socket mount is
the documented trust boundary — and where the govern gates sit.

**No-socket hosts (Railway-style PaaS)** can still run the whole control+data plane as predefined
services — branching stays pure in-container CoW writes. Custom compute there goes through the
`ComputeAdapter` seam: a platform adapter (e.g. Railway's service-create API) or none (BYO
runtime: apps run natively on the PaaS, wired via `insta secrets`).

**Empirically validated on Railway (2026-07-09, live PoC in the founder's account):** postgres:18
as a predefined service + volume ran `SET file_copy_method = clone; CREATE DATABASE … STRATEGY
file_copy` successfully — PG18 errors if the filesystem can't reflink, so success proves Railway
volumes support CoW. 100k-row database: 5 clones incl. a branch-of-branch, each ~2.5s measured
cross-continent (server-side cost is a fraction), perfect isolation census (each branch saw only
its own marker row; parents untouched). Compute: two probe services created via Railway's public
API from one codebase, each env-wired to a different branch db over the private network
(`io-pg.railway.internal`) — each reported exactly its own branch's data on public URLs.
Adapter-critical gotchas found live: bind `::` (Railway proxy + private net are IPv6-only;
`0.0.0.0` boots then 502s forever) and pin `PORT` to the domain's target port. Policy: Railway's
template marketplace explicitly welcomes open-source templates (community publishing, up to 25%
usage kickback, OSS/Technology Partners program requires open source).

- [ ] `SharedPostgresCow` adapter (PG18 image, startup reflink probe, pause→clone→release, WAL_LOG
      and dump/restore fallbacks); isolation tests must pass unchanged against it.
- [ ] `docker-compose.yml` + self-host README section (incl. socket-mount trust note, xfs/btrfs
      volume advice for instant branches).
- [ ] Remote self-host mode: opt-in `--listen 0.0.0.0` + shared bearer token (CLI already supports
      `INSTA_API_URL` + bearer); TLS via reverse proxy, documented.
- [ ] (later) `RailwayCompute`/host-process compute adapters for no-socket hosts.

## Phase 2 — metrics & logs (docker-backed)

Replace the 501s with real local implementations, keeping the cloud response shapes.

- [ ] `GET /projects/:id/logs?component=compute[&group=]` → `docker logs --tail` of the branch's app container(s); shape `{ source, lines: [{ts, message, instance}] }` (match platform's LogsResult).
- [ ] `GET /projects/:id/metrics?component=compute` → `docker stats --no-stream` (cpu %, mem) as `{ source, series: [{name, points}] }`.
- [ ] `component=db` → same for the Postgres container.
- [ ] Contract tests with fake docker; one integration test asserting `insta logs compute` prints lines.

## Phase 3 — scale-to-zero + router (the density feature)

- [ ] **Router** in the daemon: `<branch>.<project>.lvh.me:<router-port>` → branch app container (replaces raw host-port juggling); registry in state.
- [ ] **Port allocator**: replace the naive `port + 1000` on branch redeploy with allocated host ports (or router-only exposure).
- [ ] **Reaper**: no requests through the router for N seconds → `docker stop` the branch's containers (app + pg); state marks branch `suspended`.
- [ ] **Wake-on-request**: router holds the request, `docker start` db-then-app, health-wait, forward. Target < 5s cold.
- [ ] Tests: idle→stopped, request→started, data intact after wake.

## Phase 4 — source-mode deploy

Blocked on / paired with the CLI gaining `insta deploy ./dir` (parity rule: no OSS-only commands).

- [ ] Daemon accepts an upload or local path; `Dockerfile` → `docker build`; else Nixpacks → image; then normal deploy.
- [ ] Test: deploy the examples/ app from source, HTTP 200.

## Phase 5 — MCP (shared with cloud)

One MCP server, thin client over the same endpoints (lives in the `mcp/` submodule, not here); insta-oss just needs to keep serving the surface. Local mode = stdio pointed at `http://127.0.0.1:8080`.

- [ ] Verify the mcp submodule's tools run against instad unchanged (same test style as the CLI parity sweep).

## Phase 6 — local dashboard (open) via shared insta-ui

Detailed, design-driven plan: **[2026-07-06-local-dashboard.md](./2026-07-06-local-dashboard.md)**
(Vite/React SPA in `ui/`, served by instad at `/`; pages: Service, Branches, Logs, Usage
(docker stats), Approvals, Settings; presentational components = the future shared insta-ui).
Note: its Phase 2 implements this roadmap's Phase 2 endpoints (logs/metrics) as a prerequisite.

- [ ] Execute the local-dashboard plan (Phases 0–4).
- [ ] Later, when the cloud dashboard starts: extract presentational components + API hooks into a shared `insta-ui` package (cloud = closed shell over the same components/endpoints).

## Hardening backlog (any time)

- [ ] Encrypt secrets at rest in state.json (platform uses AES-256-GCM + KEK; local can use a machine key).
- [ ] `insta-oss up/down/status` daemon lifecycle commands (detach + pidfile) instead of foreground-only.
- [ ] Concurrent-request safety on the JSON state (single write lock or move to SQLite).
- [ ] Publish `@insforge/insta-oss` to npm (`npx @insforge/insta-oss up`) when open-sourcing.
