// Project/branch lifecycle over local containers. Mirrors the platform model:
// project → branches (main = default); branch create = provision new stack + copy data +
// redeploy the same app image(s); compute = the user's custom image(s), one per group.
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { loadConfig, type Config } from './config'
import { dataLayout, ensureDirSync, lazyDataDirOps, probedCapabilities } from './datadir'
import { migrateLegacyData } from './datadir-migrate'
import { docker } from './docker'
import { BRANCH_NAME_RE, SERVICE_NAME_RE } from './names'
import { MANAGED_DB, CANONICAL_MANAGED_KEYS, CANONICAL_KEYS, GARAGE_CONTAINER, suffixBundle, envSuffix, laneBundle, managedServiceId, managedContainerName, isManagedDbType, parseKeyspaceInfo, parseRedisInfo, parseServiceId, pgContainerName, pgServiceId, scanPageMembers, scanPageToHash, storageServiceId, bucketName, appContainerName, dataPaths } from './manageddb'
import * as observe from './observe'
import { isSingleStatement, lastStatementKeyword, maskSqlText, stripLeadingSqlComments, trailingTrimIndex } from './sqlsurface'
import { DEFAULT_STEP_SEC, DEFAULT_WINDOW_SEC, liveSeries, MetricsHistory, statsToSamples, type MetricsTarget, type MetricsWindow } from './metrics-history'
import { loadState, mutate, touchLater } from './state'
import type { Branch, Project, DatabaseAdapter, ComputeAdapter, StorageAdapter, ManagedDbAdapter, ManagedDbType, ObservedComponent, ObjectListing, AuditEvent, UserSecret, DataDirOps, PgTarget, ServiceKey, ServiceLimits, ServiceSettings } from './types'
// ---- region WP2 (router): the router's pure modules feed the seams at the end of this class ----
import { findCertFiles, suppliedFiles } from './router/certs'
import { checkDns, domainResult, DomainError, mapLimit, normalizeHostname, notAdded, ourAddresses, systemResolver, type ComputeDomainResult, type Resolver } from './router/domains'
import { assertHostLabel, bucketsOf, buildTable, databasesOf, hostFor as fqdnFor, hostOnly, labelFor, RESERVED_LABELS, type HostKind } from './router/table'
import type { State } from './state'
// ---- end region WP2 ----
// ---- region WP3 (scheduler) ----
import { DockerRuntime, NoContainerError, Scheduler, type Runtime, type ServiceTarget } from './scheduler'
import { stateRev } from './state'
import { Upstream, type UpstreamLike } from './upstream'
// ---- end region WP3 ----
// ---- region WP5 (templates/parity) ----
import { TemplateCatalog } from './templates/catalog'
import { TemplateExecutor } from './templates/executor'
import { ENV_NAME_RE } from './templates/manifest'
// ---- end region WP5 ----

const DEFAULT_BRANCH = 'main'

/** A branch name becomes part of a hostname (`web-demo-<branch>.<domain>`) and of every URL that
 *  addresses the branch, so it is restricted to what both can carry. Enforced on create AND on
 *  rename: they disagreed, and create was the lenient one. */
function assertBranchName(name: string): void {
  if (!BRANCH_NAME_RE.test(name)) throw new Error('branch name must be lower-kebab (a-z, 0-9, -)')
}

/** A service name is a DNS label too (`<group>-<project>-<branch>.<domain>`), and RFC 1123 labels
 *  may not start or end with a hyphen. Three call sites had drifted into two different rules: the
 *  compute-rename one refused a trailing hyphen but had no length cap, while add-service and
 *  managed-rename capped at 39 and ALLOWED a trailing hyphen, minting a name whose hostname is not
 *  valid. One rule now, the strict one, matching what the dashboard already enforced. */
function assertServiceName(name: string): void {
  if (!SERVICE_NAME_RE.test(name)) throw new Error('service name must be lower-kebab (a-z, 0-9, -)')
}
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)

/** The ad-hoc query route's server-side bounds: a browsing statement gets 30 s and the first
 *  5000 rows — the docker output cap alone let a query hold the request open indefinitely. */
const DB_QUERY_TIMEOUT_MS = 30_000
const DB_QUERY_MAX_ROWS = 5_000

// Volume-cap parity (platform #166–169): the cloud caps volumes per billing tier; oss has no
// tiers, so one fixed generous cap serves every project. Grow-only validation is kept so the
// same CLI sequence behaves identically on both targets. Sizes are ADVISORY locally — neither
// docker named volumes nor the postgres container enforce a byte quota.
const VOLUME_CAP_GIB = 100
const DB_VOLUME_DEFAULT_GIB = 10
const DB_CAP = { cpuMilli: 8000, memoryMib: 8192, volumeGib: VOLUME_CAP_GIB }
const VOLUME_MOUNT_PATH = '/data'

// ---- region WP5 (templates/parity) ----
/** The major version of the postgres image the adapter runs (adapters/postgres.ts IMAGE), served
 *  as the `pg_version` column of a postgres services row. */
const PG_VERSION = 16

/** One row of `GET /projects/:id/services`, and what every add/rename returns. */
export interface ServiceRow {
  id: string
  type: string
  name: string
  status: string
  machine_count?: number
  domain?: string
  endpoint?: string
  runtime?: string
  /** When the service was created (the console's Created column). */
  created_at?: string
  updated_at?: string
  public?: boolean
  desired_state?: string
  volume_gib?: number | null
  port?: number
  always_on?: boolean
  image?: string | null
  pg_version?: number
  template_deployment_id?: string
  template_code?: string
}

/** What every DELETE route answers with (decision 50): how many provider objects went, and how
 *  many refused to. `failed` is not an error — a bucket already gone is still gone. */
export interface Teardown {
  destroyed: number
  failed: number
  /** What refused to go, in words, for the message the operator actually sees. The wire envelope
   *  stays `{destroyed, failed}` (decision 50); `server.ts` lifts these into the `error` string
   *  every existing client already renders. */
  reasons?: string[]
}
/** A runtime transition the adapter refused: a `docker stop`, `suspend` or the re-assert of a
 *  standing intent after a redeploy. Typed rather than string-matched because the route maps it
 *  to 409, the code this server already uses for "understood, and the state says no" -- the same
 *  answer the teardown paths give when the thing they were asked to demolish is still there.
 *  Nothing is recorded when it is thrown: not the desired state, not the runtime cache. */
export class LifecycleFailedError extends Error {}

/** The status of a branch whose teardown did not finish: the row is kept so the resources it names
 *  can be found and the demolition retried (`unwindBranch`). */
export const CLEANUP_FAILED = 'cleanup-failed'
/** The refusal a queued operation owes when the service it resolved has moved under it. */
const movedUnderUs = (sid: string, what: string): Error =>
  new Error(`service "${sid}" changed while this ${what} was queued (renamed, moved to another branch, or already removed); nothing was destroyed, list the services and retry with the current id`)

/** How many times an operation may re-drive its acquisition over a grown key set before it gives
 *  up. Two is the converging case (the first round takes `branchOp(source)`, which every service
 *  add now needs); the third is slack for an add that lands between two rounds. */
const CREATE_LOCK_ROUNDS = 3
/** How many domain rows a listing checks at once. Small on purpose: each one is a DNS round
 *  trip with its own timeout, and the box this runs on is a single node. */
const DOMAIN_CHECK_CONCURRENCY = 8
const newTeardown = (): Teardown => ({ destroyed: 0, failed: 0 })
/** A mark on a SHARED counter, and the slice one branch's demolition added to it. `destroyProject`
 *  runs every branch through one `Teardown`, so a per-branch event carrying the whole thing told
 *  the operator that a container belonging to a DIFFERENT branch is what refused to go, and
 *  reported that branch's counts as this one's. Same scope rule as the row, the scheduler keys and
 *  the domains: what this branch did, not what the call has done so far. */
const teardownMark = (t: Teardown): { destroyed: number; failed: number; reasons: number } =>
  ({ destroyed: t.destroyed, failed: t.failed, reasons: t.reasons?.length ?? 0 })
