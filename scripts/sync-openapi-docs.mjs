#!/usr/bin/env node
// Curate the hosted platform's OpenAPI document into the three token-level reference specs the
// docs render (docs/openapi/{account,org,project}.json) and rewrite the "API" group of
// docs/docs.json to match.
//
//   node scripts/sync-openapi-docs.mjs            # fetch https://api.instacloud.com/openapi.json
//   node scripts/sync-openapi-docs.mjs --from f.json
//   node scripts/sync-openapi-docs.mjs --check    # exit 1 when the committed files are stale
//
// Source of truth is the platform itself: it serves the spec its routes are registered with, so
// nothing here is hand-typed. What this script adds is (1) the split by which API token can call
// an operation, mirroring the platform's own route classification (insta-platform
// src/auth/tokenScope.ts classifyTokenRoute), (2) a curation list that drops browser-only and
// console-internal transport routes, (3) page titles short enough for a sidebar, and (4) the
// public base URL, which the platform's own document does not carry.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = join(ROOT, 'docs')
const OUT_DIR = join(DOCS, 'openapi')
const DOCS_JSON = join(DOCS, 'docs.json')
const SOURCE_URL = 'https://api.instacloud.com/openapi.json'
const PUBLIC_SERVER = { url: 'https://api.instacloud.com', description: 'InstaCloud' }
const OVERVIEW_PAGE = 'reference/api/overview'

// ---- 1. classification: a port of classifyTokenRoute onto OpenAPI `{param}` paths ----------
const OPEN_PREFIXES = ['/healthz', '/.well-known/', '/webhooks/', '/templates', '/regions', '/images/inspect', '/openapi', '/internal/']
const ACCOUNT_PREFIXES = ['/me/', '/auth/', '/admin/', '/agent/', '/terminal/', '/api/auth/', '/community/', '/invitations/']
const PROJECT_TOKEN_ORG_READS = new Set(['/orgs/{orgId}', '/orgs/{orgId}/projects'])

function classify(method, path, op) {
  if (Array.isArray(op.security) && op.security.length === 0) return 'open'
  if (OPEN_PREFIXES.some(p => path === p || path.startsWith(p))) return 'open'
  if (path === '/me') return method === 'GET' ? 'me' : 'account'
  if (path === '/tokens' || path.startsWith('/tokens/')) return 'tokens'
  if (path === '/orgs') return method === 'GET' ? 'orgs-list' : 'account'
  if (path === '/orgs/checkout') return 'account'
  if (ACCOUNT_PREFIXES.some(p => path.startsWith(p))) return 'account'
  if (path.startsWith('/orgs/{orgId}')) return 'org'
  if (path.startsWith('/projects/{projectId}') || path.startsWith('/projects/{id}') || path.startsWith('/template-deployments/{deploymentId}')) return 'project'
  return undefined
}

// Which of the three token bindings may call an operation of this kind.
function scopesFor(kind, method, path) {
  switch (kind) {
    case 'open': case 'me': case 'project': return ['account', 'org', 'project']
    case 'account': return ['account']
    case 'orgs-list': case 'tokens': return ['account', 'org']
    case 'org': return method === 'GET' && PROJECT_TOKEN_ORG_READS.has(path) ? ['account', 'org', 'project'] : ['account', 'org']
  }
  throw new Error(`unknown kind ${kind}`)
}

// Which reference file an operation lands in.
const LEVEL_OF = { open: 'account', me: 'account', account: 'account', 'orgs-list': 'account', tokens: 'account', org: 'org', project: 'project' }

// ---- 2. curation: routes that exist for browsers, the console, or the CLI's own transport -----
const EXCLUDE = [
  /^\w+ \/(healthz|\.well-known|webhooks|auth|api\/auth|agent|community|internal|openapi|admin|terminal)(\/|$)/, // public plumbing, browser auth flows, agent enrollment, staff, terminal
  /^\w+ \/me\/(github|feedback-assertion|accounts)(\/|$)/, // interactive identity linking
  /^\w+ \/orgs\/checkout$/,            // Stripe Checkout that also creates the org: a browser flow
  /^\w+ \/invitations\/accept$/,       // clicked from an email
  /^GET \/images\/inspect$/,           // console helper
  /^\w+ \/projects\/\{id\}\/github\//, // GitHub App flows need the interactive link above
  /\/database\/console\//,             // the console's data browser
  /\/(terminal-ticket|ssh-cert|ssh-target)$/, // CLI / console transport for shells
]

// ---- 3. presentation --------------------------------------------------------------------------
const ACRONYMS = { api: 'API', ssh: 'SSH', url: 'URL', sql: 'SQL', id: 'ID', dns: 'DNS', ssl: 'SSL', github: 'GitHub', mongo: 'Mongo', redis: 'Redis' }
function titleFromOperationId(id) {
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(' ')
  const mapped = words.map(w => ACRONYMS[w] ?? w)
  mapped[0] = mapped[0][0].toUpperCase() + mapped[0].slice(1)
  return mapped.join(' ')
}

