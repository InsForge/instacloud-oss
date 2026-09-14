// Typed same-origin client over the instad API. Every mutation is HITL-aware: a 202 surfaces
// as {kind:'approval'} so any page can pop the approval modal and retry after the grant.
// This file is the seam that later extracts into the shared insta-ui package.
//
// Every route here exists on the cloud (contract 00 section 9). The browser holds no secret: the
// session is an httpOnly cookie the daemon sets, fetch sends it same-origin by default.

import type { DomainResult } from './lib/domains'
import type { TemplateVariable } from './lib/templateVars'

export type Project = { id: string; name: string; status: string }
export type BranchInfo = { id: string; name: string; is_default: boolean; status: string; created_at?: string }
export type ServiceType = 'postgres' | 'storage' | 'compute' | 'redis' | 'mysql' | 'mongodb'
/** One row of `GET /projects/:id`'s `resources`: what a single branch carries. The daemon's `kind`
 *  IS the service type (the cloud maps provider names like `neon`/`fly`/`s3` onto the same set). */
export type ProjectResource = { kind: string; name: string | null; branchId: string; status: string }
export type Service = {
  /** Opaque and branch-scoped (decision 49): `<branchId>:<serviceId>` off the default branch. */
  id: string; type: ServiceType; name: string; status: string
  machine_count?: number
  /** Bare hostname (`web-shop-main.<domain>`); the link is built from it plus the run mode. */
  domain?: string
  public?: boolean; desired_state?: string
  runtime?: 'online' | 'stopped' | 'none' | 'asleep' | 'suspended'
  /** `host[:port]` (a script may read it); never a URL (decision 40). */
  endpoint?: string
  updated_at?: string
  /** When the service was created (the console's Created column). */
  created_at?: string
  // Additive columns from the serverless routes (contract section 9, services row).
  always_on?: boolean; image?: string; port?: number; volume_gib?: number | null
  template_deployment_id?: string; template_code?: string; pg_version?: number
}
export type DbMetrics = {
  connections: { active: number; idle: number; total: number; max: number }
  dbSizeBytes: number; deadlocks: number
  tuples: { inserted: number; updated: number; deleted: number }; cacheHitRatio: number
}
export type DbActivityRow = {
  pid: number; state?: string; waitEvent?: string; durationMs?: number
  query?: string; application?: string; client?: string; queryStart?: string
}
export type DbQueryStatRow = { queryId: string; query: string; calls: number; meanMs: number; totalMs: number; rows: number }
export type DbQueryStats = { stats: DbQueryStatRow[]; extensionReady: boolean }
export type Operation = { id: string; action: string; status: string; createdAt?: string }
export type SecretTree = {
  projectWide: string[]
  branches: Array<{
    name: string; isDefault: boolean
    /** `minted` is the platform-issued subset of `secrets`: those reach every compute group in the
     *  branch, while the rest are user secrets bound to this service and reach only it.
     *
     *  `bindings` is the OTHER platform-owned subset: names a `${{services.x.KEY}}` binding maps
     *  into this compute group. They are not user secrets — `unsetUserSecret` does not remove one,
     *  and a user row of the same name is overridden because `envFor` applies bindings last — so a
     *  surface offering Edit or Delete has to exclude them. Only compute groups are targets.
     *
     *  `shadowsUserSecret` means a user secret of the SAME name also exists on this group. The
     *  binding still wins, so the row is a binding — but the dead user row underneath it is real
     *  and removable, and `secrets` lists the name once because the container receives one value
     *  for it. */
    services: Array<{
      type: string; name: string; secrets: string[]; minted: string[]
      bindings: Array<{ envName: string; source: string; sourceName: string; shadowsUserSecret: boolean }>
    }>
    unbound: string[]
  }>
}
/** The observability components the daemon serves logs and metrics for. Each managed database is
 *  its own component and is never folded into `db` (server.ts: `component must be
 *  db|compute|redis|mysql|mongodb`), so asking for `db` on a Redis service answers about Postgres. */
export type ObsComponent = 'compute' | 'db' | 'redis' | 'mysql' | 'mongodb'

/** Service type as the services list reports it, to the component that observes it. `storage` has
 *  no container of its own, so it has neither logs nor metrics and gets neither tab. */
export function obsComponentFor(type: string): ObsComponent | undefined {
  if (type === 'compute') return 'compute'
  if (type === 'postgres') return 'db'
  if (type === 'redis' || type === 'mysql' || type === 'mongodb') return type
  return undefined
}

