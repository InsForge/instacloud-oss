// The self-hosted MCP tool catalog. Mirrors the cloud MCP's `insta_*` tool names (docs/reference/
// mcp-tools.mdx) so an agent's muscle memory carries over, but every tool maps to a route THIS
// daemon actually serves — the cloud-only ones (billing, usage, scale/upgrade, GitHub source,
// secret bindings, deploy-events, domain purchase) are omitted rather than surfaced as dead 501s.
//
// A tool is pure data: a name, a description, a JSON-Schema for its arguments, and a `build` that
// turns validated arguments into an HTTP request against the daemon's own API. The MCP route
// executes that request over loopback WITH THE CALLER'S TOKEN, so auth, per-action governance
// (the 202 approval envelope), validation and response shapes are the API's, never re-implemented
// here. Pure, so the catalog is unit-tested under the root vitest config with no network.

export type McpToolRequest = { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; body?: unknown }

export type McpTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  build: (args: Record<string, unknown>) => McpToolRequest
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))
const enc = (v: unknown): string => encodeURIComponent(str(v))
/** A query string from defined, non-empty params (mirrors ui/src/api.ts `qs`). */
function qs(params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

// Reused schema fragments.
const projectId = { type: 'string', description: 'The project id.' }
const branch = { type: 'string', description: 'Branch name (defaults to the project default, usually "main").' }
const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> =>
  ({ type: 'object', properties, required, additionalProperties: false })

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'insta_whoami',
    description: 'The authenticated identity on this daemon.',
    inputSchema: obj({}),
    build: () => ({ method: 'GET', path: '/me' }),
  },
  {
    name: 'insta_project_list',
    description: 'List the projects on this daemon.',
    inputSchema: obj({}),
    build: () => ({ method: 'GET', path: '/orgs/local/projects' }),
  },
  {
    name: 'insta_project_get',
    description: 'A project with its branches and the resources each carries.',
    inputSchema: obj({ projectId }, ['projectId']),
    build: (a) => ({ method: 'GET', path: `/projects/${enc(a.projectId)}` }),
  },
  {
    name: 'insta_project_create',
    description: 'Create a new, empty project.',
    inputSchema: obj({ name: { type: 'string', description: 'Project name.' } }, ['name']),
    build: (a) => ({ method: 'POST', path: '/orgs/local/projects', body: { name: str(a.name) } }),
  },
  {
    name: 'insta_manifest',
    description: 'The agent-legible view of a project: branches and services. Alias of project_get.',
    inputSchema: obj({ projectId }, ['projectId']),
    build: (a) => ({ method: 'GET', path: `/projects/${enc(a.projectId)}` }),
  },
  {
    name: 'insta_branch_list',
    description: 'List a project’s branches.',
    inputSchema: obj({ projectId }, ['projectId']),
    build: (a) => ({ method: 'GET', path: `/projects/${enc(a.projectId)}/branches` }),
  },
  {
    name: 'insta_branch_create',
    description: 'Create a branch, optionally empty (no services/secrets copied from the parent).',
    inputSchema: obj({
      projectId, name: { type: 'string', description: 'New branch name (lower-kebab).' },
      from: { type: 'string', description: 'Parent branch to fork from (default the project default).' },
      excludeServices: { type: 'boolean', description: 'Create an empty branch: copy no services, secrets or bindings.' },
    }, ['projectId', 'name']),
    build: (a) => ({
      method: 'POST', path: `/projects/${enc(a.projectId)}/branches`,
      body: { name: str(a.name), ...(a.from ? { from: str(a.from) } : {}), ...(a.excludeServices ? { excludeServices: true } : {}) },
    }),
  },
  {
    name: 'insta_service_list',
    description: 'List the services on a branch (databases, storage, compute).',
    inputSchema: obj({ projectId, branch }, ['projectId']),
    build: (a) => ({ method: 'GET', path: `/projects/${enc(a.projectId)}/services${qs({ branch: a.branch })}` }),
  },
  {
    name: 'insta_service_add',
    description: 'Add a service to a branch. Types: postgres, redis, mysql, mongodb, storage, compute.',
    inputSchema: obj({
      projectId,
      type: { type: 'string', enum: ['postgres', 'redis', 'mysql', 'mongodb', 'storage', 'compute'], description: 'Service type.' },
      name: { type: 'string', description: 'Service name (lower-kebab).' },
      branch,
      public: { type: 'boolean', description: 'Storage only: serve the bucket with anonymous public-read.' },
      volumeGib: { type: 'number', description: 'Compute only: attach a volume of this size (GiB).' },
    }, ['projectId', 'type', 'name']),
    build: (a) => ({
      method: 'POST', path: `/projects/${enc(a.projectId)}/services`,
      body: {
        type: str(a.type), name: str(a.name), ...(a.branch ? { branch: str(a.branch) } : {}),
        ...(a.public !== undefined ? { public: !!a.public } : {}),
        ...(a.volumeGib !== undefined ? { volumeGib: Number(a.volumeGib) } : {}),
      },
    }),
  },
  {
    name: 'insta_service_remove',
    description: 'Remove a service from a branch (permanent teardown of its data).',
    inputSchema: obj({ projectId, serviceId: { type: 'string', description: 'Service id from insta_service_list.' }, branch }, ['projectId', 'serviceId']),
    build: (a) => ({ method: 'DELETE', path: `/projects/${enc(a.projectId)}/services/${enc(a.serviceId)}${qs({ branch: a.branch })}` }),
  },
  {
    name: 'insta_deploy',
    description: 'Deploy a container image to a compute service (creates or redeploys it).',
    inputSchema: obj({
      projectId,
      image: { type: 'string', description: 'Container image ref, e.g. nginx:alpine.' },
      group: { type: 'string', description: 'Compute service (group) name.' },
      port: { type: 'number', description: 'Port the container listens on.' },
      branch,
    }, ['projectId', 'image']),
    build: (a) => ({
      method: 'POST', path: `/projects/${enc(a.projectId)}/deploy`,
      body: { image: str(a.image), ...(a.group ? { group: str(a.group) } : {}), ...(a.port !== undefined ? { port: Number(a.port) } : {}), ...(a.branch ? { branch: str(a.branch) } : {}) },
    }),
  },
  {
    name: 'insta_secrets_list',
    description: 'List secret NAMES for a project (values are never returned).',
    inputSchema: obj({ projectId }, ['projectId']),
    build: (a) => ({ method: 'GET', path: `/projects/${enc(a.projectId)}/secrets/tree` }),
  },
  {
    name: 'insta_secrets_set',
    description: 'Set a secret’s value on a branch, optionally bound to one service (“<type>/<name>”).',
    inputSchema: obj({
      projectId, name: { type: 'string', description: 'Secret name.' },
      value: { type: 'string', description: 'Secret value.' }, branch,
      service: { type: 'string', description: 'Bind to this service, as "<type>/<name>" (e.g. postgres/db).' },
    }, ['projectId', 'name', 'value']),
    build: (a) => ({
      method: 'PUT', path: `/projects/${enc(a.projectId)}/secrets/${enc(a.name)}`,
      body: { value: str(a.value), ...(a.branch ? { branch: str(a.branch) } : {}), ...(a.service ? { service: str(a.service) } : {}) },
    }),
  },
  {
    name: 'insta_secrets_unset',
    description: 'Remove a secret (optionally only the copy bound to one service).',
    inputSchema: obj({ projectId, name: { type: 'string' }, branch, service: { type: 'string', description: 'Only the copy bound to this "<type>/<name>".' } }, ['projectId', 'name']),
    build: (a) => ({ method: 'DELETE', path: `/projects/${enc(a.projectId)}/secrets/${enc(a.name)}${qs({ branch: a.branch, service: a.service })}` }),
  },
  {
    name: 'insta_db_query',
    description: 'Run ONE SQL statement against a branch’s Postgres. SELECT returns rows; else a command tag.',
    inputSchema: obj({
      projectId, sql: { type: 'string', description: 'A single SQL statement.' }, branch,
      group: { type: 'string', description: 'Which postgres service, if the branch has several.' },
    }, ['projectId', 'sql']),
    build: (a) => ({
      method: 'POST', path: `/projects/${enc(a.projectId)}/database/query`,
      body: { sql: str(a.sql), ...(a.branch ? { branch: str(a.branch) } : {}), ...(a.group ? { group: str(a.group) } : {}) },
    }),
  },
  {
    name: 'insta_logs',
    description: 'Recent runtime logs for a component (compute | db | redis | mysql | mongodb).',
    inputSchema: obj({
      projectId,
      component: { type: 'string', enum: ['compute', 'db', 'redis', 'mysql', 'mongodb'], description: 'Which component’s logs.' },
      branch, group: { type: 'string', description: 'Narrow to one service’s container.' },
      limit: { type: 'number', description: 'Max lines (default 200).' },
    }, ['projectId', 'component']),
    build: (a) => ({ method: 'GET', path: `/projects/${enc(a.projectId)}/logs${qs({ component: a.component, branch: a.branch, group: a.group, limit: a.limit })}` }),
  },
  {
    name: 'insta_metrics',
    description: 'CPU/memory/network time series for a component.',
    inputSchema: obj({
      projectId, component: { type: 'string', enum: ['compute', 'db', 'redis', 'mysql', 'mongodb'] },
      branch, group: { type: 'string' },
    }, ['projectId', 'component']),
    build: (a) => ({ method: 'GET', path: `/projects/${enc(a.projectId)}/metrics${qs({ component: a.component, branch: a.branch, group: a.group })}` }),
  },
  {
    name: 'insta_events',
    description: 'The project’s activity/audit timeline (deploys, lifecycle, secrets, and more).',
    inputSchema: obj({
      projectId, branch, limit: { type: 'number', description: 'Max events (default 50, up to 1000).' },
      kinds: { type: 'string', description: 'Comma-separated event kinds to keep, e.g. "deploy,service.wake".' },
    }, ['projectId']),
    build: (a) => ({ method: 'GET', path: `/projects/${enc(a.projectId)}/events${qs({ branch: a.branch, limit: a.limit, kinds: a.kinds })}` }),
  },
]

/** Look up a tool by name. */
export function findTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((t) => t.name === name)
}