const LEVELS = {
  account: { label: 'Account level', file: 'account.json', dir: 'reference/api/account',
    blurb: 'Endpoints that act as the token\'s owner: their organizations, their API tokens, and the public catalog. Creating an organization needs an account-wide token.' },
  org: { label: 'Organization level', file: 'org.json', dir: 'reference/api/org',
    blurb: 'Endpoints under `/orgs/{orgId}`: members, projects, billing, domains. Callable with an account-wide token or a token bound to that organization.' },
  project: { label: 'Project level', file: 'project.json', dir: 'reference/api/project',
    blurb: 'Endpoints under `/projects/{projectId}`: branches, services, deploys, secrets, databases, storage, cron, observability, governance. Callable with any token whose binding covers the project.' },
}
// Tag order inside each level; tags not listed sort after these, alphabetically.
const TAG_ORDER = ['Account', 'Organization', 'Catalog', 'Projects', 'Branches', 'Services', 'Deploy', 'Compute', 'Secrets', 'Database', 'Storage', 'Backups', 'Cron', 'Observability', 'Governance', 'Audit', 'Domains', 'Billing', 'Templates']
const TAG_DESCRIPTIONS = {
  Account: 'The caller, their organizations and API tokens.',
  Organization: 'The organization itself: name, members, invitations.',
  Catalog: 'Public catalogs: templates and regions. No authentication required.',
  Projects: 'Projects inside an organization.',
  Branches: 'Branch environments of a project: isolated database, storage and compute per branch.',
  Services: 'Services on a branch: compute, postgres, storage and managed databases.',
  Deploy: 'Deploy an image or a source to a compute service.',
  Compute: 'Build output of a compute service.',
  Secrets: 'User secrets, service credentials and how they bind into compute env.',
  Database: 'Postgres databases, extensions, credentials and ad-hoc SQL.',
  Storage: 'Objects in a storage service.',
  Backups: 'Database backups and restores.',
  Cron: 'Scheduled HTTP calls against a service or an external URL.',
  Observability: 'Logs, metrics, deploy events and database insight.',
  Governance: 'Per-project agent policy and the approval queue.',
  Audit: 'The project\'s event timeline, including agent-ingested events.',
  Domains: 'Domains bought through InstaCloud, bring-your-own zones and their DNS records.',
  Billing: 'Usage, cycles, invoices and credits.',
  Templates: 'Deploy a template into a project.',
}
const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

// ---- helpers ----------------------------------------------------------------------------------
const args = process.argv.slice(2)
const fromIdx = args.indexOf('--from')
const check = args.includes('--check')

async function loadSource() {
  if (fromIdx >= 0) return JSON.parse(readFileSync(args[fromIdx + 1], 'utf8'))
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`${SOURCE_URL} answered ${res.status}`)
  return res.json()
}

function collectRefs(node, into) {
  if (Array.isArray(node)) { for (const n of node) collectRefs(n, into); return }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') into.add(v.replace('#/components/schemas/', ''))
      else collectRefs(v, into)
    }
  }
}

function pruneSchemas(allSchemas, paths) {
  const wanted = new Set()
  collectRefs(paths, wanted)
  let size = 0
  while (wanted.size !== size) { // close over nested references
    size = wanted.size
    for (const name of [...wanted]) if (allSchemas[name]) collectRefs(allSchemas[name], wanted)
  }
  return Object.fromEntries(Object.keys(allSchemas).filter(n => wanted.has(n)).sort().map(n => [n, allSchemas[n]]))
}

const tagRank = t => { const i = TAG_ORDER.indexOf(t); return i < 0 ? TAG_ORDER.length : i }

// ---- main -------------------------------------------------------------------------------------
const src = await loadSource()
const buckets = { account: [], org: [], project: [] }
const excluded = []
const unclassified = []

for (const [path, item] of Object.entries(src.paths)) {
  for (const [m, op] of Object.entries(item)) {
    const method = m.toUpperCase()
    if (!METHOD_ORDER.includes(method)) continue
    const key = `${method} ${path}`
    if (EXCLUDE.some(re => re.test(key))) { excluded.push(key); continue }
    const kind = classify(method, path, op)
    if (!kind) { unclassified.push(key); continue }
    buckets[LEVEL_OF[kind]].push({ method, path, op: structuredClone(op), kind })
  }
}
if (unclassified.length) {
  console.error('unclassified routes (mirror classifyTokenRoute in insta-platform src/auth/tokenScope.ts):\n  ' + unclassified.join('\n  '))
  process.exit(1)
}