export type LogLine = { ts: string; level?: string; message: string; instance?: string }
export type LogsResult = { source: string; lines: LogLine[]; note?: string }
export type MetricSeries = { name: string; unit?: string; labels?: Record<string, string>; points: Array<[number, number]> }
export type MetricsResult = { source: string; series: MetricSeries[]; note?: string }
export type Approval = { id: string; action: string; status: string; requested_at: string; decided_at: string | null }
export type AuditEvent = { id: string; branch: string | null; source: string; kind: string; payload: unknown; created_at: string }
export type Decision = 'allow' | 'deny' | 'approve'
export type Policy = Record<string, Decision>

export type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'approval'; action: string; approvalId: string }
  | { kind: 'error'; status: number; error: string; body?: unknown }

/** Set by AuthGate in server mode: a 401 outside the auth pages sends the SPA back to /login. */
let onUnauthorized: (() => void) | null = null
export function setOnUnauthorized(fn: (() => void) | null): void { onUnauthorized = fn }
const AUTH_PAGES = new Set(['/login', '/setup'])

function errorText(data: unknown, status: number): string {
  const d = data as { error?: unknown; message?: unknown; code?: unknown } | null
  if (typeof d?.error === 'string' && d.error) return d.error
  if (typeof d?.message === 'string' && d.message) return d.message
  if (typeof d?.code === 'string' && d.code) return d.code
  return `HTTP ${status}`
}

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    return { kind: 'error', status: 0, error: 'daemon unreachable' }
  }
  const data = await res.json().catch(() => ({}))
  // A 202 template-deployment accept has no status:'approval_required' and falls through as ok.
  if (res.status === 202 && data?.status === 'approval_required') {
    return { kind: 'approval', action: data.action, approvalId: data.approvalId }
  }
  if (res.status === 401 && onUnauthorized && !path.startsWith('/api/auth/') && !AUTH_PAGES.has(location.pathname)) {
    onUnauthorized()
  }
  if (!res.ok) return { kind: 'error', status: res.status, error: errorText(data, res.status), body: data }
  return { kind: 'ok', data: data as T }
}

/** GET that throws on failure (for read paths driven by usePoll); the thrown error carries `status`. */
async function get<T>(path: string): Promise<T> {
  const r = await call<T>('GET', path)
  if (r.kind === 'ok') return r.data
  if (r.kind === 'approval') throw new Error(`approval required: ${r.action}`)
  throw Object.assign(new Error(r.error), { status: r.status })
}