const teardownSince = (t: Teardown, mark: { destroyed: number; failed: number; reasons: number }): Teardown => {
  const reasons = (t.reasons ?? []).slice(mark.reasons)
  return { destroyed: t.destroyed - mark.destroyed, failed: t.failed - mark.failed, ...(reasons.length ? { reasons } : {}) }
}
/** Run one teardown step and count it. `what` names the thing for the operator's message. */
async function count(t: Teardown, fn: () => Promise<unknown>, what?: string): Promise<void> {
  try { await fn(); t.destroyed++ } catch (e) {
    t.failed++
    if (what) (t.reasons ??= []).push(`${what}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
/** Docker's own "there is no such network", in both spellings the CLI has used: dockerd's
 *  `Error response from daemon: network <name> not found` (Docker 27, measured on the box) and
 *  the older client-side `Error: No such network: <name>`. Nothing else counts as absence. */
const NO_SUCH_NETWORK = /network [^\s]+ not found|no such network/i
const saysMissing = (e: unknown): boolean => NO_SUCH_NETWORK.test(e instanceof Error ? e.message : String(e))

/** `docker network rm`, where ALREADY GONE is the ordinary outcome and not a failure: a create
 *  that never got as far as making one, a delete retried after a partial teardown, a network an
 *  operator removed by hand. A network that is STILL THERE after the attempt is the failure that
 *  matters (dockerd refuses while a container is attached), and it is the one the caller counts.
 *
 *  Absence therefore has to be ESTABLISHED, never inferred from a probe that itself failed. A
 *  `network inspect` can fail for reasons that say nothing about whether the network exists (a
 *  daemon that is not answering, a template error, a permission failure), and reading any of
 *  those as "gone" hands back a clean verdict and deletes the branch row over a network that is
 *  still standing, which is the exact outcome this counting exists to prevent. So the removal's
 *  own error is classified first, the probe only confirms, and an inconclusive probe fails
 *  CLOSED: the original error stands and the step counts as failed. */
async function removeNetwork(network: string): Promise<void> {
  try {
    await docker(['network', 'rm', network])
  } catch (e) {
    if (saysMissing(e) || (await networkState(network)) === 'missing') return
    throw e
  }
}

/** `missing` only when dockerd says so. A probe that cannot answer is `unknown`, which every
 *  caller must treat as "it may still be there". */
async function networkState(network: string): Promise<'present' | 'missing' | 'unknown'> {
  try {
    await docker(['network', 'inspect', '-f', '{{.Id}}', network])
    return 'present'
  } catch (e) {
    return saysMissing(e) ? 'missing' : 'unknown'
  }
}

/** Remove a container and PROVE it is gone before anything that depended on it is deleted.
 *
 *  `count()` turns every failure into a counter and lets execution carry on, which on the
 *  teardown paths meant a FAILED `docker rm` was followed by deleting the bind-mounted data
 *  directory that container was still writing, and then by dropping the only row that named
 *  either of them. Docker being unavailable, or refusing a removal, took the database files out
 *  from under a surviving Postgres and left nothing to retry with.
 *
 *  So the removal is not the evidence: the probe after it is, three ways like the network and
 *  fingerprint probes (`gone` only when docker ANSWERED and the container was not in the answer).
 *  Only `gone` returns true, and only a true return may delete the bytes or the row. */
async function removeContainer(
  sched: { containerPresence(c: string): Promise<'present' | 'gone' | 'unknown'> },
  t: Teardown, container: string, remove: () => Promise<unknown>,
  known?: 'present' | 'gone' | 'unknown',
): Promise<boolean> {
  // What was there BEFORE, so the summary counts a demolition rather than a no-op: a container
  // that was never there is not one destroyed, and counting it inflates the number with work
  // that did not happen. The removal is still attempted either way -- docker's own view can be
  // ahead of ours, and an adapter may have cleanup of its own to do.
  //
  // `known` is that answer taken from a snapshot the CALLER already has. `containerPresence` is
  // an uncached `docker ps -a` over every container on the box, so a caller tearing down many
  // of them (a branch, a project) reads it once instead of once per container; the probe AFTER
  // the removal is always live, because a cached one cannot see the removal it is checking.
  const before = known ?? await sched.containerPresence(container)
  let failure: string | undefined
  try { await remove() } catch (e) { failure = e instanceof Error ? e.message : String(e) }
  const state = await sched.containerPresence(container)
  if (state === 'gone') {
    if (before !== 'gone') t.destroyed++
    return true
  }
  t.failed++
  const why = `container ${container} is ${state === 'unknown' ? 'in an unknown state (docker could not answer)' : 'still there'} after its removal${failure ? `: ${failure}` : ''}`
  ;(t.reasons ??= []).push(why)
  console.warn(`${why}; its data is left in place and its row is kept`)
  return false
}

/** A teardown step whose SUCCESS is not a provider object the summary counts -- decision 50 counts
 *  containers, buckets and directories, and neither the branch network nor the object store's
 *  detach from it is one of those -- but whose FAILURE still means the branch is not gone.
 *  `unwindBranch` reads `t.failed` to decide whether the row may be dropped, so a step that
 *  swallows its own failure is a row deleted over a network that is still standing. */
async function countFailure(t: Teardown, what: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn() } catch (e) {
    t.failed++
    const why = `could not ${what}: ${e instanceof Error ? e.message : String(e)}`
    ;(t.reasons ??= []).push(why)
    console.warn(why)
  }
}
// ---- end region WP5 ----

/** The registration surface the engine drives on every provision, teardown and rename. WP3 replaced
 *  the scaffold's no-op stub with the real `Scheduler` (region WP3 below), which satisfies this. */
export interface SchedulerLike {
  register(keys: ServiceKey[]): void
  forget(keys: ServiceKey[]): void
  rekey(from: ServiceKey, to: ServiceKey): void
}

/** Constructor options (contract 00 section 7). Every field has a default so `new Engine(db, compute,
 *  storage, managedDb)` keeps working; main.ts passes what it built at boot. */
export interface EngineOptions {
  cfg?: Config                       // default loadConfig()
  data?: DataDirOps                  // scaffold default: the no-op Engine.NOOP_DATA; WP4 default: new DataDir(cfg)
  router?: { invalidate(): void }    // default no-op; main.ts sets engine.router after constructing the Router (WP2)
  // ---- region WP2 (router) ----
  resolver?: Resolver                // default systemResolver; the fake-adapter suite injects a hermetic one
  // ---- end region WP2 ----
  // ---- region WP3 (scheduler) ----
  upstream?: UpstreamLike            // default new Upstream(cfg); ONE instance for runtime, scheduler and router (decision 57)
  runtime?: Runtime                  // default new DockerRuntime(cfg, upstream); tests pass FakeRuntime
  scheduler?: Scheduler              // default: built here over `runtime`, NOT started (main.ts starts it)
  // ---- end region WP3 ----
  // ---- region WP5 (templates/parity) ----
  templates?: TemplateCatalog        // default new TemplateCatalog(cfg.templatesDir)
  // ---- end region WP5 ----
}

export class Engine {
  readonly cfg: Config
  /** CPU, memory and network samples behind `runtimeMetrics`. main.ts's MetricsSampler fills it; a
   *  daemon or test without one answers a live reading instead. */
  readonly metricsHistory = new MetricsHistory()
  /** How the four custom-domain routes look a hostname up (WP2). Injected by the fake-adapter
   *  suite so no test ever reaches a real nameserver. */
  private readonly resolver: Resolver
  /** Invalidated after every mutate that changes hosts or lanes (decision 54). A public assignable
   *  field: main.ts constructs the Router AFTER the engine and sets it (WP2). */
  router: { invalidate(): void }

  constructor(
    private db: DatabaseAdapter, private compute: ComputeAdapter, private storage: StorageAdapter, private managedDb: ManagedDbAdapter,
    opts: EngineOptions = {},
  ) {
    this.cfg = opts.cfg ?? loadConfig()
    this.data = opts.data ?? Engine.NOOP_DATA
    this.router = opts.router ?? { invalidate() { /* no router until WP2 */ } }
    this.resolver = opts.resolver ?? systemResolver
    this.templates = opts.templates ?? new TemplateCatalog(this.cfg.templatesDir)   // WP5 (lazy: reads no file until asked)
    // ---- region WP3 (scheduler) ----
    // ONE Upstream for the runtime, the scheduler and (through `engine.upstream`) the router, so a
    // sleep or a wake invalidates the address the next request would have dialled (decision 57).
    // The scheduler is built here and NOT started: main.ts starts the ticker after the listener is
    // up, and every fake-adapter test drives it on demand with the ticker off.
    this.upstream = opts.upstream ?? new Upstream(this.cfg)
    this.scheduler = opts.scheduler ?? new Scheduler(
      opts.runtime ?? new DockerRuntime(this.cfg, this.upstream),
      this.cfg,
      () => this.serviceTargets(),
      {
        markSlept: (key, at) => { this.markSlept(key, at) },
        emit: (key, kind, payload) => { this.emitForKey(key, kind, payload) },
        booting: () => this.booting,
      },
      this.upstream,
    )
    // ---- end region WP3 ----
  }

  /** Serialize container work per app. `deploy` re-asserts the standing lifecycle intent after
   *  replacing the container, and `lifecycle` changes that intent — both read state, then act on the
   *  container across an await. Interleaved, they leave the row and the container disagreeing in
   *  whichever direction lost the race: a `start` landing mid-deploy is recorded and then undone by
   *  the deploy's re-assert. One chain per app, so unrelated services and branches stay concurrent.
   *  Chained on settle, not success — a failed op must not wedge every later one behind it. */
  private appChains = new Map<string, Promise<unknown>>()
  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.appChains.get(key) ?? Promise.resolve()).then(fn, fn)
    this.appChains.set(key, next.catch(() => undefined))
    return next
  }

  // The project's container-ref slug — frozen at creation (older state derives from the name).
  private projectSlug(project: Project): string { return project.refSlug ?? slug(project.name) }

  // Branch ref keys containers/networks: <project-slug>-<branch-name>, FROZEN at provision.
  // Passing a Branch reads the stored ref (older state derives from the name — same value until
  // the branch is renamed); a string is the provision-time path, before the Branch exists.
  private ref(project: Project, branch: Branch | string): string {
    if (typeof branch !== 'string') return branch.ref ?? this.ref(project, branch.name)
    return `${this.projectSlug(project)}-${slug(branch)}`
  }
  private net(project: Project, branch: string): string { return `io-${this.ref(project, branch)}` }

  /** An audit-class write (contract 00 section 5): the timeline is not routing. A secrets read, a
   *  storage object listing, template progress and every sleep or wake emits here, and a routing
   *  write would bump `rev`, drop the router's memoized table and rebuild the scheduler's target
   *  projection for a row no route depends on. `{ audit: true }` bumps `auditRev` instead, which
   *  the router ignores (decision 54). */
  emit(projectId: string, branch: string | null, source: AuditEvent['source'], kind: string, payload: unknown = {}, dedupKey: string | null = null): void {
    mutate((s) => {
      if (dedupKey && s.events.some((e) => e.projectId === projectId && e.dedupKey === dedupKey)) return
      s.events.push({ id: randomUUID(), projectId, branch, source, kind, payload, dedupKey, createdAt: new Date().toISOString() })
    }, { audit: true })
  }

  /** `emit` for BROWSE-RATE reads (the redis key browser, the SQL editor): the row is minted now
   *  but rides `touchLater`'s coalesced audit write, because a synchronous full-state save per
   *  key click measurably blocks the event loop the router shares. The cost is bounded loss: a
   *  crash forgets at most one flush window of read-audit rows, which is the same durability
   *  `touchLater` already gives token lastUsedAt. */
  private emitLater(projectId: string, branch: string | null, source: AuditEvent['source'], kind: string, payload: unknown = {}): void {
    const row: AuditEvent = { id: randomUUID(), projectId, branch, source, kind, payload, dedupKey: null, createdAt: new Date().toISOString() }
    touchLater((s) => { s.events.push(row) })
  }

  getProject(id: string): Project | undefined { return loadState().projects[id] }
  listEvents(projectId: string): AuditEvent[] { return loadState().events.filter((e) => e.projectId === projectId) }
  listProjects(): Project[] { return Object.values(loadState().projects) }
  listBranches(projectId: string): Branch[] { return Object.values(loadState().branches).filter((b) => b.projectId === projectId) }
  getBranchByName(projectId: string, name: string): Branch | undefined {
    return this.listBranches(projectId).find((b) => b.name === name)
  }

  /** The branch a branch-scoped operation acts on: the one named, else the project's default. The
   *  cloud's `resolveBranch` (platform `src/provisioning/services.ts:344`), which is what every
   *  service add, list and merge resolves through there. */
  private targetBranch(projectId: string, branchName?: string): Branch {
    const branches = this.listBranches(projectId)
    const b = branchName
      ? branches.find((x) => x.name === branchName)
      : branches.find((x) => x.isDefault) ?? branches[0]
    if (!b) throw new Error(branchName ? `branch "${branchName}" not found` : 'project has no branches')
    return b
  }

  /** Whether a branch actually CARRIES a registered service, as opposed to the project having
   *  registered the name. Services are branch-scoped (see `addDbService`), so this is what the
   *  services list, `mergeBranch` and a clone's materialisation all ask. */
  private carries(project: Project, branch: Branch, reg: { id: string }, type: 'postgres' | 'storage' | 'managed'): boolean {
    if (type === 'postgres') return !!this.dbHandle(project, branch, reg.id)
    if (type === 'storage') return !!this.bucketHandle(project, branch, reg.id)
    return !!branch.managed?.[reg.id]
  }

  /** The 404 every branch-scoped read and action owes a service this branch does not carry: the
   *  registration is the project's namespace entry, not proof that the branch has the thing. */
  private assertCarries(project: Project, branch: Branch, reg: { id: string }, type: 'postgres' | 'storage' | 'managed'): void {
    if (!this.carries(project, branch, reg, type)) throw new Error(`service not found on branch "${branch.name}"`)
  }

  /** Which branch-scoped kind a service type is, or undefined for compute: a compute group is a
   *  project-level registration that owns no per-branch resources until a deploy puts a container
   *  on a branch (the one stated divergence, recorded in COMPATIBILITY). */
  private branchKind(type: 'postgres' | 'storage' | 'compute' | ManagedDbType): 'postgres' | 'storage' | 'managed' | undefined {
    return type === 'compute' ? undefined : type === 'postgres' || type === 'storage' ? type : 'managed'
  }

  /** `assertCarries` for a resolved service id: the branch-scoped 404 every `/services/:sid/*`
   *  read and action owes a service that lives on some OTHER branch. A no-op for compute. */
  private assertServiceOnBranch(project: Project, branch: Branch, sid: string, type: 'postgres' | 'storage' | 'compute' | ManagedDbType): void {
    const kind = this.branchKind(type)
    if (kind) this.assertCarries(project, branch, { id: sid }, kind)
  }

  /** The branch a service REMOVAL acts on, plus the bare service id: the qualifier on the id
   *  first, then `?branch`, then the default branch (decision 49). That is the branch `add`
   *  resolves through `targetBranch`, so a remove undoes exactly what an add did and nothing on
   *  any other branch. */
  private removalTarget(projectId: string, serviceId: string, branchName?: string): { project: Project; branch: Branch; sid: string } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const { branch, serviceId: sid } = this.resolveSid(projectId, serviceId, branchName)
    return { project, branch, sid }
  }

  /** Retire the project-level registration once the LAST branch carrying the service is gone.
   *  A service id is the project's namespace and has to stay stable across branches (decision 49),
   *  so the registration outlives one branch's copy: while another branch still carries the name,
   *  dropping it would strip that branch's row of its type, name and data key. The user secrets
   *  bound to the service go with the registration, for the same reason: they are project-level.
   *  Returns whether the registration went. */
  private retireRegistration(project: Project, reg: { id: string }, type: 'postgres' | 'storage' | 'managed', source: string, removedFrom?: Branch): boolean {
    // The secrets bound to the service on the branch it was just removed from go with it, whether
    // or not the shared registration can retire. They used to be deleted only in the full-retire
    // mutate below, so removing a service from one branch while another still carried it left that
    // branch's bound rows behind, and `userSecretsFor` then handed them back as ordinary branch
    // secrets: the credentials of a service that no longer exists there.
    if (removedFrom) {
      mutate((st) => {
        st.userSecrets[project.id] = (st.userSecrets[project.id] ?? [])
          .filter((u) => !(u.service === source && u.branch === removedFrom.name))
      })
    }
    if (this.listBranches(project.id).some((b) => this.carries(project, b, reg, type))) return false
    mutate((st) => {
      const pr = st.projects[project.id]
      if (type === 'postgres') pr.dbServices = (pr.dbServices ?? []).filter((d) => d.id !== reg.id)
      else if (type === 'storage') pr.storageServices = (pr.storageServices ?? []).filter((x) => x.id !== reg.id)
      else pr.managedServices = (pr.managedServices ?? []).filter((m) => m.id !== reg.id)
      st.userSecrets[project.id] = (st.userSecrets[project.id] ?? []).filter((u) => u.service !== source)
    })
    return true
  }

  /** The postgres handle of ONE database service on a branch: READ from the row (decision 17); a
   *  row provisioned before the data migration still runs today's `io-<ref>-pg` container. */
  private pgContainer(project: Project, branch: Branch, serviceId = 'pg-db'): string {
    const row = this.dbHandle(project, branch, serviceId)
    if (row) return row.container
    const reg = this.dbList(project.id).find((d) => d.id === serviceId)
    return pgContainerName(this.ref(project, branch), reg?.name ?? 'db')
  }
  /** The bucket handle of ONE storage service on a branch (legacy rows carry `io-<ref>`). */
  private bucketOf(project: Project, branch: Branch, serviceId = 'st-store'): string {
    const row = this.bucketHandle(project, branch, serviceId)
    if (row) return row.bucket
    const reg = this.stList(project.id).find((s) => s.id === serviceId)
    return bucketName(this.ref(project, branch), reg?.name ?? 'store')
  }

  /** Provision one branch stack. `source` null = fresh (initdb); a Branch = fork its database
   *  (adapter-level: reflink or dump/restore). `branchId` is minted by the caller so the lane
   *  reservation and the op lock have an owner from the start (decision 51). WP5 rewrites this method
   *  over registrations; the hooks it calls (contract 7.2) are already in place.
   *  `empty` (the console's "Exclude all services") provisions only the branch shell — ref, network
   *  and row — and materialises none of the source's services. */
  private async provisionBranch(project: Project, name: string, isDefault: boolean, source: Branch | null, branchId: string, opts?: { empty?: boolean }): Promise<Branch> {
    const ref = this.ref(project, name)
    // FIRST, and synchronously: the name and the ref are claimed before a single resource exists
    // (decision 51). A concurrent create of the same branch refuses here, having created nothing,
    // rather than building the whole stack a second time on top of the winner's.
    this.reserveBranchRef(project, name, ref, branchId)
    const network = this.net(project, name)
    try { await docker(['network', 'create', network]) } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      // Stock dockerd hands out only 31 user-defined networks from its default pools and every
      // branch is one, so this is the failure a busy box hits first.
      if (/non-overlapping IPv4 address pool/i.test(m)) {
        this.releaseBranchRef(ref, branchId)
        throw new Error('docker has no free network subnets; see docs/self-hosting/install (default-address-pools)')
      }
      // Everything else used to be treated as "it already exists". It is not: a permission
      // error, a daemon that is not answering and an invalid configuration all failed the
      // create and all read as success, and since a project now starts EMPTY, a create could
      // commit a READY default branch with no network at all and surface the truth much later,
      // on some unrelated service operation. So the already-exists case has to be VERIFIED,
      // by asking dockerd for the network rather than by reading its error text. Reusing a
      // verified leftover is still safe for the reason the reservation gives: no branch row and
      // no other operation holds this ref, so it is an interrupted create of OUR branch.
      if ((await networkState(network)) !== 'present') {
        this.releaseBranchRef(ref, branchId)
        throw new Error(`could not create the branch network ${network}: ${m}`)
      }
      console.warn(`reusing the existing network ${network}: it is a leftover of an interrupted create of this branch`)
    }
    // A clone materialises exactly what its SOURCE carries, never every registration the project
    // has ever made: services are branch-scoped, so a postgres added to `main` after `feat` was cut
    // must not appear on `feat`, and one added to `feat` must not reach `main`. This is the cloud's
    // `forkFromParent`, which iterates the parent BRANCH's services (platform
    // `src/provisioning/branch.ts:270`). A project's first branch has no source and, at that point,
    // no registrations either.
    const empty = opts?.empty === true
    const dbs = empty ? [] : this.dbList(project.id).filter((d) => !source || this.carries(project, source, d, 'postgres'))
    const stores = empty ? [] : this.stList(project.id).filter((s) => !source || this.carries(project, source, s, 'storage'))
    const managedRegs = empty ? [] : this.managedList(project.id).filter((m) => !source || this.carries(project, source, m, 'managed'))
    // Check every hostname this branch will mint and reserve every lane port it needs BEFORE the
    // first provisioning await, inside the engine-wide provision chain (decision 51). The check
    // itself writes nothing, so it stays out of a mutate: the chain is what makes it atomic.
    let lanes: Record<string, number>
    try {
      for (const d of dbs) this.assertHostFree(this.labelFor('postgres', d.name, ref))
      for (const m of managedRegs) this.assertHostFree(this.labelFor(m.type, m.name, ref))
      // From the FILTERED lists, not every registration the project has: a branch cut from a
      // source that carries a subset gets lanes for the subset. Reserving one per registration
      // both eats a small `INSTA_OSS_LANE_PORT_RANGE` (the create fails with "no free lane port
      // left" on ports nothing will ever listen on) and leaves the surplus behind as lane state
      // the branch row never supersedes.
      lanes = this.allocLanes(project, branchId, [...dbs.map((d) => d.id), ...managedRegs.map((m) => m.id)])  // WP2
    } catch (e) {
      // Nothing is provisioned yet, so the ref claim is the only thing to give back — and it has to
      // be, or the retry that follows fixing the collision would refuse itself as "in flight".
      this.releaseBranchRef(ref, branchId)
      throw e
    }
    // Every provider object this call created, so one compensation path can undo the whole stack.
    const madeDbs: PgTarget[] = []
    const madeBuckets: string[] = []
    const madeManaged: string[] = []
    const rollback = async (): Promise<void> => {
      for (const c of madeManaged) await this.managedDb.destroy(c).catch(() => {})
      for (const b of madeBuckets) await this.storage.destroy(b, network).catch(() => {})
      if (this.storage.detachFrom) await this.storage.detachFrom(network).catch(() => {})
      for (const d of madeDbs) await this.db.destroy(d.container).catch(() => {})
      // The branch root and the network carry no owner of their own — they are named after the ref,
      // which another operation may by then legitimately own. Remove them only while THIS operation
      // still holds the ref claim, so a compensation can never tear down a branch that succeeded.
      if (this.ownsBranchRef(ref, branchId)) {
        // A half-written data directory must not survive to be cloned over (WP4).
        for (const root of this.layout().branchRoots(ref)) await this.data.remove(root).catch(() => {})
        await docker(['network', 'rm', network]).catch(() => {})
      }
      this.releaseLanes(branchId)                                                                         // WP2
      this.releaseBranchRef(ref, branchId)
    }
    const databases: NonNullable<Branch['databases']> = {}
    const buckets: NonNullable<Branch['buckets']> = {}
    const managed: NonNullable<Branch['managed']> = {}
    try {
      // Postgres: one container per registered service, forked from the source's own file copy
      // when this is a clone (adapter-level: reflink or a streamed basebackup).
      for (const d of dbs) {
        const dst: PgTarget = { container: pgContainerName(ref, d.name), network, dataDir: this.layout().pg(ref, d.dataId) }
        const opts = { publishLoopback: this.cfg.mode === 'local', limits: this.limitsFor(project, d.id) }
        const src = source ? this.dbHandle(project, source, d.id) : undefined
        let url: string
        if (source && src) {
          this.assertMigrated(source)                                                                     // WP4
          const srcRef = this.ref(project, source)
          const forked = await this.db.fork(
            { container: src.container, network: source.network, dataDir: this.layout().pg(srcRef, src.dataId), url: src.url },
            dst,
            // WP3 hook: a sleeping source is woken before a basebackup-style fork reads it.
            { ...opts, ensureSourceRunning: () => this.wake(this.serviceKey(source, d.id), { door: 'api' }) },
          )
          url = forked.url
          // WP4: the copy method and duration travel to the branch.created payload (decision 39).
          // The oldest service's fork is the one the event reports.
          if (!this.forkResults.has(branchId)) this.forkResults.set(branchId, { method: forked.method, ms: forked.ms })
        } else {
          // A fresh branch, or a service the source branch never materialised: initdb.
          url = (await this.db.provision(dst, opts)).url
        }
        madeDbs.push(dst)
        databases[d.id] = { url, container: dst.container, dataId: d.dataId, host: this.hostFor('postgres', d.name, ref) }
      }
      // Storage: one bucket per registered service. The objects themselves copy in createBranch.
      for (const s of stores) {
        const out = await this.storage.provision(ref, network, s.name)
        madeBuckets.push(out.bucket)
        if (s.public === true && this.storage.setAccess) await this.storage.setAccess(out.bucket, network, true)
        buckets[s.id] = { bucket: out.bucket, env: out.env, ...(s.public !== undefined ? { public: s.public } : {}) }
      }
      // Managed databases: every branch gets a FRESH empty instance with a fresh password — no data
      // clones from the parent (cloud parity: platform materialize() for managed Fly databases).
      for (const m of managedRegs) {
        const password = randomBytes(32).toString('base64url')
        const container = managedContainerName(ref, m.type, m.name)
        // WP4: `md/<ref>/<prefix>-<dataId>` plus one sub-directory per path the image writes, all
        // created before the container starts (a missing bind source fails the start).
        const dataDir = await this.ensureManagedDirs(ref, m.type, m.dataId ?? m.name)
        await this.managedDb.provision(
          { container, network, type: m.type, name: m.name, password, dataDir },
          { publishLoopback: this.cfg.mode === 'local', limits: this.limitsFor(project, m.id) },
        )
        madeManaged.push(container)
        managed[m.id] = { password, host: this.hostFor(m.type, m.name, ref) }
      }
    } catch (e) {
      await rollback()
      throw e
    }
    const b: Branch = {
      id: branchId, projectId: project.id, name, isDefault, status: 'ready', ref,
      network, cloneOf: source?.name ?? null, createdAt: Date.now(), apps: {},
      // Handles are recorded at provision and READ afterwards (decision 17). New branches carry no
      // legacy dbUrl/bucket/s3 fields at all: migrateState derives those rows for OLD branches, and
      // nothing reads them once a branch has its own.
      databases, buckets,
      ...(Object.keys(managed).length ? { managed } : {}),
      ...(Object.keys(lanes).length ? { lanes } : {}),
      dataVersion: 1,                                                                                     // WP4
    }
    // The same mutate that writes the row drops the reservations it supersedes: the row IS the
    // claim on the ref and on every lane port from here on.
    mutate((s) => {
      s.branches[b.id] = b
      for (const [port, owner] of Object.entries(s.laneReservations ?? {})) {
        if (owner === branchId) delete s.laneReservations![port]
      }
      if (s.branchReservations?.[ref] === branchId) delete s.branchReservations[ref]
    })
    // WP3 hook: the scheduler learns the branch's database keys (no-op stub until WP3).
    this.scheduler.register([...Object.keys(databases), ...Object.keys(managed)].map((sid) => this.serviceKey(b, sid)))
    this.router.invalidate()
    return b
  }

  /** Create a project and its default branch. EMPTY, like the cloud (`resources: []`): nothing is
   *  registered, so `provisionBranch` provisions nothing and the caller adds services next. */
  async createProject(name: string): Promise<{ project: Project; defaultBranch: Branch }> {
    // The project id is minted here so its `projectOp` key exists before the row does, for the
    // same reason `createBranch` mints the branch id first: the default branch is a branch being
    // created, and a delete of this project must not run between the project row appearing and
    // that branch's row being committed. The key is taken OUTSIDE the provision chain, which is
    // the order every other taker uses (`withOp` outer, `serialize` inner), so the two can never
    // be acquired in opposite orders.
    const id = randomUUID()
    return this.withOp([this.projectOp(id)], () => this.serialize('provision', async () => {
      const project: Project = { id, name, status: 'ready', createdAt: Date.now(), refSlug: slug(name) }
      // Both uniqueness checks and the insert in ONE synchronous mutate, inside the provision
      // chain: two concurrent creates of the same name or slug cannot both pass the check
      // (decision 51). Slugs are frozen per project and outlive renames, so a NEW project must not
      // reuse one — its containers would collide with resources a renamed project still owns.
      mutate((s) => {
        for (const p of Object.values(s.projects)) {
          if (p.name === name) throw new Error(`project "${name}" already exists`)
          if (this.projectSlug(p) === project.refSlug) {
            throw new Error(`project ref "${project.refSlug}" already exists (a renamed project still owns its original resource names)`)
          }
        }
        s.projects[project.id] = project
      })
      try {
        const defaultBranch = await this.provisionBranch(project, DEFAULT_BRANCH, true, null, randomUUID())
        this.emit(project.id, DEFAULT_BRANCH, 'resource', 'project.created', { name })
        return { project, defaultBranch }
      } catch (e) {
        // compensate: never leave a half-provisioned project behind
        mutate((s) => { delete s.projects[project.id] })
        throw e
      }
    }))
  }

  async createBranch(projectId: string, name: string, from?: string, opts?: { excludeServices?: boolean }): Promise<Branch> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    // The console's "Exclude all services": an empty branch, none of the parent's services,
    // secrets, or secret bindings are copied. The parent still names what the branch was cut
    // from (the event records it), it just contributes nothing to the clone. One known
    // divergence: compute registrations are project-scoped here (`computeGroupNames`), so the
    // empty branch still lists them as not-deployed rows — no container, data or secret is copied.
    const excludeServices = opts?.excludeServices === true
    // Rename has always enforced this; create had not, so the API accepted a name that the
    // per-branch hostnames and URLs cannot express (`my branch`, `a/b`, `x?`). Same rule both
    // ways, at the daemon, so the CLI and agents get it too and not just the dashboard.
    assertBranchName(name)
    const source = this.getBranchByName(projectId, from ?? DEFAULT_BRANCH)
    if (!source) throw new Error(`source branch "${from ?? DEFAULT_BRANCH}" not found`)
    if (this.getBranchByName(projectId, name)) throw new Error(`branch "${name}" already exists`)

    // The new branch's id is minted FIRST, so its ServiceKeys exist before any container op
    // (decision 51). The lock covers the source's services (the fork reads them, and a sleeping one
    // is woken) and the clone's own, and BOTH branch keys (`branchOp`), which is what makes the
    // window between the row's commit and the last post-commit step private: a deploy to the clone
    // or a delete of it queues instead of racing the create, and the compensation runs inside the
    // same acquisition, so it can only ever tear down what this operation built.
    //
    // The clone's COMPUTE keys are held here too, rather than left to the redeploy loop. It is one
    // sorted acquisition either way, and a key taken later, while others are held, is the shape
    // that can deadlock against a multi-key operation going the other way; taken up front there is
    // no second acquisition anywhere in the create, since every nested `deploy`, `wake` and
    // `sleep` re-enters a key this already owns.
    const branchId = randomUUID()
    //
    // The key set is computed from the source row as it stands BEFORE the lock, and the row can
    // grow before the lock is granted: an `add*Service` already in flight when this snapshot is
    // taken holds `branchOp(source)` (which is why the create waits) and materialises its
    // service before it lets go. `createBranchLocked` then re-reads and forks a service this
    // acquisition never named, and that fork's `ensureSourceRunning` would take its key as a
    // SECOND acquisition while these are held, which is the circular wait decision 52 forbids.
    //
    // So the set is checked against the row under the lock and, when it has grown, the whole
    // acquisition is RE-DRIVEN over the union: released first, then taken again in one sorted
    // acquisition. Never a nested one, so deadlock freedom is the same single-acquisition
    // argument as before, and nothing has been provisioned at that point (the check runs before
    // `createBranchLocked`), so a re-drive costs only the queueing. It converges: the union only
    // grows, and from the first round on this holds `branchOp(source)`, which every add now
    // needs, so a second divergence would take an add landing in the gap between two rounds.
    // Bounded anyway, and a create that cannot settle says so rather than spinning.
    let keys = this.createBranchKeys(project, source, branchId, excludeServices)
    for (let round = 1; ; round++) {
      const settled = new Set(keys)
      const out = await this.withOp([...settled], async (): Promise<{ branch: Branch } | { union: ServiceKey[] }> => {
        // Same order as `createBranchLocked`'s own re-read, so a project that went while this
        // queued still answers `project not found` rather than reporting its branch missing.
        if (!this.getProject(projectId)) throw new Error('project not found')
        const live = loadState().branches[source.id]
        if (!live) throw new Error(`source branch "${source.name}" not found`)
        const needed = this.createBranchKeys(project, live, branchId, excludeServices)
        if (needed.every((k) => settled.has(k))) {
          return { branch: await this.createBranchLocked(project, name, live, branchId, excludeServices) }
        }
        return { union: [...new Set([...settled, ...needed])] }
      })
      if ('branch' in out) return out.branch
      if (round >= CREATE_LOCK_ROUNDS) {
        throw new Error(`branch create could not settle its lock set after ${CREATE_LOCK_ROUNDS} rounds: services on "${source.name}" are being added or removed concurrently, retry the create`)
      }
      keys = out.union
    }
  }

  /** Every ServiceKey a create of `branchId` from `source` touches: the project, both branch
   *  keys, and the source's carried services and compute groups on BOTH sides (what the source
   *  carries is exactly what the clone will carry, so one list keys both). Recomputed under the
   *  lock from the re-read row, which is what makes the union check above meaningful.
   *
   *  An exclude-services create forks nothing, so it needs no service keys at all — only the
   *  project and the two branch keys. The set is static, so the union re-drive above settles on
   *  the first round no matter what is being added to the source concurrently. */
  private createBranchKeys(project: Project, source: Branch, branchId: string, excludeServices = false): ServiceKey[] {
    if (excludeServices) return [this.projectOp(project), this.branchOp(source), this.branchOp(branchId)]
    const ids = this.carriedServiceIds(project, source)
    const groups = Object.keys(source.apps ?? {})
    return [
      // The project key too: until the row is committed there is no branch key a project delete
      // could collide with, so this is what keeps the clone out of the gap in its branch list.
      this.projectOp(project),
      this.branchOp(source),
      ...ids.map((sid) => `${source.id}:${sid}`),
      ...groups.map((g) => `${source.id}:cp-${g}`),
      this.branchOp(branchId),
      ...ids.map((sid) => `${branchId}:${sid}`),
      ...groups.map((g) => `${branchId}:cp-${g}`),
    ]
  }

  private async createBranchLocked(projectAtCall: Project, name: string, sourceAtCall: Branch, branchId: string, excludeServices = false): Promise<Branch> {
    const projectId = projectAtCall.id
    // Everything above was read BEFORE the lock, and the rows can have moved while this waited.
    // A project delete holding the same project key may have taken the project, the source
    // branch or both, so provisioning against those snapshots would build containers, buckets
    // and bytes that nothing names. And `renameBranch` takes NO operation lock (it moves no
    // container), so the source can also have been renamed under us -- `unwindBranch` carries
    // two names for exactly that reason. Both rows are therefore RE-READ, not merely asserted to
    // exist: the clone inherits its parent's branch-scoped secrets BY NAME and records the
    // parent's name in the `branch.created` payload, and a stale name inherits nothing and
    // reports a branch that no longer answers to it.
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const source = loadState().branches[sourceAtCall.id]
    if (!source) throw new Error(`source branch "${sourceAtCall.name}" not found`)
    this.assertUsable(source, 'forked')
    if (this.getBranchByName(projectId, name)) throw new Error(`branch "${name}" already exists`)
    // Each database forks inside provisionBranch (db.fork); each bucket copies here; compute
    // redeploys. An exclude-services create provisions only the branch shell (ref, network, row):
    // passing `source` with `empty` keeps the fork semantics ("cut from that branch") without
    // materialising anything it carries.
    const b = await this.serialize('provision', () => this.provisionBranch(project, name, false, source, branchId, { empty: excludeServices }))
    // `provisionBranch` COMMITS the branch row, and every step below it -- the volume forks, the
    // bucket copies, the compute deploys, the inherited secrets -- builds resources that row
    // already advertises. `provisionBranch`'s own rollback cannot reach any of them, so a failure
    // down here used to return an error and leave a HALF-BUILT branch whose name was taken: the
    // retry the user made next was refused with `branch "x" already exists`, and the only way out
    // was to delete a branch that had never finished being created.
    //
    // The compensation therefore covers the whole operation: `unwindBranch` runs the same
    // demolition `branch delete` runs and drops the row last, so a failed create leaves nothing
    // behind and the NAME IS FREE for an ordinary retry. The alternative -- a resumable
    // `provisioning` row a retry continues -- was rejected because it fights the reservation this
    // PR already has: `reserveBranchRef` yields to a branch row, and boot's
    // `reclaimAbandonedReservations` deliberately KEEPS any claim whose branch row still exists.
    // A row that outlives its operation is exactly the stuck state this fixes, one status field
    // further along, and it would put a half-built branch in front of every list, route and
    // deploy that resolves a branch by name.
    let secretsCloned = false
    // The parent's name as the secret copy below actually found it, so the event reports the
    // branch this fork came from rather than a name that moved while it was being built.
    let sourceName = source.name
    // ...and the CLONE's own name, for the same reason and read the same way. `provisionBranch`
    // has already committed this row, so `renameBranch` can move it at any await below.
    let cloneName = name
    try {
      // WP4 hook: /data volumes fork BEFORE the redeploy loop, so each new container starts on its
      // own copy rather than sharing the source's bytes. An exclude-services create carries no
      // compute, so there is nothing to fork, clone or redeploy.
      const volumes = excludeServices ? [] : await this.forkVolumes(project, source, b)
      if (!excludeServices) {
        for (const s of this.stList(projectId)) {
          const from = this.bucketHandle(project, source, s.id)
          const to = this.bucketHandle(project, b, s.id)
          if (from && to) await this.storage.cloneInto(from.bucket, to.bucket, b.network)
        }
        // compute = redeploy: same image, SAME listen port, allocated host mapping.
        for (const [group, app] of Object.entries(source.apps)) {
          // WP3 hook: a clone of a non-always-on service starts asleep (false until the scheduler lands).
          await this.deployAllocatingPort(projectId, name, group, app, { startAsleep: this.startAsleepFor(project, b, group) })
        }
      }
      // platform parity: the parent branch's user-defined (branch-scoped) secrets clone onto the new
      // branch, and so do its bindings (a template's platform credential renames must survive a fork).
      //
      // The parent is read from the state this mutate is ALREADY HOLDING, never from the row this
      // method re-read on the way in. Re-reading under the lock closed the window before the
      // provisioning; the window after it is the long one, and it is still open: the provision
      // chain, the volume forks, the bucket clones and the whole redeploy loop are seconds of
      // awaits, and `renameBranch` takes no operation lock (it moves no container), so it lands
      // anywhere in there. These rows are keyed by branch NAME, so a name captured before that
      // window matches nothing afterwards and the clone silently inherits NONE of its parent's
      // secrets. A synchronous read inside the same mutate has no window at all. A parent row
      // that is somehow gone by now falls back to the name the create started with, which is the
      // best evidence left.
      // The DESTINATION is read from the same state, in the same mutate, and for a worse
      // reason than the source. The clone's row is committed and visible, so a rename can move
      // it while the volumes fork and the containers deploy; writing the inherited rows under
      // the name captured at the start then files them under a name this branch no longer
      // answers to. That is not "the clone loses its secrets": secret resolution is by NAME, so
      // the next branch to take the freed old name INHERITS THEM. A cross-branch leak of
      // credentials, from a rename that looks like a metadata edit.
      mutate((st) => {
        const parent = st.branches[source.id]
        sourceName = parent?.name ?? source.name
        cloneName = st.branches[b.id]?.name ?? name
        // Exclude-services: the names above are still needed for the event, but none of the
        // parent's secrets, bindings or db settings are copied ("Creates an empty branch").
        if (excludeServices) return
        const list = st.userSecrets[projectId] ?? []
        const inherited = list.filter((u) => u.branch === sourceName).map((u) => ({ ...u, branch: cloneName }))
        st.userSecrets[projectId] = [...list, ...inherited]
        const bindings = parent?.bindings ?? source.bindings
        if (bindings?.length) st.branches[b.id].bindings = bindings.map((x) => ({ ...x }))
        // the DB volume-size setting travels with the clone (it describes the copied database)
        const dbVolumeGib = parent?.dbVolumeGib ?? source.dbVolumeGib
        if (dbVolumeGib !== undefined) st.branches[b.id].dbVolumeGib = dbVolumeGib
      })
      secretsCloned = !excludeServices
      // WP3 hook: the clone's databases sleep until first use (no-op until the scheduler lands).
      await this.sleepNewBranch(project, b)
      // WP4: how the database and each /data volume were copied (decision 39), so `insta events`
      // shows whether the box reflinked or fell back to streaming and copying.
      const db = this.forkResults.get(b.id)
      this.forkResults.delete(b.id)
      // Both names as the copy actually found them, so the event does not report a branch that
      // no longer answers to the name in it, and the caller gets the row as it stands rather
      // than the snapshot taken at commit time.
      this.emit(projectId, cloneName, 'resource', 'branch.created', { from: sourceName, ...(db ? { db } : {}), volumes, ...(excludeServices ? { excludedServices: true } : {}) })
      return loadState().branches[b.id] ?? b
    } catch (e) {
      const undone = await this.unwindBranch(project, b, secretsCloned)
      // The user is told the name is still taken, on the error they already have: with the message
      // amended in place the error keeps its type and any `status` a route reads off it.
      if (!undone.complete && e instanceof Error) {
        e.message = `${e.message} (the half-built branch could not be fully torn down, so its row is kept as "${undone.kept ?? name}" with status ${CLEANUP_FAILED} and the name stays taken; \`insta branch delete ${undone.kept ?? name}\` retries the teardown)`
      }
      throw e
    }
  }

  /** Undo a branch create that failed AFTER its row was committed.
   *
   *  `teardownBranch` is the demolition `branch delete` uses, so every provider object the create
   *  made -- containers, buckets, the network, the branch's bytes -- goes exactly the way it would
   *  if the branch had finished and then been deleted. When it all goes, the ROW goes last: with it
   *  gone, the name, the ref, the lane ports and the minted hostnames it owned are all free, and
   *  the user's retry is an ordinary create rather than a collision. That is the property this
   *  compensation exists to provide and it is unchanged for the case that matters.
   *
   *  When the demolition does NOT all go, the row STAYS, marked `cleanup-failed`. Deleting it
   *  anyway is what the teardown counters were being ignored for: a container, bucket or directory
   *  that refused to go on with no row naming it is invisible to `insta branch list`, to project
   *  delete and to the operator, while still holding its ports, its RAM and its disk, and nothing
   *  will ever come back for it. A row that names it is the handle: it lists (with a status that
   *  says what happened), `insta branch delete <name>` retries exactly this demolition, and boot's
   *  own sweeps can see it.
   *
   *  The cost is stated plainly because it is real: a kept row KEEPS THE NAME, so the retry of the
   *  create is refused with `already exists` until the delete succeeds. Between a name blocked by
   *  a row the user can see and act on, and a name freed by abandoning resources nobody can reach,
   *  this takes the first. Nothing is kept on the success path, which is the common one.
   *
   *  Best effort throughout, and that means the bookkeeping too, not just the demolition: the
   *  state write, the lane release, the router invalidation and the event all sit inside a catch
   *  of their own. The caller is already throwing the failure the user needs to see, and a
   *  compensation that throws its own would replace it with a worse one; what it reports back is
   *  whether the name is free again, re-read from the row when a step did throw. */
  private async unwindBranch(project: Project, b: Branch, secretsCloned: boolean): Promise<{ complete: boolean; kept?: string }> {
    // The row as it stands now, not the snapshot the create started from: the deploy loop wrote
    // apps onto it, and those are what `teardownBranch` forgets from the scheduler.
    const row = loadState().branches[b.id] ?? b
    const ref = this.ref(project, b)
    // `teardownBranch` counts each provider object it could not remove instead of throwing, so the
    // counter is the verdict; a throw is one too (it means the rest of the demolition never ran).
    const t = newTeardown()
    let failure: string | undefined
    try {
      await this.teardownBranch(project, row, t)
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e)
      console.warn(`could not fully undo the failed create of branch "${b.name}": ${failure}`)
    }
    const complete = t.failed === 0 && failure === undefined
    let kept: string | undefined
    // Everything below is bookkeeping, and "best effort throughout" has to cover it too: a throw
    // out of the state write, the lane release, the router invalidation or the event would leave
    // the caller re-throwing THIS error instead of the create failure the user needs to see, and
    // would skip whichever of these steps came after it. So they run inside a catch of their own,
    // and the verdict is then re-read from the state rather than assumed: what the caller needs
    // to know is whether the name is free, and only the row can answer that.
    try {
      this.forkResults.delete(b.id)
      mutate((s) => {
        // Every name this branch has answered to: the one the create minted, the one it carried into
        // the teardown, and the one it has RIGHT NOW (a rename can land during the teardown too).
        const names = [b.name, row.name, s.branches[b.id]?.name].filter((n): n is string => typeof n === 'string')
        // Names OTHER branches hold, computed before this row goes either way, so a kept row does
        // not shield its own secret copies from the sweep below.
        const taken = new Set(Object.values(s.branches).filter((x) => x.id !== b.id && x.projectId === b.projectId).map((x) => x.name))
        if (complete) delete s.branches[b.id]
        else if (s.branches[b.id]) {
          s.branches[b.id].status = CLEANUP_FAILED
          kept = s.branches[b.id].name
        }
        // The clone inherits the source's branch-scoped secrets BY NAME, so the copies it made are
        // exactly the rows naming a branch that is about to stop existing. Only drop them when that
        // step actually ran: a failure before it has nothing of its own to clean.
        //
        // BOTH names, because `renameBranch` is synchronous state work that takes no operation lock
        // (it moves no container), so it can land at any await this create makes -- and when it does
        // it carries the branch's secret rows to the new name with it. Matching only the name the
        // create started with then left every inherited copy behind under the new one. A branch id
        // on the rows would be the better key, but `UserSecret` is `{name, value, branch, service}`
        // with the branch as a NAME (that is what `userSecretsFor`, the CLI's `--branch` and the
        // rename itself all read), so keying by id means migrating every stored row and every
        // reader; two names is the fix that fits the shape the data actually has.
        // They go even when the row is kept: the kept row is a handle for finishing the demolition,
        // not a usable branch, and leaving the copies would hand them to the create that follows the
        // delete -- which is the double inheritance this sweep exists to prevent.
        if (secretsCloned) {
          const list = s.userSecrets[b.projectId]
          // ...but never a name some OTHER branch holds now: a rename frees the old name, and if a
          // branch created since owns it, its secrets are not ours to delete.
          const ours = new Set(names.filter((n) => !taken.has(n)))
          if (list) s.userSecrets[b.projectId] = list.filter((u) => u.branch === null || !ours.has(u.branch))
        }
        // The row superseded the ref claim on commit; if anything re-took it, it is not ours.
        if (s.branchReservations?.[ref] === b.id) delete s.branchReservations[ref]
      })
      // Only stale RESERVATIONS: a kept row's own `lanes` stay claimed, because the containers that
      // refused to go may still be listening on them.
      this.releaseLanes(b.id)
      this.router.invalidate()
      if (!complete) {
        this.emit(project.id, kept ?? row.name, 'resource', 'branch.cleanupFailed', { teardown: t, ...(failure ? { error: failure } : {}) })
      }
    } catch (e) {
      console.warn(`could not finish the unwind of branch "${b.name}": ${e instanceof Error ? e.message : String(e)}`)
      const left = loadState().branches[b.id]
      return left ? { complete: false, kept: left.name } : { complete }
    }
    return { complete, ...(kept !== undefined ? { kept } : {}) }
  }

  /** Rename a project — DISPLAY NAME ONLY, like the cloud: every resource keeps its original
   *  name (the ref slug froze at creation, so even branches created later stay on it). */
  renameProject(projectId: string, name: string): { id: string; name: string; status: string } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    if (!name.trim() || name.length > 100) throw new Error('name must be 1..100 characters')
    if (name !== project.name && this.listProjects().some((p) => p.name === name)) throw new Error(`project "${name}" already exists`)
    mutate((st) => {
      // freeze the slug before the name moves (older records derive it from the name)
      st.projects[projectId].refSlug ??= this.projectSlug(project)
      st.projects[projectId].name = name
    })
    this.emit(projectId, null, 'resource', 'project.rename', { from: project.name, to: name })
    return { id: projectId, name, status: project.status }
  }

  /** Rename a branch — METADATA ONLY, like the cloud: provider resources (containers, network,
   *  bucket, minted creds) keep their frozen ref. Not the default branch; lower-kebab; unique. */
  renameBranch(projectId: string, branchId: string, newName: string): { id: string; name: string; is_default: boolean; status: string } {
    const project = this.getProject(projectId)
    const b = loadState().branches[branchId]
    if (!project || !b || b.projectId !== projectId) throw new Error('branch not found')
    if (b.isDefault) throw new Error('cannot rename the default branch')
    assertBranchName(newName)
    if (newName !== b.name && this.getBranchByName(projectId, newName)) throw new Error(`branch "${newName}" already exists`)
    const oldName = b.name
    mutate((st) => {
      // freeze the ref before the name moves (older records derive it from the name)
      st.branches[branchId].ref ??= this.ref(project, oldName)
      st.branches[branchId].name = newName
      // branch-scoped user secrets are keyed by branch NAME — they follow the rename
      for (const u of st.userSecrets[projectId] ?? []) if (u.branch === oldName) u.branch = newName
      // git bindings store branchName only for display (deploy resolves by branchId); keep it in sync
      // so GET /…/git and `insta` output don't report a stale branch name after a rename.
      if (st.gitBindings) for (const r of Object.values(st.gitBindings)) if (r.projectId === projectId && r.branchId === branchId) r.branchName = newName
    })
    this.emit(projectId, newName, 'resource', 'branch.rename', { from: oldName, to: newName })
    const renamed = loadState().branches[branchId]
    return { id: renamed.id, name: renamed.name, is_default: renamed.isDefault, status: renamed.status }
  }

  async deploy(projectId: string, branchName: string, opts: { image: string; port?: number; hostPort?: number; group?: string; startAsleep?: boolean }): Promise<{ url: string; branch: string; group: string }> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const b = this.getBranchByName(projectId, branchName)
    if (!b) throw new Error(`branch "${branchName}" not found`)
    const group = opts.group ?? 'default'
    // The branch key with the service key, in ONE acquisition: a deploy must not land inside a
    // branch create that has committed the row but is still building the branch.
    return this.withOp([this.branchOp(b), this.serviceKey(b, `cp-${group}`)], () => this.deployLocked(projectId, b.id, group, opts))
  }

  /** Git push-to-deploy's deploy step. Unlike `deploy`, this NEVER materialises a new group and it
   *  preserves the existing service's configured port: the binding, the group's existence and its
   *  port are all re-read INSIDE the same service lock that `removeComputeService` takes, so a build
   *  that finished after its target was removed sees the group gone and returns null instead of
   *  re-creating it, and a service on a non-8080 port is redeployed on that same port. Returns null
   *  when the branch, the binding, or the group is gone (the caller then does not deploy). */
  async deployFromGit(projectId: string, branchId: string, group: string, bindingId: string, image: string): Promise<{ deployed: true; port: number } | null> {
    const b0 = loadState().branches[branchId]
    if (!b0 || b0.projectId !== projectId) return null
    return this.withOp([this.branchOp(b0), this.serviceKey(b0, `cp-${group}`)], async () => {
      const st = loadState()
      const b = st.branches[branchId]
      // Re-validated under the lock (the whole point): the branch, the still-live binding, and the
      // EXISTING app row. If removeComputeService got the key first it has already deleted both, so
      // a stale webhook cannot re-materialise the group deployLocked would otherwise re-create.
      if (!b || b.projectId !== projectId || !st.gitBindings?.[bindingId]) return null
      const app = b.apps?.[group]
      if (!app) return null
      const port = app.port // preserve the configured port; deployLocked defaults an omitted port to 8080
      await this.deployLocked(projectId, branchId, group, { image, port })
      return { deployed: true, port }
    })
  }

  // Takes a branch ID, not a Branch: anything read before the chain is a pre-queue snapshot, and an
  // op that ran ahead of this one has already moved it (its image, its host mapping, its intent).
  // The adapter argument object is assembled through the owner hooks of contract 7.2 (WP2 host
  // port/aliases/containerize/url, WP3 limits/afterDeploy, WP4 volume, WP5 envFor): those packages
  // replace hook bodies in their regions and never edit this method again.
  private async deployLocked(
    projectId: string, branchId: string, group: string,
    opts: { image: string; port?: number; hostPort?: number; startAsleep?: boolean },
  ): Promise<{ url: string; branch: string; group: string }> {
    const project = this.getProject(projectId)!
    const b = loadState().branches[branchId]
    if (!b) throw new Error('branch not found')
    this.assertUsable(b, 'deployed to')
    const port = opts.port ?? 8080
    // The group's /data volume, if one was attached at service creation. Named per-branch (each
    // branch is isolated; a clone starts with an EMPTY volume — compute state lives in db/storage)
    // and keyed by the volume's stable id so a service rename never detaches the data.
    const vol = project.computeVolumes?.[group]
    if (vol && !this.compute.supportsVolumes) {
      throw new Error(`service "${group}" has a /data volume, which this compute adapter does not support — use the docker adapter`)
    }
    // Read before the container work, not only after: the adapter can then decline to start a
    // replacement whose standing intent is STOPPED, instead of running it and being stopped a moment
    // later. Safe to read here — the chain means nothing else is moving it.
    //
    // Only 'stopped'. A suspended service's replacement must START: suspend is `docker pause`, and
    // a container that was created and never started cannot be paused — the pause fails, the
    // container stays `created`, and state() reports it `stopped`, contradicting the intent the
    // re-assert just preserved. The brief run is the cost of suspend being a pause.
    const standing = b.apps[group]?.desiredState
    const key = this.serviceKey(b, `cp-${group}`)
    // A group materialises on its first deploy — `insta deploy --group <name>` needs no prior
    // `services add` — so this IS the compute registration for a direct deploy, and it gets the
    // same treatment: the name is validated, and the hostname it will mint is checked against
    // every label on the box and reserved before anything is created (decision 51). Without it a
    // group named `pg-db` mints the postgres service `db`'s hostname and shadows it in the table.
    const label = this.labelFor('compute', group, this.ref(project, b))
    const minting = b.apps[group]?.host === undefined
    if (minting) {
      this.assertServiceName(group)
      this.reserveHosts([label], key)
    }
    const hostPort = this.localHostPort(b, group, { hostPort: opts.hostPort, port })
    const started = standing !== 'stopped' && !opts.startAsleep
    let adapterUrl: string
    try {
      ({ url: adapterUrl } = await this.compute.deploy(this.ref(project, b), {
        image: opts.image, port, network: b.network, group,
        hostPort,                                                    // WP2 (local mode only)
        hostAliases: this.hostAliasesFor(project, b, group),         // WP2 (incl. THIS group's own host)
        volume: this.volumeMount(project, b, group),                 // WP4
        limits: this.limitsFor(project, `cp-${group}`),              // WP3
        // minted credentials (db + storage + managed databases) reach every compute deploy; user
        // secrets are scoped (project-wide + branch-unbound + bound to THIS group)
        envVars: this.containerize(this.envFor(project, b, group)), // WP5 envFor, WP2 containerize
        start: started,
      }))
    } catch (e) {
      // The row write below is what turns the reservation into ownership; a deploy that never gets
      // there must give the port back instead of leaking one out of the lane range every time —
      // and the same holds for the hostname it reserved.
      if (hostPort !== undefined && b.apps[group]?.hostPort !== hostPort) this.releaseHostPort(hostPort)
      if (minting) this.releaseHosts(key)
      throw e
    }
    // The recorded URL is the serviceUrl hook's (WP2: the router URL, deterministic before deploy);
    // the scaffold body reads the adapter's informational url off the row about to be written.
    const url = this.serviceUrl(project, { ...b, apps: { ...b.apps, [group]: { ...b.apps[group], image: opts.image, port, hostPort, url: adapterUrl } } }, group)
    // Spread, not replace: desiredState is the user's standing intent and this write is not the
    // place to clear it. A `stop` landing while a deploy is in flight would otherwise be undone by
    // the deploy's own state write — and `restart` makes that reachable from an operation that
    // checked the intent moments earlier. Matches the platform, whose desired_state survives a deploy.
    const host = this.mintedHost(project, b, group)                                                     // WP2
    mutate((s) => {
      // Read BEFORE the row is rewritten: on an install upgraded to this code the previous
      // `updatedAt` is the only record of when the group was last deployed, and it is exactly what
      // the Created column has been showing for it.
      const priorUpdatedAt = s.branches[b.id].apps[group]?.updatedAt
      // addedAt: stamped when this branch first carries the group, and kept by every redeploy after. A group
      // removed from this branch drops its row, so a later deploy here is a new incarnation whose metrics
      // history must not include the removed one's samples (observedTargets' `since`).
      s.branches[b.id].apps[group] = { ...s.branches[b.id].apps[group], image: opts.image, port, hostPort, url, ...(host !== undefined ? { host } : {}), updatedAt: Date.now(), addedAt: s.branches[b.id].apps[group]?.addedAt ?? Date.now() }
      // A group materialised BY this deploy (`insta deploy --group <name>`, no prior add) never got
      // a createdAt, so the service row fell back to `updatedAt` — which every redeploy rewrites,
      // making the dashboard's Created column walk forward on each deploy. Stamp it once; an
      // existing stamp is never overwritten.
      //
      // NOT gated on `minting`. A group that was direct-deployed BEFORE this code shipped already
      // has a host, so it would never mint again and would never be stamped: its Created column
      // would keep walking forward for the life of the install. Backfill it with the `updatedAt`
      // it had on the way in rather than with now, so the date the user has been reading does not
      // jump on the upgrade deploy — it just stops moving, which is the whole point.
      {
        const settings = (s.projects[project.id].serviceSettings ??= {})
        const existing = settings[`cp-${group}`]?.createdAt
        // Derived from every branch that already carries the group, NOT from this branch's
        // `minting`. The stamp is project-level and `services()` reads it for every branch, while
        // `minting` is per-branch: cloning a legacy group onto a NEW branch makes it true there, so
        // keying off it stamped `Date.now()` and jumped the Created date of the copy that had been
        // running all along. The oldest deploy we can still see is the closest thing to the truth;
        // `Date.now()` is only for a group nothing has ever deployed.
        const seen: number[] = []
        for (const br of Object.values(s.branches)) {
          if (br.projectId !== project.id) continue
          const at = br.id === b.id ? priorUpdatedAt : br.apps?.[group]?.updatedAt
          if (typeof at === 'number') seen.push(at)
        }
        settings[`cp-${group}`] = {
          ...settings[`cp-${group}`],
          createdAt: existing ?? (seen.length ? Math.min(...seen) : Date.now()),
        }
      }
      // The row now owns the port, exactly as `laneFor` retires a branch-create reservation.
      if (hostPort !== undefined) delete s.laneReservations?.[String(hostPort)]
      // ...and the row now owns the hostname, so the reservation retires with it.
      if (s.hostReservations?.[label] === key) delete s.hostReservations[label]
    })
    // ...and the container has to HONOUR that intent, or preserving it just makes the row lie:
    // DockerCompute.deploy always `docker run`s the replacement, so a service the user stopped would
    // come back up while the row still read `stopped`. Re-assert on the container only — the state
    // is already right and must not be rewritten, and the EXACT verb matters (oss allows a suspended
    // volume-bearing service, so suspend must not be coarsened to stop). Best-effort, like the
    // adapter ops in lifecycle(): the deploy itself has already succeeded.
    // Re-assert anyway: `start` is a hint an adapter may ignore, and this is the guarantee. A
    // guarantee that swallows its own failure is not one: the re-assert used to be best-effort
    // and `afterDeploy` below then told the scheduler `onPaused`/`onStopped` for a container
    // that had just been started and never stopped. The deploy itself HAS succeeded, so the
    // truth is recorded first (the replacement is up) and the call then fails, naming the verb
    // to retry. Nothing is left claiming a transition that did not happen.
    if (standing === 'stopped' || standing === 'suspended') {
      const op = standing === 'suspended' ? this.compute.suspend : this.compute.stop
      try {
        await op?.call(this.compute, this.ref(project, b), group)
      } catch (e) {
        if (started) this.scheduler.onUp(key)
        this.router.invalidate()
        const verb = standing === 'suspended' ? 'suspend' : 'stop'
        throw new LifecycleFailedError(`deployed ${group}, but could not re-assert its ${standing} state on the replacement container (${e instanceof Error ? e.message : String(e)}): it is RUNNING against a ${standing} intent. Run \`insta compute ${verb} ${group}\` to retry`)
      }
    }
    this.afterDeploy(key, { started, startAsleep: opts.startAsleep }) // WP3
    this.router.invalidate()                                          // WP2
    this.emit(projectId, b.name, 'resource', 'deploy', { image: opts.image, group, url })
    return { url, branch: b.name, group }
  }

  /** Deploy an app spec onto a branch with an allocated host mapping. The naive parent+1000
   *  collides as soon as a second branch exists (or the OS holds the port — e.g. macOS AirPlay
   *  on 5000), so allocate from state and retry on bind failures. */
  private async deployAllocatingPort(projectId: string, branchName: string, group: string, app: { image: string; port: number }, extra: { startAsleep?: boolean } = {}): Promise<void> {
    let lastErr: unknown
    for (const candidate of this.freeHostPorts(app.port, 5)) {
      try {
        await this.deploy(projectId, branchName, { image: app.image, port: app.port, hostPort: candidate, group, ...extra })
        return
      } catch (e) {
        lastErr = e
        if (!/port is already allocated|address already in use/i.test(e instanceof Error ? e.message : '')) throw e
      }
    }
    throw lastErr
  }

  /** Host-port candidates for a branch redeploy: base+1000·k, skipping ports any app already uses. */
  private freeHostPorts(basePort: number, count: number): number[] {
    const used = new Set<number>()
    for (const b of Object.values(loadState().branches)) {
      for (const app of Object.values(b.apps)) used.add(app.hostPort ?? app.port)
    }
    const out: number[] = []
    for (let k = 1; out.length < count && k < 50; k++) {
      const cand = basePort + 1000 * k
      if (!used.has(cand)) out.push(cand)
    }
    return out
  }

  secrets(projectId: string, branchName: string): Record<string, string> {
    const b = this.getBranchByName(projectId, branchName)
    if (!b) throw new Error(`branch "${branchName}" not found`)
    return { ...this.mintedSecretsFor(projectId, b), ...this.userSecretsFor(projectId, branchName) }
  }

  /** The branch's minted credentials: every postgres DSN, every S3 bundle and every
   *  managed-database bundle, each SUFFIXED with its service name, the oldest of each type also
   *  under the canonical unsuffixed keys. Bindings are NOT here: they are per target group. */
  private mintedSecretsFor(projectId: string, b: Branch): Record<string, string> {
    const project = this.getProject(projectId)
    if (!project) return {}
    return { ...this.dbSecretsFor(project, b), ...this.storageSecretsFor(project, b), ...this.managedSecretsFor(projectId, b) }
  }

  /** Minted managed-database credentials for a branch, on the cloud's naming contract: every
   *  service's bundle stored SUFFIXED (`REDIS_URL_<NAME>`), and the oldest service of each type
   *  additionally surfaces the canonical unsuffixed aliases — computed here at read time, so
   *  removing the oldest shifts the aliases on the next read (platform spec §2.1). */
  private managedSecretsFor(projectId: string, branch: Branch): Record<string, string> {
    const project = this.getProject(projectId)
    const out: Record<string, string> = {}
    const aliased = this.aliasedManagedIds(projectId, branch)
    for (const m of project?.managedServices ?? []) {
      const cred = branch.managed?.[m.id]
      if (!cred) continue
      // Host-facing, like the postgres DSN and `credentials()`: the lane is the address a client
      // outside the branch network dials, and `containerize()` maps it back for a container.
      const lane = this.laneAddress(project!, branch, m.id)
      const bundle = laneBundle(m.type, lane.host, lane.port, cred.password, lane.tls)
      Object.assign(out, suffixBundle(bundle, m.name))
      if (aliased.has(m.id)) Object.assign(out, bundle)
    }
    return out
  }

  // ---- user-defined secrets (insta secrets set/unset) ----

  /** Effective user secrets for a branch: project-wide first, branch-scoped override. */
  userSecretsFor(projectId: string, branchName: string): Record<string, string> {
    const list = loadState().userSecrets[projectId] ?? []
    const out: Record<string, string> = {}
    for (const u of list) if (u.branch === null) out[u.name] = u.value
    for (const u of list) if (u.branch === branchName) out[u.name] = u.value
    return out
  }

  /** Env for one compute group's deploy: project-wide + branch-unbound + secrets bound to
   *  THIS group. Secrets bound to a different service never leak into another group's env. */
  private deploySecretsFor(projectId: string, branchName: string, group: string): Record<string, string> {
    const list = loadState().userSecrets[projectId] ?? []
    const out: Record<string, string> = {}
    for (const u of list) if (u.branch === null) out[u.name] = u.value
    for (const u of list) if (u.branch === branchName && !u.service) out[u.name] = u.value
    for (const u of list) if (u.branch === branchName && u.service === `compute/${group}`) out[u.name] = u.value
    return out
  }

  /** Reserved = platform-minted credential names — user secrets must not clobber them. Managed
   *  types reserve their canonical keys and every suffixed form (`REDIS_URL_<NAME>` etc.),
   *  matching the stance already taken for DATABASE_URL_/BUCKET_NAME_. */
  isReservedSecret(name: string): boolean {
    if (name === 'DATABASE_URL' || name === 'BUCKET_NAME' || name.startsWith('AWS_') ||
      name.startsWith('DATABASE_URL_') || name.startsWith('BUCKET_NAME_')) return true
    for (const k of CANONICAL_MANAGED_KEYS) if (name === k || name.startsWith(`${k}_`)) return true
    return false
  }

  setUserSecret(projectId: string, name: string, value: string, branch: string | null, service: string | null = null): void {
    if (!this.getProject(projectId)) throw new Error('project not found')
    if (this.isReservedSecret(name)) throw new Error(`"${name}" is a reserved platform credential name`)
    if (branch && !this.getBranchByName(projectId, branch)) throw new Error(`branch "${branch}" not found`)
    if (service) {
      if (!branch) throw new Error('binding a secret to a service requires a branch')
      // The services THIS branch has. A user secret is stored per branch, so binding one to a
      // service that lives on another branch writes a row nothing reads: no env carries it and,
      // now that the inventory is branch-scoped, nothing lists it either. Compute stays
      // project-wide, as everywhere else.
      const project = this.getProject(projectId)!
      const b = this.getBranchByName(projectId, branch)!
      const valid = [
        ...this.dbList(projectId).filter((d) => this.carries(project, b, d, 'postgres')).map((d) => `postgres/${d.name}`),
        ...this.stList(projectId).filter((x) => this.carries(project, b, x, 'storage')).map((x) => `storage/${x.name}`),
        ...this.computeGroupNames(projectId).map((g) => `compute/${g}`),
        ...this.managedList(projectId).filter((m) => this.carries(project, b, m, 'managed')).map((m) => `${m.type}/${m.name}`)]
      if (!valid.includes(service)) throw new Error(`service not found: ${service}`)
    }
    mutate((st) => {
      const list = (st.userSecrets[projectId] ??= [])
      const existing = list.find((u) => u.name === name && u.branch === branch)
      if (existing) { existing.value = value; existing.service = service }
      else list.push({ name, value, branch, service } satisfies UserSecret)
    })
    this.emit(projectId, branch, 'govern', 'secrets.write', { name, scope: branch ?? 'project', service })
  }

  /** Remove a user secret. `service` narrows the removal to a secret bound to THAT service, which
   *  is what the template executor's authoritative env replace needs: a stale name it wrote onto
   *  one compute group must go without touching a same-named secret on another. */
  unsetUserSecret(projectId: string, name: string, branch: string | null, service?: string | null): void {
    mutate((st) => {
      st.userSecrets[projectId] = (st.userSecrets[projectId] ?? []).filter((u) => !(
        u.name === name && u.branch === branch && (service === undefined || (u.service ?? null) === service)
      ))
    })
    this.emit(projectId, branch, 'govern', 'secrets.unset', { name, scope: branch ?? 'project' })
  }

  // ---- services view (services model parity) ----

  /** host:port of the S3 server one storage service was minted against (its own credential, so a
   *  bucket provisioned by an older adapter still reports the server it actually answers on). */
  private s3Host(project: Project, b: Branch, serviceId = 'st-store'): string | undefined {
    try { return new URL(this.bucketHandle(project, b, serviceId)?.env.AWS_ENDPOINT_URL_S3 ?? '').host } catch { return undefined }
  }

  /** Every compute group name: registered on the project plus any group already deployed. */
  private computeGroupNames(projectId: string): string[] {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const groups = new Set<string>(project.computeGroups ?? [])
    for (const b of this.listBranches(projectId)) for (const g of Object.keys(b.apps)) groups.add(g)
    return [...groups].sort()
  }

  /** The project's registered managed databases (empty when none). `dataId` is WP4's immutable
   *  directory key (decision 16); rows from before the data dir carry none until the boot migration
   *  backfills one. */
  private managedList(projectId: string): Array<{ id: string; type: ManagedDbType; name: string; createdAt: number; renamedAt?: number; dataId?: string }> {
    return this.getProject(projectId)?.managedServices ?? []
  }

  /** Resolve a service id (`pg-<name>` | `st-<name>` | `cp-<group>` | `rd/my/mo-<name>`, with or
   *  without a `<branchId>:` qualifier) to its type + name, checked against the project's
   *  registrations. An id no registration claims is a 404. */
  private serviceOf(projectId: string, serviceId: string): { type: 'postgres' | 'storage' | 'compute' | ManagedDbType; name: string } {
    const parsed = parseServiceId(serviceId)
    if (!parsed) throw new Error('service not found')
    const { type, name } = parsed
    const known = type === 'postgres' ? this.dbList(projectId).some((d) => d.id === parsed.serviceId)
      : type === 'storage' ? this.stList(projectId).some((s) => s.id === parsed.serviceId)
        : type === 'compute' ? this.computeGroupNames(projectId).includes(name)
          : this.managedList(projectId).some((m) => m.id === parsed.serviceId)
    if (!known) throw new Error('service not found')
    return { type, name }
  }

  /** The project's services as the CLI expects them: one row per registration (postgres, storage,
   *  managed database) plus one per compute group (registered or already deployed on the branch).
   *  Additive dashboard fields (never touching `status`, which the CLI prints): `runtime` from live
   *  docker ps, `domain`/`endpoint`, `always_on`, `template_*`, `updated_at`. Branch-aware via
   *  `branchName` (defaults to the default branch); OFF the default branch every row id carries the
   *  `<branchId>:` qualifier, because the CLI calls the follow-up route with no branch (decision 49). */
  async services(projectId: string, branchName?: string): Promise<ServiceRow[]> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const branches = this.listBranches(projectId)
    const branch = branchName ? branches.find((b) => b.name === branchName) : branches.find((b) => b.isDefault)
    if (branchName && !branch) throw new Error(`branch "${branchName}" not found`)
    const groups = new Set<string>(this.computeGroupNames(projectId))
    // ONE docker read per listing, through the scheduler's Runtime seam: `rowRuntime` and the
    // object-store row then read that snapshot (decision 53 — there is no second `docker ps`).
    await this.scheduler.refreshStates()
    const iso = (ms?: number): string | undefined => (ms ? new Date(ms).toISOString() : undefined)
    const rt = (serviceId: string): string | undefined => (branch ? this.rowRuntime(this.serviceKey(branch, serviceId)) : undefined)
    const id = (serviceId: string): string => (branch ? this.qualifiedId(branch, serviceId) : serviceId)
    const settings = (serviceId: string): ServiceSettings => project.serviceSettings?.[serviceId] ?? {}
    // Only what THIS branch carries. Postgres, storage and managed databases are branch-scoped
    // (see `addDbService`), so listing every registration would advertise a domain, an endpoint and
    // a set of credentials for a service that does not exist on the branch being listed — which is
    // also what the cloud refuses to do: its list resolves one branch and filters on `branch_id`
    // (platform `src/provisioning/repos.ts:475`). With no branch resolved (no branches at all) the
    // registrations are all there is to report.
    const on = <T extends { id: string }>(regs: T[], type: 'postgres' | 'storage' | 'managed'): T[] =>
      (branch ? regs.filter((r) => this.carries(project, branch, r, type)) : regs)
    return [
      ...on(this.dbList(projectId), 'postgres').map((d) => ({
        id: id(d.id), type: 'postgres', name: d.name, status: 'ready', pg_version: PG_VERSION,
        ...this.rowNetwork(project, branch, { id: d.id, type: 'postgres', name: d.name }),
        runtime: rt(d.id),
        ...(d.templateDeploymentId ? { template_deployment_id: d.templateDeploymentId } : {}),
        created_at: iso(d.createdAt),
        updated_at: iso(d.createdAt),
      })),
      // Storage endpoint/container derive from the branch's OWN minted creds, so branches
      // provisioned by an older storage adapter still report their real server.
      ...on(this.stList(projectId), 'storage').map((s) => ({
        id: id(s.id), type: 'storage', name: s.name, status: 'ready',
        public: (branch ? this.bucketHandle(project, branch, s.id)?.public : s.public) ?? s.public ?? false,
        ...this.rowNetwork(project, branch, { id: s.id, type: 'storage', name: s.name }),
        // The object store is ONE shared container for the whole box, so every bucket reports its
        // state. Not the S3 host: that is `io-garage` only in local mode, and in server mode it is
        // `s3.<domain>`, which matches no container, so every bucket on a real install read
        // 'stopped' while Garage was up and serving it.
        runtime: branch ? this.runtimeOf(GARAGE_CONTAINER) : undefined,
        created_at: iso(s.createdAt),
        updated_at: iso(s.createdAt),
      })),
      // Managed databases (redis/mysql/mongodb): one private container per branch. `port` +
      // `volume_gib` are what the CLI renders (`tcp/6379  vol 1Gi`); the volume size is the
      // cloud's fixed 1Gi, advisory locally like every other recorded size.
      ...on(this.managedList(projectId), 'managed').map((m) => ({
        id: id(m.id), type: m.type, name: m.name, status: 'ready',
        port: MANAGED_DB[m.type].port, volume_gib: MANAGED_DB[m.type].volumeGib,
        always_on: branch ? this.effectiveAlwaysOn(project, branch, m.id) : undefined,
        ...this.rowNetwork(project, branch, { id: m.id, type: m.type, name: m.name }),
        runtime: rt(m.id),
        created_at: iso(m.createdAt),
        updated_at: iso(m.createdAt),
      })),
      ...[...groups].sort().map((g) => {
        const app = branch?.apps[g]
        const cfgd = settings(`cp-${g}`)
        return {
          id: id(`cp-${g}`), type: 'compute', name: g, status: 'ready', machine_count: 1,
          // Always present, null when the group has never deployed: `GET .../source` reports
          // what a local service runs, and an absent key would read as "no answer".
          image: app?.image ?? null,
          volume_gib: project.computeVolumes?.[g]?.sizeGib ?? null, // platform Service.volume_gib (compute only)
          desired_state: app?.desiredState ?? 'running',
          always_on: branch ? this.effectiveAlwaysOn(project, branch, `cp-${g}`) : undefined,
          ...(app?.port ?? cfgd.port ? { port: app?.port ?? cfgd.port } : {}),
          ...(cfgd.templateDeploymentId ? { template_deployment_id: cfgd.templateDeploymentId } : {}),
          ...(cfgd.templateCode ? { template_code: cfgd.templateCode } : {}),
          ...this.rowNetwork(project, branch, { id: `cp-${g}`, type: 'compute', name: g }),
          runtime: branch ? rt(`cp-${g}`) : app ? undefined : 'none',
          // The registration's own time (addComputeService stamps it); a group that predates the
          // stamp falls back to its last deploy.
          created_at: iso(cfgd.createdAt ?? app?.updatedAt),
          updated_at: iso(app?.updatedAt),
        }
      }),
    ]
  }

  /** The `runtime` column of a row that has no ServiceKey (the object store): the last snapshot the
   *  scheduler took, read by container name. A name docker has never listed is not running. */
  private runtimeOf(container: string): string | undefined {
    if (!container) return undefined
    return this.scheduler.containerState(container) === 'running' ? 'online' : 'stopped'
  }

  /** Names-only secret inventory as project→branch→service→secrets (SecretTree contract shape).
   *  Minted credential names sit under their service (DATABASE_URL → postgres, AWS_* / BUCKET_NAME
   *  → storage), matching the cloud, where minted secrets are service-bound rows. */
  secretTree(projectId: string): {
    projectWide: string[]
    branches: Array<{
      name: string; isDefault: boolean
      services: Array<{
        type: string; name: string; secrets: string[]; minted: string[]
        bindings: Array<{ envName: string; source: string; sourceName: string; shadowsUserSecret: boolean }>
      }>
      unbound: string[]
    }>
  } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const list = loadState().userSecrets[projectId] ?? []
    const groups = this.computeGroupNames(projectId)
    const bound = (branch: string, service: string): string[] =>
      list.filter((u) => u.branch === branch && u.service === service).map((u) => u.name)
    // A binding is a name this group's env carries too, so the inventory lists it under the TARGET
    // group (where it appears) rather than under the service it reads from.
    //
    // It is reported SEPARATELY from the user secrets, not merged into an undifferentiated list. A
    // binding is platform-owned: `unsetUserSecret` does not remove it (so a Delete reported success
    // while the name stayed), and `bindingsFor` is applied LAST in `envFor` (so an Edit wrote a row
    // the container never sees). Anything offering Edit/Delete has to be able to tell them apart,
    // and the source is worth carrying too: "this service" is not where the value comes from.
    const boundIn = (b: Branch, group: string, userBound: string[]): Array<{ envName: string; source: string; sourceName: string; shadowsUserSecret: boolean }> =>
      (b.bindings ?? []).filter((x) => x.target === `compute/${group}`)
        .map((x) => ({
          envName: x.envName, source: x.source, sourceName: x.sourceName,
          // A user secret of the same name can exist on this group — `insta secrets set NAME
          // --service compute/<g>` is not refused, and a later template deploy can bind over one.
          // The binding WINS (envFor applies it last), so the row is a binding; this says a dead
          // user row is sitting underneath it, which is the only way a surface can offer to
          // remove that row rather than pretending it is not there.
          shadowsUserSecret: userBound.includes(x.envName),
        }))
    return {
      projectWide: list.filter((u) => u.branch === null).map((u) => u.name).sort(),
      // Per branch, only the services that branch CARRIES: the tree is an inventory of the names
      // a branch's env actually holds, and `secrets` never mints a credential for a service with
      // no row here, so listing one promised a name that is nowhere in the bundle.
      branches: this.listBranches(projectId).map((b) => {
        // Loop-INVARIANT within a branch, and each call clones the whole state via getProject, so
        // it is computed once here rather than per managed service inside the map below. That is
        // the same cost the note about mintedNamesOf warns of, and calling it per service put this
        // route's clone count back up (27 -> 51 on 8 branches x 3 redis services).
        const aliased = this.aliasedManagedIds(projectId, b)
        return {
        name: b.name,
        isDefault: b.isDefault,
        services: [
          // `minted` is the platform-issued subset of `secrets`. They differ in who receives them:
          // a minted credential is handed to EVERY compute group in the branch, while a user
          // secret bound to this service reaches only this service. Callers that answer "what can
          // service X read" cannot tell them apart from the merged list, and the dashboard read it
          // as "every name under every service", which showed one app another app's bound secrets.
          // `mintedNamesOf` clones state, so it is called ONCE per service and reused for both
          // fields: calling it again for `minted` doubled the clones and broke the linear-clone
          // guarantee this route is held to.
          ...this.dbList(projectId).filter((d) => this.carries(project, b, d, 'postgres')).map((d) => {
            const minted = this.mintedNamesOf(project, b, d.id)
            return {
              type: 'postgres', name: d.name,
              secrets: [...minted, ...bound(b.name, `postgres/${d.name}`)].sort(),
              minted: [...minted].sort(),
              // Only a compute group is a binding TARGET.
              bindings: [],
            }
          }),
          ...this.stList(projectId).filter((s) => this.carries(project, b, s, 'storage')).map((s) => {
            const minted = this.mintedNamesOf(project, b, s.id)
            return {
              type: 'storage', name: s.name,
              secrets: [...minted, ...bound(b.name, `storage/${s.name}`)].sort(),
              minted: [...minted].sort(),
              // Only a compute group is a binding TARGET.
              bindings: [],
            }
          }),
          ...this.managedList(projectId).filter((m) => this.carries(project, b, m, 'managed')).map((m) => {
            // The branch's oldest service of each type also carries the canonical unsuffixed names.
            const minted = this.mintedManagedNames(m, aliased.has(m.id))
            return {
              type: m.type, name: m.name,
              secrets: [...minted, ...bound(b.name, `${m.type}/${m.name}`)].sort(),
              minted: [...minted].sort(),
              // Only a compute group is a binding TARGET.
              bindings: [],
            }
          }),
          // A compute group mints nothing: everything under it is bound to it, and reaches only it.
          ...groups.map((g) => {
            const userBound = bound(b.name, `compute/${g}`)
            const bindings = boundIn(b, g, userBound)
            return {
              type: 'compute', name: g,
              // `secrets` is the inventory of NAMES this group's env carries, and a container
              // receives one value per name — so it is a SET. Concatenating listed a name that is
              // both a user secret and a binding twice, and the page drew two rows for one
              // variable. `bindings` says which of them are platform-owned and where each reads
              // from.
              secrets: [...new Set([...userBound, ...bindings.map((x) => x.envName)])].sort(),
              minted: [],
              bindings: [...bindings].sort((x, y) => x.envName.localeCompare(y.envName)),
            }
          }),
        ],
        unbound: list.filter((u) => u.branch === b.name && !u.service).map((u) => u.name).sort(),
        }
      }),
    }
  }

  /** Which managed services additionally surface the canonical UNSUFFIXED aliases on this branch:
   *  the oldest carried service of each type (platform spec §2.1).
   *
   *  One definition, used by both the minting path and the inventory. They were separate, and the
   *  inventory only knew about the suffixed forms — so an app's env carried `REDIS_URL` while the
   *  Variables tab and the Secrets page listed only `REDIS_URL_<NAME>`, leaving the one name most
   *  apps actually read invisible, and `REDIS_URL` typeable in Add Secret for a bare 400. */
  private aliasedManagedIds(projectId: string, branch: Branch): Set<string> {
    const seen = new Set<ManagedDbType>()
    const ids = new Set<string>()
    for (const m of this.getProject(projectId)?.managedServices ?? []) {
      if (!branch.managed?.[m.id] || seen.has(m.type)) continue
      seen.add(m.type)
      ids.add(m.id)
    }
    return ids
  }

  /** A managed service's minted secret names: the suffixed bundle, plus the canonical unsuffixed
   *  one when this is the branch's aliased service for its type. */
  private mintedManagedNames(m: { id: string; type: ManagedDbType; name: string }, aliased: boolean): string[] {
    const bundle = MANAGED_DB[m.type].bundle('h', 'p')
    return [...Object.keys(suffixBundle(bundle, m.name)), ...(aliased ? Object.keys(bundle) : [])]
  }

  /** A service's secret names (names only): minted credentials + user secrets bound to it. Named
   *  on ONE branch, like every other `/services/:sid/*` read: the names of a service this branch
   *  does not carry are the names of nothing. */
  serviceSecretNames(projectId: string, serviceId: string, branchName?: string): string[] {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const { branch, serviceId: sid } = this.resolveSid(projectId, serviceId, branchName)
    const svc = this.serviceOf(projectId, sid)
    this.assertServiceOnBranch(project, branch, sid, svc.type)
    const list = loadState().userSecrets[projectId] ?? []
    // Bound secrets are per branch, so a branch-scoped inventory must not borrow another branch's.
    // The minted half beside it is already resolved for THIS branch, so listing every branch's
    // bound names made the two halves describe different things.
    const bound = list
      .filter((u) => u.service === `${svc.type}/${svc.name}` && u.branch === branch.name)
      .map((u) => u.name)
    return [...new Set([...this.mintedNamesOf(project, branch, sid), ...bound])].sort()
  }

  /** Structural merge (additive, no data — platform spec §6): materialize on the target branch
   *  every service the SOURCE carries and the target does not, fresh and empty, plus every compute
   *  group deployed on `from` and absent there, against the TARGET's own db/bucket.
   *
   *  Services are branch-scoped, so postgres, storage and managed databases have real work here:
   *  a database added on `from` after the branch was cut is created on the target, with its own
   *  lineage and no data (platform `src/provisioning/services.ts:2685`). Only what the target
   *  already carries reports as `skipped`. */
  async mergeBranch(projectId: string, targetName: string, fromName: string): Promise<{
    created: Array<{ type: string; name: string }>
    skipped: Array<{ type: string; name: string; reason: string }>
  }> {
    if (!this.getProject(projectId)) throw new Error('project not found')
    const target = this.getBranchByName(projectId, targetName)
    if (!target) throw new Error(`target branch not found: ${targetName}`)
    const source = this.getBranchByName(projectId, fromName)
    if (!source) throw new Error(`source branch not found: ${fromName}`)
    if (source.id === target.id) throw new Error('source and target are the same branch')
    // A merge PROVISIONS onto the target (fresh databases, buckets, managed instances and a
    // redeploy per group), and reads the source's registrations to decide what. Neither may be
    // a half-demolished branch.
    this.assertUsable(target, 'merged into')
    this.assertUsable(source, 'merged from')

    const project = this.getProject(projectId)!
    const created: Array<{ type: string; name: string }> = []
    const skipped: Array<{ type: string; name: string; reason: string }> = []
    // Services are branch-scoped, so a merge has real work to do for every type: create on the
    // target what the SOURCE carries and the target does not, fresh and empty, data never carried
    // (the cloud's structural merge, platform `src/provisioning/services.ts:2685`). Anything the
    // target already has is skipped rather than rebuilt.
    const structural: Array<[type: 'postgres' | 'storage' | 'managed', regs: Array<{ id: string; name: string; type?: string }>]> = [
      ['postgres', this.dbList(projectId)],
      ['storage', this.stList(projectId)],
      ['managed', this.managedList(projectId)],
    ]
    for (const [kind, regs] of structural) {
      for (const reg of regs) {
        const label = kind === 'managed' ? String(reg.type) : kind
        if (!this.carries(project, source, reg, kind)) continue
        if (this.carries(project, target, reg, kind)) { skipped.push({ type: label, name: reg.name, reason: 'exists' }); continue }
        if (kind === 'postgres') await this.addDbService(projectId, reg.name, { branch: target.name })
        else if (kind === 'storage') await this.addStorageService(projectId, reg.name, { branch: target.name })
        else await this.addManagedService(projectId, reg.type as ManagedDbType, reg.name, { branch: target.name })
        created.push({ type: label, name: reg.name })
      }
    }
    for (const [group, app] of Object.entries(source.apps).sort(([a], [b]) => a.localeCompare(b))) {
      if (target.apps[group]) { skipped.push({ type: 'compute', name: group, reason: 'exists' }); continue }
      await this.deployAllocatingPort(projectId, target.name, group, app)
      created.push({ type: 'compute', name: group })
    }
    this.emit(projectId, target.name, 'resource', 'branch.merge', { from: source.name, into: target.name, created: created.length })
    return { created, skipped }
  }

  /** Compute lifecycle (start|stop|suspend): persistent developer intent + best-effort adapter op.
   *  Branch-scoped — oss service ids don't encode a branch, so callers pass one (default branch
   *  otherwise). Returns the service row + live runtime state, the shape the CLI prints. */
  async lifecycle(projectId: string, serviceId: string, verb: 'start' | 'stop' | 'suspend', branchName?: string): Promise<{
    service: ServiceRow | undefined; state: string
  }> {
    const t = this.computeTarget(projectId, serviceId, branchName)
    return this.withOp([this.branchOp(t.branch), this.serviceKey(t.branch, `cp-${t.group}`)], () => this.lifecycleLocked(projectId, verb, t.branch.id, t.group))
  }

  // Branch ID, not a Branch — same reason as deployLocked: a snapshot taken before the chain is one
  // an op ahead has already moved. A stop queued behind a service's FIRST deploy saw a branch with
  // no app record at all and silently did nothing.
  private async lifecycleLocked(
    projectId: string, verb: 'start' | 'stop' | 'suspend', branchId: string, group: string,
  ): Promise<{ service: ServiceRow | undefined; state: string }> {
    const project = this.getProject(projectId)!
    const branch = loadState().branches[branchId]
    if (!branch) throw new Error('branch not found')
    const serviceId = `cp-${group}`
    const ref = this.ref(project, branch)
    const key = this.serviceKey(branch, serviceId)
    const desired = verb === 'start' ? 'running' : verb === 'stop' ? 'stopped' : 'suspended'
    let state = 'none'
    // The group NAME was resolved before the lock, and a compute rename that ran while this
    // queued moves it. `branch.apps[group]` is then undefined, the whole body below is skipped,
    // and the verb answers 200 with `state: none` having done nothing -- indistinguishable from
    // the legitimate registered-but-never-deployed no-op, which is the case that block exists
    // for. The REGISTRATION is what tells the two apart, so it is asked first. This was the last
    // site where the rule stated engine-wide (`freshRemoval`: no operation acts on an identity
    // it resolved before its lock) did not hold.
    if (!this.computeGroupNames(projectId).includes(group)) {
      throw new Error(`compute service "${group}" changed while this ${verb} was queued (renamed or removed); nothing was done, list the services and retry with the current name`)
    }
    if (branch.apps[group]) {
      const op = this.compute[verb]
      if (!op) throw new Error(`${verb} is not supported by this compute adapter`)
      // WP3 edit point: the intent is written FIRST for a start, so the wake that follows cannot be
      // refused by the very intent it is clearing (`insta compute start` also re-enables auto-wake).
      if (verb === 'start') mutate((s) => { s.branches[branch.id].apps[group].desiredState = desired })
      if (verb === 'start') {
        // The adapter's start is a HINT and the wake is the authority: it holds this key
        // (re-entrant), waits for readiness, clears the sleep mark and stamps activity, and it
        // throws when the service does not come up. So a start that the adapter refuses but the
        // wake completes is a success, and one neither can do is the wake's error. A container
        // that is not there any more is not an error for an intent write: the row keeps the
        // intent and reports `none`.
        await op.call(this.compute, ref, group).catch(() => { /* the wake below is the authority */ })
        await this.wake(key, { door: 'api' }).catch((e: unknown) => {
          if (!(e instanceof NoContainerError)) throw e
        })
      } else {
        // NOT best-effort, and this is the sharp end of the rule the rest of this file follows.
        // The adapter op IS the transition here, there is no second authority behind it, and a
        // swallowed failure did not merely lose an error: the row was then written to the
        // REQUESTED state and `onStopped`/`onPaused` wrote `exited`/`paused` into the snapshot
        // the sweep and the eviction pass reason from. That fabricates a runtime fact rather
        // than failing to learn one -- a container believed stopped while it is running and
        // holding RAM is the worst possible input to a box with a memory floor, and routing
        // then honours a stopped intent for a service that is still answering. The row and the
        // cache are written from the OUTCOME, so a failure propagates with nothing recorded.
        const graceSec = verb === 'stop' ? this.cfg.sleep.stopGraceSec : undefined
        try {
          await (verb === 'stop' ? this.compute.stop?.(ref, group, { graceSec }) : op.call(this.compute, ref, group))
        } catch (e) {
          throw new LifecycleFailedError(`could not ${verb} ${group} on branch ${branch.name}: ${e instanceof Error ? e.message : String(e)}. Nothing was changed: the service keeps its previous state and this ${verb} can be retried`)
        }
        mutate((s) => { s.branches[branch.id].apps[group].desiredState = desired })
        if (verb === 'stop') this.scheduler.onStopped(key)
        else this.scheduler.onPaused(key)
      }
      state = this.liveState(key)
    }
    this.emit(projectId, branch.name, 'resource', `service.${verb}`, { service: serviceId })
    const service = (await this.services(projectId, branch.name)).find((x) => x.id === this.qualifiedId(branch, serviceId))
    return { service, state }
  }

  /** Restart a compute service: re-run the image it ALREADY runs, so the container is recreated
   *  with a freshly assembled env. `docker restart` would replay the env the container was created
   *  with — env reaches a container at `docker run`, exactly as the platform bakes it into machine
   *  config — so a restart that picks up a changed secret has to be a redeploy on both sides.
   *  Refused unless the desired state is 'running', mirroring the platform's refusal. */
  async restart(projectId: string, serviceId: string, branchName?: string): Promise<{
    service: ServiceRow | undefined; state: string
  }> {
    const t = this.computeTarget(projectId, serviceId, branchName)
    return this.withOp([this.branchOp(t.branch), this.serviceKey(t.branch, `cp-${t.group}`)], () => this.restartLocked(projectId, t.branch.id, t.group))
  }

  private async restartLocked(projectId: string, branchId: string, group: string): Promise<{
    service: ServiceRow | undefined; state: string
  }> {
    const branch = loadState().branches[branchId]
    if (!branch) throw new Error('branch not found')
    // Read the recorded image INSIDE the chain. A deploy queued ahead of this one has already
    // replaced it, and re-running a pre-queue snapshot would roll that deploy back — a restart must
    // re-run what the service runs NOW, which is the whole contract.
    const app = branch.apps[group]
    if (!app) throw new Error('this service has no machines yet — deploy an image first, then retry')
    const desired = app.desiredState ?? 'running'
    if (desired !== 'running') throw new Error(`this service is ${desired} — start it with \`insta compute start\`, which also re-enables auto-wake`)
    // deployLocked, not deploy: this already holds the chain and it is not re-entrant.
    await this.deployLocked(projectId, branchId, group, { image: app.image, port: app.port, hostPort: app.hostPort })
    this.emit(projectId, branch.name, 'resource', 'service.restart', { service: `cp-${group}` })
    const service = (await this.services(projectId, branch.name)).find((x) => x.id === this.qualifiedId(branch, `cp-${group}`))
    return { service, state: this.liveState(this.serviceKey(branch, `cp-${group}`)) }
  }

  /** A compute service's desired (developer intent) vs. live runtime state. */
  async serviceState(projectId: string, serviceId: string, branchName?: string): Promise<{ desiredState: string; state: string }> {
    const { branch, group } = this.computeTarget(projectId, serviceId, branchName)
    const app = branch.apps[group]
    return {
      desiredState: app?.desiredState ?? 'running',
      state: app ? this.liveState(this.serviceKey(branch, `cp-${group}`)) : 'none',
    }
  }

  /** Set a storage service's bucket access mode (anonymous public-read vs private). */
  async setServiceAccess(projectId: string, serviceId: string, isPublic: boolean, branchName?: string): Promise<ServiceRow | undefined> {
    const { branch, serviceId: sid } = this.resolveSid(projectId, serviceId, branchName)
    const svc = this.serviceOf(projectId, sid)
    if (svc.type !== 'storage') throw new Error('access control is only supported for storage services')
    const project = this.getProject(projectId)!
    this.assertCarries(project, branch, { id: sid }, 'storage')
    if (!this.storage.setAccess) throw new Error('access control is not supported by this storage adapter')
    await this.storage.setAccess(this.bucketOf(project, branch, sid), branch.network, isPublic)
    mutate((s) => {
      const row = s.branches[branch.id].buckets?.[sid]
      if (row) row.public = isPublic
      // The registration carries the mode a NEW branch provisions with (services add --public).
      const pr = s.projects[projectId]
      pr.storageServices = (pr.storageServices ?? []).map((x) => (x.id === sid ? { ...x, public: isPublic } : x))
      if (sid === 'st-store') s.branches[branch.id].storagePublic = isPublic
    })
    this.emit(projectId, branch.name, 'resource', 'service.setAccess', { service: sid, public: isPublic })
    return (await this.services(projectId, branch.name)).find((x) => x.id === this.qualifiedId(branch, sid))
  }

  // ---- storage objects (platform parity: `insta storage list|get|delete`, console browser) ----

  /** Resolve an object-operation target: a storage service id + the branch's credential env. */
  private objectTarget(projectId: string, serviceId: string, branchName?: string): Branch & { s3: Record<string, string> } {
    const { branch, serviceId: sid } = this.resolveSid(projectId, serviceId, branchName)
    const svc = this.serviceOf(projectId, sid)
    if (svc.type !== 'storage') throw new Error('object operations are only supported for storage services')
    const project = this.getProject(projectId)!
    // A bucket that is not on THIS branch is a 404, not an object listing signed with `{}`.
    this.assertCarries(project, branch, { id: sid }, 'storage')
    return { ...branch, s3: this.bucketHandle(project, branch, sid)?.env ?? {} }
  }

  private objectOps(): Required<Pick<StorageAdapter, 'listBucketObjects' | 'presignObjectGet' | 'presignObjectPost' | 'removeObject' | 'removeObjects'>> {
    const s = this.storage
    if (!s.listBucketObjects || !s.presignObjectGet || !s.presignObjectPost || !s.removeObject || !s.removeObjects) {
      throw new Error('object operations are not supported by this storage adapter')
    }
    return { listBucketObjects: s.listBucketObjects.bind(s), presignObjectGet: s.presignObjectGet.bind(s), presignObjectPost: s.presignObjectPost.bind(s), removeObject: s.removeObject.bind(s), removeObjects: s.removeObjects.bind(s) }
  }

  async listServiceObjects(projectId: string, serviceId: string, opts: { branch?: string; prefix?: string; cursor?: string; limit?: number }): Promise<ObjectListing> {
    const b = this.objectTarget(projectId, serviceId, opts.branch)
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
    const out = await this.objectOps().listBucketObjects(b.s3, { prefix: opts.prefix, cursor: opts.cursor, limit })
    this.emit(projectId, b.name, 'resource', 'storage.objects.list', { service: serviceId, prefix: opts.prefix ?? null })
    return out
  }

  async presignServiceObjectDownload(projectId: string, serviceId: string, opts: { branch?: string; key: string; disposition?: 'attachment' | 'inline' }): Promise<{ url: string; expiresAt: string }> {
    const b = this.objectTarget(projectId, serviceId, opts.branch)
    const out = await this.objectOps().presignObjectGet(b.s3, opts.key, opts.disposition ?? 'attachment')
    this.emit(projectId, b.name, 'resource', 'storage.objects.download', { service: serviceId, key: opts.key })
    return out
  }

  async presignServiceObjectUpload(projectId: string, serviceId: string, opts: { branch?: string; key: string; contentType: string; size: number }): Promise<{ url: string; fields: Record<string, string>; expiresAt: string }> {
    // S3's ceiling for a single POST Object — the signed policy makes the provider enforce it.
    if (!Number.isInteger(opts.size) || opts.size < 0 || opts.size > 5 * 1024 * 1024 * 1024) throw new Error('size must be 0..5GiB (bytes)')
    const b = this.objectTarget(projectId, serviceId, opts.branch)
    const out = await this.objectOps().presignObjectPost(b.s3, opts.key, opts.contentType, opts.size)
    this.emit(projectId, b.name, 'resource', 'storage.objects.upload', { service: serviceId, key: opts.key, size: opts.size })
    return out
  }

  async deleteServiceObject(projectId: string, serviceId: string, opts: { branch?: string; key: string }): Promise<{ deleted: true }> {
    const b = this.objectTarget(projectId, serviceId, opts.branch)
    await this.objectOps().removeObject(b.s3, opts.key)
    this.emit(projectId, b.name, 'resource', 'storage.objects.delete', { service: serviceId, key: opts.key })
    return { deleted: true }
  }

  async deleteServiceObjects(projectId: string, serviceId: string, opts: { branch?: string; keys: string[] }): Promise<{ deleted: number; failed: Array<{ key: string; message: string }> }> {
    if (opts.keys.length > 1000) throw new Error("keys must hold at most 1000 object keys (S3's DeleteObjects cap)")
    const b = this.objectTarget(projectId, serviceId, opts.branch)
    const out = await this.objectOps().removeObjects(b.s3, opts.keys)
    // What the provider actually removed, not what the caller asked for. The two differ whenever a
    // key is missing or the delete is refused, and an audit row that always reports the request
    // size tells the reader a bulk delete of 1000 keys removed 1000 objects when it removed none.
    // `failed` rides along for the same reason: a partial success has to read as one.
    this.emit(projectId, b.name, 'resource', 'storage.objects.delete', { service: serviceId, count: out.deleted, requested: opts.keys.length, failed: out.failed.length })
    return out
  }

  // ---- managed data browser (platform parity: the console's redis key browser) ----

  /** Resolve a redis-browse target: the managed service on THIS branch, its container and password. */
  private redisTarget(projectId: string, serviceId: string, branchName?: string): { branch: Branch; sid: string; container: string; password: string } {
    const { branch, serviceId: sid } = this.resolveSid(projectId, serviceId, branchName)
    const svc = this.serviceOf(projectId, sid)
    if (svc.type !== 'redis') throw new Error('key browsing is only supported for redis services')
    const project = this.getProject(projectId)!
    this.assertCarries(project, branch, { id: sid }, 'managed')
    const password = branch.managed?.[sid]?.password
    if (!password) throw new Error(`redis service not found: ${svc.name}`)
    return { branch, sid, container: managedContainerName(this.ref(project, branch), 'redis', svc.name), password }
  }

  private redisCmd(t: { container: string; password: string }, args: string[]): Promise<string> {
    if (!this.managedDb.command) throw new Error('key browsing is not supported by this managed database adapter')
    return this.managedDb.command(t.container, t.password, args)
  }

  /** valkey-cli's `--json` output, parsed; the raw text when a command answers outside JSON. */
  private async redisJson(t: { container: string; password: string }, args: string[]): Promise<unknown> {
    const out = (await this.redisCmd(t, ['--json', ...args])).trim()
    try { return JSON.parse(out) } catch { return out }
  }

  /** One SCAN page of a logical db plus the keyspace summary (the console's db chips). Never wakes:
   *  a sleeping instance answers "sleeping" through the same 503 gate as the postgres insight
   *  reads, and the dashboard's Wake and browse is what wakes it. */
  async redisKeys(projectId: string, serviceId: string, opts: { branch?: string; db?: number; cursor?: string; count?: number }): Promise<{ dbs: Array<{ db: number; keys: number }>; keys: string[]; cursor?: string }> {
    const t = this.redisTarget(projectId, serviceId, opts.branch)
    await this.assertPgAwake(t.branch, t.sid) // pg-named, but it only reads the scheduler state of a key
    const db = String(opts.db ?? 0)
    const count = Math.min(Math.max(opts.count ?? 200, 1), 1000)
    const scan = await this.redisJson(t, ['-n', db, 'SCAN', opts.cursor ?? '0', 'COUNT', String(count)])
    if (!Array.isArray(scan) || scan.length < 2 || !Array.isArray(scan[1])) {
      throw new Error('could not read the key listing: the server answered an unexpected shape')
    }
    const dbs = parseKeyspaceInfo(await this.redisCmd(t, ['INFO', 'keyspace']))
    const cursor = String(scan[0])
    // Governed reads land on the audit timeline (README: `insta events`) — the op and db only,
    // never key names or values.
    this.emitLater(projectId, t.branch.name, 'resource', 'db.read', { service: t.sid, op: 'keys', db: Number(db) })
    return { dbs, keys: (scan[1] as unknown[]).map(String), ...(cursor === '0' ? {} : { cursor }) }
  }

  /** The Stats view's snapshot: the server's own INFO counters, picked into the console's shape.
   *  Same gate as the key reads: never wakes, 503 while asleep. */
  async redisStats(projectId: string, serviceId: string, opts: { branch?: string } = {}): Promise<{
    version: string; uptimeSec: number; connectedClients: number
    usedMemoryBytes: number; maxMemoryBytes: number
    totalCommands: number; opsPerSec: number; keyspaceHits: number; keyspaceMisses: number
    expiredKeys: number; evictedKeys: number
  }> {
    const t = this.redisTarget(projectId, serviceId, opts.branch)
    await this.assertPgAwake(t.branch, t.sid)
    const info = parseRedisInfo(await this.redisCmd(t, ['INFO']))
    const num = (k: string): number => { const n = Number(info[k]); return Number.isFinite(n) ? n : 0 }
    this.emitLater(projectId, t.branch.name, 'resource', 'db.read', { service: t.sid, op: 'stats' })
    return {
      version: info.valkey_version ?? info.redis_version ?? 'unknown',
      uptimeSec: num('uptime_in_seconds'), connectedClients: num('connected_clients'),
      usedMemoryBytes: num('used_memory'), maxMemoryBytes: num('maxmemory'),
      totalCommands: num('total_commands_processed'), opsPerSec: num('instantaneous_ops_per_sec'),
      keyspaceHits: num('keyspace_hits'), keyspaceMisses: num('keyspace_misses'),
      expiredKeys: num('expired_keys'), evictedKeys: num('evicted_keys'),
    }
  }

  /** One key's type, TTL and value. Collection reads are bounded (first 200 entries), because a
   *  key browser must never buffer an unbounded structure into the daemon's heap. */
  async redisValue(projectId: string, serviceId: string, opts: { branch?: string; db?: number; key: string }): Promise<{ type: string; ttl: number; value: unknown }> {
    const t = this.redisTarget(projectId, serviceId, opts.branch)
    await this.assertPgAwake(t.branch, t.sid)
    const db = String(opts.db ?? 0)
    const read = (args: string[]) => this.redisJson(t, ['-n', db, ...args])
    const type = String(await read(['TYPE', opts.key]))
    if (type === 'none') throw new Error('key not found')
    const ttl = Number(await read(['TTL', opts.key]))
    // Every collection read is incremental AND hard-sliced: SCAN's COUNT is a hint the server may
    // exceed, and HGETALL would return the whole hash, so neither is trusted with the bound.
    const value = type === 'string' ? await read(['GET', opts.key])
      : type === 'hash' ? scanPageToHash(await read(['HSCAN', opts.key, '0', 'COUNT', '200']))
        : type === 'list' ? await read(['LRANGE', opts.key, '0', '199'])
          : type === 'set' ? scanPageMembers(await read(['SSCAN', opts.key, '0', 'COUNT', '200']))
            : type === 'zset' ? await read(['ZRANGE', opts.key, '0', '199', 'WITHSCORES'])
              : type === 'stream' ? await read(['XRANGE', opts.key, '-', '+', 'COUNT', '200'])
                : null
    this.emitLater(projectId, t.branch.name, 'resource', 'db.read', { service: t.sid, op: 'value', db: Number(db) })
    return { type, ttl, value }
  }

  /** Resolve a lifecycle target: a compute service id + branch (default branch unless given). */
  private computeTarget(projectId: string, serviceId: string, branchName?: string): { branch: Branch; group: string } {
    // The branch comes from a qualified sid FIRST, then ?branch, then the default (decision 49):
    // the CLI reads an id off the branch-scoped list and calls this route with no branch at all.
    const { branch, serviceId: sid } = this.resolveSid(projectId, serviceId, branchName)
    const svc = this.serviceOf(projectId, sid)
    if (svc.type !== 'compute') throw new Error('lifecycle control is only supported for compute services')
    return { branch, group: svc.name }
  }

  /** WP3 edit point (decision 53): the ONE runtime-state read the routes use, mapped from
   *  `scheduler.stateOf` by contract section 13. Asleep and starting both report `suspended`,
   *  which is what the CLI prints beside a `running` desired state. */
  private liveState(key: ServiceKey): 'running' | 'stopped' | 'suspended' | 'none' {
    switch (this.scheduler.stateOf(key)) {
      case 'running': return 'running'
      case 'paused': case 'asleep': case 'starting': return 'suspended'
      case 'stopped': return 'stopped'
      default: return 'none'
    }
  }

  /** Bulk runtime health for a branch's compute + postgres + managed databases (storage omitted
   *  — object storage has no runtime), the cloud's shape, from ONE `docker ps -a` read. Local
   *  mapping: running→healthy · paused, or exited on developer intent→standby · exited against a
   *  'running' intent→crashed · restarting/created→starting · no container→none · docker
   *  unreadable→unknown. */
  async runtimeHealth(projectId: string, branchName?: string): Promise<{ services: Array<{ serviceId: string; status: string; machines: number; failing: number }> }> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    const ref = this.ref(project, branch)
    let states: Map<string, string> | null = null
    try {
      const out = (await docker(['ps', '-a', '--format', '{{.Names}}\t{{.State}}'])).toString()
      states = new Map(out.trim().split('\n').filter(Boolean).map((l) => {
        const [name, state] = l.split('\t')
        return [name, state ?? 'unknown'] as const
      }))
    } catch { /* docker unreadable — every service reports unknown rather than a guess */ }
    // Per row: the WP3 healthOverlay hook maps one container's docker state (+ sleep bookkeeping).
    const health = (container: string, desired: 'running' | 'stopped' | 'suspended', sleptAt: number | null | undefined, serviceId: string): { status: string; machines: number; failing: number } => {
      if (!states) return { status: 'unknown', machines: 0, failing: 0 }
      return this.healthOverlay(states.get(container), desired, sleptAt, this.serviceKey(branch, serviceId))
    }
    // Only what THIS branch carries, like the services list: a registration another branch
    // materialised has no container here, so reporting a row for it read as `crashed` (a desired
    // state of running against a container docker has never heard of) for a service that is
    // simply not on this branch.
    return {
      services: [
        ...this.dbList(projectId).filter((d) => this.carries(project, branch, d, 'postgres')).map((d) => ({
          serviceId: d.id,
          ...health(this.pgContainer(project, branch, d.id), 'running', branch.databases?.[d.id]?.sleptAt, d.id),
        })),
        ...this.managedList(projectId).filter((m) => this.carries(project, branch, m, 'managed')).map((m) => ({ serviceId: m.id, ...health(managedContainerName(ref, m.type, m.name), 'running', branch.managed?.[m.id]?.sleptAt, m.id) })),
        ...this.computeGroupNames(projectId).map((g) => {
          const app = branch.apps[g]
          if (!app) return { serviceId: `cp-${g}`, status: 'none', machines: 0, failing: 0 }
          return { serviceId: `cp-${g}`, ...health(appContainerName(ref, g), app.desiredState ?? 'running', app.sleptAt, `cp-${g}`) }
        }),
      ],
    }
  }

  /** Register a compute group as a service (materializes on first deploy --group <name>).
   *  volumeGib optionally attaches a persistent /data volume; it can also attach any time later
   *  via setServiceVolume (platform #185 parity) and be deleted via removeServiceVolume (data
   *  destroyed) — but never detached. */
  addComputeService(
    projectId: string, name: string, volumeGib?: number,
    opts: { alwaysOn?: boolean; port?: number; templateDeploymentId?: string; templateCode?: string; branch?: string } = {},
  ): ServiceRow {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    // A named branch that does not exist is a 404 before anything is registered, as it is for every
    // other service type: a create from a stale branch page must not register a project-wide group.
    if (opts.branch !== undefined && !this.listBranches(projectId).some((b) => b.name === opts.branch)) {
      throw new Error(`branch "${opts.branch}" not found`)
    }
    this.assertServiceName(name)
    const groups = new Set(project.computeGroups ?? [])
    for (const b of this.listBranches(projectId)) for (const g of Object.keys(b.apps)) groups.add(g)
    if (groups.has(name)) throw new Error(`compute service "${name}" already exists`)
    this.assertTypeCap(groups.size, 'compute')
    if (volumeGib !== undefined) {
      if (!Number.isInteger(volumeGib) || volumeGib < 1) throw new Error('volumeGib must be a positive integer (whole Gi)')
      if (volumeGib > VOLUME_CAP_GIB) throw new Error(`volume exceeds the cap (${VOLUME_CAP_GIB}Gi)`)
      if (!this.compute.supportsVolumes) throw new Error('/data volumes are not supported by this compute adapter — use the docker adapter')
    }
    // The registration and every hostname it will mint are reserved in ONE synchronous mutate
    // (decision 51); the container itself arrives on the first deploy --group <name>.
    mutate((st) => {
      for (const b of this.listBranches(projectId)) this.assertHostFree(this.labelFor('compute', name, this.ref(project, b)))
      const pr = st.projects[projectId]
      pr.computeGroups = [...(pr.computeGroups ?? []), name]
      if (volumeGib !== undefined) (pr.computeVolumes ??= {})[name] = { id: randomUUID().slice(0, 8), sizeGib: volumeGib }
      const settings: ServiceSettings = { createdAt: Date.now() }
      if (opts.alwaysOn !== undefined) settings.alwaysOn = opts.alwaysOn
      if (opts.port !== undefined) settings.port = opts.port
      if (opts.templateDeploymentId !== undefined) settings.templateDeploymentId = opts.templateDeploymentId
      if (opts.templateCode !== undefined) settings.templateCode = opts.templateCode
      ;(pr.serviceSettings ??= {})[`cp-${name}`] = settings
    })
    this.emit(projectId, null, 'resource', 'service.added', { type: 'compute', name, ...(volumeGib !== undefined ? { volumeGib } : {}) })
    // The group is project-level, but whether it sleeps is per branch (`effectiveAlwaysOn`), so the
    // reply reports the branch the request named, else the default branch, through the same rule
    // the services list and the scheduler use. The daemon-wide default alone told a preview
    // branch "always on" for a service that branch then put to sleep.
    const branches = this.listBranches(projectId)
    const target = (opts.branch !== undefined ? branches.find((b) => b.name === opts.branch) : undefined) ?? branches.find((b) => b.isDefault)
    return {
      id: `cp-${name}`, type: 'compute', name, status: 'ready', volume_gib: volumeGib ?? null,
      always_on: target ? this.effectiveAlwaysOn(this.getProject(projectId)!, target, `cp-${name}`) : (opts.alwaysOn ?? false),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.templateDeploymentId !== undefined ? { template_deployment_id: opts.templateDeploymentId } : {}),
      ...(opts.templateCode !== undefined ? { template_code: opts.templateCode } : {}),
    }
  }

  /** Rename a compute group everywhere it appears: registration, every branch's deployment
   *  (runtime artifact included, via the adapter), the minted hostname each branch answers on, and
   *  service-bound user secrets. InstaCloud OSS mints no per-service secret names for compute, so there
   *  is nothing to re-key there.
   *
   *  The hostname is RE-MINTED, exactly as the postgres and managed renames do it. Moving the row
   *  from `apps[old]` to `apps[new]` while leaving its recorded `host` alone left the group
   *  answering on its OLD hostname (the route table reads `app.host` and only falls back to
   *  deriving one) while `<new-group>-<ref>` resolved nowhere, and the services list kept
   *  advertising the stale domain and endpoint. */
  async renameComputeService(projectId: string, oldName: string, newName: string): Promise<ServiceRow | undefined> {
    return this.withRenameKeys(projectId, `cp-${oldName}`, () => this.renameComputeServiceLocked(projectId, oldName, newName))
  }

  private async renameComputeServiceLocked(projectId: string, oldName: string, newName: string): Promise<ServiceRow | undefined> {
    return this.serialize('provision', async () => {
      const project = this.getProject(projectId)
      if (!project) throw new Error('project not found')
      assertServiceName(newName)
      const groups = this.computeGroupNames(projectId)
      if (!groups.includes(oldName)) throw new Error('service not found')
      const current = async (): Promise<ServiceRow | undefined> =>
        (await this.services(projectId)).find((s) => s.id === `cp-${newName}`)
      if (newName === oldName) return current()
      if (groups.includes(newName)) throw new Error(`compute service "${newName}" already exists`)
      const branches = this.listBranches(projectId)
      const deployed = branches.filter((b) => b.apps[oldName])
      if (deployed.length && !this.compute.rename) throw new Error('rename is not supported by this compute adapter')
      // What each carrier will answer on afterwards, computed before the first await so the state
      // write below is pure bookkeeping.
      const minted = new Map(deployed.map((b) => {
        const ref = this.ref(project, b)
        const host = this.hostFor('compute', newName, ref)
        return [b.id, {
          host,
          url: this.serviceUrl(project, { ...b, apps: { ...b.apps, [newName]: { ...b.apps[oldName], host } } }, newName),
          oldLabel: this.labelFor('compute', oldName, ref),
          newLabel: this.labelFor('compute', newName, ref),
        }]
      }))
      // A branch with no deployment mints nothing today, but its next deploy will, so the new name
      // has to be free there too — the check `addComputeService` makes for the same reason. Only
      // the carriers get a RESERVATION: a reservation is retired by the row that supersedes it, and
      // a branch that writes no row would leak one for ever.
      for (const b of branches) {
        if (minted.has(b.id)) continue
        this.assertHostFree(this.labelFor('compute', newName, this.ref(project, b)))
      }
      const owner = `${projectId}:cp-${oldName}->cp-${newName}`
      this.reserveHosts([...minted.values()].map((m) => m.newLabel), owner)
      const done: Array<{ label: string; back: () => Promise<void> }> = []
      try {
        for (const b of deployed) {
          const ref = this.ref(project, b)
          if (!(await this.renameNeeded(appContainerName(ref, oldName), appContainerName(ref, newName)))) continue
          await this.compute.rename!(ref, oldName, newName)
          done.push({ label: `${appContainerName(ref, newName)} (branch ${b.name})`, back: () => this.compute.rename!(ref, newName, oldName) })
        }
      } catch (e) {
        const stuck = await this.undoRenames(done)
        this.releaseHosts(owner)
        throw this.renameFailure(e, stuck, `\`insta services rename cp-${oldName} ${newName}\``)
      }
      mutate((st) => {
        const pr = st.projects[projectId]
        pr.computeGroups = (pr.computeGroups ?? []).map((g) => (g === oldName ? newName : g))
        // the /data volume record follows the rename; its stable id keeps the docker volume attached
        if (pr.computeVolumes?.[oldName]) {
          pr.computeVolumes[newName] = pr.computeVolumes[oldName]
          delete pr.computeVolumes[oldName]
        }
        // always-on, limits, the recorded port and the template provenance are keyed by service id,
        // and the id embeds the name: without this the rename silently reset them to the defaults.
        // renamedAt: the container is keyed by the NEW name, whose metrics history may still hold a deleted
        // service's samples; this service's history under it starts now (observedTargets' `since`).
        pr.serviceSettings = pr.serviceSettings ?? {}
        pr.serviceSettings[`cp-${newName}`] = { ...pr.serviceSettings[`cp-${oldName}`], renamedAt: Date.now() }
        delete pr.serviceSettings[`cp-${oldName}`]
        for (const b of branches) {
          const app = st.branches[b.id].apps[oldName]
          if (!app) continue
          const m = minted.get(b.id)!
          st.branches[b.id].apps[newName] = { ...app, host: m.host, url: m.url }
          delete st.branches[b.id].apps[oldName]
          // The old hostname is this group's no longer: drop any reservation still standing on it
          // (a deploy that took one and never wrote its row), and retire the one just taken, which
          // the row above now supersedes.
          if (st.hostReservations?.[m.oldLabel] !== undefined) delete st.hostReservations[m.oldLabel]
          if (st.hostReservations?.[m.newLabel] === owner) delete st.hostReservations[m.newLabel]
        }
        for (const u of st.userSecrets[projectId] ?? []) {
          if (u.service === `compute/${oldName}`) u.service = `compute/${newName}`
        }
        // Git bindings resolve their target by group name, so they follow the rename too — else a
        // push would deploy to a group that no longer exists and the binding could never be pruned.
        if (st.gitBindings) for (const r of Object.values(st.gitBindings)) if (r.projectId === projectId && r.group === oldName) r.group = newName
      })
      // The ServiceKey embeds the id, so the scheduler's ledger has to follow or the renamed group
      // is tracked under a key nothing resolves any more (and its wake would never fire).
      for (const b of deployed) this.scheduler.rekey(this.serviceKey(b, `cp-${oldName}`), this.serviceKey(b, `cp-${newName}`))
      this.router.invalidate()
      this.emit(projectId, null, 'resource', 'service.rename', { type: 'compute', from: oldName, to: newName })
      return current()
    })
  }

  /** Remove a compute group from ONE branch, resolved exactly as its postgres, storage and managed
   *  siblings resolve one: the qualifier on the id first, then `opts.branch`, then the default
   *  (decision 49). A group is a project-level REGISTRATION, but what a branch carries is a
   *  container and, with `--volume`, a `/data` directory of its own bytes, so sweeping every branch
   *  destroyed main's container and deleted main's volume when the caller asked to drop the copy on
   *  `feat` — with both the branch-qualified id and `?branch=feat` on the request.
   *
   *  The registration (the name, its volume record, its limits and always-on settings) is what
   *  survives one branch's copy: it retires with the LAST branch that still runs the group, which
   *  is also what makes removing a group that was never deployed anywhere unregister it. */
  async removeComputeService(projectId: string, serviceId: string, opts: { branch?: string } = {}): Promise<Teardown> {
    const { branch: atBranch, sid } = this.removalTarget(projectId, serviceId, opts.branch)
    const parsed = parseServiceId(sid)
    // A name no branch and no registration claims is a 404, not an empty teardown reporting the
    // successful removal of something that never existed (contract section 9).
    if (parsed?.type !== 'compute') throw new Error('service not found')
    const name = parsed.name
    if (!this.computeGroupNames(projectId).includes(name)) throw new Error('service not found')
    // Decision 52 names "service remove" a taker and this one held nothing at all, so a deploy,
    // a lifecycle op or a rename could run against the same container while it was being
    // destroyed. The key, and the re-resolution every queued operation owes, together.
    return this.withOp([this.serviceKey(atBranch, sid)], async () => {
      const { project, branch } = this.freshRemoval(projectId, atBranch.id, sid)
      if (!this.computeGroupNames(projectId).includes(name)) throw movedUnderUs(sid, 'removal')
      return this.removeComputeLocked(project, branch, sid, name)
    })
  }

  private async removeComputeLocked(project: Project, branch: Branch, sid: string, name: string): Promise<Teardown> {
    const projectId = project.id
    const vol = project.computeVolumes?.[name]
    const t = newTeardown()
    // Only this branch's copy. A branch that carries no container for the group has nothing to
    // destroy here, and that is not a 404: the registration shows on every branch's list with a
    // `runtime` of `none` until a deploy puts a container there (the divergence COMPATIBILITY
    // records), so removing it from such a branch has to be accepted and count nothing.
    if (branch.apps[name]) {
      // Fail-closed, exactly as the branch and project teardowns are: the container has to be
      // PROVEN gone before its bind-mounted /data is deleted and before the row that names both
      // is dropped. A failed `docker rm` followed by a directory removal erases the files a
      // still-running container is writing, and dropping the row then leaves it with nothing
      // naming it. The row that stays is what `insta services remove` retries through.
      const container = `io-${this.ref(project, branch)}-app-${name}`
      if (await removeContainer(this.scheduler, t, container, () => docker(['rm', '-f', '-v', container]))) {
        // WP4: the /data bytes are a directory under the data dir; remove it AFTER the container.
        // ...and the BYTES arm gates the row exactly as the container arm does: a directory that
        // could not be removed is still on disk, and dropping the row, the scheduler key and the
        // registration leaves it with nothing naming it, on a 409 whose message says the row was
        // kept and to retry. The retry then answers 404.
        const beforeBytes = t.failed
        if (vol) {
          const dir = this.layout().vol(this.ref(project, branch), vol.id)
          await count(t, () => this.data.remove(dir), `remove the /data directory ${dir}`)
          if (t.failed !== beforeBytes) return t
        }
        mutate((st) => {
          delete st.branches[branch.id].apps[name]
          st.branches[branch.id].bindings = (st.branches[branch.id].bindings ?? []).filter((x) => x.target !== `compute/${name}`)
          // Drop any git push-to-deploy binding for this compute group: its target is gone, so a
          // later webhook must not resolve to a same-named service redeployed after this removal.
          if (st.gitBindings) for (const [k, r] of Object.entries(st.gitBindings)) if (r.projectId === projectId && r.branchId === branch.id && r.group === name) delete st.gitBindings[k]
        })
        this.scheduler.forget([this.serviceKey(branch, sid)])                                        // WP3
      } else {
        // Nothing else may run: the domains, the secrets and the registration all still describe
        // a service that is still there.
        return t
      }
    }
    // The custom domains bound to the group ON THIS BRANCH answered through the container that
    // just went; another branch's stay, because its container still serves them.
    this.releaseDomainsFor(projectId, branch.id, name)                                               // WP2
    // The secrets bound to the group on the branch it was just removed from go with it, whether or
    // not the shared registration can retire — the rule `retireRegistration` applies to the other
    // three types, and for the same reason: `userSecretsFor` would otherwise hand them back as
    // ordinary branch secrets, the credentials of a service that no longer exists there.
    const source = `compute/${name}`
    mutate((st) => {
      st.userSecrets[projectId] = (st.userSecrets[projectId] ?? [])
        .filter((u) => !(u.service === source && u.branch === branch.name))
    })
    if (!this.listBranches(projectId).some((b) => b.apps[name])) {
      mutate((st) => {
        const pr = st.projects[projectId]
        pr.computeGroups = (pr.computeGroups ?? []).filter((g) => g !== name)
        if (pr.computeVolumes) delete pr.computeVolumes[name]
        if (pr.serviceSettings) delete pr.serviceSettings[`cp-${name}`]
        st.userSecrets[projectId] = (st.userSecrets[projectId] ?? []).filter((u) => u.service !== source)
      })
    }
    this.router.invalidate()
    this.emit(projectId, branch.name, 'resource', 'service.removed', { type: 'compute', name })
    return t
  }

  // ---- managed databases (redis | mysql | mongodb — cloud parity, platform #235/#236) ----

  private managedRow(m: { id: string; type: ManagedDbType; name: string }): { id: string; type: string; name: string; status: string; port: number; volume_gib: number } {
    return { id: m.id, type: m.type, name: m.name, status: 'ready', port: MANAGED_DB[m.type].port, volume_gib: MANAGED_DB[m.type].volumeGib }
  }

  /** Add a managed database to ONE branch (`opts.branch`, else the project's default): a private
   *  container with a fresh password and an empty volume, exactly as the cloud materialises one.
   *  Data is never cloned for this type, on any path.
   *
   *  Branch-scoped for the reason spelled out on `addDbService`: fanning out meant an agent adding
   *  a redis on its own branch also got one, with its own credentials, on `main`. */
  async addManagedService(projectId: string, type: ManagedDbType, name: string, opts: { branch?: string } = {}): Promise<{ id: string; type: string; name: string; status: string; port: number; volume_gib: number; always_on: boolean }> {
    // The branch key outside the provision chain, the order every other taker uses (decision 52,
    // `addKeys`): an add that runs inside a queued branch create's window changes what that
    // create will fork, out from under the key set it already enqueued.
    return this.withOp(this.addKeys(projectId, opts.branch), () => this.addManagedServiceLocked(projectId, type, name, opts))
  }

  private async addManagedServiceLocked(projectId: string, type: ManagedDbType, name: string, opts: { branch?: string } = {}): Promise<{ id: string; type: string; name: string; status: string; port: number; volume_gib: number; always_on: boolean }> {
    // Inside the engine-wide provision chain, exactly like its postgres and storage siblings.
    // Without it the `existing` check and the append that follows it were check-then-act across
    // every provisioning await: two concurrent first adds of the same managed service, on two
    // branches, both saw no registration and both appended one with the same id — a duplicate
    // row in `managedServices` that every later read then reported twice. On ONE branch they
    // also raced through `reserveHosts` unchallenged, because both hold the same owner string
    // (`<projectId>:<serviceId>`), and provisioned the same container twice. The chain makes
    // check, provision and append one operation, so the second call sees the first's
    // registration and either materialises on its own branch or is the 409 (decision 51).
    return this.serialize('provision', async () => {
      const project = this.getProject(projectId)
      if (!project) throw new Error('project not found')
      assertServiceName(name)
      const b = this.targetBranch(projectId, opts.branch)
      this.assertUsable(b, 'given new services')
      const existing = this.managedList(projectId).find((m) => m.type === type && m.name === name)
      if (existing && this.carries(project, b, existing, 'managed')) throw new Error(`${type} service "${name}" already exists`)
      // Suffixed only, deliberately: a user secret can never hold a CANONICAL managed name, since
      // setUserSecret refuses every reserved one (isReservedSecret covers `k` and `k_*`). Passing
      // the aliases here would be unreachable defence.
      const wouldMint = this.mintedManagedNames({ id: '', type, name }, false)
      const clash = (loadState().userSecrets[projectId] ?? []).find((u) => wouldMint.includes(u.name))
      if (clash) throw new Error(`service would mint secret names already used by user secrets: ${clash.name}`)
      // WP4: an immutable directory key, minted once and stored, so a rename never detaches the data
      // (decision 16). The directory is `md/<ref>/<prefix>-<dataId>` on every branch that carries it.
      const entry = existing ?? { id: managedServiceId(type, name), type, name, createdAt: Date.now(), dataId: randomUUID().slice(0, 8) }
      // The hostname this service will mint, checked against ALL service labels and reserved in ONE
      // synchronous mutate before the first provisioning await (decision 51) — the same rule the
      // postgres and compute registrations follow. `<type>-<name>-<ref>` shares its label space with
      // compute's `<group>-<ref>`, so a redis called `cache` collides with a group called
      // `redis-cache`; minting it unchecked would shadow one of them in the route table.
      const owner = `${projectId}:${entry.id}`
      this.reserveHosts([this.labelFor(type, name, this.ref(project, b))], owner)
      const provisioned: Array<{ branch: Branch; password: string; container: string; dataDir: string }> = []
      try {
        const password = randomBytes(32).toString('base64url')
        const ref = this.ref(project, b)
        const container = managedContainerName(ref, type, name)
        const dataDir = await this.ensureManagedDirs(ref, type, entry.dataId ?? name)
        await this.managedDb.provision(
          { container, network: b.network, type, name, password, dataDir },
          { publishLoopback: this.cfg.mode === 'local', limits: this.limitsFor(project, entry.id) },
        )
        provisioned.push({ branch: b, password, container, dataDir })
      } catch (e) {
        for (const p of provisioned) await this.managedDb.destroy(p.container).catch(() => {})
        for (const p of provisioned) await this.data.remove(p.dataDir).catch(() => {})                       // WP4
        this.releaseHosts(owner)
        throw e
      }
      mutate((st) => {
        const pr = st.projects[projectId]
        // Only a registration this call MADE is added: one that already existed is other branches'
        // service too, and re-appending it would duplicate the row.
        if (!existing) pr.managedServices = [...(pr.managedServices ?? []), entry]
        for (const p of provisioned) {
          // Record the minted hostname on the row, like `provisionBranch` does: the row is what the
          // route table and the credentials bundle read, and it retires the reservation.
          const label = this.labelFor(type, name, this.ref(project, p.branch))
          // addedAt: see addDbService. A kept registration keeps its createdAt; this row marks the new incarnation.
          ;(st.branches[p.branch.id].managed ??= {})[entry.id] = { password: p.password, host: `${label}.${this.cfg.domain}`, addedAt: Date.now() }
          if (st.hostReservations?.[label] === owner) delete st.hostReservations[label]
        }
      })
      this.scheduler.register(provisioned.map((p) => this.serviceKey(p.branch, entry.id))) // WP3
      // Its postgres and storage siblings do this and managed did not. `reconcile()` is what opens a
      // lane listener, and it runs only at `router.start()` and on invalidate, so a managed database
      // added after boot had no lane until something unrelated invalidated. Server-mode redis and
      // mongodb hide it behind their fixed lanes, so what it actually broke was local mode and
      // server-mode MySQL, which take a per-service port.
      this.router.invalidate()                                          // WP2
      this.emit(projectId, b.name, 'resource', 'service.added', { type, name })
      // What the branch it landed on will do, through the rule the list and the scheduler use.
      return { ...this.managedRow(entry), always_on: this.effectiveAlwaysOn(this.getProject(projectId)!, b, entry.id) }
    })
  }

  /** Remove a managed database from ONE branch (`removalTarget`): destroy THAT branch's container
   *  and its bytes, and unregister only once no branch carries the name any more. The data goes
   *  with it — same irreversibility class as removing a compute service — which is exactly why the
   *  blast radius is one branch (see `removeDbService`). */
  async removeManagedService(projectId: string, serviceId: string, opts: { branch?: string } = {}): Promise<Teardown> {
    const { project, branch, sid } = this.removalTarget(projectId, serviceId, opts.branch)
    const m = this.managedList(projectId).find((x) => x.id === sid)
    if (!m) throw new Error('service not found')
    this.assertCarries(project, branch, m, 'managed')
    // The key this removal never took, plus the re-resolution it owes (see `freshRemoval`).
    return this.withOp([this.serviceKey(branch, sid)], async () => {
      const fresh = this.freshRemoval(projectId, branch.id, sid)
      const live = this.managedList(projectId).find((x) => x.id === sid)
      if (!live || !this.carries(fresh.project, fresh.branch, live, 'managed')) throw movedUnderUs(sid, 'removal')
      return this.removeManagedLocked(fresh.project, fresh.branch, sid, live)
    })
  }

  private async removeManagedLocked(project: Project, branch: Branch, sid: string, m: { id: string; type: ManagedDbType; name: string; dataId?: string }): Promise<Teardown> {
    const projectId = project.id
    const t = newTeardown()
    const ref = this.ref(project, branch)
    const container = managedContainerName(ref, m.type, m.name)
    // Proven gone before the bytes and the row, like every other teardown here.
    if (!(await removeContainer(this.scheduler, t, container, () => this.managedDb.destroy(container)))) return t
    // WP4: the data goes with the container (same irreversibility class as the compute service),
    // and it gates the row for the same reason the container does.
    const beforeBytes = t.failed
    const dir = this.layout().md(ref, m.type, m.dataId ?? m.name)
    await count(t, () => this.data.remove(dir), `remove the data directory ${dir}`)
    if (t.failed !== beforeBytes) return t
    mutate((st) => {
      delete st.branches[branch.id].managed?.[sid]
      st.branches[branch.id].bindings = (st.branches[branch.id].bindings ?? []).filter((x) => x.source !== `${m.type}/${m.name}`)
    })
    this.scheduler.forget([this.serviceKey(branch, sid)]) // WP3
    this.retireRegistration(project, m, 'managed', `${m.type}/${m.name}`, branch)
    this.router.invalidate()
    this.emit(projectId, branch.name, 'resource', 'service.removed', { type: m.type, name: m.name })
    return t
  }

  /** Rename a managed database everywhere it appears: registration (the id embeds the name),
   *  every branch's container (docker DNS follows), per-branch credentials (re-keyed by the new
   *  id; the bundle re-mints on the next read with the new host + suffix), and service-bound
   *  user secrets. Deployed compute containers keep the OLD host in their env until their next
   *  deploy — same as the cloud, where a rename re-keys stored names but never hot-patches env. */
  async renameManagedService(projectId: string, serviceId: string, newName: string): Promise<{ id: string; type: string; name: string; status: string; port: number; volume_gib: number }> {
    return this.withRenameKeys(projectId, serviceId, () => this.renameManagedServiceLocked(projectId, serviceId, newName))
  }

  private async renameManagedServiceLocked(projectId: string, serviceId: string, newName: string): Promise<{ id: string; type: string; name: string; status: string; port: number; volume_gib: number }> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const m = this.managedList(projectId).find((x) => x.id === serviceId)
    if (!m) throw new Error('service not found')
    assertServiceName(newName)
    if (newName === m.name) return this.managedRow(m)
    if (this.managedList(projectId).some((x) => x.type === m.type && x.name === newName)) throw new Error(`${m.type} service "${newName}" already exists`)
    const newId = managedServiceId(m.type, newName)
    // The rename mints a new hostname on every branch that carries the service (postgres rename
    // does the same), so it reserves them first: unchecked, `insta services rename cache redis-x`
    // could land on the label a compute group already answers on.
    const carriers = this.listBranches(projectId).filter((b) => b.managed?.[serviceId])
    const owner = `${projectId}:${serviceId}->${newId}`
    const newLabel = new Map(carriers.map((b) => [b.id, this.labelFor(m.type, newName, this.ref(project, b))]))
    this.reserveHosts([...newLabel.values()], owner)
    const done: Array<{ label: string; back: () => Promise<void> }> = []
    try {
      for (const b of carriers) {
        const ref = this.ref(project, b)
        const from = managedContainerName(ref, m.type, m.name)
        const to = managedContainerName(ref, m.type, newName)
        if (!(await this.renameNeeded(from, to))) continue
        await this.managedDb.rename(from, to)
        done.push({ label: `${to} (branch ${b.name})`, back: () => this.managedDb.rename(to, from) })
      }
    } catch (e) {
      const stuck = await this.undoRenames(done)
      this.releaseHosts(owner)
      throw this.renameFailure(e, stuck, `\`insta services rename ${serviceId} ${newName}\``)
    }
    mutate((st) => {
      const pr = st.projects[projectId]
      // renamedAt: metrics history under the new name starts now, not at creation (observedTargets' `since`).
      pr.managedServices = (pr.managedServices ?? []).map((x) => (x.id === serviceId ? { ...x, id: newId, name: newName, renamedAt: Date.now() } : x))
      for (const b of Object.values(st.branches)) {
        if (b.projectId !== projectId || !b.managed?.[serviceId]) continue
        const label = newLabel.get(b.id)
        b.managed[newId] = { ...b.managed[serviceId], ...(label !== undefined ? { host: `${label}.${this.cfg.domain}` } : {}) }
        delete b.managed[serviceId]
        if (label !== undefined && st.hostReservations?.[label] === owner) delete st.hostReservations[label]
      }
      for (const u of st.userSecrets[projectId] ?? []) {
        if (u.service === `${m.type}/${m.name}`) u.service = `${m.type}/${newName}`
      }
    })
    // AFTER the records, like the compute path: the ledger key embeds the service id, and moving
    // it while the rows still name the old id left the scheduler keyed to something no reader
    // resolved for the length of the write, and keyed to it for good if the write never came.
    for (const b of carriers) this.scheduler.rekey(this.serviceKey(b, serviceId), this.serviceKey(b, newId)) // WP3
    this.emit(projectId, null, 'resource', 'service.rename', { type: m.type, from: m.name, to: newName })
    return this.managedRow({ id: newId, type: m.type, name: newName })
  }

  // ---- volumes + database settings (tier-caps contract parity — platform #166–169) ----

  /** A compute service's /data volume (null when none) + the volume cap — GET …/volume shape. */
  serviceVolume(projectId: string, serviceId: string): { volume: { sizeGib: number; mountPath: string } | null; cap: { volumeGib: number } } {
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute') throw new Error('volumes are only supported for compute services')
    const vol = this.getProject(projectId)?.computeVolumes?.[svc.name]
    return { volume: vol ? { sizeGib: vol.sizeGib, mountPath: VOLUME_MOUNT_PATH } : null, cap: { volumeGib: VOLUME_CAP_GIB } }
  }

  /** Attach or grow a compute service's /data volume — the cloud contract (attach any time,
   *  platform #185; grow-only; ≤ cap) so the CLI flow is identical; the size itself is advisory
   *  locally (a docker named volume has no quota to extend). */
  async setServiceVolume(projectId: string, serviceId: string, sizeGib: number): Promise<{
    service: ServiceRow | undefined; volume: { sizeGib: number; mountPath: string }; cap: { volumeGib: number }; attached?: boolean
  }> {
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute') throw new Error('volumes are only supported for compute services')
    // Decision 52 says "volume ops", plural, and this is the other one. It writes the same
    // `computeVolumes` record `removeServiceVolume` deletes and restores, so without a key an
    // attach landing mid-removal is either lost by the restore or survives a removal that
    // succeeded. It takes the SAME keys, which excludes the two by construction rather than by
    // making the restore guess whose record it is looking at.
    //
    // No union re-drive here, and that is not an oversight: this does no per-branch work, so
    // its set does not have to be COMPLETE, only to overlap the removal's, and both always
    // contain the default branch. It also acquires nothing while holding these (no deploy, no
    // lifecycle), so it cannot be half of a cycle.
    return this.withOp(this.listBranches(projectId).flatMap((b) => [this.branchOp(b), this.serviceKey(b, `cp-${svc.name}`)]),
      () => this.setServiceVolumeLocked(projectId, serviceId, sizeGib))
  }

  private async setServiceVolumeLocked(projectId: string, serviceId: string, sizeGib: number): Promise<{
    service: ServiceRow | undefined; volume: { sizeGib: number; mountPath: string }; cap: { volumeGib: number }; attached?: boolean
  }> {
    // Re-resolved under the lock, like every operation that had to resolve to take a key.
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute') throw new Error('volumes are only supported for compute services')
    if (!Number.isInteger(sizeGib) || sizeGib < 1) throw new Error('sizeGib must be a positive integer (whole Gi)')
    if (sizeGib > VOLUME_CAP_GIB) throw new Error(`volume exceeds the cap (${VOLUME_CAP_GIB}Gi)`)
    const vol = this.getProject(projectId)?.computeVolumes?.[svc.name]
    if (!vol) {
      // Attach-after-create (platform #185 parity): record only — the named volume materializes
      // when the NEXT deploy rebuilds the container with the mount, exactly the cloud's "mounts
      // at /data on the next deploy". `attached: true` is what the CLI keys its wording on.
      if (!this.compute.supportsVolumes) throw new Error('/data volumes are not supported by this compute adapter — use the docker adapter')
      mutate((st) => { (st.projects[projectId].computeVolumes ??= {})[svc.name] = { id: randomUUID().slice(0, 8), sizeGib } })
      this.emit(projectId, null, 'resource', 'service.volume', { service: serviceId, sizeGib, attached: true })
      const attachedSvc = (await this.services(projectId)).find((s) => s.id === serviceId)
      return { service: attachedSvc, volume: { sizeGib, mountPath: VOLUME_MOUNT_PATH }, cap: { volumeGib: VOLUME_CAP_GIB }, attached: true }
    }
    if (sizeGib < vol.sizeGib) throw new Error(`the volume can only grow (currently ${vol.sizeGib}Gi) — the volume is a provisioned disk and cannot shrink`)
    if (sizeGib !== vol.sizeGib) {
      mutate((st) => { st.projects[projectId].computeVolumes![svc.name].sizeGib = sizeGib })
      this.emit(projectId, null, 'resource', 'service.volume', { service: serviceId, sizeGib })
    }
    const service = (await this.services(projectId)).find((s) => s.id === serviceId)
    return { service, volume: { sizeGib, mountPath: VOLUME_MOUNT_PATH }, cap: { volumeGib: VOLUME_CAP_GIB } }
  }

  /** Delete a compute service's /data volume — the 2026-08-08 cloud contract (DELETE …/volume):
   *  the only way off the volume path (there is still no detach), destroying the data. EAGER like
   *  the platform: every branch where the group is deployed is rebuilt WITHOUT the mount now (the
   *  record goes first — deploy() reads it), the branch's named volume is removed, and the
   *  recorded intent is re-asserted by deploy() itself — the same lifecycle-preserving rule the platform
   *  keeps with skip_launch. Docker cleanup is best-effort like removeComputeService's: oss has
   *  no billing, and branch teardown sweeps any stragglers. Non-transactional like the engine's
   *  other multi-branch sweeps: a rebuild that throws mid-loop leaves LATER branches still
   *  mounted with the record already gone — locally a retry or redeploy converges, and nothing
   *  bills meanwhile (John-bot note on this PR). */
  async removeServiceVolume(projectId: string, serviceId: string): Promise<{
    service: ServiceRow | undefined; volume: null; cap: { volumeGib: number }; removed: true
  }> {
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute') throw new Error('volumes are only supported for compute services')
    // The last taker on decision 52's list ("volume ops"). It is a MULTI-BRANCH operation: it
    // redeploys the group on every branch that runs it and deletes each branch's bytes, and it
    // held no key at all, so a create could fork this very volume onto a new branch after the
    // loop took its snapshot and leave a freshly cloned directory nothing ever visits. The keys
    // are taken up front, which also makes the nested `deploy` and `lifecycle` calls re-entrant
    // instead of second acquisitions, and the set is re-driven over the union exactly as
    // `createBranch` and `destroyProject` do it when a branch appears under it.
    const keysFor = (b: Branch): ServiceKey[] => [this.branchOp(b), this.serviceKey(b, `cp-${svc.name}`)]
    let keys = this.listBranches(projectId).flatMap(keysFor)
    for (let round = 1; ; round++) {
      const settled = new Set(keys)
      const out = await this.withOp([...settled], async (): Promise<{ done: { service: ServiceRow | undefined; volume: null; cap: { volumeGib: number }; removed: true } } | { union: ServiceKey[] }> => {
        const live = this.listBranches(projectId)
        const needed = live.flatMap(keysFor)
        if (!needed.every((k) => settled.has(k))) return { union: [...new Set([...settled, ...needed])] }
        return { done: await this.removeServiceVolumeLocked(projectId, serviceId, live) }
      })
      if ('done' in out) return out.done
      if (round >= CREATE_LOCK_ROUNDS) {
        throw new Error(`volume removal could not settle its lock set after ${CREATE_LOCK_ROUNDS} rounds: branches are being created or changed concurrently, retry it`)
      }
      keys = out.union
    }
  }

  private async removeServiceVolumeLocked(projectId: string, serviceId: string, branches: Branch[]): Promise<{
    service: ServiceRow | undefined; volume: null; cap: { volumeGib: number }; removed: true
  }> {
    // Re-resolved under the lock, like every other operation that had to resolve to take a key.
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute') throw new Error('volumes are only supported for compute services')
    const project = this.getProject(projectId)
    const vol = project?.computeVolumes?.[svc.name]
    if (!project || !vol) throw new Error('this service has no volume')
    // The record goes first because `deploy()` READS it to decide the mount, so it cannot be
    // deferred. What can be fixed is what a failure leaves behind: it is put BACK below if any
    // part of this fails, so the operation is retryable instead of leaving bytes on disk with
    // no registration left to reach them through.
    mutate((st) => { delete st.projects[projectId].computeVolumes![svc.name] })
    const failures: string[] = []
    for (const b of branches) {
      const app = loadState().branches[b.id]?.apps[svc.name]
      if (!app) continue
      try {
        // `deploy()` re-asserts the recorded intent on the replacement itself, with the EXACT
        // verb (oss allows a suspended volume-bearing service, so this must land back on
        // `suspend` and never be coarsened to `stop`), so this loop must NOT do it a second
        // time. It used to, harmlessly, while the re-assert swallowed its own failures: making
        // that fail-closed turned the duplicate into a deterministic break, because
        // `docker pause` on an already-paused container exits 1 while `docker stop` on an
        // exited one exits 0 -- so the `stopped` arm never showed it and the `suspended` arm
        // failed every `volume delete`. The lesson is the general one: making an error
        // propagate surfaces latent DUPLICATE calls, not just real failures.
        await this.deploy(projectId, b.name, { image: app.image, port: app.port, hostPort: app.hostPort, group: svc.name })
      } catch (e) {
        failures.push(`${b.name}: ${e instanceof Error ? e.message : String(e)}`)
        continue   // the mount may still be attached: its bytes are not ours to delete
      }
      // WP4: the redeploy above dropped the mount; now the bytes go too -- and the PROBE after
      // the removal is the evidence, not the call, the same rule the container teardowns use.
      const dir = this.layout().vol(this.ref(project, b), vol.id)
      try {
        await this.data.remove(dir)
        if (!(await this.data.isEmptyOrMissing(dir))) throw new Error('it is still there after the remove')
      } catch (e) {
        failures.push(`${b.name}: ${dir}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (failures.length) {
      // Put the record back, with its stable id, so the bytes still have a registration naming
      // them and `insta compute volume rm` retries exactly this. Reporting `removed: true` over
      // a directory that is still on disk is the failure this method used to have.
      mutate((st) => { (st.projects[projectId].computeVolumes ??= {})[svc.name] = vol })
      throw new Error(`could not remove the /data volume of "${svc.name}" on ${failures.length} branch(es) (${failures.join('; ')}); the volume record is kept so the removal can be retried`)
    }
    this.emit(projectId, null, 'resource', 'service.volume', { service: serviceId, sizeGib: null, removed: true })
    const service = (await this.services(projectId)).find((s) => s.id === serviceId)
    return { service, volume: null, cap: { volumeGib: VOLUME_CAP_GIB }, removed: true }
  }

  /** Read-only DB instance view (DbInstanceInfo shape): settings + volume size + the cap. Local
   *  values are honest constants — pooling/scale-to-zero are cloud provider levers with no
   *  docker-postgres analog. Includes the deprecated storage* aliases the platform still mirrors. */
  dbInstance(projectId: string, branchName?: string, group?: string): Record<string, unknown> {
    const t = this.dbTarget(projectId, branchName, group)
    const branch = t.branch
    const gib = branch.dbVolumeGib ?? DB_VOLUME_DEFAULT_GIB
    // WP3 edit point: `scaleToZero`, `idleTimeoutSecs` and the cpu/memory ceiling are real now, and
    // `host`/`port` are the row's LANE address (WP2), which is what a client actually dials.
    const row = branch.databases?.[t.serviceId]
    const lane = this.laneAddress(t.project, branch, t.serviceId)
    const limits = row?.limits
    return {
      id: t.serviceId, name: t.serviceId.replace(/^pg-/, ''), state: branch.status,
      host: lane.host, port: lane.port,
      routeKey: this.labelFor('postgres', t.serviceId.replace(/^pg-/, ''), this.ref(t.project, branch)),
      connectionPooling: false, deletionProtection: false,
      scaleToZero: row?.scaleToZero ?? true,
      idleTimeoutSecs: row?.idleTimeoutSec ?? this.cfg.sleep.idleDbSec,
      ...(limits ? { cpuMilli: limits.cpu * 1000, memoryMib: limits.memoryMb } : {}),
      volumeSize: `${gib}Gi`, volumeGib: gib,
      storageSize: `${gib}Gi`, storageGiB: gib, // DEPRECATED aliases — dropped when the platform drops them
      cap: { ...DB_CAP },
    }
  }

  /** PATCH database/settings: volumeSize ('10Gi', whole Gi, grow-only) is accepted, persisted,
   *  and echoed — advisory locally, the postgres container's disk is unbounded. `scaleToZero`,
   *  `idleTimeout`, `cpu` and `memory` are REAL here (WP3): they are the instance's own sleep and
   *  ceiling levers, per branch, because the database is a per-branch container. Connection pooling
   *  stays a cloud lever with no local analog: accepted and ignored. */
  async dbSettings(
    projectId: string,
    patch: { volumeSize?: string; storageSize?: string; scaleToZero?: boolean; idleTimeout?: number | string; cpu?: number | string; memory?: number | string },
    branchName?: string, group?: string,
  ): Promise<Record<string, unknown>> {
    const t = this.dbTarget(projectId, branchName, group)
    const { branch } = t
    await this.patchDbScheduling(t, patch)
    const raw = patch.volumeSize ?? patch.storageSize // storageSize = deprecated platform alias
    if (raw !== undefined) {
      const m = /^(\d+)Gi$/.exec(String(raw).trim())
      const want = m ? Number(m[1]) : 0
      if (want < 1) throw new Error(`invalid volume quantity: ${raw} (whole Gi only — try '10Gi')`)
      const current = branch.dbVolumeGib ?? DB_VOLUME_DEFAULT_GIB
      if (want < current) throw new Error(`the volume can only grow (currently ${current}Gi) — the volume is a provisioned disk and cannot shrink`)
      if (want > VOLUME_CAP_GIB) throw new Error(`volume exceeds the cap (${VOLUME_CAP_GIB}Gi)`)
      if (want !== current) {
        mutate((st) => { st.branches[branch.id].dbVolumeGib = want })
        this.emit(projectId, branch.name, 'resource', 'database.settings', { volumeSize: `${want}Gi` })
      }
    }
    return this.dbInstance(projectId, branchName, group)
  }

  /** The scheduler half of `PATCH database/settings` (WP3): the sleep lever, the idle window and
   *  the cgroup ceiling of ONE postgres service on ONE branch. Each field is optional and only a
   *  real change writes state or moves a container. */
  private async patchDbScheduling(
    t: { project: Project; branch: Branch; serviceId: string; container: string },
    patch: { scaleToZero?: boolean; idleTimeout?: number | string; cpu?: number | string; memory?: number | string },
  ): Promise<void> {
    const row = t.branch.databases?.[t.serviceId]
    if (!row) return
    const write = (fn: (r: NonNullable<Branch['databases']>[string]) => void): void => {
      mutate((s) => {
        const target = s.branches[t.branch.id].databases?.[t.serviceId]
        if (target) fn(target)
      })
    }
    if (patch.scaleToZero !== undefined) {
      if (typeof patch.scaleToZero !== 'boolean') throw new Error('scaleToZero must be a boolean')
      if (patch.scaleToZero !== (row.scaleToZero ?? true)) {
        write((r) => { r.scaleToZero = patch.scaleToZero })
        this.emit(t.project.id, t.branch.name, 'resource', 'service.alwaysOn', { service: t.serviceId, enabled: !patch.scaleToZero })
      }
    }
    if (patch.idleTimeout !== undefined) {
      const secs = Number(patch.idleTimeout)
      if (!Number.isInteger(secs) || secs < 0) throw new Error('idleTimeout must be a whole number of seconds (0 disables sleep)')
      if (secs !== row.idleTimeoutSec) write((r) => { r.idleTimeoutSec = secs })
    }
    if (patch.cpu !== undefined || patch.memory !== undefined) {
      const current = row.limits
      const cpu = patch.cpu !== undefined ? this.parseCpuQuantity(patch.cpu) : current?.cpu
      const memoryMb = patch.memory !== undefined ? this.parseMemoryQuantity(patch.memory) : current?.memoryMb
      if (memoryMb === undefined) throw new Error('memory is required when setting a cpu ceiling for the first time')
      const limits = this.validateLimits(memoryMb, cpu)
      const key = this.serviceKey(t.branch, t.serviceId)
      await this.withOp([key], async () => {
        try { await this.scheduler.runtimeUpdate(t.container, limits) }
        catch (e) {
          const m = e instanceof Error ? e.message : String(e)
          const err = new Error(`resize failed on the compute provider: ${m} (applied to 0/1 machines; the stored ceiling is unchanged)`)
          Object.assign(err, { status: 502 })
          throw err
        }
        write((r) => { r.limits = limits })
      })
      this.emit(t.project.id, t.branch.name, 'resource', 'service.limits', { service: t.serviceId, ...limits })
    }
  }

  // ---- database management (password / databases / extensions / insight — cloud parity) ----

  /** Extensions the daemon itself depends on — installed by the platform, cannot be disabled
   *  (plpgsql is postgres's own default; pg_stat_statements backs `insta` query-stats). */
  private static REQUIRED_EXTENSIONS = ['plpgsql', 'pg_stat_statements']
  private static DB_NAME_RE = /^[A-Za-z0-9._-]+$/
  private quoteIdent(name: string): string { return `"${name.replace(/"/g, '""')}"` }

  /** The branch's HOST-FACING connection URL (the service's lane, contract section 10) with the
   *  database name swapped: these strings are printed for a developer to paste, exactly like the
   *  DSN in `credentials` and `secrets`. */
  private connStringFor(t: { project: Project; branch: Branch; serviceId: string; url: string }, database: string): string {
    const u = new URL(this.laneUrl(t.project, t.branch, t.serviceId, t.url))
    u.pathname = `/${database}`
    return u.toString()
  }

  /** Set or regenerate the postgres user password; re-mints the branch's DATABASE_URL. Deployed
   *  containers keep the old env until their next deploy — same as the cloud. */
  async dbSetPassword(projectId: string, password: string | undefined, branchName?: string, group?: string): Promise<{ connString: string; password: string }> {
    const t = this.dbTarget(projectId, branchName, group)
    const pw = password ?? randomBytes(24).toString('base64url')
    // WP3 (decision 48): management is an explicit operation, so it WAKES a sleeping instance.
    await this.pgManage(t.branch, t.serviceId, () => this.db.query(t.container, `alter user postgres with password '${pw.replace(/'/g, "''")}'`))
    const u = new URL(t.url)
    // The STORED url stays the container-host form every read seam rewrites onto a lane; what the
    // caller gets back is that host-facing lane form (contract section 10).
    const stored = `${u.protocol}//${u.username}:${encodeURIComponent(pw)}@${u.host}${u.pathname}`
    const connString = this.laneUrl(t.project, t.branch, t.serviceId, stored)
    mutate((st) => {
      const row = st.branches[t.branch.id].databases?.[t.serviceId]
      if (row) row.url = stored
      // A legacy branch keeps its deprecated mirror in step until the migration drops it.
      if (t.serviceId === 'pg-db' && st.branches[t.branch.id].dbUrl !== undefined) st.branches[t.branch.id].dbUrl = stored
    })
    this.emit(projectId, t.branch.name, 'resource', 'db.password.set', { generated: !password })
    return { connString, password: pw }
  }

  async dbListDatabases(projectId: string, branchName?: string, group?: string): Promise<{ databases: Array<{ name: string; connString: string }> }> {
    const t = this.dbTarget(projectId, branchName, group)
    const rows = JSON.parse(await this.pgManage(t.branch, t.serviceId, () => this.db.query(t.container, observe.DB_DATABASES_SQL))) as Array<{ name: string }>
    return { databases: rows.map((r) => ({ name: r.name, connString: this.connStringFor(t, r.name) })) }
  }

  async dbCreateDatabase(projectId: string, name: string, branchName?: string, group?: string): Promise<{ name: string; connString: string }> {
    const t = this.dbTarget(projectId, branchName, group)
    if (!Engine.DB_NAME_RE.test(name)) throw new Error('database name must match ^[A-Za-z0-9._-]+$')
    await this.pgManage(t.branch, t.serviceId, () => this.db.query(t.container, `create database ${this.quoteIdent(name)}`))
    this.emit(projectId, t.branch.name, 'resource', 'db.database.create', { name })
    return { name, connString: this.connStringFor(t, name) }
  }

  async dbDeleteDatabase(projectId: string, name: string, branchName?: string, group?: string): Promise<void> {
    const t = this.dbTarget(projectId, branchName, group)
    if (!Engine.DB_NAME_RE.test(name)) throw new Error('database name must match ^[A-Za-z0-9._-]+$')
    // 'app' is the local substrate's fixed primary (adapters/postgres.ts DB); the URL-derived
    // name covers adapters that mint a different primary.
    const primary = new URL(t.url).pathname.slice(1) || 'app'
    if (name === primary || name === 'app' || name === 'postgres' || name.startsWith('template')) {
      throw new Error(`cannot delete ${name === primary || name === 'app' ? 'the primary database' : 'a system database'} (${name})`)
    }
    // WITH (FORCE): a control plane must not be blocked by an app holding a connection open.
    await this.pgManage(t.branch, t.serviceId, () => this.db.query(t.container, `drop database ${this.quoteIdent(name)} with (force)`))
    this.emit(projectId, t.branch.name, 'resource', 'db.database.delete', { name })
  }

  /** Installed + available extensions. Local postgres is full-power: `available` is the image's
   *  real pg_available_extensions, not a curated allowlist; the daemon's own two are `required`. */
  async dbExtensions(projectId: string, branchName?: string, group?: string): Promise<{ available: Array<{ name: string; required?: boolean }>; enabled: string[] }> {
    const t = this.dbTarget(projectId, branchName, group)
    const r = JSON.parse(await this.pgManage(t.branch, t.serviceId, () => this.db.query(t.container, observe.DB_EXTENSIONS_SQL))) as { available: Array<{ name: string }>; enabled: string[] }
    return {
      available: r.available.map((a) => (Engine.REQUIRED_EXTENSIONS.includes(a.name) ? { name: a.name, required: true } : { name: a.name })),
      enabled: r.enabled,
    }
  }

  async dbPatchExtensions(projectId: string, patch: { enable?: string[]; disable?: string[] }, branchName?: string, group?: string): Promise<{ available: Array<{ name: string; required?: boolean }>; enabled: string[] }> {
    const t = this.dbTarget(projectId, branchName, group)
    const container = t.container
    const view = await this.dbExtensions(projectId, t.branch.name, group)
    const known = new Set(view.available.map((a) => a.name))
    for (const name of [...(patch.enable ?? []), ...(patch.disable ?? [])]) {
      if (!known.has(name)) throw new Error(`unknown extension: ${name}`)
    }
    for (const name of patch.disable ?? []) {
      if (Engine.REQUIRED_EXTENSIONS.includes(name)) throw new Error(`extension ${name} is required by the platform and cannot be disabled`)
    }
    await this.pgManage(t.branch, t.serviceId, async () => {
      for (const name of patch.enable ?? []) await this.db.query(container, `create extension if not exists ${this.quoteIdent(name)}`)
      for (const name of patch.disable ?? []) await this.db.query(container, `drop extension if exists ${this.quoteIdent(name)}`)
    })
    this.emit(projectId, t.branch.name, 'resource', 'db.extensions.update', { enable: patch.enable ?? [], disable: patch.disable ?? [] })
    return this.dbExtensions(projectId, t.branch.name, group)
  }

  /** Deep database health (DbInsight shape): size breakdown, per-table stats, vacuum health,
   *  unused indexes — same sections the cloud serves, read straight off the branch container. */
  async dbInsight(projectId: string, branchName?: string, group?: string): Promise<observe.DbInsight> {
    const t = this.dbTarget(projectId, branchName, group)
    await this.assertPgAwake(t.branch, t.serviceId)                             // WP3: never wakes
    return observe.toDbInsight(await this.db.query(t.container, observe.DB_INSIGHT_SQL))
  }

  /** Tear down one branch's containers, bucket and network (shared by branch and project delete).
   *  After the containers: data directories (WP4), scheduler keys (WP3), custom domains (WP2). */
  private async teardownBranch(project: Project, b: Branch, t: Teardown): Promise<void> {
    const ref = this.ref(project, b)
    // What this branch's own demolition adds to the counter. `destroyProject` shares ONE
    // `Teardown` across every branch and already decides each ROW by this delta
    // (`t.failed === before`), so everything else this teardown decides has to use the same
    // scope or the two disagree -- which is exactly what a cumulative test did below.
    const failedBefore = t.failed
    // Every container this branch owns, so what follows can be gated on them ACTUALLY being
    // gone rather than on the removal call having returned.
    const survivors: string[] = []
    // ONE `docker ps -a` for the whole branch, rather than one per container before each
    // removal: a 26-branch project delete walked this per container and paid for a full
    // listing every time.
    const snapshot = await this.scheduler.containerSnapshot()
    const prove = async (container: string, remove: () => Promise<unknown>): Promise<void> => {
      const known = snapshot === null ? 'unknown' as const : snapshot.has(container) ? 'present' as const : 'gone' as const
      if (!(await removeContainer(this.scheduler, t, container, remove, known))) survivors.push(container)
    }
    const groups = Object.keys(b.apps ?? {})
    if (groups.length) {
      // One `compute.destroy` takes the whole branch's apps, so it is proved per container.
      let removed = false
      const once = async (): Promise<void> => { if (!removed) { removed = true; await this.compute.destroy(ref) } }
      for (const g of groups) await prove(appContainerName(ref, g), once)
    } else {
      await count(t, () => this.compute.destroy(ref))
    }
    // Only what this branch CARRIES: services are branch-scoped, so a registration another branch
    // materialised has no container, no bucket and no bytes here, and destroying its derived name
    // would count a provider object that never existed into the teardown summary.
    const dbs = this.dbList(project.id).filter((d) => this.carries(project, b, d, 'postgres'))
    const stores = this.stList(project.id).filter((x) => this.carries(project, b, x, 'storage'))
    for (const d of dbs) {
      const c = this.pgContainer(project, b, d.id)
      await prove(c, () => this.db.destroy(c))
    }
    for (const x of stores) {
      const bucket = this.bucketOf(project, b, x.id)
      await count(t, () => this.storage.destroy(bucket, b.network), `remove bucket ${bucket}`)
    }
    // The object store is ONE container for the whole box, attached to this branch's network: it is
    // detached once, after every bucket on the network is gone (a per-bucket detach would strand the
    // purge of the next one), and before `network rm`, which refuses while anything is attached.
    // Counted rather than swallowed, so an adapter that reports a failed detach is not lost from
    // the verdict `unwindBranch` reads. The only shipped adapter does not report one (Garage's
    // `detachFrom` swallows its own error), so today this line cannot fire: what actually catches
    // a detach that failed is the `network rm` below, which dockerd refuses while an endpoint is
    // still attached, and that IS counted.
    if (this.storage.detachFrom) await countFailure(t, `detach the object store from ${b.network}`, () => this.storage.detachFrom!(b.network))
    const managed = this.managedList(project.id).filter((m) => this.carries(project, b, m, 'managed'))
    for (const m of managed) {
      const c = managedContainerName(ref, m.type, m.name)
      await prove(c, () => this.managedDb.destroy(c))
    }
    await countFailure(t, `remove network ${b.network}`, () => removeNetwork(b.network))
    // WP4: the branch's bytes, after every container that held them, and ONLY when every one of
    // those containers is proven gone. These are bind mounts: deleting them under a container
    // that is still running takes the files out from under it, and a `docker rm` that failed or
    // a docker that could not answer is exactly when that happens. A remove failure of its own
    // is counted and never fails the delete (an unreadable directory must not wedge
    // `insta branch delete`).
    if (survivors.length) {
      console.warn(`not removing the data of branch "${b.name}": ${survivors.join(', ')} ${survivors.length === 1 ? 'is' : 'are'} still there or unaccounted for`)
    } else {
      for (const root of this.layout().branchRoots(ref)) {
        await count(t, () => this.data.remove(root), `remove the data directory ${root}`)
      }
    }
    // ONE rule, the same one the row follows: a teardown that did not finish keeps the row, the
    // scheduler's knowledge of it, and its claims. The retry re-runs the whole demolition and
    // releases all three together.
    //
    // Both of these used to run whatever happened. Forgetting a key whose container survived
    // drops that service's ledger entry and its in-flight hold counts, so the idle clock starts
    // again from the next stamp and a container that is still holding RAM is bookkept as if it
    // were new -- on a single-node box that is the resource the whole product is rationing.
    // Releasing the domains is sharper still: the branch row is kept and refuses provisioning,
    // so its hostnames must stay claimed rather than becoming available to something else while
    // the old container is still answering on them.
    //
    // THE DELTA, not the total. A cumulative `t.failed > 0` is right for `destroyBranch`, which
    // owns its counter, and wrong for `destroyProject`, which shares one across every branch:
    // a branch demolished COMPLETELY after an earlier branch failed would see the earlier
    // failure, return here, and keep its keys and domains -- while `destroyProject`, deciding
    // the row by the delta, saw no new failure and deleted the row. Keys and domain rows
    // orphaned permanently, because a retry only walks branch rows that still exist. Whatever
    // decides the row decides these, in the same scope, in both callers.
    if (t.failed !== failedBefore) return
    const ids = [...dbs.map((d) => d.id), ...managed.map((m) => m.id), ...Object.keys(b.apps).map((g) => `cp-${g}`)]
    this.scheduler.forget(ids.map((sid) => this.serviceKey(b, sid)))                                          // WP3
    this.releaseDomainsFor(project.id, b.id)                                                                  // WP2
    // ...and the branch's own secret rows, for the same reason and on the same gate. A user
    // secret is keyed by branch NAME (`{name, value, branch, service}`, which is what
    // `userSecretsFor`, `--branch` and `renameBranch` all read), and a create inherits its
    // source's rows BY NAME, so rows left behind by a delete are resurrected by the next branch
    // of that name -- including one forked from a parent that never held the value, where they
    // also SHADOW the project-wide secret of the same name. A branch deleted to retire a
    // compromised credential brought it back. `unwindBranch` has swept them since round nine;
    // the two deliberate teardowns owed the same sweep and did not do it.
    //
    // Only on a clean demolition, which is what the gate above means here: a kept
    // `cleanup-failed` row is a branch that still exists and whose retry still needs its
    // secrets. And the name is read INSIDE the mutate, not from the row this call captured,
    // because `renameBranch` takes no operation lock and carries the secret rows with it.
    mutate((st) => {
      const name = st.branches[b.id]?.name ?? b.name
      const list = st.userSecrets[project.id]
      if (list) st.userSecrets[project.id] = list.filter((u) => u.branch !== name)
    })
  }

  /** Delete one branch. Answers the cloud's teardown summary (decision 50): how many provider
   *  objects went and how many refused to, counted across containers, buckets and directories. */
  async destroyBranch(projectId: string, branchId: string): Promise<Teardown> {
    const project = this.getProject(projectId)
    const b = loadState().branches[branchId]
    if (!project || !b || b.projectId !== projectId) throw new Error('branch not found')
    if (b.isDefault) throw new Error('cannot delete the default branch')
    // Whole-branch keys: a delete cannot interleave with a create still building this branch, nor
    // with a deploy or a lifecycle op on one of its services.
    //
    // ...and the set is RE-DRIVEN over the union when the row grew, exactly as `createBranch`
    // and `destroyProject` do it. My earlier note here claimed the snapshot was sound because
    // every add takes `branchOp(b)`, and that reasoning is wrong: an add only HOLDS that key
    // while it provisions, so it can finish and release BEFORE this delete acquires it, leaving
    // its new service outside the snapshot the keys were built from. The delete then tears that
    // service down holding none of its keys, and a traffic wake can take the service key
    // independently and race `docker start` against the container removal, the network removal
    // and the data deletion.
    let keys = this.branchKeys(project, b)
    for (let round = 1; ; round++) {
      const settled = new Set(keys)
      const out = await this.withOp([...settled], async (): Promise<{ teardown: Teardown } | { union: ServiceKey[] }> => {
      // The row as it stands INSIDE the lock, not the snapshot the keys were built from: a
      // deploy or a create that was ahead of this in the queue has since written to it, and
      // tearing down the snapshot would miss whatever it added (`freshRemoval`'s rule, one level
      // up).
      const { project: live, branch: row } = this.freshRemoval(projectId, branchId, branchId, 'branch delete')
      const needed = this.branchKeys(live, row)
      if (!needed.every((k) => settled.has(k))) return { union: [...new Set([...settled, ...needed])] }
      const t = newTeardown()
      await this.teardownBranch(live, row, t)
      // The row goes only when the demolition all went. Dropping it over a container that is
      // still there, or over bytes that could not be removed, leaves resources holding ports,
      // RAM and disk with nothing naming them: invisible to `branch list`, to project delete and
      // to the operator, and never retried. `unwindBranch` has kept the row on that outcome
      // since round nine; a deliberate `branch delete` owes the same, and `insta branch delete`
      // run again retries exactly this demolition.
      if (t.failed === 0) {
        mutate((s) => {
          delete s.branches[branchId]
          // Prune any git push-to-deploy bindings on this branch: their compute target is gone, so
          // a lingering webhook must not resolve to a recreated branch/service with the same name.
          if (s.gitBindings) for (const [k, r] of Object.entries(s.gitBindings)) if (r.projectId === projectId && r.branchId === branchId) delete s.gitBindings[k]
        })
        this.emit(projectId, row.name, 'resource', 'branch.deleted', { teardown: t })
      } else {
        mutate((s) => { if (s.branches[branchId]) s.branches[branchId].status = CLEANUP_FAILED })
        this.emit(projectId, row.name, 'resource', 'branch.cleanupFailed', { teardown: t })
      }
      this.router.invalidate()
      return { teardown: t }
      })
      if ('teardown' in out) return out.teardown
      if (round >= CREATE_LOCK_ROUNDS) {
        throw new Error(`branch delete could not settle its lock set after ${CREATE_LOCK_ROUNDS} rounds: services are being added to "${b.name}" concurrently, retry the delete`)
      }
      keys = out.union
    }
  }

  async destroyProject(projectId: string): Promise<Teardown> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const branches = this.listBranches(projectId)
    // The PROJECT key plus every branch's keys, in one sorted acquisition (never one branch at a
    // time: that is the ordering a concurrent multi-branch operation can deadlock against). The
    // project key stops a branch coming into existence while this runs, since `createProject`
    // and `createBranch` both hold it.
    //
    // It does not, on its own, make the KEYS complete: a branch that committed its row between
    // this snapshot and the acquisition is in the re-read list but its `branchOp` and service
    // keys were never acquired, so a deploy, a lifecycle op or a traffic wake on that branch
    // could run straight through its teardown and leave a container behind. That is closed the
    // same way `createBranch` closes it: the needed set is recomputed under the lock and, if it
    // is not a subset of what was acquired, the whole acquisition is released and RE-DRIVEN over
    // the union before anything is torn down. One sorted acquisition per round, never a nested
    // one, and nothing has been destroyed when a round is abandoned.
    let keys = [this.projectOp(project), ...branches.flatMap((b) => this.branchKeys(project, b))]
    for (let round = 1; ; round++) {
      const settled = new Set(keys)
      const out = await this.withOp([...settled], async (): Promise<{ teardown: Teardown } | { union: ServiceKey[] }> => {
        // Re-read under the lock rather than trusting the pre-lock snapshot: the rows may have
        // moved (a rename, a create that finished just before we got in, a branch delete that
        // beat us to one), and what must not survive this call is every branch the state has NOW.
        const live = this.listBranches(projectId)
        const needed = [this.projectOp(project), ...live.flatMap((b) => this.branchKeys(project, b))]
        if (!needed.every((k) => settled.has(k))) return { union: [...new Set([...settled, ...needed])] }
        const t = newTeardown()
        let kept = false
        for (const b of live) {
          const mark = teardownMark(t)
          await this.teardownBranch(project, b, t)
          // Same rule as `destroyBranch`: a row goes only when its demolition all went, so a
          // container or a directory that refused is still named by something.
          const mine = teardownSince(t, mark)
          if (mine.failed === 0) mutate((s) => {
            delete s.branches[b.id]
            // Prune this branch's git bindings here, in the per-branch success path: on a mixed
            // teardown the project row is kept, so the final delete-branches prune never runs for
            // the branches that DID tear down cleanly.
            if (s.gitBindings) for (const [k, r] of Object.entries(s.gitBindings)) if (r.projectId === projectId && r.branchId === b.id) delete s.gitBindings[k]
          })
          else {
            kept = true
            mutate((s) => { if (s.branches[b.id]) s.branches[b.id].status = CLEANUP_FAILED })
            // The branch's OWN slice: the shared counter names every branch's failures, so this
            // event used to tell the operator that another branch's container is what refused.
            this.emit(projectId, b.name, 'resource', 'branch.cleanupFailed', { teardown: mine })
          }
        }
        // ...and the project row outlives a branch row that outlived its teardown, or the branch
        // would point at a project that is gone, which is the orphan this all exists to prevent.
        if (!kept) mutate((s) => {
          delete s.projects[projectId]
          if (s.gitBindings) for (const [k, r] of Object.entries(s.gitBindings)) if (r.projectId === projectId) delete s.gitBindings[k]
        })
        else mutate((s) => { if (s.projects[projectId]) s.projects[projectId].status = CLEANUP_FAILED })
        this.router.invalidate()
        return { teardown: t }
      })
      if ('teardown' in out) return out.teardown
      if (round >= CREATE_LOCK_ROUNDS) {
        throw new Error(`project delete could not settle its lock set after ${CREATE_LOCK_ROUNDS} rounds: branches are being created or changed concurrently, retry the delete`)
      }
      keys = out.union
    }
  }

  // ---- observability (docker + SQL backed; cloud response shapes) ----

  /** Resolve a branch (default branch unless named) or throw. */
  private branchOrThrow(projectId: string, branchName?: string): { project: Project; branch: Branch } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const branch = branchName ? this.getBranchByName(projectId, branchName) : this.listBranches(projectId).find((b) => b.isDefault)
    if (!branch) throw new Error(`branch "${branchName}" not found`)
    return { project, branch }
  }

  /** The containers an observability request targets, each with the service it is drawn as: the
   *  branch's postgres services, its compute group(s), or its managed databases of one type. Each
   *  managed type is its OWN component, never folded into 'compute' (cloud parity: names are unique
   *  per type, so `group` resolves inside a type, and the compute fan-out must not absorb database
   *  containers). */
  private observedTargets(project: Project, branch: Branch, component: ObservedComponent, group?: string): MetricsTarget[] {
    const ref = this.ref(project, branch)
    // Container names reuse project, branch and service NAMES, so a name's metrics history can predate
    // the resource now carrying it (delete a project and recreate it under the same name, rename a service
    // into a name a deleted one gave up, or remove a service from one branch while another keeps its
    // registration and add it back). `since` is the first whole second after the newest of those moments:
    // the project's and branch's creation, the service's creation or rename, and its addition to THIS
    // branch (the branch row's `addedAt`). Samples
    // are stamped in whole seconds, so one stamped in that second may predate the resource, and none
    // stamped at or after `since` can.
    const since = (...serviceTimes: Array<number | undefined>): number =>
      Math.floor(Math.max(project.createdAt, branch.createdAt, ...serviceTimes.map((t) => t ?? 0)) / 1000) + 1
    // 'db' fans out over the project's postgres services; `group` narrows it to one by NAME, the
    // same `?group=` the database routes take.
    if (component === 'db') {
      return this.dbList(project.id)
        .filter((d) => (!group || d.name === group) && this.carries(project, branch, d, 'postgres'))
        .map((d) => ({ container: this.pgContainer(project, branch, d.id), group: d.name, since: since(d.createdAt, d.renamedAt, branch.databases?.[d.id]?.addedAt) }))
    }
    if (component !== 'compute') {
      return this.managedList(project.id)
        .filter((m) => m.type === component && (!group || m.name === group) && branch.managed?.[m.id])
        .map((m) => ({ container: managedContainerName(ref, m.type, m.name), group: m.name, since: since(m.createdAt, m.renamedAt, branch.managed?.[m.id]?.addedAt) }))
    }
    const groups = group ? [group] : Object.keys(branch.apps).sort()
    return groups.filter((g) => branch.apps[g])
      .map((g) => {
        const settings = project.serviceSettings?.[`cp-${g}`]
        return { container: appContainerName(ref, g), group: g, since: since(settings?.createdAt, settings?.renamedAt, branch.apps[g]?.addedAt) }
      })
  }

  /** Runtime logs via `docker logs --tail` — same LogsResult shape as the cloud (which serves
   *  compute from Fly; here BOTH components are real containers, so db logs work too). */
  async runtimeLogs(projectId: string, opts: { component: ObservedComponent; branchName?: string; group?: string; limit?: number }): Promise<observe.LogsResult> {
    const { project, branch } = this.branchOrThrow(projectId, opts.branchName)
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
    const lines: observe.LogLine[] = []
    for (const { container: name } of this.observedTargets(project, branch, opts.component, opts.group)) {
      try {
        const raw = (await docker(['logs', '--tail', String(limit), '--timestamps', name], { mergeStderr: true })).toString()
        lines.push(...observe.parseDockerLogs(raw, name))
      } catch { /* container gone — skip rather than fail the whole read */ }
    }
    lines.sort((a, b) => a.ts.localeCompare(b.ts))
    return { source: 'docker-logs', lines: lines.slice(-limit) }
  }

  /** CPU, memory and network over a window, in the cloud's MetricsResult shape and series names, from
   *  the history the sampler keeps (metrics-sampler.ts). Before any of these containers has a sample —
   *  a daemon that just started — it answers one live `docker stats` reading rather than an empty
   *  chart. The window defaults to the cloud's: the last hour at 60 s. */
  async runtimeMetrics(projectId: string, opts: { component: ObservedComponent; branchName?: string; group?: string; window?: MetricsWindow }): Promise<observe.MetricsResult> {
    const { project, branch } = this.branchOrThrow(projectId, opts.branchName)
    const targets = this.observedTargets(project, branch, opts.component, opts.group)
    // Scoped to one service, say so: "nothing deployed on this branch" was wrong for an undeployed app whose branch
    // runs a database and a cache.
    if (!targets.length) {
      return { source: 'docker-stats', series: [], note: opts.group ? 'nothing deployed for this service' : 'nothing deployed on this branch' }
    }
    const now = Math.floor(Date.now() / 1000)
    const win = opts.window ?? { from: now - DEFAULT_WINDOW_SEC, to: now, step: DEFAULT_STEP_SEC }
    const containers = targets.map((t) => t.container)
    // A live reading is stamped now, so it answers only a window that contains now: a historical window
    // with no history is empty, not a point outside the range asked for.
    if (this.metricsHistory.sampled(targets) || now < win.from || now > win.to) {
      return { source: 'docker-stats', series: this.metricsHistory.query(targets, win.from, win.to, win.step) }
    }
    let raw = ''
    // Not running (asleep, stopped): no reading, which the dashboard draws as zero usage, like the cloud.
    try { raw = (await docker(['stats', '--no-stream', '--format', '{{json .}}', ...containers])).toString() }
    catch { return { source: 'docker-stats', series: [] } }
    return { source: 'docker-stats', series: liveSeries(statsToSamples(raw), targets, now) }
  }

  /** Control-plane operation log (cloud: Neon operations) — here, the resource-event timeline. */
  operations(projectId: string, limit = 20): { operations: observe.DbOperation[] } {
    if (!this.getProject(projectId)) throw new Error('project not found')
    const ops = this.listEvents(projectId)
      .filter((e) => e.source === 'resource')
      .slice(-Math.min(Math.max(limit, 1), 100))
      .reverse()
      .map((e) => ({ id: e.id, action: e.kind, status: 'finished', createdAt: e.createdAt }))
    return { operations: ops }
  }

  /** Point-in-time DB metrics — runs SQL against the branch database (same query as the cloud). */
  async dbMetricsSnapshot(projectId: string, branchName?: string, group?: string): Promise<observe.DbMetricsSnapshot> {
    const t = this.dbTarget(projectId, branchName, group)
    await this.assertPgAwake(t.branch, t.serviceId)                             // WP3: never wakes
    return observe.toDbMetrics(await this.db.query(t.container, observe.DB_METRICS_SQL))
  }

  /** Currently running queries (pg_stat_activity, ≤100). */
  async dbActivity(projectId: string, branchName?: string, group?: string): Promise<{ queries: observe.DbActivityRow[] }> {
    const t = this.dbTarget(projectId, branchName, group)
    await this.assertPgAwake(t.branch, t.serviceId)                             // WP3: never wakes
    return { queries: observe.toDbActivity(await this.db.query(t.container, observe.DB_ACTIVITY_SQL)) }
  }

  /** Top statements by execution time (pg_stat_statements; preloaded on newly-provisioned branch
   *  databases — older containers report extensionReady:false, exactly like the cloud's
   *  "enabled on demand" path when the extension can't load). */
  async dbQueryStats(projectId: string, branchName: string | undefined, opts: { limit?: number; sort?: observe.QueryStatSort; group?: string } = {}): Promise<observe.DbQueryStats> {
    const t = this.dbTarget(projectId, branchName, opts.group)
    await this.assertPgAwake(t.branch, t.serviceId)                             // WP3: never wakes
    const container = t.container
    try {
      await this.db.query(container, 'create extension if not exists pg_stat_statements')
      const rows = await this.db.query(container, observe.queryStatsSql(opts.limit ?? 20, opts.sort ?? 'total'))
      return { extensionReady: true, stats: observe.toQueryStats(rows) }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (observe.isExtensionUnavailable(m)) return { stats: [], extensionReady: false }
      throw e
    }
  }

  /** One ad-hoc SQL statement against a branch's Postgres, for the console's SQL editor and Data
   *  tab. Never wakes (the tab sits behind the dashboard's wake gate, decision 48). A SELECT-ish
   *  statement comes back as columns + rows through a json_agg wrap — psql's `-tAc` transport is
   *  text, so JSON is the one shape that survives it losslessly — and anything else runs as
   *  written, reporting psql's command tag. Bounded by DOCKER_MAX_OUTPUT_BYTES like every other
   *  docker read; callers should still LIMIT what they select. */
  async dbQuery(projectId: string, sql: string, branchName?: string, group?: string): Promise<
    { columns: string[]; rows: unknown[][]; rowCount: number; ms: number } | { status: string; ms: number }
  > {
    const t = this.dbTarget(projectId, branchName, group)
    await this.assertPgAwake(t.branch, t.serviceId)
    const started = Date.now()
    // EXACTLY-ONCE, whatever the classification says: the statement runs through ONE transport,
    // chosen up front, and no error ever re-runs it (an error-text fallback re-executed volatile
    // side effects). Classification reads the MASKED text (src/sqlsurface.ts), so a `;` or an
    // `update` inside a string literal never changes the route; SHOW/EXPLAIN are utility
    // statements a subquery cannot host and run as written; a WITH is row-shaped only when its
    // last statement keyword is SELECT (a data-modifying CTE runs as a command).
    const bare = stripLeadingSqlComments(sql)
    const masked = maskSqlText(bare)
    // The wrapper's inner text ends where the MASKED copy says the statement does: a terminal
    // `;` followed by a comment survived an end-anchored strip of the raw text and broke the
    // subquery (`from (select 1; -- done) t`).
    const inner = bare.slice(0, trailingTrimIndex(masked))
    // The contract is ONE statement per request (COMPATIBILITY): several used to run raw, which
    // both broke the documented shape and let a request chain sub-timeout statements past the
    // per-statement bound. Refused outright, with the `;` read from the MASKED text.
    if (!isSingleStatement(masked)) throw new Error('one statement per request: split the input and run each statement on its own')
    // A backslash outside literals is never SQL — it is a psql meta-command, and over the stdin
    // transport those EXECUTE (`\watch` re-runs past the statement timeout, `\!` shells into the
    // container). Refused before anything reaches psql.
    if (masked.includes('\\')) throw new Error('psql meta-commands are not supported: send SQL only')
    // Row-shaped: SELECT/VALUES/TABLE, a statement that IS a parenthesized query expression, and
    // a WITH whose top level either ends in SELECT or holds no top-level keyword at all (its
    // final query parenthesized — only a query expression can be; settled on live Postgres).
    const withKeyword = lastStatementKeyword(masked)
    const rowShaped = /^(select|values|table)\b/i.test(bare) || bare.startsWith('(')
      || (/^with\b/i.test(bare) && (withKeyword === 'select' || withKeyword === null))
    // `sqlOnly` re-checks at the transport (defence in depth): the meta-command guard above is the
    // friendly first line, the adapter's is the one no future caller can forget.
    const opts = { statementTimeoutMs: DB_QUERY_TIMEOUT_MS, sqlOnly: true }
    if (rowShaped) {
      // The values travel as TEXT (json_each_text), because row_to_json + JSON.parse silently
      // rounds bigint/numeric past 2^53. Column order and names come from the same single
      // execution (row_to_json's key order); zero rows answer empty columns. Bounded at
      // DB_QUERY_MAX_ROWS on the server side — the editor is a browser, not an exporter.
      // min() over the per-row column arrays, because array_agg builds text[][] whose single
      // subscript is a SCALAR (a coalesce type error that failed every statement); min over
      // arrays is btree-defined and every row carries the same array. Settled against a live
      // Postgres 16 (bigint/numeric text fidelity, zero-rows -> [], column order, nulls) and
      // pinned by test/db-query.int.test.ts.
      const wrapped = `select json_build_object('columns', coalesce(min(cols), array[]::text[]), 'rows', coalesce(json_agg(vals), '[]'::json))
from (select array(select json_object_keys(row_to_json(t))) as cols,
             (select json_agg(v.value) from json_each_text(row_to_json(t)) v) as vals
      from (${inner}) t limit ${DB_QUERY_MAX_ROWS}) s`
      const out = await this.db.query(t.container, wrapped, opts)
      const parsed = JSON.parse(out || '{}') as { columns?: string[]; rows?: Array<Array<string | null>> }
      const columns = parsed.columns ?? []
      const rows = parsed.rows ?? []
      this.emitLater(projectId, t.branch.name, 'resource', 'db.query', { service: t.serviceId, mode: 'rows' })
      return { columns, rows, rowCount: rows.length, ms: Date.now() - started }
    }
    const out = await this.db.query(t.container, sql, opts)
    // The audit row carries what ran and where — never the SQL text (README: governed actions
    // land in `insta events`; the statement itself may hold data or credentials).
    this.emitLater(projectId, t.branch.name, 'resource', 'db.query', { service: t.serviceId, mode: 'command' })
    return { status: out || 'OK', ms: Date.now() - started }
  }

  /** Manifest view: project + branches + per-branch resources (db / compute groups). */
  detail(projectId: string): { project: Record<string, unknown>; branches: Record<string, unknown>[]; resources: Record<string, unknown>[] } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const branches = this.listBranches(projectId)
    // One row per service a branch actually carries (managed already did this): a registration
    // another branch materialised reported here as `ready` with an undefined url or bucket.
    const resources = branches.flatMap((b) => [
      ...this.dbList(projectId).filter((d) => this.carries(project, b, d, 'postgres')).map((d) => ({
        kind: 'postgres', name: d.name as string | null, branchId: b.id,
        ref: { url: this.dbHandle(project, b, d.id)?.url }, status: 'ready',
      })),
      ...this.stList(projectId).filter((x) => this.carries(project, b, x, 'storage')).map((x) => ({
        kind: 'storage', name: x.name as string | null, branchId: b.id,
        ref: { bucket: this.bucketHandle(project, b, x.id)?.bucket }, status: 'ready',
      })),
      ...this.managedList(projectId).filter((m) => b.managed?.[m.id]).map((m) => ({
        kind: m.type as string, name: m.name as string | null, branchId: b.id,
        ref: { host: managedContainerName(this.ref(project, b), m.type, m.name), port: MANAGED_DB[m.type].port }, status: 'ready',
      })),
      ...Object.entries(b.apps).map(([group, app]) => (
        { kind: 'compute', name: group, branchId: b.id, ref: { url: app.url, image: app.image }, status: 'ready' }
      )),
    ])
    return {
      project: { id: project.id, name: project.name, status: project.status, org_id: 'local' },
      // Same branch shape the /branches route answers with, `created_at` included: the dashboard's
      // Environments table reads its Created column from HERE (one call for branches and what each
      // carries), and without the timestamp every row rendered an em dash.
      branches: branches.map((b) => ({
        id: b.id, name: b.name, is_default: b.isDefault, status: b.status,
        ...(b.createdAt ? { created_at: new Date(b.createdAt).toISOString() } : {}),
      })),
      resources,
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Package regions (contract 00 sections 1.3 and 7.1). Every `filled by WPn` hook below is an
  // identity / no-op that returns TODAY's value; the owning package replaces the body inside its
  // own region and never edits the callers above (the 7.2 edit points already go through them).
  // ---------------------------------------------------------------------------------------------

  // ---- region WP1 (identity/config) ----
  // ---- end region WP1 ----

  // ---- region WP2 (router) ----
  /** The FQDN a service answers on: the bounded label (decision 55) plus the run mode's domain. Minted
   *  when the service is created and recorded on the row (`apps[g].host`, `databases[id].host`,
   *  `managed[id].host`); every later READ takes the row's value, so a config change never moves a
   *  live hostname. A rename is the one write that re-mints it — the name is in the label — and each
   *  rename records the new value on the row in the same mutate that moves the row. */
  hostFor(kind: HostKind, name: string, ref: string): string { return fqdnFor(kind, name, ref, this.cfg.domain) }
  /** The bare label only: what `assertHostFree` compares and what the 63-char bound applies to. */
  labelFor(kind: HostKind, name: string, ref: string): string { return labelFor(kind, name, ref) }
  /** Operator-supplied custom-domain hostnames only (400); minted labels are bounded, never rejected. */
  assertHostLabel(hostname: string): void { assertHostLabel(hostname) }

  /** Lane ports a bind probe refused. The router reports them here when a listener could not open, so
   *  the next allocation skips the port instead of handing it out again. `allocLanes` runs inside one
   *  synchronous `mutate` (decision 51) and a bind probe cannot be synchronous, hence this ledger
   *  rather than a probe at allocation time. */
  private readonly laneBusy = new Set<number>()
  markLaneBusy(port: number): void { this.laneBusy.add(port) }

  /** Which of a branch's services need a host listen port: local mode every database (postgres and
   *  managed), server mode MySQL only (redis and mongo share the SNI lanes, decision 38). */
  private laneServiceIds(project: Project, serviceIds: string[]): string[] {
    const managed = new Map(this.managedList(project.id).map((m) => [m.id, m.type]))
    return serviceIds.filter((id) => {
      const type = managed.get(id)
      if (this.cfg.mode === 'local') return id.startsWith('pg-') || type !== undefined
      return type === 'mysql'
    })
  }

  private nextLanePort(taken: Set<number>): number {
    const [lo, hi] = this.cfg.lanes.portRange
    for (let p = lo; p <= hi; p++) if (!taken.has(p) && !this.laneBusy.has(p)) return p
    throw new Error(`no free lane port left in ${lo}-${hi} (INSTA_OSS_LANE_PORT_RANGE)`)
  }

  /** Every loopback port this daemon has already published or reserved: database lanes, lane
   *  reservations, and the host ports local mode published for compute services. It is ONE port
   *  space, so a lane can never be handed the port an app already publishes and vice versa. */
  private takenLanePorts(s: State, skip?: { branchId: string; group: string }): Set<number> {
    const taken = new Set<number>()
    for (const b of Object.values(s.branches)) for (const p of Object.values(b.lanes ?? {})) taken.add(p)
    for (const p of Object.keys(s.laneReservations ?? {})) taken.add(Number(p))
    for (const [bid, b] of Object.entries(s.branches)) {
      for (const [group, app] of Object.entries(b.apps ?? {})) {
        if (skip && bid === skip.branchId && group === skip.group) continue
        if (app.hostPort) taken.add(app.hostPort)
      }
    }
    return taken
  }

  /** The lowest free port in the configured range (contract 7.1). Used by the router when something
   *  else already holds a service's lane port. */
  allocLanePort(): number { return this.nextLanePort(this.takenLanePorts(loadState())) }
  /** The host listen port of one database service on one branch. `provisionBranch` reserves the lanes
   *  a branch needs at create time; a service ADDED later (a redis on an existing branch) has none, so
   *  the first read allocates one and records it, which is also what makes the router open its
   *  listener on the next invalidate. Idempotent and once per service. */
  private laneFor(branch: Branch, serviceId: string, fallback: number): number {
    const known = branch.lanes?.[serviceId]
    if (known !== undefined) return known
    if (!this.laneNeeded(branch, serviceId)) return fallback
    const port = this.allocLanePort()
    mutate((s) => {
      const row = s.branches[branch.id]
      if (!row) return
      row.lanes = { ...(row.lanes ?? {}), [serviceId]: port }
      delete s.laneReservations?.[String(port)]
    })
    branch.lanes = { ...(branch.lanes ?? {}), [serviceId]: port }
    this.router.invalidate()
    return port
  }

  /** Local mode gives every database service a port; server mode only MySQL (decision 38). */
  private laneNeeded(branch: Branch, serviceId: string): boolean {
    if (!branch.id || !loadState().branches[branch.id]) return false
    if (this.cfg.mode === 'local') return true
    return serviceId.startsWith(MANAGED_DB.mysql.idPrefix + '-')
  }

  /** Reserve every lane port a new branch needs in ONE synchronous mutate before provisioning awaits,
   *  so two concurrent `branch create` calls on two projects can never share a port (decision 51). */
  allocLanes(project: Project, branchId: string, serviceIds: string[]): Record<string, number> {
    const ids = this.laneServiceIds(project, serviceIds)
    if (!ids.length) return {}
    return mutate((s) => {
      const taken = this.takenLanePorts(s)
      const out: Record<string, number> = {}
      s.laneReservations = s.laneReservations ?? {}
      for (const id of ids) {
        const port = this.nextLanePort(taken)
        taken.add(port)
        out[id] = port
        s.laneReservations[String(port)] = branchId
      }
      return out
    })
  }

  /** Compensation path: drop the reservations a failed provision took. On success the branch row's
   *  `lanes` supersedes them and `provisionBranch` clears them in the same mutate that writes the row. */
  releaseLanes(branchId: string): void {
    mutate((s) => {
      for (const [port, owner] of Object.entries(s.laneReservations ?? {})) {
        if (owner === branchId) delete s.laneReservations![port]
      }
    })
  }

  /** 409 when a label is reserved or already minted. Runs inside the reservation mutate, under the
   *  engine-wide provision chain, so check-then-act cannot interleave (decision 51).
   *
   *  Every kind shares ONE label space (compute `<group>-<ref>`, postgres `pg-<name>-<ref>`, managed
   *  `<type>-<name>-<ref>`), so a compute group called `pg-db` collides with the postgres service
   *  `db` and a group called `redis-cache` with the redis service `cache`. `buildTable` keeps the
   *  first route on a duplicate, which would silently shadow the database while its credentials
   *  still advertise that hostname — hence a refusal here rather than a warning later.
   *
   *  `own` is the operation re-checking a label it already holds (a redeploy of a group whose row
   *  predates recorded hostnames): its own route and its own reservation are not a conflict. */
  assertHostFree(label: string, own?: string): void {
    const host = `${label}.${this.cfg.domain}`
    if (RESERVED_LABELS.has(label)) throw new Error(`hostname ${host} is reserved by the daemon`)
    const s = loadState()
    const holder = s.hostReservations?.[label]
    if (holder !== undefined && holder !== own) {
      throw new Error(`hostname ${host} is already being created by ${holder}`)
    }
    const table = buildTable(s, this.cfg, () => { /* quiet: this is a check, not a rebuild */ })
    if (!table.hosts().has(host)) return
    // Name the conflict: the operator's next question is always "taken by what?".
    const owner = table.routes().find((r) => r.host === host || r.aliases.includes(host))
    if (own !== undefined && owner?.key === own) return
    const by = owner?.serviceId ?? owner?.key
    throw new Error(`hostname ${host} already exists on this daemon${by !== undefined ? ` (${by})` : ''}`)
  }

  /** Check and reserve every label an operation is about to mint, in ONE synchronous mutate before
   *  its first await (decision 51), so two concurrent requests cannot both pass the check. The
   *  reservation is released by the operation's compensation path and superseded by the row that
   *  records the hostname, exactly as `laneReservations` is by `branch.lanes`. */
  private reserveHosts(labels: string[], owner: string): void {
    if (!labels.length) return
    mutate((s) => {
      const seen = new Set<string>()
      for (const label of labels) {
        // Two branches of one project never share a ref, so a repeat inside one request is a
        // request that would mint the same hostname twice.
        if (seen.has(label)) throw new Error(`hostname ${label}.${this.cfg.domain} would be minted twice by this request`)
        this.assertHostFree(label, owner)
        seen.add(label)
      }
      s.hostReservations = s.hostReservations ?? {}
      for (const label of labels) s.hostReservations[label] = owner
    })
  }

  /** Claim a branch NAME and the `ref` every one of its resources is named after, in ONE synchronous
   *  mutate before `provisionBranch`'s first await (decision 51).
   *
   *  `createBranch`'s duplicate-name check was check-then-act across the operation and provision
   *  locks: two calls for the same name both passed it, and the loser then built the same ref a
   *  second time — same network, same container names, same buckets, same data directories — while
   *  its compensation removed the branch root the winner had just filled. The reservation makes the
   *  ref an EXCLUSIVE claim held for the whole provision: the loser refuses before it creates
   *  anything, and the compensation path can prove the resources it is about to remove are its own.
   *
   *  The ref is checked as well as the name because it is what the resources are named after: two
   *  different names that slug to one ref would collide on every container.
   *
   *  The NAME is unique per project; the REF is unique per DAEMON. `ref` is
   *  `<projectSlug>-<branchSlug>` and a hyphen occurs inside both halves, so it is not injective
   *  across projects: `demo-a` / `main` and `demo` / `a-main` both spell `demo-a-main`. Nothing
   *  downstream re-separates them — `branchRoots(ref)` keys the data directories on the ref alone,
   *  and the network and container names carry no project either — so the second create silently
   *  adopts the first's storage, and a later `branch delete` (or `project delete`) removes the
   *  OTHER project's postgres bytes, volumes and managed data while its branch row goes on
   *  advertising `ready` with credentials for a directory that is gone. Each row is resolved
   *  against ITS OWN project, so both creation orders report the collision and refuse. Renaming
   *  the ref to an unambiguous separator would fix it too, and was rejected: it renames every
   *  container and every directory on an existing install. */
  private reserveBranchRef(project: Project, name: string, ref: string, branchId: string): void {
    mutate((s) => {
      for (const b of Object.values(s.branches)) {
        if (b.projectId === project.id && b.name === name) throw new Error(`branch "${name}" already exists`)
        const owner = s.projects[b.projectId]
        const bRef = b.ref ?? (owner ? this.ref(owner, b.name) : undefined)
        if (bRef === ref) {
          throw new Error(`branch "${name}" already exists as "${b.name}" in project "${owner?.name ?? b.projectId}" (both name the resources ${ref})`)
        }
      }
      const holder = s.branchReservations?.[ref]
      if (holder !== undefined && holder !== branchId) throw new Error(`branch "${name}" already exists (a create for it is in flight)`)
      s.branchReservations = s.branchReservations ?? {}
      s.branchReservations[ref] = branchId
    })
  }

  /** Whether THIS operation still holds the ref: what the compensation path asks before it removes
   *  a branch-root directory or a network, neither of which carries an owner of its own. */
  private ownsBranchRef(ref: string, branchId: string): boolean {
    return loadState().branchReservations?.[ref] === branchId
  }

  /** Compensation path: drop the branch reservation a failed provision took. On success the branch
   *  row supersedes it and `provisionBranch` clears it in the same mutate that writes the row. */
  private releaseBranchRef(ref: string, branchId: string): void {
    mutate((s) => { if (s.branchReservations?.[ref] === branchId) delete s.branchReservations[ref] })
  }

  /** Compensation path: drop the host reservations a failed operation took. */
  private releaseHosts(owner: string): void {
    const held = Object.entries(loadState().hostReservations ?? {}).filter(([, o]) => o === owner)
    if (!held.length) return
    mutate((s) => { for (const [label] of held) delete s.hostReservations?.[label] })
  }

  /** Where a client dials one database service. Server mode: the minted hostname on the shared lane
   *  with TLS (SNI routes it); MySQL keeps a plaintext per-service port. Local mode: loopback plus the
   *  branch's lane port. */
  laneAddress(project: Project, branch: Branch, serviceId: string): { host: string; port: number; tls: boolean } {
    const ref = this.ref(project, branch)
    const server = this.cfg.mode === 'server'
    if (serviceId.startsWith('pg-')) {
      const host = branch.databases?.[serviceId]?.host ?? this.hostFor('postgres', serviceId.slice(3), ref)
      return server ? { host, port: this.cfg.lanes.pgPort, tls: true } : { host: '127.0.0.1', port: this.laneFor(branch, serviceId, 5432), tls: false }
    }
    const m = this.managedList(project.id).find((x) => x.id === serviceId)
    if (m) {
      const host = branch.managed?.[serviceId]?.host ?? this.hostFor(m.type, m.name, ref)
      if (!server) return { host: '127.0.0.1', port: this.laneFor(branch, serviceId, MANAGED_DB[m.type].port), tls: false }
      if (m.type === 'redis') return { host, port: this.cfg.lanes.redisPort, tls: true }
      if (m.type === 'mongodb') return { host, port: this.cfg.lanes.mongoPort, tls: true }
      return { host, port: this.laneFor(branch, serviceId, MANAGED_DB.mysql.port), tls: false }
    }
    const group = serviceId.replace(/^cp-/, '')
    const host = branch.apps[group]?.host ?? this.hostFor('compute', group, ref)
    return server ? { host, port: 443, tls: true } : { host, port: this.cfg.port, tls: false }
  }

  /** The app's URL, deterministic before the container exists (the deploy records it on the row). */
  serviceUrl(project: Project, branch: Branch, group: string): string {
    const host = branch.apps[group]?.host ?? this.hostFor('compute', group, this.ref(project, branch))
    return this.cfg.mode === 'server' ? `https://${host}` : `http://${host}:${this.cfg.port}`
  }

  /** The bare hostname `deployLocked` records on `apps[g].host`: minted once, then read back. */
  mintedHost(project: Project, branch: Branch, group: string): string | undefined {
    return branch.apps[group]?.host ?? this.hostFor('compute', group, this.ref(project, branch))
  }

  /** Local mode: a container cannot reach the host's loopback by that name, so every 127.0.0.1 in a
   *  URL-shaped or `*_HOST` value becomes `host.docker.internal` (pinned to host-gateway by the deploy
   *  aliases). Server mode: the same string works on the host and inside a container. */
  containerize(env: Record<string, string>): Record<string, string> {
    if (this.cfg.mode === 'server') return env
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) {
      const urlish = /^[a-z][a-z0-9+.-]*:\/\//i.test(v)
      out[k] = urlish || k.endsWith('_HOST') ? v.replace(/127\.0\.0\.1/g, 'host.docker.internal') : v
    }
    return out
  }

  /** Every name a container on this branch must resolve to the box itself (decision 5): the branch's
   *  minted hostnames, the daemon and object-store names its env points at, its bucket vhosts, its
   *  custom domains, and `host.docker.internal`. Public DNS cannot be trusted to send these to the box
   *  (sslip.io, NAT, private addresses), so each becomes `--add-host <name>:host-gateway`. */
  hostAliasesFor(project: Project, branch: Branch, pendingGroup?: string): string[] {
    const ref = this.ref(project, branch)
    const out = new Set<string>()
    for (const [g, app] of Object.entries(branch.apps ?? {})) out.add(app.host ?? this.hostFor('compute', g, ref))
    // The group being deployed RIGHT NOW: `deployLocked` writes `apps[g].host` only after the
    // container exists, so on a first deploy the new group is not in `branch.apps` yet and the
    // container would be the one name it cannot resolve — it could not reach its own router URL.
    if (pendingGroup !== undefined) out.add(branch.apps?.[pendingGroup]?.host ?? this.hostFor('compute', pendingGroup, ref))
    for (const [id, db] of Object.entries(databasesOf(branch, ref))) out.add(db.host ?? this.hostFor('postgres', id.replace(/^pg-/, ''), ref))
    for (const m of this.managedList(project.id)) {
      const row = branch.managed?.[m.id]
      if (row) out.add(row.host ?? this.hostFor(m.type, m.name, ref))
    }
    if (this.cfg.mode === 'server') {
      out.add(`api.${this.cfg.domain}`)
      out.add(`s3.${this.cfg.domain}`)
      for (const bucket of bucketsOf(branch)) out.add(`${bucket}.s3.${this.cfg.domain}`)
      for (const cd of Object.values(loadState().customDomains ?? {})) if (cd.branchId === branch.id) out.add(cd.hostname)
    }
    out.add('host.docker.internal')
    return [...out]
  }

  /** Local mode publishes the app on a loopback host port (macOS cannot route to container IPs);
   *  server mode publishes nothing and the router dials the container. A redeploy keeps the port the
   *  row already has; a legacy row without `host` still carries it in its `http://localhost:<port>` url. */
  localHostPort(branch: Branch, group: string, opts: { hostPort?: number; port: number }): number | undefined {
    if (this.cfg.mode === 'server') return undefined
    const prior = branch.apps[group]
    const fromLegacyUrl = prior && !prior.host && prior.url ? Number(new URL(prior.url).port) || undefined : undefined
    // A port the caller named and the port the row already holds are honoured as they are: a
    // redeploy has to keep the port it published, and a caller who asked for one gets docker's own
    // error if it is busy. The DEFAULT is never the container's own port: it is the same number for
    // every instance (two apps on 3000, a second deploy of one template), it squats a well known
    // host port the box may already be using, and a privileged one (an image serving 80) cannot be
    // published at all where docker runs inside a VM. It comes out of the lane range instead, which
    // is one loopback port space with the database lanes.
    const pinned = opts.hostPort ?? prior?.hostPort ?? fromLegacyUrl
    if (pinned !== undefined) return pinned
    // RESERVE it in the same mutate that picks it. The pick is not written onto the app row until
    // the container is up, and in between `deployLocked` builds the container's env, which reads
    // DATABASE_URL, which allocates the database lane out of THIS port range. Unreserved, both
    // allocators answered the lowest free port and `docker start` failed with "address already in
    // use" on the first deploy of any project whose DSN had not been read yet.
    return mutate((s) => {
      const port = this.nextLanePort(this.takenLanePorts(s, { branchId: branch.id, group }))
      s.laneReservations = s.laneReservations ?? {}
      s.laneReservations[String(port)] = branch.id
      return port
    })
  }

  /** Drop the reservation `localHostPort` took, for a deploy that never reached the row write. */
  private releaseHostPort(port: number | undefined): void {
    if (port === undefined) return
    mutate((s) => { delete s.laneReservations?.[String(port)] })
  }

  /** The services() row's network columns: `domain` is the bare hostname, `endpoint` is `host[:port]`
   *  (a script may read it, so it stays a host and port, never a URL; decision 40). */
  rowNetwork(project: Project, branch: Branch | undefined, row: { id: string; type: string; name: string }): { domain?: string; endpoint?: string } {
    if (!branch) return {}
    const ref = this.ref(project, branch)
    if (row.type === 'compute') {
      const app = branch.apps[row.name]
      if (!app) return {}
      const host = app.host ?? this.hostFor('compute', row.name, ref)
      return { domain: host, endpoint: this.cfg.mode === 'server' ? host : `${host}:${this.cfg.port}` }
    }
    if (row.type === 'postgres' || isManagedDbType(row.type)) {
      const minted = row.type === 'postgres'
        ? (branch.databases?.[row.id]?.host ?? this.hostFor('postgres', row.name, ref))
        : (branch.managed?.[row.id]?.host ?? this.hostFor(row.type as ManagedDbType, row.name, ref))
      const lane = this.laneAddress(project, branch, row.id)
      return { domain: minted, endpoint: `${lane.host}:${lane.port}` }
    }
    if (row.type === 'storage') {
      const bucket = this.bucketOf(project, branch, row.id)
      if (this.cfg.mode === 'server') return { domain: `${bucket}.s3.${this.cfg.domain}`, endpoint: `s3.${this.cfg.domain}/${bucket}` }
      return { endpoint: `${this.s3Host(project, branch, row.id) ?? 'storage'}/${bucket}` }
    }
    return {}
  }

  // ---- custom domains (the four hidden cloud routes, decision 25) ------------------------------

  /** The compute group a domain call means: the body's, or the branch's sole group. */
  private domainTarget(projectId: string, opts: { branch?: string; group?: string }): { project: Project; branch: Branch; group: string } {
    const project = this.getProject(projectId)
    if (!project) throw new DomainError(404, 'project not found')
    const branch = opts.branch ? this.getBranchByName(projectId, opts.branch) : this.listBranches(projectId).find((b) => b.isDefault)
    if (!branch) throw new DomainError(404, `branch not found: ${opts.branch ?? 'default'}`)
    const groups = Object.keys(branch.apps ?? {})
    const group = opts.group ?? (groups.length === 1 ? groups[0] : undefined)
    if (!group) throw new DomainError(400, groups.length ? `group required: ${groups.join(', ')}` : 'group required')
    return { project, branch, group }
  }

  /** Whether this hostname has a certificate. Local mode terminates no TLS, so there is nothing
   *  to have and `true` is an answer rather than a guess. Server mode with no certificate
   *  directory configured is a different thing: we cannot LOOK, and "cannot look" reported as
   *  "there is one" made `domainResult` answer `configured: true` / `ready` for a name that may
   *  serve nothing. An unreadable directory already answers false through `findCertFiles`, which
   *  is the safe direction for this question. */
  private domainCertOk(hostname: string): boolean {
    if (this.cfg.mode !== 'server') return true
    // `--tls custom`: there is no store to walk, because nothing is issued. The question is
    // whether the operator's certificate covers this name, and the certificate answers it -- so
    // a custom domain inside their wildcard reads `ready` and one outside it reads `pending`,
    // which is the truth in a mode where no certificate will appear for it on its own.
    // The PAIR: with only one half configured the router serves no supplied certificate and
    // issues per hostname, so this must not answer from a file nothing is serving.
    const supplied = suppliedFiles(this.cfg)
    if (supplied) {
      try { return new X509Certificate(readFileSync(supplied.crt)).checkHost(hostname) !== undefined } catch { return false }
    }
    if (!this.cfg.tls.certDir) return false
    return findCertFiles(this.cfg.tls.certDir, hostname) !== null
  }

  private async domainEnvelope(project: Project, branch: Branch, group: string, hostname: string, ours?: Set<string>): Promise<ComputeDomainResult> {
    const dns = await checkDns(hostname, this.cfg, this.resolver, ours)
    return domainResult({
      hostname, flyApp: appContainerName(this.ref(project, branch), group), service: group,
      dns, certOk: this.domainCertOk(hostname),
    })
  }

  /** Attach a hostname to one compute group on one branch (idempotent on the same target). */
  async setComputeDomain(projectId: string, opts: { hostname?: unknown; branch?: string; group?: string }): Promise<ComputeDomainResult> {
    const { project, branch, group } = this.domainTarget(projectId, opts)
    const hostname = normalizeHostname(opts.hostname, this.cfg)
    if (!branch.apps?.[group]) throw new DomainError(404, `no compute deployed for group ${group} on branch ${branch.name}`)
    const existing = loadState().customDomains?.[hostname]
    if (existing && (existing.branchId !== branch.id || existing.group !== group)) {
      throw new DomainError(409, `${hostname} is already attached to ${existing.group}; remove it there first`)
    }
    if (!existing) {
      mutate((s) => {
        s.customDomains = s.customDomains ?? {}
        s.customDomains[hostname] = { hostname, projectId, branchId: branch.id, group, createdAt: Date.now() }
      })
      this.router.invalidate()
      this.emit(projectId, branch.name, 'resource', 'compute.domain.set', { hostname, group })
    }
    return await this.domainEnvelope(project, branch, group, hostname)
  }

  /** The check-domain answer, bound or not. */
  async computeDomainStatus(projectId: string, opts: { hostname?: unknown; branch?: string; group?: string }): Promise<ComputeDomainResult> {
    const project = this.getProject(projectId)
    if (!project) throw new DomainError(404, 'project not found')
    const hostname = normalizeHostname(opts.hostname, this.cfg)
    const entry = loadState().customDomains?.[hostname]
    if (!entry || entry.projectId !== projectId) {
      const { branch, group } = this.domainTarget(projectId, opts)
      return notAdded(hostname, appContainerName(this.ref(project, branch), group), group)
    }
    const branch = loadState().branches[entry.branchId]
    if (!branch) return notAdded(hostname, '', entry.group)
    return await this.domainEnvelope(project, branch, entry.group, hostname)
  }

  /** Every domain of a project, optionally narrowed to one branch or group. */
  async listComputeDomains(projectId: string, opts: { branch?: string; group?: string } = {}): Promise<ComputeDomainResult[]> {
    const project = this.getProject(projectId)
    if (!project) throw new DomainError(404, 'project not found')
    const s = loadState()
    const branchId = opts.branch ? this.getBranchByName(projectId, opts.branch)?.id : undefined
    const rows = Object.values(s.customDomains ?? {}).filter((cd) =>
      cd.projectId === projectId && (!branchId || cd.branchId === branchId) && (!opts.group || cd.group === opts.group))
    // The target address lookup is identical for every row, so it happens ONCE here, and the
    // per-row checks run with a ceiling on how many are in flight: nothing caps the number of
    // domains a project may attach, and a `Promise.all` over the list turned a single listing
    // into as many simultaneous resolver operations as there are rows.
    const ours = await ourAddresses(this.cfg, this.resolver)
    return await mapLimit(rows, DOMAIN_CHECK_CONCURRENCY, async (cd) => {
      const branch = s.branches[cd.branchId]
      if (!branch) return notAdded(cd.hostname, '', cd.group)
      return await this.domainEnvelope(project, branch, cd.group, cd.hostname, ours)
    })
  }

  /** Detach a hostname. 404 when it was never attached to this project. */
  removeComputeDomain(projectId: string, opts: { hostname?: unknown }): { hostname: string; flyApp: string; service: string; region: string } {
    const project = this.getProject(projectId)
    if (!project) throw new DomainError(404, 'project not found')
    const hostname = normalizeHostname(opts.hostname, this.cfg)
    const entry = loadState().customDomains?.[hostname]
    if (!entry || entry.projectId !== projectId) throw new DomainError(404, `domain not found: ${hostname}`)
    const branch = loadState().branches[entry.branchId]
    mutate((s) => { delete s.customDomains?.[hostname] })
    this.router.invalidate()
    this.emit(projectId, branch?.name ?? null, 'resource', 'compute.domain.remove', { hostname, group: entry.group })
    return {
      hostname,
      flyApp: branch ? appContainerName(this.ref(project, branch), entry.group) : '',
      service: entry.group,
      region: 'local',
    }
  }

  /** Called from teardown paths so a deleted branch, project or compute group takes its domains with
   *  it; a rename moves them to the new group. */
  releaseDomainsFor(projectId: string, branchId?: string, group?: string, moveTo?: string): void {
    let changed = false
    mutate((s) => {
      for (const [h, cd] of Object.entries(s.customDomains ?? {})) {
        if (cd.projectId !== projectId) continue
        if (branchId && cd.branchId !== branchId) continue
        if (group && cd.group !== group) continue
        changed = true
        if (moveTo) s.customDomains[h] = { ...cd, group: moveTo }
        else delete s.customDomains[h]
      }
    })
    if (changed) this.router.invalidate()
  }

  /** The ask endpoint's answer: every hostname this daemon serves (service names, api/console, the
   *  object store and its existing bucket vhosts, attached custom domains). */
  ownsHostname(host: string): boolean {
    const h = hostOnly(host)
    if (!h) return false
    return buildTable(loadState(), this.cfg, () => { /* quiet */ }).hosts().has(h)
  }
  // ---- end region WP2 ----

  // ---- region WP3 (scheduler) ----
  /** The ONE address cache (decision 57): `main.ts` hands the same instance to the router, and the
   *  scheduler's `forget` after a sleep or a wake is what keeps the router from dialling a
   *  container that has gone away. */
  readonly upstream: UpstreamLike
  /** The scheduler: sleep, wake, eviction, and THE per-key operation lock. Unstarted here. */
  readonly scheduler: Scheduler
  /** `${branchId}:${serviceId}`, contract section 4 ServiceKey. */
  serviceKey(branch: Branch, serviceId: string): ServiceKey { return `${branch.id}:${serviceId}` }

  /** THE per-key operation lock (decision 52). Every container-mutating path goes through it:
   *  deploy, restart, lifecycle, branch create, teardown, service add/remove/rename, volume ops,
   *  limits, and the scheduler's own wake. Re-entrant inside the acquiring async context, so a
   *  nested `wake` (lifecycle start, a fork waking its source) takes no second acquisition. */
  withOp<T>(keys: ServiceKey[], fn: () => Promise<T>): Promise<T> { return this.scheduler.withOp(keys, fn) }

  /** The same lock, one level up: a key that names the BRANCH instead of one of its services.
   *
   *  A branch create COMMITS its row before the volume forks, the bucket copies, the compute
   *  deploys and the inherited secrets have run, and from that moment every request resolves the
   *  branch by name. Another deploy to it, or a delete of it, could land in that window, and if a
   *  later step of the create then failed, `unwindBranch` tore down whatever was there BY THEN --
   *  including the concurrent operation's own containers. Holding this key across the post-commit
   *  steps and the compensation closes the window: the create owns the branch until it is whole
   *  or gone.
   *
   *  It is the existing `withOp` and nothing else (decision 52), so re-entrancy, sorted
   *  acquisition and release-on-every-path all come for free: an operation takes this key IN THE
   *  SAME acquisition as its service keys, and a nested step of the create re-enters both without
   *  a second acquisition. `*branch` cannot collide with a service id (`cp-`, `pg-`, `st-`,
   *  `rd-`, `my-`, `mo-`) and names no `ServiceTarget`, so the sweep never sees it. */
  branchOp(branch: Branch | string): ServiceKey { return `${typeof branch === 'string' ? branch : branch.id}:*branch` }

  /** The same lock, one level up again: a key that names the PROJECT.
   *
   *  `branchOp` makes a branch private while it is being built, but a branch that does not exist
   *  yet has no key anyone can hold. A project delete lists the branches it will demolish, and a
   *  create that has not committed its row is not in that list; the delete then takes the keys of
   *  the branches it saw, queues behind the create on the SOURCE branch's keys, and afterwards
   *  removes the project while the clone's containers, buckets, network and bytes stay behind
   *  with a row pointing at a project that is gone. Nothing will ever come back for them.
   *
   *  So every operation that can bring a branch into existence (`createProject` for the default
   *  branch, `createBranch` for a clone) holds this key, and `destroyProject` holds it too: the
   *  two cannot overlap at all, and the delete's list is therefore complete.
   *
   *  Deadlock freedom is the same argument as `branchOp` and rests on the same two rules. Each of
   *  the three operations takes this key IN THE SAME sorted acquisition as its branch and service
   *  keys, never one after another, and nothing takes it while already holding a key (the nested
   *  `deploy`, `wake` and `sleep` of a create re-enter keys the create already owns). `*project`
   *  cannot collide with a service id or with `*branch`, and names no `ServiceTarget`, so the
   *  sweep never sees it. */
  projectOp(project: Project | string): ServiceKey { return `${typeof project === 'string' ? project : project.id}:*project` }

  /** The branch key a service ADD resolves to, or nothing when the target cannot be resolved.
   *
   *  Decision 52 names "service add" among the takers of the operation lock and the three adds
   *  took none: only `serialize('provision')`, which a QUEUED `createBranch` has not entered yet.
   *  An add could therefore land inside a create's queue window, and since the create's key set
   *  was enqueued from the pre-lock snapshot while `provisionBranch` forks what the row says
   *  NOW, the create would fork a service whose key it never acquired. That fork's
   *  `ensureSourceRunning` takes `withOp([key])`, a second acquisition while other keys are held,
   *  which is the circular wait decision 52 exists to make impossible; and because it happens
   *  inside the engine-wide `serialize('provision')` with no timeout in the queue, every
   *  provisioning call in the daemon wedges behind it until a restart. With the branch key held
   *  by the add, the two sets cannot diverge.
   *
   *  It resolves WITHOUT throwing: the body inside the chain re-resolves the branch and raises
   *  the real error, and pre-empting that here would change which error an invalid request gets.
   *  `withOp([])` runs the body directly, so an unresolvable target behaves exactly as before. */
  private addKeys(projectId: string, branchName?: string): ServiceKey[] {
    try {
      return [this.branchOp(this.targetBranch(projectId, branchName))]
    } catch {
      return []
    }
  }

  /** The project and branch as they stand INSIDE the lock, for an operation that had to resolve
   *  them BEFORE it (every removal does: the key is derived from them).
   *
   *  The rule this enforces, after three bugs of one shape: no operation may ACT on a service
   *  identity it resolved before acquiring its lock. A removal can wait behind a rename, which
   *  now takes the lock, and the rename moves the id; acting on the snapshot then deleted the
   *  RENAMED database's data directory while leaving its row and its registration in place, and
   *  reported success. Re-read, compare, and refuse if anything moved: a removal that destroys
   *  nothing and says why is always better than one that destroys the wrong thing. */
  private freshRemoval(projectId: string, branchId: string, sid: string, what = 'removal'): { project: Project; branch: Branch } {
    const project = this.getProject(projectId)
    const branch = loadState().branches[branchId]
    if (!project || !branch || branch.projectId !== projectId) throw movedUnderUs(sid, what)
    return { project, branch }
  }

  /** A branch whose teardown did not finish is a HALF-DEMOLISHED branch: some of its containers
   *  or bytes are gone and some are not, and which is which is exactly what nobody knows. It
   *  keeps its row so those resources stay reachable and `insta branch delete` can retry, but it
   *  is not a branch to build on, and forking one copies whatever survived into a new branch
   *  that looks healthy.
   *
   *  This was declined at round ten as a behaviour change on hot paths, and that reasoning is
   *  dead: since 4b489f6 keeping the row is the NORMAL outcome of a failed teardown rather than
   *  an exotic one, so these rows are common now, and a forkable half-demolished branch is a
   *  data-integrity hazard this delta itself created.
   *
   *  It guards the whole PROVISIONING family, not the two paths that were named first: the fork
   *  source (`createBranchLocked`), the deploy target (`deployLocked`, which every redeploy goes
   *  through, including a merge's and a volume removal's), both ends of a merge, and the three
   *  service adds. What is deliberately NOT guarded is everything an operator needs in order to
   *  GET OUT of the state: listing, reading, credentials, the lifecycle verbs, and the branch
   *  delete that retries the demolition. `addComputeService` is not guarded either, because it
   *  registers a project-level name and materialises nothing; its deploy is the guarded step. */
  private assertUsable(branch: Branch, what: string): void {
    if (branch.status !== CLEANUP_FAILED) return
    // The DEFAULT branch cannot be pointed at `insta branch delete`: that refuses with "cannot
    // delete the default branch", so the operator would be sent to a dead end by the message
    // that was supposed to be the way out. `destroyProject` is what marked it and re-running it
    // is what retries the demolition.
    const retry = branch.isDefault
      ? 'Re-run `insta project delete` to retry the teardown'
      : `Run \`insta branch delete ${branch.name}\` to retry the teardown`
    throw new Error(`branch "${branch.name}" is ${CLEANUP_FAILED}: its teardown did not finish, so it cannot be ${what}. ${retry}`)
  }

  /** Does this branch's container still need renaming? Decided on EVIDENCE, three ways, like
   *  every other probe here: dockerd saying the OLD name is there means yes; saying it is not,
   *  with the new name present (or with neither present, a row naming a container that is
   *  already gone), means this branch is done; a probe that cannot answer stops the operation
   *  rather than guessing, because both guesses are wrong -- renaming again fails, and skipping
   *  leaves a container behind under the old name with the row saying otherwise.
   *
   *  This is what makes a multi-branch rename RESUMABLE: the containers are the record, so a
   *  retry of the same command finishes a rename that stopped partway, whatever happened to the
   *  compensation below. */
  private async renameNeeded(from: string, to: string): Promise<boolean> {
    const before = await this.scheduler.containerPresence(from)
    if (before === 'present') return true
    if (before === 'unknown') throw new Error(`docker could not report whether ${from} is still there, so this rename stopped rather than guessing`)
    const after = await this.scheduler.containerPresence(to)
    if (after === 'unknown') throw new Error(`docker could not report whether ${to} exists, so this rename stopped rather than guessing`)
    return false
  }

  /** Undo the container renames a failed multi-branch rename had already made, newest first.
   *
   *  The lock makes a rename EXCLUSIVE; it does not make a sequence of docker calls atomic, and
   *  that is the whole of this. The state write happens only after every branch's container has
   *  moved, so a failure partway used to leave state naming the old container on every branch
   *  while some containers already carried the new one: routing and lifecycle then addressed a
   *  container that does not exist, a teardown proved the old name gone and dropped the row
   *  over a live container under the new one, and the retry could not win either way.
   *
   *  Compensating is chosen over persisting a rename-in-flight record because the alternative
   *  means a new state shape that every reader of a service name would have to understand, at
   *  the end of this branch, on the path a late structural change has already cost us once. The
   *  compensation can itself fail -- docker is misbehaving, that is why we are here -- so it
   *  NEVER replaces the original error: what it could not undo is named alongside it, and the
   *  forward pass is resumable, so re-running the same rename finishes the job from wherever it
   *  actually stands. */
  private async undoRenames(done: Array<{ label: string; back: () => Promise<void> }>): Promise<string[]> {
    const stuck: string[] = []
    for (const step of [...done].reverse()) {
      try {
        await step.back()
      } catch (e) {
        stuck.push(`${step.label} (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    return stuck
  }

  /** The error a partial rename answers with: the reason it stopped, plus what is still moved. */
  private renameFailure(e: unknown, stuck: string[], retry: string): Error {
    const why = e instanceof Error ? e.message : String(e)
    if (!stuck.length) return new Error(`${why}. Nothing was renamed: every container this call had already moved was moved back`)
    return new Error(`${why}. These containers could NOT be moved back and still carry the new name: ${stuck.join('; ')}. Nothing in the project's records changed, and re-running ${retry} finishes the rename from where it stands`)
  }

  /** What a service RENAME holds: every branch's branch key and its key for this service.
   *
   *  Decision 52 names rename among the takers and all four rename paths took nothing, or only
   *  `serialize('provision')`, which is not an operation key. A rename mutates the SERVICE ID,
   *  and `provisionBranch` filters a freshly read registration list through the branch row the
   *  create captured: after a rename lands mid-create, `carries(project, staleRow, d)` looks the
   *  new id up in the old row, finds nothing, and the database silently drops out of the fork
   *  list. The clone comes back 201 with no database at all. Holding every carrier's branch key
   *  makes the rename queue behind a create instead, which closes it by construction rather than
   *  by widening a snapshot.
   *
   *  Project-wide because a rename is: it re-mints a hostname on every branch that carries the
   *  service and renames each container. Taken `withOp` OUTER and `serialize('provision')` inner,
   *  the order every other taker uses, so the engine-wide invariant holds: keys are acquired
   *  before the provision chain, never after it, and no path can close a cycle between them.
   *
   *  The list is a SNAPSHOT, so `withRenameKeys` re-drives it: a branch born between the snapshot
   *  and the acquisition would otherwise be renamed with none of ITS keys held. This was left open
   *  twice on the grounds that the outcome is loud rather than silent (a fork still in flight for
   *  the new branch finds its container gone under the old name, fails with `No such container`
   *  and unwinds the create). Loud is not the standard: the contract says every rename holds all
   *  affected operation keys before entering the provision chain, and that is false while the set
   *  is a pre-lock snapshot, so an otherwise valid branch create fails for a promise the code did
   *  not keep. The remedy is the same bounded union re-drive `createBranch`, `destroyProject`,
   *  `removeServiceVolume` and `destroyBranch` run. */
  private renameKeys(projectId: string, serviceId: string): ServiceKey[] {
    return this.listBranches(projectId).flatMap((b) => [this.branchOp(b), this.serviceKey(b, serviceId)])
  }

  /** Acquire a rename's keys over the branch set as it is UNDER THE LOCK, not as it was when the
   *  set was computed. The fifth use of the pattern and identical to the other four: recompute
   *  the carrier set inside the acquisition, and if it is not a subset of what was acquired,
   *  release everything and re-drive over the union before the body runs. A round that is
   *  abandoned has mutated nothing (the body is the whole rename, and it has not started), so a
   *  re-drive costs a re-queue and nothing else, and it converges because the union only grows.
   *
   *  `serviceId` is stable across the wait: only this operation changes it, and it does so inside
   *  the body with every carrier's keys held. */
  private async withRenameKeys<T>(projectId: string, serviceId: string, fn: () => Promise<T>): Promise<T> {
    let keys = this.renameKeys(projectId, serviceId)
    for (let round = 1; ; round++) {
      const settled = new Set(keys)
      const out = await this.withOp([...settled], async (): Promise<{ done: T } | { union: ServiceKey[] }> => {
        const needed = this.renameKeys(projectId, serviceId)
        if (!needed.every((k) => settled.has(k))) return { union: [...new Set([...settled, ...needed])] }
        return { done: await fn() }
      })
      if ('done' in out) return out.done
      if (round >= CREATE_LOCK_ROUNDS) {
        throw new Error(`rename could not settle its lock set after ${CREATE_LOCK_ROUNDS} rounds: branches are being created concurrently, retry the rename`)
      }
      keys = out.union
    }
  }

  /** What a WHOLE-branch operation holds: the branch key plus every service key on the branch. */
  private branchKeys(project: Project, b: Branch): ServiceKey[] {
    return [
      this.branchOp(b),
      ...this.carriedServiceIds(project, b).map((sid) => this.serviceKey(b, sid)),
      ...Object.keys(b.apps ?? {}).map((g) => this.serviceKey(b, `cp-${g}`)),
    ]
  }

  /** Start a sleeping service and wait until it accepts connections. `traffic` refuses a service
   *  the developer stopped; `api` and `deploy` are explicit and never refused. */
  wake(key: ServiceKey, opts: { door: 'traffic' | 'api' | 'deploy' }): Promise<void> { return this.scheduler.wake(key, opts) }
  /** Put one service to sleep now (the sweep's own path; also `sleepNewBranch`). */
  sleep(key: ServiceKey, reason: 'idle' | 'memory' | 'branch-create'): Promise<boolean> { return this.scheduler.sleep(key, reason) }
  /** A request or a connection read: the only thing that resets the idle clock. */
  touch(key: ServiceKey): void { this.scheduler.touch(key) }
  stateOf(key: ServiceKey): 'running' | 'asleep' | 'stopped' | 'paused' | 'starting' | 'none' { return this.scheduler.stateOf(key) }
  /** In-flight request/splice bookkeeping the router drives; a held key is never evicted. */
  holds(key: ServiceKey): number { return this.scheduler.holds(key) }
  beginHold(key: ServiceKey): void { this.scheduler.beginHold(key) }
  endHold(key: ServiceKey): void { this.scheduler.endHold(key) }

  /** A clone of a service that is not always-on is created and never started (asleep from birth). */
  startAsleepFor(project: Project, target: Branch, group: string): boolean {
    return !this.effectiveAlwaysOn(project, target, `cp-${group}`)
  }

  /** Whether a service opts out of sleep. Compute and managed databases carry the per-service
   *  setting; without one, the DEFAULT branch follows `INSTA_OSS_ALWAYS_ON_DEFAULT` (on, like the
   *  hosted platform, so production never cold-starts) and every other branch scales to zero.
   *  That split is what keeps one box able to hold many branches: were the default applied to
   *  every clone, each fork would start all of its apps running, and always-on services are never
   *  evicted, so a handful of branches would fill memory with nothing able to make room. An
   *  explicit setting wins on every branch. Postgres carries the inverse of its own per-branch
   *  `scaleToZero`, which is what `PATCH database/settings` writes: scale-to-zero unless set. */
  effectiveAlwaysOn(project: Project, branch: Branch, serviceId: string): boolean {
    if (serviceId.startsWith('pg-')) return !(branch.databases?.[serviceId]?.scaleToZero ?? true)
    const explicit = project.serviceSettings?.[serviceId]?.alwaysOn
    if (explicit !== undefined) return explicit
    return branch.isDefault ? this.cfg.sleep.alwaysOnDefault : false
  }

  /** Bookkeeping after a deploy replaced the container: asleep from birth, honouring a standing
   *  stop or suspend, or running. The standing intent is read back from the row `deployLocked` just
   *  wrote, because a suspended service's replacement is STARTED and then paused by the re-assert:
   *  reporting it running until the next sweep would be the container and the row disagreeing. */
  afterDeploy(key: ServiceKey, o: { started: boolean; startAsleep?: boolean }): void {
    if (o.startAsleep) { this.scheduler.onAsleep(key, 'branch-create'); return }
    const desired = this.targetOf(key)?.desiredState ?? 'running'
    if (desired === 'suspended') { this.scheduler.onPaused(key); return }
    if (!o.started || desired === 'stopped') { this.scheduler.onStopped(key); return }
    this.scheduler.onUp(key)
  }

  /** A clone's databases sleep until first use: they were provisioned and readied, and nothing has
   *  asked them for anything yet. Always-on services stay up. */
  async sleepNewBranch(project: Project, branch: Branch): Promise<void> {
    for (const sid of this.carriedServiceIds(project, branch)) {
      if (this.effectiveAlwaysOn(project, branch, sid)) continue
      await this.sleep(this.serviceKey(branch, sid), 'branch-create').catch(() => false)
    }
  }

  /** The services() `runtime` column, contract section 13's view mapping. A compute group that was
   *  registered and never deployed has no container at all: `none`. */
  rowRuntime(key: ServiceKey): string | undefined {
    const serviceId = key.slice(key.indexOf(':') + 1)
    if (!this.scheduler.targetOf(key)) return serviceId.startsWith('cp-') ? 'none' : undefined
    switch (this.scheduler.stateOf(key)) {
      case 'running': return 'online'
      case 'asleep': case 'starting': return 'asleep'
      case 'paused': return 'suspended'
      case 'stopped': return 'stopped'
      default: return 'none'
    }
  }

  /** One runtime-health row (contract section 13): `standby` for asleep or suspended, `starting`
   *  while a wake is in flight, and `crashed` ONLY for a container that exited with no sleep mark
   *  against a running intent. `sleptAt` is what separates standby from crashed after a restart. */
  healthOverlay(dockerState: string | undefined, desired: string, sleptAt: number | null | undefined, key: ServiceKey): { status: string; machines: number; failing: number } {
    if (!dockerState) return { status: 'none', machines: 0, failing: 0 }
    const live = this.scheduler.stateOf(key)
    const status = live === 'starting' || dockerState === 'restarting' ? 'starting'
      : dockerState === 'running' ? 'healthy'
        : dockerState === 'paused' ? 'standby'
          : sleptAt !== null && sleptAt !== undefined ? 'standby'
            : dockerState === 'created' ? 'starting'
              : desired === 'running' ? 'crashed' : 'standby'
    return { status, machines: 1, failing: status === 'crashed' ? 1 : 0 }
  }

  /** The cgroup ceiling recorded for a service: project-level for compute and managed databases,
   *  per branch for postgres (its own `PATCH database/settings` writes it). */
  limitsFor(project: Project, serviceId: string, branch?: Branch): ServiceLimits | undefined {
    if (serviceId.startsWith('pg-')) return branch?.databases?.[serviceId]?.limits
    return project.serviceSettings?.[serviceId]?.limits
  }

  // ---- targets: state.json projected for the scheduler -------------------------------------------

  /** Every schedulable service on every branch. Memoized on the state revision, because `stateOf`
   *  runs on the router's request path and `loadState()` clones (decision 54); `markSlept` patches
   *  the cached row in place, since a sleep mark is an audit-class write that bumps no revision. */
  private targetsCache: { rev: number; list: ServiceTarget[] } | undefined
  serviceTargets(): ServiceTarget[] {
    const rev = stateRev()
    if (this.targetsCache?.rev === rev) return this.targetsCache.list
    const s = loadState()
    const list: ServiceTarget[] = []
    for (const b of Object.values(s.branches)) {
      const project = s.projects[b.projectId]
      if (!project) continue
      const ref = this.ref(project, b)
      const common = { projectId: project.id, branchId: b.id, network: b.network }
      for (const d of project.dbServices ?? []) {
        const row = b.databases?.[d.id]
        if (!row) continue
        list.push({
          ...common, key: this.serviceKey(b, d.id), kind: 'postgres', serviceId: d.id,
          container: row.container, port: 5432,
          alwaysOn: this.effectiveAlwaysOn(project, b, d.id),
          desiredState: 'running',                                  // a database has no stop intent
          idleSec: row.idleTimeoutSec ?? this.cfg.sleep.idleDbSec,
          limits: row.limits, sleptAt: row.sleptAt ?? null,
          createdAt: d.createdAt ?? b.createdAt,
        })
      }
      for (const m of project.managedServices ?? []) {
        if (!b.managed?.[m.id]) continue
        list.push({
          ...common, key: this.serviceKey(b, m.id), kind: 'managed', serviceId: m.id,
          container: managedContainerName(ref, m.type, m.name), port: MANAGED_DB[m.type].port,
          alwaysOn: this.effectiveAlwaysOn(project, b, m.id),
          desiredState: 'running',
          idleSec: this.cfg.sleep.idleDbSec,
          limits: this.limitsFor(project, m.id), managedType: m.type,
          sleptAt: b.managed[m.id].sleptAt ?? null,
          createdAt: m.createdAt ?? b.createdAt,
        })
      }
      // Compute groups only once they are deployed: a registered group has no container to schedule.
      for (const [group, app] of Object.entries(b.apps)) {
        const serviceId = `cp-${group}`
        list.push({
          ...common, key: this.serviceKey(b, serviceId), kind: 'compute', serviceId,
          container: appContainerName(ref, group), port: app.port,
          alwaysOn: this.effectiveAlwaysOn(project, b, serviceId),
          desiredState: app.desiredState ?? 'running',
          idleSec: this.cfg.sleep.idleComputeSec,
          limits: this.limitsFor(project, serviceId),
          sleptAt: app.sleptAt ?? null,
          // The ROW's creation time, so a daemon restart does not hand every service a fresh create
          // grace on top of its idle window (decision 10).
          createdAt: project.serviceSettings?.[serviceId]?.createdAt ?? app.updatedAt ?? b.createdAt,
        })
      }
    }
    this.targetsCache = { rev, list }
    return list
  }

  targetOf(key: ServiceKey): ServiceTarget | undefined { return this.scheduler.targetOf(key) }

  /** The sleep mark on the service's own row: audit-class, so it never forces a router table
   *  rebuild (decision 54). The memoized projection is patched in the same breath. */
  private markSlept(key: ServiceKey, at: number | null): void {
    const branchId = key.slice(0, key.indexOf(':'))
    const serviceId = key.slice(key.indexOf(':') + 1)
    mutate((s) => {
      const b = s.branches[branchId]
      if (!b) return
      if (serviceId.startsWith('cp-')) {
        const app = b.apps[serviceId.slice(3)]
        if (app) app.sleptAt = at
      } else if (serviceId.startsWith('pg-')) {
        const row = b.databases?.[serviceId]
        if (row) row.sleptAt = at
      } else {
        const row = b.managed?.[serviceId]
        if (row) row.sleptAt = at
      }
    }, { audit: true })
    const cached = this.targetsCache?.list.find((t) => t.key === key)
    if (cached) cached.sleptAt = at
  }

  /** One scheduler event onto the project's timeline (decision 39): the payload carries the BARE
   *  service id and the branch name, never the branch-qualified key. */
  private emitForKey(key: ServiceKey, kind: string, payload: Record<string, unknown>): void {
    const b = loadState().branches[key.slice(0, key.indexOf(':'))]
    if (!b) return
    this.emit(b.projectId, b.name, 'resource', kind, { ...payload, branch: b.name })
  }

  // ---- always-on and limits (the cloud's two service knobs) --------------------------------------

  /** `PUT /projects/:id/services/:sid/always-on`. A boolean pins the service on every branch; `null`
   *  clears the setting, so it follows the default again (always-on on the default branch while
   *  INSTA_OSS_ALWAYS_ON_DEFAULT is on, scale-to-zero on every other branch). No container action
   *  here: the sweep stops a service that is no longer always-on once it goes idle, and wakes one
   *  that became always-on while it was asleep. */
  async setAlwaysOn(projectId: string, serviceId: string, enabled: boolean | null): Promise<{ service: ServiceRow | undefined }> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute' && !isManagedDbType(svc.type)) {
      throw new Error('alwaysOn is only supported for compute and managed database services')
    }
    mutate((s) => {
      const p = s.projects[projectId]
      p.serviceSettings ??= {}
      const next = { ...p.serviceSettings[serviceId] }
      if (enabled === null) delete next.alwaysOn
      else next.alwaysOn = enabled
      p.serviceSettings[serviceId] = next
    })
    this.emit(projectId, null, 'resource', 'service.alwaysOn', { service: serviceId, enabled })
    return { service: (await this.services(projectId)).find((x) => x.id === serviceId) }
  }

  /** The cloud's shared-cpu ladder (specs.ts): 256 to 2048 MB of memory per vCPU. */
  private static CPU_LADDER = [1, 2, 4, 6, 8] as const
  private static LIMITS_CAP = { cpu: 8, memoryMb: 8192, volumeGib: VOLUME_CAP_GIB }

  /** Validate a requested ceiling against the grid, with the cloud's own wording (specs.ts:131-141,
   *  the dash spelled `to`). An unset cpu is derived: the smallest ladder size that can carry the
   *  memory. */
  private validateLimits(memoryMb: number, cpu?: number): ServiceLimits {
    const derived = cpu ?? Engine.CPU_LADDER.find((c) => memoryMb <= c * 2048)
    if (derived === undefined) throw new Error(`no vCPU size can carry ${memoryMb} MB of memory`)
    if (!(Engine.CPU_LADDER as readonly number[]).includes(derived)) {
      throw new Error(`cpu must be one of ${Engine.CPU_LADDER.join(', ')} (provider vCPU sizes); got ${derived}`)
    }
    if (!Number.isInteger(memoryMb) || memoryMb % 256 !== 0) {
      throw new Error(`memoryMb must be a multiple of 256; got ${memoryMb}`)
    }
    const min = 256 * derived
    const max = 2048 * derived
    if (memoryMb < min || memoryMb > max) {
      throw new Error(`${derived} vCPU allows ${min} to ${max} MB of memory; got ${memoryMb}`)
    }
    if (derived > Engine.LIMITS_CAP.cpu || memoryMb > Engine.LIMITS_CAP.memoryMb) {
      throw new Error(`limits exceed this plan's ceiling (${Engine.LIMITS_CAP.cpu} vCPU / ${Engine.LIMITS_CAP.memoryMb} MB)`)
    }
    return { cpu: derived, memoryMb }
  }

  /** What a service runs under when nothing was set: the effective host ceiling, snapped to the
   *  grid (decision 15). */
  private hostCeiling(): ServiceLimits {
    const cpu = [...Engine.CPU_LADDER].reverse().find((c) => c <= Math.min(Engine.LIMITS_CAP.cpu, cpus().length)) ?? 1
    const snapped = Math.floor(totalmem() / (256 * 1024 * 1024)) * 256
    const memoryMb = Math.max(256 * cpu, Math.min(Engine.LIMITS_CAP.memoryMb, 2048 * cpu, snapped))
    return { cpu, memoryMb }
  }

  /** `GET /projects/:id/services/:sid/limits`. */
  serviceLimits(projectId: string, serviceId: string): {
    limits: ServiceLimits; cap: { cpu: number; memoryMb: number; volumeGib: number }; volume?: { sizeGib: number; mountPath: string }
  } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute' && !isManagedDbType(svc.type)) {
      throw new Error('limits are only supported for compute and managed database services')
    }
    const vol = svc.type === 'compute' ? project.computeVolumes?.[svc.name] : undefined
    return {
      limits: this.limitsFor(project, serviceId) ?? this.hostCeiling(),
      cap: { ...Engine.LIMITS_CAP },
      ...(vol ? { volume: { sizeGib: vol.sizeGib, mountPath: VOLUME_MOUNT_PATH } } : {}),
    }
  }

  /** `PUT /projects/:id/services/:sid/limits`: validate, apply to every branch container of the
   *  service (`docker update` is legal on a created or exited container too), then persist. A
   *  partial apply is the cloud's 502 and leaves the STORED ceiling alone, so a retry is safe. */
  async setServiceLimits(projectId: string, serviceId: string, patch: { memoryMb: number; cpu?: number }): Promise<{
    service: ServiceRow | undefined; limits: ServiceLimits; cap: { cpu: number; memoryMb: number; volumeGib: number }; changed: boolean
  }> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute' && !isManagedDbType(svc.type)) {
      throw new Error('limits are only supported for compute and managed database services')
    }
    const limits = this.validateLimits(patch.memoryMb, patch.cpu)
    const current = this.limitsFor(project, serviceId)
    const changed = current?.cpu !== limits.cpu || current?.memoryMb !== limits.memoryMb
    const branches = this.listBranches(projectId)
    const keys = branches.map((b) => this.serviceKey(b, serviceId))
    await this.withOp(keys, async () => {
      const containers = branches
        .map((b) => this.scheduler.targetOf(this.serviceKey(b, serviceId))?.container)
        .filter((c): c is string => c !== undefined)
      let applied = 0
      const failures: string[] = []
      for (const container of containers) {
        try { await this.scheduler.runtimeUpdate(container, limits); applied++ }
        catch (e) { failures.push(e instanceof Error ? e.message : String(e)) }
      }
      if (failures.length) {
        const err = new Error(`resize failed on the compute provider: ${failures[0]} (applied to ${applied}/${containers.length} machines; the stored ceiling is unchanged)`)
        Object.assign(err, { status: 502 })
        throw err
      }
      if (changed) {
        mutate((s) => {
          const p = s.projects[projectId]
          p.serviceSettings ??= {}
          p.serviceSettings[serviceId] = { ...p.serviceSettings[serviceId], limits }
        })
      }
    })
    if (changed) this.emit(projectId, null, 'resource', 'service.limits', { service: serviceId, ...limits })
    return { service: (await this.services(projectId)).find((x) => x.id === serviceId), limits, cap: { ...Engine.LIMITS_CAP }, changed }
  }

  /** A kubernetes-style cpu quantity (`2`, `2500m`) rounded UP to the ladder. */
  parseCpuQuantity(raw: string | number): number {
    const text = String(raw).trim()
    const milli = /m$/.test(text) ? Number(text.slice(0, -1)) : Number(text) * 1000
    if (!Number.isFinite(milli) || milli <= 0) throw new Error(`invalid cpu quantity: ${raw} (try '2' or '2000m')`)
    const wanted = milli / 1000
    const snapped = Engine.CPU_LADDER.find((c) => c >= wanted)
    if (snapped === undefined) throw new Error(`cpu must be one of ${Engine.CPU_LADDER.join(', ')} vCPU`)
    return snapped
  }

  /** A kubernetes-style memory quantity (`4Gi`, `2048Mi`, `512M`, bytes) in whole MB. */
  parseMemoryQuantity(raw: string | number): number {
    const text = String(raw).trim()
    const m = /^(\d+(?:\.\d+)?)\s*(Gi|Mi|G|M|K|Ki)?$/.exec(text)
    if (!m) throw new Error(`invalid memory quantity: ${raw} (try '512Mi' or '4Gi')`)
    const n = Number(m[1])
    const unit = m[2]
    const mb = unit === 'Gi' ? n * 1024
      : unit === 'G' ? (n * 1_000_000_000) / (1024 * 1024)
        : unit === 'Mi' || unit === 'M' ? (unit === 'M' ? (n * 1_000_000) / (1024 * 1024) : n)
          : unit === 'Ki' || unit === 'K' ? n / 1024
            : n / (1024 * 1024)
    return Math.round(mb)
  }

  // ---- postgres: management wakes, observability does not (decision 48) --------------------------

  /** Before a MANAGEMENT query (password, databases, extensions): an explicit operation, so it
   *  wakes the instance through the api door. Re-entrant: the caller already holds the key. */
  private async ensurePgAwake(branch: Branch, serviceId: string): Promise<void> {
    await this.wake(this.serviceKey(branch, serviceId), { door: 'api' })
  }

  /** Before an OBSERVABILITY query: a sleeping database reports that it is sleeping instead of
   *  being woken by a dashboard poll. `server.ts` maps this message to 503. A refusal is only ever
   *  taken on a FRESH snapshot, because a stale one would refuse a database that is up. */
  private async assertPgAwake(branch: Branch, serviceId: string): Promise<void> {
    const key = this.serviceKey(branch, serviceId)
    // The cheap answer first: the dashboard polls the four routes this guards, and a `docker ps -a`
    // per panel per poll is a process spawn for a question the snapshot almost always answers with
    // `running`. A REFUSAL is still never taken on a stale read: only that path pays for the fresh
    // snapshot, and re-tests against it.
    if (!this.refusesPgRead(this.stateOf(key))) return
    await this.scheduler.refreshStates()
    if (this.refusesPgRead(this.stateOf(key))) {
      throw new Error('database is sleeping: it wakes on the next connection')
    }
  }

  /** Only `asleep` and `starting` refuse: a container that crashed is not sleeping, and letting the
   *  query fail says so honestly. */
  private refusesPgRead(live: string): boolean { return live === 'asleep' || live === 'starting' }

  /** Run one management query with the instance awake and the key held for its duration. */
  private async pgManage<T>(branch: Branch, serviceId: string, fn: () => Promise<T>): Promise<T> {
    const key = this.serviceKey(branch, serviceId)
    return this.withOp([key], async () => {
      await this.ensurePgAwake(branch, serviceId)
      return fn()
    })
  }
  // ---- end region WP3 ----

  // ---- region WP4 (data dir) ----
  /** The engine's default `DataDirOps`: the process-wide `DataDir`, resolved on the first CALL, not
   *  at class definition, so constructing an Engine still reads no config and touches no disk.
   *  `main.ts` passes the instance it probed at boot; tests pass a recorder. (The name is the
   *  scaffold's; the body is no longer a no-op.) */
  private static readonly NOOP_DATA: DataDirOps = lazyDataDirOps()
  readonly data: DataDirOps
  /** True while migrateLegacyData runs: the sleep sweep stays inert while containers are being
   *  stopped and recreated by the migration (decision 24). */
  booting = false
  /** Host paths under `cfg.dataDir`, keyed by IMMUTABLE ids: a rename must never detach data
   *  (decision 16, contract 00 section 12). */
  layout(): { pg(ref: string, dataId: string): string; vol(ref: string, volId: string): string; md(ref: string, type: ManagedDbType, dataId: string): string; branchRoots(ref: string): string[] } {
    return dataLayout(this.cfg.dataDir)
  }
  /** The compute group's /data bind mount. Created before the deploy, 0777 because a user image may
   *  run as any uid (the parent tree is 0700, so the box is not open). A missing bind source makes
   *  `--mount type=bind` fail the start, which is why this is not lazy. */
  volumeMount(project: Project, branch: Branch, group: string): { hostPath: string } | undefined {
    const vol = project.computeVolumes?.[group]
    if (!vol) return undefined
    const hostPath = this.layout().vol(this.ref(project, branch), vol.id)
    ensureDirSync(hostPath, 0o777)
    return { hostPath }
  }
  /** Reflink (or plain-copy) every /data volume of the source branch onto the target. Runs BEFORE
   *  the clone's redeploy loop, so the new containers start on their own copy.
   *
   *  The source app keeps RUNNING through the walk, and that is a deliberate divergence from the
   *  Postgres fork, which refuses to walk a live data directory and streams a `pg_basebackup`
   *  instead. The difference is that Postgres HAS a consistent alternative, and that a torn
   *  database does not survive its own recovery. A `/data` volume has neither: there is no
   *  protocol that streams an arbitrary application's files consistently, so the only choices
   *  here are copying a live tree or refusing every branch create of an app that is awake. What
   *  the copy holds is each file as it stood when the walk reached it: MANY moments of the tree,
   *  not the single instant a crash or a power cut freezes, so an invariant spanning two files
   *  can land broken in a way no crash would produce. That is the same distinction this PR draws
   *  for Postgres, and the reason the database refuses the walk where it has an alternative;
   *  here there is none, and failing every branch create of an awake app would be the worse
   *  answer by a distance. Stated as a divergence in COMPATIBILITY and in the branching docs,
   *  and a caller who wants a quiescent copy stops the group first (`insta compute stop
   *  <group>`, or lets the idle sweep put it to sleep). */
  async forkVolumes(project: Project, source: Branch, target: Branch): Promise<Array<{ group: string; method: 'reflink' | 'copy'; ms: number }>> {
    const out: Array<{ group: string; method: 'reflink' | 'copy'; ms: number }> = []
    const srcRef = this.ref(project, source)
    const dstRef = this.ref(project, target)
    for (const group of Object.keys(source.apps)) {
      const vol = project.computeVolumes?.[group]
      if (!vol) continue
      const from = this.layout().vol(srcRef, vol.id)
      if (!existsSync(from)) continue
      const to = this.layout().vol(dstRef, vol.id)
      await this.data.ensureDir(to, 0o777)
      const r = await this.data.cloneTree(from, to)
      out.push({ group, method: r.method, ms: r.ms })
    }
    return out
  }
  /** The boot probe's answer (decision 23): `warning` is set when the probe degraded to copying. */
  dataCapabilities(): { dataDir: string; reflink: boolean; engine: 'inprocess' | 'helper' | 'cp-c'; warning?: string } {
    return this.dataCaps ?? probedCapabilities()
  }
  private dataCaps: { dataDir: string; reflink: boolean; engine: 'inprocess' | 'helper' | 'cp-c'; warning?: string } | undefined
  /** main.ts hands the boot probe's result to the engine so `insta` can report it without probing
   *  again. */
  setDataCapabilities(caps: { dataDir: string; reflink: boolean; engine: 'inprocess' | 'helper' | 'cp-c'; warning?: string }): void {
    this.dataCaps = caps
  }
  /** One boot migration of branches still storing data in docker volumes and container layers
   *  (decision 24). Resumable and idempotent; a branch it could not finish keeps
   *  `dataVersion: undefined`, and `createBranch` from such a branch throws. */
  async migrateLegacyData(): Promise<{ migrated: string[]; skipped: string[]; failed: Array<{ ref: string; error: string }> }> {
    return migrateLegacyData({
      cfg: this.cfg,
      data: this.data,
      layout: () => this.layout(),
      ref: (branch) => this.ref(this.getProject(branch.projectId)!, branch),
      query: (container, sql) => this.db.query(container, sql),
      provisionManaged: (t, opts) => this.managedDb.provision(t, opts),
      redeploy: (projectId, branchName, group, opts) => this.deploy(projectId, branchName, { ...opts, group }).then(() => undefined),
    })
  }
  /** The per-branch guard the plan's message names: a fork of a branch whose bytes still live in a
   *  docker volume would clone an empty directory. */
  private assertMigrated(branch: Branch): void {
    if (branch.dataVersion !== 1) {
      throw new Error(`branch ${branch.name} still stores data in docker volumes; restart the daemon to retry the migration`)
    }
  }
  /** Every managed sub-directory of one service, created before the container starts (a missing
   *  bind source fails `--mount type=bind`). */
  private async ensureManagedDirs(ref: string, type: ManagedDbType, dataId: string): Promise<string> {
    const dir = this.layout().md(ref, type, dataId)
    await this.data.ensureDir(dir, 0o700)
    for (const p of dataPaths(type)) await this.data.ensureDir(join(dir, p.sub), 0o700)
    return dir
  }
  /** The fork result of the branch currently being provisioned, read once by `createBranch` for the
   *  `branch.created` payload (decision 39) and then dropped. */
  private forkResults = new Map<string, { method: 'reflink' | 'basebackup'; ms: number }>()
  // ---- end region WP4 ----

  // ---- region WP5 (templates/parity) ----

  /** The bundled template registry (`cfg.templatesDir`). Reads no file until a route asks. */
  readonly templates: TemplateCatalog
  private executorInstance: TemplateExecutor | undefined
  /** The template executor, created on first use so nothing has to wire it up: main.ts just calls
   *  `abandonStale()` at boot. Assignable like `router`, because an executor needs the engine that
   *  owns it — a test builds the engine, then hands it one with a fake health probe. */
  get executor(): TemplateExecutor {
    return (this.executorInstance ??= new TemplateExecutor(this))
  }
  set executor(ex: TemplateExecutor) { this.executorInstance = ex }

  /** User secrets bound to ONE service on ONE branch, by name. The template executor reads back
   *  what a previous attempt wrote (the deployment record stores refs, never values). */
  boundSecrets(projectId: string, branchName: string, service: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const u of loadState().userSecrets[projectId] ?? []) {
      if (u.branch === branchName && u.service === service) out[u.name] = u.value
    }
    return out
  }

  /** The project's postgres registrations, in creation order (the OLDEST holds the canonical
   *  unsuffixed `DATABASE_URL` alias, computed at read time so a removal shifts it). */
  private dbList(projectId: string): NonNullable<Project['dbServices']> {
    return this.getProject(projectId)?.dbServices ?? []
  }
  /** The project's storage registrations, in creation order (the oldest holds the S3 aliases). */
  private stList(projectId: string): NonNullable<Project['storageServices']> {
    return this.getProject(projectId)?.storageServices ?? []
  }

  /** One postgres service's handle on one branch. READ from the row; derived only for a row a
   *  migration has not reached yet (decision 17). */
  private dbHandle(project: Project, branch: Branch, serviceId: string): { url: string; container: string; dataId: string } | undefined {
    const row = branch.databases?.[serviceId]
    if (row) return row
    // The branch-local test FIRST. `carries()` calls this once per registration per branch, and a
    // filter discriminates on the miss, so the miss is the common path: a project's registration
    // list is every name any branch ever registered, not what this one holds. `dbList` reaches
    // `getProject` -> `loadState()`, which is a `structuredClone` of every project, branch, event
    // and secret, so asking it before this line made `GET /secrets/tree` over 26 branches
    // carrying 5 databases each clone the whole daemon state thousands of times. The fallback
    // below can only produce a handle for a branch that still has a pre-migration `dbUrl`, so
    // nothing needs the registration until that is known to be there.
    if (branch.dbUrl === undefined) return undefined
    const reg = this.dbList(project.id).find((d) => d.id === serviceId)
    if (!reg) return undefined
    return { url: branch.dbUrl, container: `io-${this.ref(project, branch)}-pg`, dataId: reg.dataId }
  }

  /** One storage service's handle on one branch (bucket + its minted credential env). */
  /** Per-service teardown: the shared object store stays on the branch network while ANY other
   *  bucket on it is live, so the detach happens only with the last one (the row is already gone
   *  from state when this runs). */
  private async detachIfLastBucket(branch: Branch): Promise<void> {
    if (!this.storage.detachFrom) return
    if (Object.keys(loadState().branches[branch.id]?.buckets ?? {}).length > 0) return
    await this.storage.detachFrom(branch.network).catch(() => {})
  }

  private bucketHandle(project: Project, branch: Branch, serviceId: string): { bucket: string; env: Record<string, string>; public?: boolean } | undefined {
    const row = branch.buckets?.[serviceId]
    if (row) return row
    // Cheap branch-local test before the clone, for the reason spelled out on `dbHandle`: the
    // `||` ran `stList` (a full `structuredClone` of the state) on every miss, and `carries()`
    // misses once per registration per branch.
    if (branch.bucket === undefined) return undefined
    if (!this.stList(project.id).some((x) => x.id === serviceId)) return undefined
    return { bucket: branch.bucket, env: branch.s3 ?? {}, public: branch.storagePublic ?? false }
  }

  /** The database service ids ONE branch carries (postgres then managed, the order
   *  `provisionBranch` creates them in). Services are branch-scoped, so the project's registration
   *  list is not this: it is every name the project has ever registered, on any branch. */
  private carriedServiceIds(project: Project, branch: Branch): string[] {
    return [
      ...this.dbList(project.id).filter((d) => this.carries(project, branch, d, 'postgres')).map((d) => d.id),
      ...this.managedList(project.id).filter((m) => this.carries(project, branch, m, 'managed')).map((m) => m.id),
    ]
  }

  // ---- env assembly (contract 00 section 10, plan 05 section 5) ----------------------------------

  /** Minted postgres credentials: every service SUFFIXED (`DATABASE_URL_<NAME>`), the oldest also
   *  unsuffixed. ONE host-facing string everywhere (contract section 10): the stored DSN is rewritten
   *  onto the service's lane, exactly as `credentials()` does it, because this is what `insta run`
   *  and `insta secrets -o .env` inject into a HOST process. A container gets the same string with
   *  127.0.0.1 swapped for host.docker.internal by `containerize()` on the deploy path. */
  private dbSecretsFor(project: Project, branch: Branch): Record<string, string> {
    const out: Record<string, string> = {}
    let aliased = false
    for (const d of this.dbList(project.id)) {
      const row = this.dbHandle(project, branch, d.id)
      if (!row) continue
      const url = this.laneUrl(project, branch, d.id, row.url)
      out[`DATABASE_URL_${envSuffix(d.name)}`] = url
      if (!aliased) { aliased = true; out.DATABASE_URL = url }
    }
    return out
  }

  /** Minted storage credentials on the same suffix + alias rule as postgres and managed.
   *  `hostFacing` (the default, for `secrets` and `credentials`) swaps the stored branch-network
   *  endpoint for the one that answers on the HOST, which is what `insta secrets -o .env` and the
   *  aws CLI need; a deploy asks for the stored form, because a container resolves `io-garage`
   *  through the branch network and needs no gateway at all (contract section 10). */
  private storageSecretsFor(project: Project, branch: Branch, hostFacing = true): Record<string, string> {
    const out: Record<string, string> = {}
    let aliased = false
    for (const s of this.stList(project.id)) {
      const row = this.bucketHandle(project, branch, s.id)
      if (!row) continue
      const env = hostFacing ? this.hostFacingS3(row.env) : row.env
      Object.assign(out, suffixBundle(env, s.name))
      if (!aliased) { aliased = true; Object.assign(out, env) }
    }
    return out
  }

  /** The stored S3 endpoint rewritten onto the host: in server mode the two are the same string
   *  already, so this only bites in local mode, where the row holds `http://io-garage:3900`. */
  private hostFacingS3(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = { ...env }
    for (const [k, v] of Object.entries(out)) {
      if (!/^AWS_ENDPOINT_URL_S3(_|$)/.test(k)) continue
      try { if (new URL(v).hostname === GARAGE_CONTAINER) out[k] = this.cfg.s3HostEndpoint } catch { /* not a URL: leave it */ }
    }
    return out
  }

  /** Env names one service mints ON ONE BRANCH (names only, for the inventory routes): always its
   *  SUFFIXED set, plus the canonical unsuffixed keys when it is the oldest of its type and
   *  therefore holds the aliases. Derived from the same rule the value assembly above applies —
   *  including which service holds the aliases, which `dbSecretsFor` and `storageSecretsFor`
   *  decide over the services the BRANCH carries. The project's oldest registration may not be on
   *  this branch at all, and naming it here reported `DATABASE_URL` under a service the branch
   *  does not have while the branch's real alias holder showed none. */
  private mintedNamesOf(project: Project, branch: Branch, serviceId: string): string[] {
    const parsed = parseServiceId(serviceId)
    if (!parsed) return []
    if (parsed.type === 'postgres') {
      const canonical = this.dbList(project.id).find((d) => this.carries(project, branch, d, 'postgres'))?.id === parsed.serviceId
      return [...(canonical ? ['DATABASE_URL'] : []), `DATABASE_URL_${envSuffix(parsed.name)}`]
    }
    if (parsed.type === 'storage') {
      const env = this.bucketHandle(project, branch, parsed.serviceId)?.env
      const keys = env ? Object.keys(env) : [...CANONICAL_KEYS.storage]
      const canonical = this.stList(project.id).find((x) => this.carries(project, branch, x, 'storage'))?.id === parsed.serviceId
      return [...(canonical ? keys : []), ...keys.map((k) => `${k}_${envSuffix(parsed.name)}`)]
    }
    if (isManagedDbType(parsed.type)) {
      // Same rule as postgres and storage above: the branch's oldest service of the type holds the
      // canonical aliases. This arm used to return the suffixed set only, so the one name most
      // apps read (REDIS_URL) was missing from every inventory that asks here.
      return this.mintedManagedNames(
        { id: parsed.serviceId, type: parsed.type, name: parsed.name },
        this.aliasedManagedIds(project.id, branch).has(parsed.serviceId),
      )
    }
    return []
  }

  /** Secrets bound INTO one compute group by `${{services.x.KEY}}` bindings: `envName` takes the
   *  named credential of the named source service. Bindings bypass `isReservedSecret` by design —
   *  renaming a platform credential into an app's own env name is exactly what they are for. */
  private bindingsFor(project: Project, branch: Branch, group: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const b of branch.bindings ?? []) {
      if (b.target !== `compute/${group}`) continue
      const [type, name] = [b.source.slice(0, b.source.indexOf('/')), b.source.slice(b.source.indexOf('/') + 1)]
      const sid = type === 'postgres' ? pgServiceId(name)
        : type === 'storage' ? storageServiceId(name)
        : isManagedDbType(type) ? managedServiceId(type, name)
        : undefined
      if (!sid) continue
      const value = this.credentialsOn(project, branch, sid)[b.sourceName]
      if (value !== undefined) out[b.envName] = value
    }
    return out
  }

  /** The env one compute deploy receives, low precedence to high: minted postgres, minted storage,
   *  minted managed databases, user secrets scoped to this group, then bindings. */
  envFor(project: Project, branch: Branch, group: string): Record<string, string> {
    return {
      ...this.dbSecretsFor(project, branch),
      ...this.storageSecretsFor(project, branch, false),
      ...this.managedSecretsFor(project.id, branch),
      ...this.deploySecretsFor(project.id, branch.name, group),
      ...this.bindingsFor(project, branch, group),
    }
  }

  /** The canonical credential bundle of ONE service on ONE branch, host-facing: the DSN and host
   *  values point at the lane a client outside the branch network dials (WP2's `laneAddress`),
   *  which is what `insta db url` prints and what a binding reads. Compute services mint nothing. */
  private credentialsOn(project: Project, branch: Branch, serviceId: string): Record<string, string> {
    const parsed = parseServiceId(serviceId)
    if (!parsed) return {}
    if (parsed.type === 'postgres') {
      const row = this.dbHandle(project, branch, serviceId)
      if (!row) return {}
      return { DATABASE_URL: this.laneUrl(project, branch, serviceId, row.url) }
    }
    if (parsed.type === 'storage') {
      const row = this.bucketHandle(project, branch, serviceId)
      return row ? this.hostFacingS3(row.env) : {}
    }
    if (isManagedDbType(parsed.type)) {
      const cred = branch.managed?.[serviceId]
      if (!cred) return {}
      const lane = this.laneAddress(project, branch, serviceId)
      return laneBundle(parsed.type, lane.host, lane.port, cred.password, lane.tls)
    }
    return {}
  }

  /** A stored container-host DSN rewritten onto the service's lane, `sslmode=require` when the lane
   *  terminates TLS (contract 00 section 10). */
  private laneUrl(project: Project, branch: Branch, serviceId: string, stored: string): string {
    const lane = this.laneAddress(project, branch, serviceId)
    let u: URL
    try { u = new URL(stored) } catch { return stored }
    u.host = `${lane.host}:${lane.port}`
    if (lane.tls) u.searchParams.set('sslmode', 'require')
    return u.toString()
  }

  /** GET /projects/:id/services/:sid/credentials. */
  credentials(projectId: string, serviceId: string, branchName?: string): Record<string, string> {
    const { branch, serviceId: sid } = this.resolveSid(projectId, serviceId, branchName)
    const project = this.getProject(projectId)!
    const svc = this.serviceOf(projectId, sid) // 404 for an id no registration claims
    // ...and a 404 for one this BRANCH does not carry. `credentialsOn` answers `{}` for a service
    // with no row here, which the route served as a 200: a caller asking for the credentials of a
    // database that lives on another branch was told, successfully, that it has none.
    this.assertServiceOnBranch(project, branch, sid, svc.type)
    return this.credentialsOn(project, branch, sid)
  }

  // ---- branch-qualified service ids (decision 49) ------------------------------------------------

  /** The id a `services()` row carries: bare on the default branch, `<branchId>:<serviceId>`
   *  elsewhere. The CLI takes an id from the branch-scoped list and calls credentials/state/stop
   *  with NO branch, so a bare id off the default branch would silently act on main. */
  qualifiedId(branch: Branch, serviceId: string): string {
    return branch.isDefault ? serviceId : `${branch.id}:${serviceId}`
  }

  /** Resolve a possibly-qualified sid to its branch and BARE service id: the qualifier wins, then
   *  `?branch`, then the default branch. A qualifier naming a branch that is gone (or belongs to
   *  another project) is a 404, never a silent fall-through to main. */
  resolveSid(projectId: string, sid: string, branchQuery?: string): { branch: Branch; serviceId: string } {
    const parsed = parseServiceId(sid)
    const serviceId = parsed?.serviceId ?? sid
    if (parsed?.branchId !== undefined) {
      const branch = loadState().branches[parsed.branchId]
      if (!branch || branch.projectId !== projectId) throw new Error('branch not found')
      return { branch, serviceId }
    }
    const { branch } = this.branchOrThrow(projectId, branchQuery)
    return { branch, serviceId }
  }

  // ---- postgres service registrations -----------------------------------------------------------

  /** The one rule (see SERVICE_NAME_RE): this used to be a fourth, lenient copy that allowed a
   *  trailing hyphen, so which names were legal depended on which route you reached. */
  private static NAME_RE = SERVICE_NAME_RE

  private assertServiceName(name: string): void {
    if (!Engine.NAME_RE.test(name)) throw new Error('service name must be lower-kebab (a-z, 0-9, -)')
  }

  /** The cloud's per-type BRANCH cap, minus its dash and upgrade hint (there is no plan to buy).
   *  Callers count what the target branch carries: services are branch-scoped, so the project's
   *  registration list is every name on every branch and not this branch's load. */
  private assertTypeCap(count: number, type: string): void {
    if (count >= this.cfg.services.maxPerType) {
      throw new Error(`branch has reached this plan's limit of ${this.cfg.services.maxPerType} ${type} services (INSTA_OSS_MAX_SERVICES_PER_TYPE)`)
    }
  }

  /** Add a postgres service to ONE branch: `opts.branch`, else the project's default branch.
   *
   *  Services are BRANCH-scoped, as they are in the cloud. The hosted control plane made a service
   *  branch-owned in migration `0022_branch_scoped_services.sql` ("a service was a project-level
   *  catalog entry materialized on every branch; it becomes branch-owned so add/remove stay local
   *  and branches diverge"), `POST /projects/:id/services` takes an optional `branch` and resolves
   *  it to the default branch when absent (platform `src/server.ts:1492`, `src/provisioning/
   *  services.ts:662`), and the write itself is one row on one branch: "Branch-owned: one row on
   *  this branch, materialized only here as the lineage origin. No fan-out." Fanning out here
   *  instead meant `insta services add postgres db --branch feat` silently built a second database,
   *  with its own credentials, on `main`.
   *
   *  InstaCloud OSS keeps the REGISTRATION project-level, because a service id is the project's name
   *  space and has to stay stable across branches (contract decision 49); the service itself is the
   *  row on the branch. So a name this project has registered but this branch does not carry is
   *  MATERIALISED here rather than refused, which is what the cloud does too (it creates a fresh
   *  row with its own lineage and no data). A name this branch already carries is the conflict. */
  async addDbService(projectId: string, name: string, opts: { templateDeploymentId?: string; branch?: string } = {}): Promise<ServiceRow> {
    return this.withOp(this.addKeys(projectId, opts.branch), () => this.addDbServiceLocked(projectId, name, opts))
  }

  private async addDbServiceLocked(projectId: string, name: string, opts: { templateDeploymentId?: string; branch?: string } = {}): Promise<ServiceRow> {
    return this.serialize('provision', async () => {
      const project = this.getProject(projectId)
      if (!project) throw new Error('project not found')
      this.assertServiceName(name)
      const b = this.targetBranch(projectId, opts.branch)
      this.assertUsable(b, 'given new services')
      const existing = this.dbList(projectId).find((d) => d.name === name)
      if (existing && this.carries(project, b, existing, 'postgres')) throw new Error('service already exists on this branch')
      // What the TARGET BRANCH carries, which is what the message, contract line 725 and
      // COMPATIBILITY all say the cap counts. Under the old fan-out the two were the same number;
      // branch-scoped they are not, and counting registrations refused a branch its FIRST database
      // once the cap's worth of names existed anywhere in the project, while waving a
      // re-materialisation of an already-registered name past the cap entirely.
      this.assertTypeCap(this.dbList(projectId).filter((d) => this.carries(project, b, d, 'postgres')).length, 'postgres')
      const entry = existing ?? { id: pgServiceId(name), name, dataId: randomUUID().slice(0, 8), createdAt: Date.now(), ...(opts.templateDeploymentId ? { templateDeploymentId: opts.templateDeploymentId } : {}) }
      const ref = this.ref(project, b)
      // ONE synchronous mutate checks the hostname and records the registration, before any
      // provisioning await (decision 51).
      mutate((st) => {
        this.assertHostFree(this.labelFor('postgres', name, ref))
        if (existing) return
        const pr = st.projects[projectId]
        pr.dbServices = [...(pr.dbServices ?? []), entry]
      })
      const container = pgContainerName(ref, name)
      const dataDir = this.layout().pg(ref, entry.dataId)
      try {
        const { url } = await this.db.provision({ container, network: b.network, dataDir }, { publishLoopback: this.cfg.mode === 'local', limits: this.limitsFor(project, entry.id) })
        const host = this.hostFor('postgres', name, ref)
        // addedAt: a registration another branch kept is reused with its old createdAt, so this branch's
        // own row is what marks the new incarnation for its metrics history (observedTargets' `since`).
        mutate((st) => { (st.branches[b.id].databases ??= {})[entry.id] = { url, container, dataId: entry.dataId, host, addedAt: Date.now() } })
        this.scheduler.register([this.serviceKey(b, entry.id)])                                     // WP3
      } catch (e) {
        await this.db.destroy(container).catch(() => {})
        await this.data.remove(dataDir).catch(() => {})
        mutate((st) => {
          delete st.branches[b.id].databases?.[entry.id]
          // Only a registration THIS call made is rolled back: one that already existed is other
          // branches' service too.
          if (existing) return
          const pr = st.projects[projectId]
          pr.dbServices = (pr.dbServices ?? []).filter((d) => d.id !== entry.id)
        })
        throw e
      }
      // The new lane must be listening before `insta db url` is followed by a psql.
      this.router.invalidate()
      this.emit(projectId, b.name, 'resource', 'service.added', { type: 'postgres', name })
      return { id: entry.id, type: 'postgres', name, status: 'ready', pg_version: PG_VERSION }
    })
  }

  /** Remove a postgres service from ONE branch: the qualifier on the id, else `opts.branch`, else
   *  the project's default branch. The data goes with it, on that branch only.
   *
   *  Removal is branch-scoped for the same reason `addDbService` is: the cloud made a service
   *  branch-owned so that "add/remove stay local and branches diverge" (platform migration
   *  `0022_branch_scoped_services.sql`). Destroying every branch's copy meant a `services remove`
   *  run on `feat` also destroyed main's database and its bytes. */
  async removeDbService(projectId: string, serviceId: string, opts: { branch?: string } = {}): Promise<Teardown> {
    const { project: at, branch: atBranch, sid } = this.removalTarget(projectId, serviceId, opts.branch)
    const known = this.dbList(projectId).find((d) => d.id === sid)
    if (!known) throw new Error('service not found')
    this.assertCarries(at, atBranch, known, 'postgres')
    return this.withOp([this.serviceKey(atBranch, sid)], async () => {
      // Everything above is a pre-queue snapshot: this may have waited behind a RENAME, which
      // takes the lock now and moves the id. Acting on the snapshot deleted the renamed
      // database's data directory and left its row standing (`freshRemoval`).
      const { project, branch } = this.freshRemoval(projectId, atBranch.id, sid)
      const reg = this.dbList(projectId).find((d) => d.id === sid)
      if (!reg || !this.carries(project, branch, reg, 'postgres')) throw movedUnderUs(sid, 'removal')
      const t = newTeardown()
      const row = this.dbHandle(project, branch, sid)
      // Same rule as the branch teardown: the bytes and the row go only for a container that is
      // proven gone. This one is a bind-mounted PGDATA, so a directory removal under a
      // surviving Postgres is the worst version of it.
      if (row && !(await removeContainer(this.scheduler, t, row.container, () => this.db.destroy(row.container)))) {
        return t
      }
      // The bytes gate the row too, not only the container: a PGDATA that could not be removed
      // with its row dropped is a database directory nothing names.
      const beforeBytes = t.failed
      const dir = this.layout().pg(this.ref(project, branch), reg.dataId)
      await count(t, () => this.data.remove(dir), `remove the data directory ${dir}`)
      if (t.failed !== beforeBytes) return t
      mutate((st) => {
        delete st.branches[branch.id].databases?.[sid]
        st.branches[branch.id].bindings = (st.branches[branch.id].bindings ?? []).filter((x) => x.source !== `postgres/${reg.name}`)
      })
      this.scheduler.forget([this.serviceKey(branch, sid)])                                          // WP3
      this.retireRegistration(project, reg, 'postgres', `postgres/${reg.name}`, branch)
      this.router.invalidate()
      this.emit(projectId, branch.name, 'resource', 'service.removed', { type: 'postgres', name: reg.name })
      return t
    })
  }

  /** Rename a postgres service everywhere its name appears: the registration and its id, every
   *  branch's container and minted hostname, bindings and service-bound user secrets. The data
   *  directory keeps its immutable `dataId` (decision 16). */
  async renameDbService(projectId: string, serviceId: string, newName: string): Promise<ServiceRow> {
    return this.withRenameKeys(projectId, serviceId, () => this.renameDbServiceLocked(projectId, serviceId, newName))
  }

  private async renameDbServiceLocked(projectId: string, serviceId: string, newName: string): Promise<ServiceRow> {
    return this.serialize('provision', async () => {
      const project = this.getProject(projectId)
      if (!project) throw new Error('project not found')
      const reg = this.dbList(projectId).find((d) => d.id === serviceId)
      if (!reg) throw new Error('service not found')
      this.assertServiceName(newName)
      if (newName === reg.name) return { id: reg.id, type: 'postgres', name: reg.name, status: 'ready', pg_version: PG_VERSION }
      if (this.dbList(projectId).some((d) => d.name === newName)) throw new Error(`postgres service "${newName}" already exists`)
      const newId = pgServiceId(newName)
      // Only the branches that CARRY it: a rename mints a hostname exactly where the service has a
      // row, so checking the label on branches without one refused the rename over a collision
      // that would never happen (the managed rename already scopes this to its carriers).
      const branches = this.listBranches(projectId).filter((b) => this.carries(project, b, reg, 'postgres'))
      for (const b of branches) this.assertHostFree(this.labelFor('postgres', newName, this.ref(project, b)))
      for (const b of branches) {
        const row = this.dbHandle(project, b, serviceId)
        if (!row) continue
        const ref = this.ref(project, b)
        const container = pgContainerName(ref, newName)
        if (this.db.rename) await this.db.rename(row.container, container)
        const host = this.hostFor('postgres', newName, ref)
        mutate((st) => {
          const rows = st.branches[b.id].databases
          if (!rows?.[serviceId]) return
          rows[newId] = { ...rows[serviceId], url: rows[serviceId].url.replace(row.container, container), container, host }
          delete rows[serviceId]
          for (const x of st.branches[b.id].bindings ?? []) if (x.source === `postgres/${reg.name}`) x.source = `postgres/${newName}`
        })
        this.scheduler.rekey(this.serviceKey(b, serviceId), this.serviceKey(b, newId))                // WP3
      }
      mutate((st) => {
        const pr = st.projects[projectId]
        // renamedAt: metrics history under the new name starts now, not at creation (observedTargets' `since`).
        pr.dbServices = (pr.dbServices ?? []).map((d) => (d.id === serviceId ? { ...d, id: newId, name: newName, renamedAt: Date.now() } : d))
        for (const u of st.userSecrets[projectId] ?? []) if (u.service === `postgres/${reg.name}`) u.service = `postgres/${newName}`
      })
      this.router.invalidate()
      this.emit(projectId, null, 'resource', 'service.rename', { type: 'postgres', from: reg.name, to: newName })
      return { id: newId, type: 'postgres', name: newName, status: 'ready', pg_version: PG_VERSION }
    })
  }

  // ---- storage service registrations -------------------------------------------------------------

  /** Add a storage service to ONE branch: `opts.branch`, else the project's default branch. Same
   *  branch scoping, and the same reason for it, as `addDbService`. */
  async addStorageService(projectId: string, name: string, opts: { public?: boolean; branch?: string } = {}): Promise<ServiceRow> {
    return this.withOp(this.addKeys(projectId, opts.branch), () => this.addStorageServiceLocked(projectId, name, opts))
  }

  private async addStorageServiceLocked(projectId: string, name: string, opts: { public?: boolean; branch?: string } = {}): Promise<ServiceRow> {
    return this.serialize('provision', async () => {
      const project = this.getProject(projectId)
      if (!project) throw new Error('project not found')
      this.assertServiceName(name)
      const b = this.targetBranch(projectId, opts.branch)
      this.assertUsable(b, 'given new services')
      const existing = this.stList(projectId).find((s) => s.name === name)
      if (existing && this.carries(project, b, existing, 'storage')) throw new Error('service already exists on this branch')
      // Per branch, for the reason spelled out in `addDbService`.
      this.assertTypeCap(this.stList(projectId).filter((x) => this.carries(project, b, x, 'storage')).length, 'storage')
      const entry = existing ?? { id: storageServiceId(name), name, createdAt: Date.now(), ...(opts.public !== undefined ? { public: opts.public } : {}) }
      mutate((st) => {
        if (existing) return
        const pr = st.projects[projectId]
        pr.storageServices = [...(pr.storageServices ?? []), entry]
      })
      let made: string | undefined
      try {
        const out = await this.storage.provision(this.ref(project, b), b.network, name)
        made = out.bucket
        if (opts.public === true && this.storage.setAccess) await this.storage.setAccess(out.bucket, b.network, true)
        mutate((s) => { (s.branches[b.id].buckets ??= {})[entry.id] = { bucket: out.bucket, env: out.env, ...(opts.public !== undefined ? { public: opts.public } : {}) } })
      } catch (e) {
        if (made !== undefined) await this.storage.destroy(made, b.network).catch(() => { /* best-effort */ })
        mutate((s) => {
          delete s.branches[b.id].buckets?.[entry.id]
          // Only a registration THIS call made is rolled back: one that already existed is other
          // branches' service too.
          if (existing) return
          const pr = s.projects[projectId]
          pr.storageServices = (pr.storageServices ?? []).filter((x) => x.id !== entry.id)
        })
        await this.detachIfLastBucket(b)
        throw e
      }
      // The bucket vhost is a route in server mode, and the deploy alias list just grew.
      this.router.invalidate()
      this.emit(projectId, b.name, 'resource', 'service.added', { type: 'storage', name })
      return { id: entry.id, type: 'storage', name, status: 'ready', public: opts.public ?? false }
    })
  }

  /** Remove a storage service from ONE branch (`removalTarget`): purge and delete THAT branch's
   *  bucket, and unregister only once no branch carries the name any more. Branch-scoped for the
   *  reason spelled out on `removeDbService`. */
  async removeStorageService(projectId: string, serviceId: string, opts: { branch?: string } = {}): Promise<Teardown> {
    const { project, branch, sid } = this.removalTarget(projectId, serviceId, opts.branch)
    const reg = this.stList(projectId).find((s) => s.id === sid)
    if (!reg) throw new Error('service not found')
    this.assertCarries(project, branch, reg, 'storage')
    // The key this removal never took, plus the re-resolution it owes (see `freshRemoval`).
    return this.withOp([this.serviceKey(branch, sid)], async () => {
      const fresh = this.freshRemoval(projectId, branch.id, sid)
      const live = this.stList(projectId).find((x) => x.id === sid)
      if (!live || !this.carries(fresh.project, fresh.branch, live, 'storage')) throw movedUnderUs(sid, 'removal')
      return this.removeStorageLocked(fresh.project, fresh.branch, sid, live)
    })
  }

  private async removeStorageLocked(project: Project, branch: Branch, sid: string, reg: { id: string; name: string; public?: boolean }): Promise<Teardown> {
    const projectId = project.id
    const t = newTeardown()
    const row = this.bucketHandle(project, branch, sid)
    // The adapter now raises when it cannot prove the bucket is gone, and unregistering over a
    // bucket that is still there leaves objects and keys nobody can reach: the row stays.
    if (row) {
      const before = t.failed
      await count(t, () => this.storage.destroy(row.bucket, branch.network), `remove bucket ${row.bucket}`)
      if (t.failed !== before) return t
    }
    mutate((st) => {
      delete st.branches[branch.id].buckets?.[sid]
      st.branches[branch.id].bindings = (st.branches[branch.id].bindings ?? []).filter((x) => x.source !== `storage/${reg.name}`)
    })
    await this.detachIfLastBucket(branch)
    this.retireRegistration(project, reg, 'storage', `storage/${reg.name}`, branch)
    this.router.invalidate()
    this.emit(projectId, branch.name, 'resource', 'service.removed', { type: 'storage', name: reg.name })
    return t
  }

  /** Rename a storage service: a re-key only. The bucket handle is immutable (its name is baked
   *  into every object URL and into the access key scoped to it), exactly like the cloud. */
  async renameStorageService(projectId: string, serviceId: string, newName: string): Promise<ServiceRow> {
    return this.withRenameKeys(projectId, serviceId, () => this.renameStorageServiceLocked(projectId, serviceId, newName))
  }

  private async renameStorageServiceLocked(projectId: string, serviceId: string, newName: string): Promise<ServiceRow> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const reg = this.stList(projectId).find((s) => s.id === serviceId)
    if (!reg) throw new Error('service not found')
    this.assertServiceName(newName)
    const row = (name: string, id: string): ServiceRow => ({ id, type: 'storage', name, status: 'ready', public: reg.public ?? false })
    if (newName === reg.name) return row(reg.name, reg.id)
    if (this.stList(projectId).some((s) => s.name === newName)) throw new Error(`storage service "${newName}" already exists`)
    const newId = storageServiceId(newName)
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.storageServices = (pr.storageServices ?? []).map((s) => (s.id === serviceId ? { ...s, id: newId, name: newName } : s))
      for (const b of Object.values(st.branches)) {
        if (b.projectId !== projectId || !b.buckets?.[serviceId]) continue
        b.buckets[newId] = b.buckets[serviceId]
        delete b.buckets[serviceId]
        for (const x of b.bindings ?? []) if (x.source === `storage/${reg.name}`) x.source = `storage/${newName}`
      }
      for (const u of st.userSecrets[projectId] ?? []) if (u.service === `storage/${reg.name}`) u.service = `storage/${newName}`
    })
    this.router.invalidate()
    this.emit(projectId, null, 'resource', 'service.rename', { type: 'storage', from: reg.name, to: newName })
    return row(newName, newId)
  }

  // ---- bindings (`${{services.x.KEY}}`) ----------------------------------------------------------

  /** Bind one credential of one service into one compute group's env under a chosen name. */
  setBinding(projectId: string, branchName: string, b: { envName: string; target: string; source: string; sourceName: string }): void {
    const { branch } = this.branchOrThrow(projectId, branchName)
    if (!ENV_NAME_RE.test(b.envName)) throw new Error(`invalid env name: ${b.envName}`)
    mutate((st) => {
      const row = st.branches[branch.id]
      const list = (row.bindings ??= [])
      const i = list.findIndex((x) => x.envName === b.envName && x.target === b.target)
      if (i === -1) list.push({ ...b })
      else list[i] = { ...b }
    })
    this.emit(projectId, branch.name, 'govern', 'secrets.write', { name: b.envName, scope: branch.name, service: b.target, binding: b.source })
  }

  unsetBinding(projectId: string, branchName: string, envName: string, target: string): void {
    const { branch } = this.branchOrThrow(projectId, branchName)
    mutate((st) => {
      const row = st.branches[branch.id]
      row.bindings = (row.bindings ?? []).filter((x) => !(x.envName === envName && x.target === target))
    })
  }

  listBindings(projectId: string, branchName: string, target?: string): NonNullable<Branch['bindings']> {
    const { branch } = this.branchOrThrow(projectId, branchName)
    return (branch.bindings ?? []).filter((x) => (target ? x.target === target : true))
  }

  // ---- database routes over several postgres services (plan 05 section 6) -----------------------

  /** Which postgres service a `/database/*` request means: `?group=`, or the project's sole one. */
  dbTarget(projectId: string, branchName?: string, group?: string): { project: Project; branch: Branch; serviceId: string; container: string; url: string } {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    // The postgres services on THIS branch. Counting registrations another branch materialised
    // made `insta db url --branch feat` answer "multiple postgres services - specify one: a, b"
    // on a branch that carries exactly one of them, and pick one it does not carry when it was
    // the only registration.
    const list = this.dbList(projectId).filter((d) => this.carries(project, branch, d, 'postgres'))
    const reg = group !== undefined
      ? list.find((d) => d.name === group) ?? (() => { throw new Error(`postgres service not found: ${group}`) })()
      : list.length === 1 ? list[0]
        : list.length === 0 ? (() => { throw new Error('no postgres service in this project (add one with `insta services add postgres <name>`)') })()
          : (() => { throw new Error(`multiple postgres services - specify one: ${list.map((d) => d.name).sort().join(', ')}`) })()
    const row = this.dbHandle(project, branch, reg.id)
    if (!row) throw new Error(`postgres service not found: ${reg.name}`)
    return { project, branch, serviceId: reg.id, container: row.container, url: row.url }
  }

  // ---- boot-time repair --------------------------------------------------------------------------

  /** Best-effort rename of a legacy `io-<ref>-pg` container onto the `io-<ref>-pg-db` handle
   *  (decision 17). A no-op after WP4's data migration, which renames while moving the bytes; kept
   *  for an install that ran with `INSTA_OSS_DATA_MIGRATE=0`. */
  async migrateLegacyContainers(): Promise<void> {
    for (const b of Object.values(loadState().branches)) {
      const project = this.getProject(b.projectId)
      if (!project) continue
      const row = b.databases?.['pg-db']
      const legacy = `io-${this.ref(project, b)}-pg`
      if (!row || row.container !== legacy) continue
      const container = pgContainerName(this.ref(project, b), 'db')
      try { await this.db.rename?.(legacy, container) } catch { continue }
      mutate((st) => {
        const target = st.branches[b.id].databases?.['pg-db']
        if (!target) return
        target.url = target.url.replace(legacy, container)
        target.container = container
      })
      this.router.invalidate()
    }
  }
  // ---- end region WP5 ----
}