const outputs = {}
const navGroups = []
for (const [level, meta] of Object.entries(LEVELS)) {
  const ops = buckets[level]
  const paths = {}
  for (const { method, path, op, kind } of ops) {
    // Tags: the account file keeps the platform's `Account`; the org file renames it so the two
    // levels do not share a group name; catalog reads get a tag of their own.
    if (kind === 'open') op.tags = ['Catalog']
    else if (level === 'org' && op.tags?.[0] === 'Account') op.tags = ['Organization']
    // Titles: many platform summaries are a paragraph. Keep a short one as the title, otherwise
    // derive one from the operationId and move the paragraph into the description.
    const derived = titleFromOperationId(op.operationId)
    const shortSummary = op.summary && op.summary.length <= 80 && !/[.!?]$/.test(op.summary.trim()) ? op.summary.trim() : null
    const title = shortSummary ?? derived
    const scopes = scopesFor(kind, method, path)
    const ro = method === 'GET' ? 'read-only tokens allowed' : 'read-only tokens refused (not a GET)'
    const scopeLine = `**Token scope:** ${scopes.map(s => `\`${s}\``).join(' · ')} — ${ro}.`
    op.description = [scopeLine, shortSummary ? null : op.summary, op.description].filter(Boolean).join('\n\n')
    op.summary = title
    op['x-mint'] = { metadata: { title, sidebarTitle: derived } }
    ;(paths[path] ??= {})[method.toLowerCase()] = op
  }
  const usedTags = [...new Set(ops.flatMap(o => o.op.tags ?? []))].sort((a, b) => tagRank(a) - tagRank(b) || a.localeCompare(b))
  const doc = {
    openapi: '3.1.0', // the platform declares 3.0.3 but emits TypeBox output (`type: null`, `const`), which only 3.1 admits — Mintlify validates strictly
    info: {
      title: `InstaCloud API — ${meta.label}`,
      version: src.info.version,
      description: `${meta.blurb}\n\nGenerated from the platform's own OpenAPI document (${SOURCE_URL}); see the [API overview](/${OVERVIEW_PAGE}) for authentication and token scopes.`,
    },
    servers: [PUBLIC_SERVER],
    security: src.security,
    tags: usedTags.map(name => ({ name, description: TAG_DESCRIPTIONS[name] ?? (src.tags ?? []).find(t => t.name === name)?.description ?? '' })),
    paths: Object.fromEntries(Object.keys(paths).sort().map(p => [p, paths[p]])),
    components: { securitySchemes: src.components.securitySchemes, schemas: pruneSchemas(src.components.schemas, paths) },
  }
  outputs[join(OUT_DIR, meta.file)] = JSON.stringify(doc, null, 2) + '\n'

  // Navigation: one group per level, sub-groups per tag, endpoints ordered by path then method.
  const byTag = new Map()
  for (const { method, path, op } of ops) (byTag.get(op.tags[0]) ?? byTag.set(op.tags[0], []).get(op.tags[0])).push({ method, path })
  const subgroups = usedTags.map(tag => ({
    group: tag,
    pages: byTag.get(tag)
      .sort((a, b) => a.path.localeCompare(b.path) || METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method))
      .map(({ method, path }) => `${method} ${path}`),
  }))
  navGroups.push({ group: meta.label, openapi: { source: `/openapi/${meta.file}`, directory: meta.dir }, pages: subgroups })
}

// docs.json: own the "API" group of the Reference tab and drop the redirect that used to send
// /reference/api/overview to the CLI page.
const docsJson = JSON.parse(readFileSync(DOCS_JSON, 'utf8'))
const referenceTab = docsJson.navigation.tabs.find(t => t.tab === 'Reference')
if (!referenceTab) throw new Error('docs.json has no Reference tab')
const apiGroup = { group: 'API', icon: 'plug', pages: [OVERVIEW_PAGE, ...navGroups] }
const idx = referenceTab.groups.findIndex(g => g.group === 'API')
if (idx >= 0) referenceTab.groups[idx] = apiGroup; else referenceTab.groups.push(apiGroup)
docsJson.redirects = (docsJson.redirects ?? []).filter(r => r.source !== `/${OVERVIEW_PAGE}`)
outputs[DOCS_JSON] = JSON.stringify(docsJson, null, 2) + '\n'

// write / check
let stale = []
for (const [file, content] of Object.entries(outputs)) {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (current !== content) stale.push(file)
  if (!check) writeFileSync(file, content)
}
const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]))
console.log(`operations: ${JSON.stringify(counts)} (excluded ${excluded.length} of ${Object.values(counts).reduce((a, b) => a + b, 0) + excluded.length})`)
if (check) {
  if (stale.length) { console.error('stale:\n  ' + stale.map(f => f.replace(ROOT + '/', '')).join('\n  ') + '\nRun `npm run docs:openapi` and commit the result.'); process.exit(1) }
  console.log('docs/openapi is up to date.')
} else {
  console.log('wrote:\n  ' + Object.keys(outputs).map(f => f.replace(ROOT + '/', '')).join('\n  '))
  console.log('excluded:\n  ' + excluded.sort().join('\n  '))
}