/** `?a=1&b=2` from defined entries only. */
function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const api = {
  health: () => get<{ ok: boolean }>('/healthz'),
  projects: async () => (await get<{ projects: Project[] }>('/orgs/local/projects')).projects,
  branches: async (p: string) => (await get<{ branches: BranchInfo[] }>(`/projects/${p}/branches`)).branches,
  /** Branches AND the resources each one carries, in one call. The console builds its Environments
   *  table from exactly this (`GET /projects/{projectId}` + `mapEnvironments`), deriving a branch's
   *  service types by matching `resource.branchId`, rather than asking per environment. */
  projectDetail: (p: string) => get<{ branches: BranchInfo[]; resources: ProjectResource[] }>(`/projects/${p}`),
  services: async (p: string, branch: string) =>
    (await get<{ services: Service[] }>(`/projects/${p}/services${qs({ branch })}`)).services,
  approvals: async (p: string) => (await get<{ approvals: Approval[] }>(`/projects/${p}/approvals`)).approvals,
  policy: async (p: string) => (await get<{ policy: Policy }>(`/projects/${p}/policy`)).policy,
  events: async (p: string, limit = 30) => (await get<{ events: AuditEvent[] }>(`/projects/${p}/events?limit=${limit}`)).events,
  /** `group` narrows to ONE service's container. It matters for more than bandwidth: the daemon
   *  merges every container in the component and truncates to `limit` LAST, so a noisy sibling can
   *  fill the whole window and a quiet service looks like it has no logs at all. */
  logs: (p: string, component: ObsComponent, branch: string, limit = 200, group?: string) =>
    get<LogsResult>(`/projects/${p}/logs${qs({ component, branch, limit, group })}`),
  /** `group` narrows to one service's container, as on the logs route. `window` is the cloud's
   *  from/to (unix seconds) and step ("60s", "5m", "1h"); omitted, the daemon answers the last hour. */
  metrics: (p: string, component: ObsComponent, branch: string, group?: string, window: { from?: number; to?: number; step?: string } = {}) =>
    get<MetricsResult>(`/projects/${p}/metrics${qs({ component, branch, group, ...window })}`),

  // Names-only inventory: the dashboard never shows secret VALUES (plan v1 non-goal; values
  // stay behind `insta secrets`, secrets.read-gated). This route emits no audit event.
  secretTree: (p: string) => get<SecretTree>(`/projects/${p}/secrets/tree`),
  /** The same read, returning an approval instead of throwing: the canvas stops polling a gated tree. */
  secretTreeResult: (p: string) => call<SecretTree>('GET', `/projects/${p}/secrets/tree`),
  // Database reads answer 503 `database is sleeping` when the branch database is asleep and
  // never wake it (decision 48); `group` picks one of several postgres services (WP5).
  dbMetrics: (p: string, branch: string, group?: string) =>
    get<DbMetrics>(`/projects/${p}/database/metrics${qs({ branch, group })}`),
  dbActivity: async (p: string, branch: string, group?: string) =>
    (await get<{ queries: DbActivityRow[] }>(`/projects/${p}/database/activity${qs({ branch, group })}`)).queries,
  dbQueryStats: (p: string, branch: string, group?: string) =>
    get<DbQueryStats>(`/projects/${p}/database/query-stats${qs({ branch, group, limit: 20 })}`),
  operations: async (p: string, limit = 50) =>
    (await get<{ operations: Operation[] }>(`/projects/${p}/operations?limit=${limit}`)).operations,

  /** `service` binds an environment-scoped secret to one service (`<type>/<name>`, as the CLI's
   *  `--service` sends it); omitted, the secret is shared by the environment or the project. */
  setSecret: (p: string, name: string, value: string, branch?: string, service?: string) =>
    call<{ ok: boolean }>('PUT', `/projects/${p}/secrets/${encodeURIComponent(name)}`,
      { value, ...(branch ? { branch } : {}), ...(branch && service ? { service } : {}) }),
  unsetSecret: (p: string, name: string, branch?: string) =>
    call<{ ok: boolean }>('DELETE', `/projects/${p}/secrets/${encodeURIComponent(name)}${qs({ branch })}`),
  renameService: (p: string, sid: string, name: string, branch?: string) =>
    call<{ service: Service }>('POST', `/projects/${p}/services/${sid}/rename${qs({ branch })}`, { name }),
  lifecycle: (p: string, sid: string, verb: 'start' | 'stop' | 'suspend' | 'restart', branch: string) =>
    call<{ service?: Service; state?: string }>('POST', `/projects/${p}/services/${sid}/${verb}${qs({ branch })}`),
  setAccess: (p: string, sid: string, isPublic: boolean, branch: string) =>
    call<{ service?: Service }>('PUT', `/projects/${p}/services/${sid}/access`, { public: isPublic, branch }),

  createBranch: (p: string, name: string, from: string) =>
    call<{ branch: { id: string; name: string } }>('POST', `/projects/${p}/branches`, { name, from }),
  deleteBranch: (p: string, branchId: string) =>
    call<Teardown>('DELETE', `/projects/${p}/branches/${branchId}`),
  removeService: (p: string, sid: string, branch?: string) =>
    call<Teardown>('DELETE', `/projects/${p}/services/${sid}${qs({ branch })}`),
  setPolicy: (p: string, action: string, decision: Decision) =>
    call<{ policy: Policy }>('PUT', `/projects/${p}/policy/${action}`, { decision }),
  decide: (p: string, approvalId: string, verdict: 'approve' | 'deny', always = false) =>
    call<{ approval: Approval }>('POST', `/projects/${p}/approvals/${approvalId}/${verdict}`, always ? { always } : undefined),

  // ---- region WP7 ----
  // Types and api methods for the serverless routes (templates, credentials, sleep/wake, domains,
  // auth) live below this marker (WP7 owns the file; the marker is for the dashboard-side contract
  // tests other packages read).

  // Identity (WP1): Better Auth mount for the dashboard, `/tokens` for `insta_` keys.
  getSession: () => get<SessionInfo>('/api/auth/get-session'),
  signUp: (b: { name?: string; email: string; password: string }) =>
    call<{ token: string | null; user: BetterAuthUser }>('POST', '/api/auth/sign-up/email', b),
  signIn: (b: { email: string; password: string }) =>
    call<{ redirect: boolean; token: string; user: BetterAuthUser }>('POST', '/api/auth/sign-in/email', { ...b, rememberMe: true }),
  signOut: () => call<{ success: boolean }>('POST', '/api/auth/sign-out', {}),
  me: () => get<{ user: PublicUser; via?: 'jwt' | 'api' }>('/me'),
  tokens: async () => (await get<{ tokens: ApiToken[] }>('/tokens')).tokens,
  createToken: (b: { name: string; expiresInDays?: number }) =>
    call<{ token: string; record: ApiToken }>('POST', '/tokens', b),
  revokeToken: (id: string) => call<{ ok: boolean }>('DELETE', `/tokens/${encodeURIComponent(id)}`),

  // Health, wake, always-on, limits (WP3).
  runtimeHealth: async (p: string, branch: string) =>
    (await get<{ services: RuntimeHealthRow[] }>(`/projects/${p}/runtime-health${qs({ branch })}`)).services,
  setAlwaysOn: (p: string, sid: string, enabled: boolean, branch?: string) =>
    call<{ service: Service }>('PUT', `/projects/${p}/services/${sid}/always-on${qs({ branch })}`, { enabled }),
  limits: (p: string, sid: string, branch?: string) =>
    get<LimitsResult>(`/projects/${p}/services/${sid}/limits${qs({ branch })}`),
  setLimits: (p: string, sid: string, b: { memoryMb: number; cpu?: number }, branch?: string) =>
    call<LimitsResult & { service?: Service; changed?: boolean }>('PUT', `/projects/${p}/services/${sid}/limits${qs({ branch })}`, b),
  volume: (p: string, sid: string, branch?: string) =>
    get<VolumeResult>(`/projects/${p}/services/${sid}/volume${qs({ branch })}`),
  setVolume: (p: string, sid: string, sizeGib: number, branch?: string) =>
    call<VolumeResult & { service?: Service }>('PUT', `/projects/${p}/services/${sid}/volume${qs({ branch })}`, { sizeGib }),
  dbInstance: (p: string, branch: string, group?: string) =>
    get<DbInstance>(`/projects/${p}/database/instance${qs({ branch, group })}`),
  dbSettings: (p: string, branch: string, patch: { scaleToZero?: boolean; idleTimeout?: number; cpu?: string; memory?: string; volumeSize?: string }, group?: string) =>
    call<DbInstance>('PATCH', `/projects/${p}/database/settings${qs({ branch, group })}`, patch),

  // Services add (WP5), image deploy (today), templates (WP5).
  addService: (p: string, b: { type: ServiceType; name: string; branch?: string; public?: boolean; image?: string; port?: number; alwaysOn?: boolean; volumeGib?: number }) =>
    call<{ service: Service }>('POST', `/projects/${p}/services`, b),
  deployImage: (p: string, b: { image: string; port: number; group: string; branch: string }) =>
    call<DeployResult>('POST', `/projects/${p}/deploy`, b),
  // `hostArchitecture` rides the envelope on both routes because it belongs to the BOX, not to a
  // template. Stamped onto each row here so a card can answer "will this run on this machine"
  // without threading a second value through four components.
  templates: async () => {
    const r = await get<{ templates: TemplateListItem[]; hostArchitecture?: string }>('/templates')
    return r.templates.map((t) => ({ ...t, hostArchitecture: r.hostArchitecture }))
  },
  template: async (code: string) => {
    const r = await get<{ template: TemplateDetail; hostArchitecture?: string }>(`/templates/${encodeURIComponent(code)}`)
    return { ...r.template, hostArchitecture: r.hostArchitecture }
  },
  deployTemplate: (p: string, b: { templateCode: string; branch: string; variables: Record<string, string>; deploymentId?: string }) =>
    call<{ deploymentId: string; deployment: TemplateDeployment }>('POST', `/projects/${p}/template-deployments`, b),
  templateDeployment: (id: string) => get<TemplateDeployment>(`/template-deployments/${encodeURIComponent(id)}`),

  // Custom domains (WP2): the four cloud routes; hidden by the UI in local mode (decision 25).
  domains: async (p: string, branch: string, group: string) =>
    (await get<{ items: DomainResult[] }>(`/projects/${p}/compute/domains${qs({ branch, group })}`)).items,
  addDomain: (p: string, b: { hostname: string; branch: string; group: string }) =>
    call<DomainResult>('POST', `/projects/${p}/compute/domain`, b),
  domainStatus: (p: string, q: { hostname: string; branch: string; group: string }) =>
    get<DomainResult>(`/projects/${p}/compute/domain${qs(q)}`),
  removeDomain: (p: string, b: { hostname: string; branch: string; group: string }) =>
    call<{ hostname: string; flyApp?: string }>('DELETE', `/projects/${p}/compute/domain`, b),
}

export type Teardown = { teardown?: { destroyed: number; failed: number } }
export type DeployResult = { url?: string; branch?: string; group?: string }

/** The cloud's PublicUser (openapi PublicUser); local mode answers `{id:'local', email:null}`. */
export type PublicUser = { id: string; email: string | null; name: string | null; avatarUrl?: string | null; emailVerified?: boolean }
export type BetterAuthUser = { id: string; name: string; email: string; emailVerified: boolean; image?: string | null; createdAt: string; updatedAt: string }
export type SessionInfo = {
  session: { id: string; token?: string; userId: string; expiresAt: string; createdAt: string; updatedAt: string; ipAddress?: string; userAgent?: string }
  user: BetterAuthUser
} | null
/** openapi ApiToken: the public view, never the secret. */
export type ApiToken = {
  id: string; name: string; prefix: string; scopes: string[]
  lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string; orgId?: string | null
}

export type RuntimeHealthRow = { serviceId: string; status: string; machines: number; failing: number }
export type ServiceLimits = { cpu: number; memoryMb: number }
export type LimitsResult = {
  limits: ServiceLimits
  cap: { cpu: number; memoryMb: number; volumeGib: number }
  volume?: { sizeGib: number; mountPath: string } | null
}
export type VolumeResult = { volume: { sizeGib: number; mountPath: string } | null; cap: { volumeGib: number }; attached?: boolean }
/** openapi DbInstanceInfo, the fields the dashboard reads. */
export type DbInstance = {
  id: string; name: string; state: string; host: string; port: number
  scaleToZero: boolean; idleTimeoutSecs?: number; cpuMilli?: number; memoryMib?: number
  volumeSize?: string; volumeGib?: number; cap?: Record<string, unknown>
}

/** openapi TemplateListItem; `logoUrl` is a data: URI on self-host (decision 29) or null. */
export type TemplateListItem = {
  code: string; version: string; name: string; tagline: string; category: string; tags: string[]
  logoUrl: string | null; license: string | null; updatedAt?: string
  /** OCI architecture names the deployable image is published for; absent when the manifest makes
   *  no claim. Self-host only: the cloud picks the machine, so its gallery has no use for it. */
  architectures?: string[] | null
  /** Not a field of the row on the wire: the api helper copies it off the response envelope. */
  hostArchitecture?: string
  requiredVarCount?: number; requiredVars?: TemplateVariable[]
  totalProjects?: number; activeProjects?: number; successRate?: number | null
  deploymentCount?: number; activeDeploymentCount?: number
}
export type TemplateService = {
  type: string; image?: string; port?: number; healthcheck?: string; volume?: boolean; alwaysOn?: boolean
  env?: Record<string, unknown>
}
/** openapi TemplateDetail. */
export type TemplateDetail = TemplateListItem & {
  maintainer?: string; source?: string
  upstream?: { repo?: string; image?: string; pinned?: string; license?: string } & Record<string, unknown>
  services?: Record<string, TemplateService>
  variables?: { required?: TemplateVariable[]; optional?: TemplateVariable[] }
  constraints?: unknown[]
  readme?: string | null
  documentationUrl?: string | null
}
export type TemplateDeploymentStatus = 'running' | 'succeeded' | 'failed' | 'partial'
export type TemplateDeploymentStep = 'create_services' | 'write_variables' | 'deploy' | 'health_check'
export type TemplateDeploymentService = {
  name: string; serviceId?: string; url?: string
  state: 'pending' | 'created' | 'deployed' | 'healthy' | 'failed'
}
/** openapi TemplateDeployment (unwrapped on GET /template-deployments/:id). */
export type TemplateDeployment = {
  id: string; status: TemplateDeploymentStatus; step: TemplateDeploymentStep
  templateCode: string; templateVersion: string; projectId: string; branchId: string
  services: TemplateDeploymentService[]
  error?: string; logsTail?: string; createdAt: string
}
export type { DomainResult } from './lib/domains'
export type { TemplateVariable } from './lib/templateVars'

export function relTime(iso?: string): string {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min${Math.round(s / 60) === 1 ? '' : 's'} ago`
  if (s < 86400) return `${Math.round(s / 3600)} hr${Math.round(s / 3600) === 1 ? '' : 's'} ago`
  return `${Math.round(s / 86400)} d ago`
}
