// The local daemon (instad): serves the SAME endpoint surface (paths + response shapes) as the
// Instacloud platform control-plane, so the stock `insta` CLI and MCP work unchanged — just
// pointed at localhost. Single-tenant: no OAuth; a builtin "local" org/user stand in for the
// account system. Cloud-only surfaces (billing, usage, tokens, members) return 501.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerFactory } from 'fastify'
import fastifyStatic from '@fastify/static'
import { registerAuth } from './auth'
import { loadConfig, type Config } from './config'
import { LifecycleFailedError } from './engine'
import { SuppliedCertWatch, suppliedFiles } from './router/certs'
import { classifyWakeError } from './router/wake'
import type { Engine, Teardown } from './engine'
import * as govern from './govern'
import { isManagedDbType, parseServiceId } from './manageddb'
import { metricsWindow } from './metrics-history'
import { GateRefused, TemplateError } from './templates/executor'
import { ManifestError, MissingTemplateVariablesError } from './templates/manifest'
import { loadState, mutate } from './state'
import { docker, dockerCall } from './docker'
import { bindingOut, dockerBuildSpec, imageTag, newBinding, normalizeRef, parseRepo, pushRef, verifySignature, type GitBindingRecord } from './gitdeploy'
import { isGatedAction, type Approval, type AuditEvent, type Branch, type GatedAction } from './types'

const LOCAL_ORG = { id: 'local', name: 'local', is_personal: true, role: 'owner' }

const approvalOut = (a: Approval) => ({
  id: a.id, action: a.action, status: a.status, requested_at: a.requestedAt, decided_at: a.decidedAt,
})
const eventOut = (e: AuditEvent) => ({
  id: e.id, branch: e.branch, source: e.source, kind: e.kind, payload: e.payload, created_at: e.createdAt,
})

/** Path prefixes the API owns: a GET outside them falls back to the dashboard shell (SPA routing).
 *  Each package appends its prefixes on its marked line (contract 00 section 1.1). */
export const API_PREFIXES: string[] = [
  '/projects', '/orgs', '/me', '/tokens', '/healthz', '/regions', '/images', '/invitations', '/github',
  '/api', '/auth', '/tls',
  '/templates', '/template-deployments',
]

/** True when the API owns `url`: a GET outside these prefixes falls back to the dashboard shell
 *  (SPA routing) and, in server mode, needs no credentials (decision 9). A function declaration, so
 *  the server/auth import cycle (auth.ts reads the allowlist) is safe at module init. */
export function isApiPath(url: string): boolean {
  return API_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`))
}

/** `serverFactory` is forwarded straight into Fastify() so the router (WP2) can hand it the shared
 *  listener; undefined until then. `cfg` is the boot config (tests pass their own). */
export function buildServer(
  engine: Engine,
  cfg: Config = loadConfig(),
  opts: { serverFactory?: FastifyServerFactory; certWatch?: SuppliedCertWatch } = {},
): FastifyInstance {
  // main.ts passes the watch it refreshes on the daemon's beat; a server built without one (local
  // mode, tests) reads once at construction and answers from that. Either way `/healthz` does no
  // file I/O per request, which is what matters for a public unauthenticated endpoint.
  const certWatch = opts.certWatch ?? new SuppliedCertWatch(suppliedFiles(cfg)?.crt ?? null)
  // 'loopback', not `true`. The only proxy in front of the daemon is the edge, on 127.0.0.1, and it
  // APPENDS the peer to X-Forwarded-For. `trustProxy: true` trusts the whole chain and takes its
  // LEFTMOST entry, which is whatever the remote client wrote, so `req.ip` was forgeable from
  // outside and the sign-in limiter, which buckets by it, could be walked past with a fresh header
  // per attempt. Trusting only the loopback hop takes the rightmost untrusted entry, which is the
  // address the edge itself observed. Same reasoning as the router's `proto()`.
  const app = Fastify({ logger: false, trustProxy: cfg.trustProxy ? 'loopback' : false, forceCloseConnections: 'idle', ...(opts.serverFactory ? { serverFactory: opts.serverFactory } : {}) })

  // Tolerate bodyless POSTs sent as application/json (the CLI does this on approve/deny).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    // Keep the raw JSON string on the request: the git webhook verifies GitHub's HMAC over these
    // exact bytes, which the parsed object cannot reproduce.
    ;(req as FastifyRequest & { rawBody?: string }).rawBody = body as string
    const s = (body as string).trim()
    if (s === '') return done(null, undefined)
    try { done(null, JSON.parse(s)) } catch (e) { done(e as Error) }
  })

  // Identity (WP1): in server mode the guard plus /api/auth/*, /auth/*, /me and /tokens; in local
  // mode exactly today's /me and the three /tokens 501s, and no hook.
  registerAuth(app, cfg)

  const notCloud = (reply: FastifyReply, what: string) =>
    reply.code(501).send({ error: `${what} is cloud-only — InstaCloud OSS is a single-tenant local runtime` })
  // Locally meaningful but not built yet — still a clean 501 with the local workaround, never a
  // bare 404 the CLI would render as a mystery.
  const notYet = (reply: FastifyReply, what: string, hint: string) =>
    reply.code(501).send({ error: `${what} is not implemented by InstaCloud OSS yet — ${hint}` })

  // Gate a sensitive action; on approval_required reply 202 (the CLI understands this shape).
  const gated = (projectId: string, action: GatedAction, reply: FastifyReply): boolean => {
    const g = govern.gate(projectId, action)
    if (g.decision === 'deny') { reply.code(403).send({ error: `${action} denied by policy` }); return false }
    if (g.decision === 'approval_required') {
      engine.emit(projectId, null, 'govern', 'govern.pending', { action, approvalId: g.approvalId })
      reply.code(202).send({ status: 'approval_required', action, approvalId: g.approvalId })
      return false
    }
    return true
  }

  // `healthz` carries what a SUPPLIED certificate has left (`--tls custom`), unconditionally and
  // in seconds as well as days: nothing renews that certificate, so its expiry is the one failure
  // in this stack that would otherwise reach an operator through their users. The number is here
  // rather than a threshold, so a monitor alerts on the margin that operator wants; the daemon
  // says so on its own under CERT_WARN_DAYS. Absent in every other mode, and absent when the file
  // cannot be read, which is itself worth alerting on.
  app.get('/healthz', async () => {
    const cert = certWatch.current()
    return { ok: true, ...(cert ? { certificate: { notAfter: cert.notAfter, daysLeft: cert.daysLeft, secondsLeft: cert.secondsLeft } } : {}) }
  })
  app.get('/orgs', async () => ({ orgs: [LOCAL_ORG] }))
  app.post('/orgs', async (_req, reply) => notCloud(reply, 'org management'))
  app.get('/orgs/:id/billing', async (_req, reply) => notCloud(reply, 'billing'))
  // Billing sub-surfaces too — the MCP sweep found checkout/portal falling to bare 404s.
  app.get('/orgs/:id/billing/cycle', async (_req, reply) => notCloud(reply, 'billing'))
  app.get('/orgs/:id/billing/overview', async (_req, reply) => notCloud(reply, 'billing'))
  app.post('/orgs/:id/billing/checkout', async (_req, reply) => notCloud(reply, 'billing checkout (Stripe)'))
  app.post('/orgs/:id/billing/portal', async (_req, reply) => notCloud(reply, 'the billing portal (Stripe)'))
  app.get('/projects/:id/usage', async (_req, reply) => notCloud(reply, 'usage metering'))
  app.get('/orgs/:id/usage', async (_req, reply) => notCloud(reply, 'usage metering'))
  app.get('/projects/:id/usage/daily', async (_req, reply) => notCloud(reply, 'usage metering'))
  app.get('/projects/:id/utilisation', async (_req, reply) => notCloud(reply, 'utilisation metering'))
  // Org membership is an account-system surface; the builtin `local` org has exactly one user.
  app.get('/orgs/:id/members', async (_req, reply) => notCloud(reply, 'org membership'))
  app.put('/orgs/:id/members/:uid', async (_req, reply) => notCloud(reply, 'org membership'))
  app.delete('/orgs/:id/members/:uid', async (_req, reply) => notCloud(reply, 'org membership'))
  app.post('/orgs/:id/invitations', async (_req, reply) => notCloud(reply, 'org invitations'))
  app.get('/orgs/:id/invitations', async (_req, reply) => notCloud(reply, 'org invitations'))
  app.delete('/orgs/:id/invitations/:iid', async (_req, reply) => notCloud(reply, 'org invitations'))
  app.post('/invitations/accept', async (_req, reply) => notCloud(reply, 'org invitations'))
  // insta 0.1.0 `domain attach|detach` read the org's bought domains first; OSS sells none, so both lists are empty.
  app.get('/orgs/:id/domains', async () => ({ items: [] }))
  app.get('/orgs/:id/domains/orders', async () => ({ items: [] }))
  app.get('/orgs/:id/domains/search', async (_req, reply) => notCloud(reply, 'domain purchase'))
  app.post('/orgs/:id/domains/orders', async (_req, reply) => notCloud(reply, 'domain purchase'))
  app.post('/projects/:id/domains/:name/attach', async (_req, reply) => notCloud(reply, 'attaching a bought domain'))
  app.get('/orgs/:id/domains/:name/records', async (_req, reply) => notCloud(reply, 'DNS records of a bought domain'))
  app.post('/orgs/:id/domains/:name/records', async (_req, reply) => notCloud(reply, 'DNS records of a bought domain'))
  app.patch('/orgs/:id/domains/:name/records/:rid', async (_req, reply) => notCloud(reply, 'DNS records of a bought domain'))
  app.delete('/orgs/:id/domains/:name/records/:rid', async (_req, reply) => notCloud(reply, 'DNS records of a bought domain'))
  // Registry image inspection is the cloud console's helper (fans out to 3rd-party registries).
  app.get('/images/inspect', async (_req, reply) => notCloud(reply, 'registry image inspection'))
  // Everything is one region here: the machine the daemon runs on (CLI shape: {slug, label}).
  app.get('/regions', async () => ({ regions: [{ slug: 'local', label: 'Local (this machine)' }] }))
  // ---- observability (docker + SQL backed; same response shapes as the cloud) ----
  // A project, branch or service that is not there, plus the one message that says so in the
  // cloud's own words: `no postgres service in this project (add one with ...)` is a 404 on every
  // route that resolves a database, not a 400 or a 502 (plan 05 section 6).
  const notFoundish = (m: string): boolean => m.includes('not found') || m.startsWith('no postgres service in this project')
  // WP3 (decision 48): an observability read never wakes a database. When the instance is asleep the
  // engine says so and the page reports 503, so a dashboard poll is not what keeps it up.
  const obsCode = (m: string): number => (notFoundish(m) ? 404 : /sleeping/.test(m) ? 503 : 502)
  // Each managed type is its own component, never folded into compute (cloud parity, platform
  // #243). Absent stays the historical compute default; junk is the cloud's 400.
  const COMPONENTS = ['db', 'compute', 'redis', 'mysql', 'mongodb'] as const
  const component = (q: { component?: string }): (typeof COMPONENTS)[number] | null => {
    if (q.component === undefined) return 'compute'
    return (COMPONENTS as readonly string[]).includes(q.component) ? (q.component as (typeof COMPONENTS)[number]) : null
  }
  const badComponent = (reply: FastifyReply): FastifyReply =>
    reply.code(400).send({ error: 'component must be db|compute|redis|mysql|mongodb' })

  app.get('/projects/:id/metrics', async (req, reply) => {
    const { id } = req.params as { id: string }
    // from/to/step stay `unknown`: a repeated key arrives as an array, and metricsWindow answers that 400.
    const q = req.query as { component?: string; branch?: string; group?: string; from?: unknown; to?: unknown; step?: unknown }
    const c = component(q)
    if (!c) return badComponent(reply)
    // The cloud's window: from/to in unix seconds and a step like 60s, 5m or 1h; the last hour at 60 s
    // when absent. A malformed one is the cloud's 400, not a silently different chart.
    const window = metricsWindow(q, Math.floor(Date.now() / 1000))
    if ('error' in window) return reply.code(400).send({ error: window.error })
    try { return await engine.runtimeMetrics(id, { component: c, branchName: q.branch, group: q.group, window }) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(obsCode(m)).send({ error: m }) }
  })

  app.get('/projects/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const c = component(req.query as { component?: string })
    if (!c) return badComponent(reply)
    const q = req.query as { branch?: string; group?: string; limit?: string }
    try { return await engine.runtimeLogs(id, { component: c, branchName: q.branch, group: q.group, limit: q.limit ? Number(q.limit) : undefined }) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(obsCode(m)).send({ error: m }) }
  })

  // Control-plane operation log (cloud: Neon operations; here the resource-event timeline).
  app.get('/projects/:id/operations', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { limit?: string }
    try { return engine.operations(id, q.limit ? Number(q.limit) : undefined) }
    catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  // Point-in-time DB signals — run SQL against the branch database (same queries as the cloud).
  app.get('/projects/:id/database/metrics', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { branch?: string; group?: string }
    try { return await engine.dbMetricsSnapshot(id, q.branch, q.group) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(obsCode(m)).send({ error: m }) }
  })

  app.get('/projects/:id/database/activity', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { branch?: string; group?: string }
    try { return await engine.dbActivity(id, q.branch, q.group) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(obsCode(m)).send({ error: m }) }
  })

  app.get('/projects/:id/database/query-stats', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { branch?: string; limit?: string; sort?: string; group?: string }
    const sort = (['total', 'mean', 'calls'] as const).find((s) => s === q.sort)
    try { return await engine.dbQueryStats(id, q.branch, { limit: q.limit ? Number(q.limit) : undefined, sort, group: q.group }) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(obsCode(m)).send({ error: m }) }
  })

  // The console's SQL editor and Data tab: one ad-hoc statement against the branch database.
  // Gated (`db.query`) because an arbitrary statement writes as easily as it reads; never wakes a
  // sleeping instance (503, same as the insight reads — the dashboard's wake gate fronts it).
  app.post('/projects/:id/database/query', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    const { sql, branch, group } = (req.body ?? {}) as { sql?: unknown; branch?: unknown; group?: unknown }
    if (typeof sql !== 'string' || !sql.trim()) return reply.code(400).send({ error: 'sql required' })
    if (branch !== undefined && typeof branch !== 'string') return reply.code(400).send({ error: 'branch must be a string' })
    if (group !== undefined && typeof group !== 'string') return reply.code(400).send({ error: 'group must be a string' })
    if (!gated(id, 'db.query', reply)) return reply
    try { return await engine.dbQuery(id, sql, branch, group) }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      // A statement psql refused is the caller's 400, quoted from psql's own ERROR line — the
      // FIRST line only: the LINE/caret context that follows points into the daemon's private
      // wrapper SQL, text the user never wrote. Multi-statement input is the same 400 class.
      if (m.includes('one statement per request') || m.includes('meta-commands are not supported')) return reply.code(400).send({ error: m })
      const sqlError = /ERROR: {2}[^\n]*/.exec(m)?.[0]
      if (sqlError) return reply.code(400).send({ error: sqlError.trim() })
      return reply.code(obsCode(m)).send({ error: m })
    }
  })

  app.post('/orgs/:id/projects', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string }
    if (!name) return reply.code(400).send({ error: 'name required' })
    try {
      const { project, defaultBranch } = await engine.createProject(name)
      // EMPTY, like the cloud (provisioning/service.ts provisionProject): a project starts with a
      // branch and nothing in it; services arrive through `insta services add`.
      return reply.code(201).send({
        project: { id: project.id, name: project.name, status: project.status },
        defaultBranch: { id: defaultBranch.id, name: defaultBranch.name },
        resources: [],
      })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return reply.code(m.includes('already exists') ? 409 : provisionCode(m)).send({ error: m })
    }
  })

  app.get('/orgs/:id/projects', async () => ({
    projects: engine.listProjects().map((p) => ({ id: p.id, name: p.name, status: p.status })),
  }))

  app.get('/projects/:id', async (req, reply) => {
    try { return engine.detail((req.params as { id: string }).id) }
    catch { return reply.code(404).send({ error: 'project not found' }) }
  })

  app.delete('/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'project.delete', reply)) return reply
    // The cloud's teardown summary, from the same envelope every delete route answers with
    // (decision 50; platform server.ts:1300 TeardownSummary).
    return teardownReply(reply, await engine.destroyProject(id), 're-running the project delete')
  })

  app.get('/projects/:id/branches', async (req, reply) => {
    const { id } = req.params as { id: string }
    // A project that does not exist is a 404, not an empty list. Answering 200 made "deleted" and
    // "has no branches" indistinguishable, so a client cannot tell a stale link from a real
    // project: the dashboard's deleted-project redirect keyed on the 404 that never came.
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    return {
      branches: engine.listBranches(id).map((b) => ({
        id: b.id, name: b.name, is_default: b.isDefault, status: b.status,
        // The console's Created column. Every branch the engine creates stamps it.
        ...(b.createdAt ? { created_at: new Date(b.createdAt).toISOString() } : {}),
      })),
    }
  })

  app.post('/projects/:id/branches', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { name, from, excludeServices } = (req.body ?? {}) as { name?: unknown; from?: unknown; excludeServices?: unknown }
    // Typed at the boundary, not just truthy: `{"name": 123}` used to pass, because RegExp.test
    // coerces its argument, and then failed deep in provisioning as a state-ish error instead of
    // the malformed-request 400 it is. Same for a non-string `from`.
    if (typeof name !== 'string' || !name) return reply.code(400).send({ error: 'name required' })
    if (from !== undefined && typeof from !== 'string') return reply.code(400).send({ error: 'from must be a string' })
    // The console's "Exclude all services": an empty branch, nothing of the parent is copied.
    if (excludeServices !== undefined && typeof excludeServices !== 'boolean') return reply.code(400).send({ error: 'excludeServices must be a boolean' })
    try {
      const b = await engine.createBranch(id, name, from, { excludeServices: excludeServices === true })
      return reply.code(201).send({ branch: { id: b.id, name: b.name } })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      // This route's fallback is 409, for "understood, and the state says no" (already exists, a
      // source that is busy). A malformed name is not that: nothing about the state would make it
      // work, so it is the request that is bad.
      if (m.includes('must be lower-kebab')) return reply.code(400).send({ error: m })
      return reply.code(provisionCode(m, 409)).send({ error: m })
    }
  })

  /** A teardown that did not finish is not a 200. The row is KEPT on that outcome (marked
   *  `cleanup-failed`, since 4b489f6), which is right: the resources it names have to stay
   *  reachable. But answering 200 tells a CLI or a dashboard the thing is gone, and it then
   *  shows the branch vanishing and reappearing on the next refresh. 409 is the code this
   *  server already uses for "the request was understood and the state says no", and the body
   *  is the same teardown envelope either way, so a client that only reads counts is unaffected.
   *  Documented in COMPATIBILITY. */
  const teardownReply = (reply: FastifyReply, t: Teardown, retry: string): { teardown: { destroyed: number; failed: number }; error?: string } => {
    const teardown = { destroyed: t.destroyed, failed: t.failed }   // the decision-50 envelope, exactly
    if (t.failed === 0) return { teardown }
    reply.code(409)
    // An `error` beside it, because 409 without one renders as a bare "HTTP 409" in the
    // dashboard (`ui/src/api.ts` reads error, then message, then code) -- for precisely the
    // outcome this status was added to communicate. The daemon knows what refused and knows the
    // recovery, so it says both.
    const why = (t.reasons ?? []).join('; ')
    return {
      teardown,
      error: `${t.failed} resource${t.failed === 1 ? '' : 's'} could not be removed${why ? ` (${why})` : ''}. Nothing that depended on ${t.failed === 1 ? 'it' : 'them'} was deleted and the row is kept, so ${retry} retries exactly this demolition`,
    }
  }

  app.delete('/projects/:id/branches/:bid', async (req, reply) => {
    const { id, bid } = req.params as { id: string; bid: string }
    if (!gated(id, 'branch.delete', reply)) return reply
    try { return teardownReply(reply, await engine.destroyBranch(id, bid), '`insta branch delete` on it')  }
    catch (e) {
      // Not every refusal is "no such branch". A 404 tells a CLI the branch is gone, so an
      // operator told that about a branch that was FOUND (the default-branch refusal) goes
      // looking for something that is right there, and a retryable lock-set exhaustion -- which
      // the create path on this same file already answers 409 to -- reads as permanent. 409 is
      // this server's code for "understood, and the state says no"; anything else here is a
      // fault in the teardown itself, not a statement about the branch.
      const m = e instanceof Error ? e.message : String(e)
      const code = m.includes('not found') ? 404
        : m.includes('cannot delete the default branch') || m.includes('could not settle its lock set') ? 409
          : 500
      return reply.code(code).send({ error: m })
    }
  })

  // Structural merge: create on the target branch what exists on `from` and is missing there.
  // No data moves — only migration files carry schema forward. Gated — service.add.
  app.post('/projects/:id/branches/:branch/merge', async (req, reply) => {
    const { id, branch } = req.params as { id: string; branch: string }
    const { from } = (req.body ?? {}) as { from?: string }
    if (!from) return reply.code(400).send({ error: 'from (source branch name) required' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'service.add', reply)) return reply
    try { return await engine.mergeBranch(id, branch, from) }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return reply.code(m.startsWith('target') ? 404 : 400).send({ error: m })
    }
  })

  app.get('/projects/:id/secrets', async (req, reply) => {
    const { id } = req.params as { id: string }
    const branch = (req.query as { branch?: string }).branch ?? 'main'
    if (!gated(id, 'secrets.read', reply)) return reply
    try {
      engine.emit(id, branch, 'govern', 'secrets.read', {})
      return { secrets: engine.secrets(id, branch) }
    } catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  // The project→branch→service→secrets inventory (names only, no values). Gated — secrets.read.
  app.get('/projects/:id/secrets/tree', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'secrets.read', reply)) return reply
    return engine.secretTree(id)
  })

  app.post('/projects/:id/deploy', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { image?: string; branch?: string; group?: string; port?: number }
    if (!body.image) return reply.code(400).send({ error: 'image required' })
    if (!gated(id, 'deploy', reply)) return reply
    try { return await engine.deploy(id, body.branch ?? 'main', { image: body.image, port: body.port, group: body.group }) }
    catch (e) {
      // 409 for the one failure that is not about the request: the image went out and the
      // container could not be put back into the standing stopped/suspended state it had.
      const m = e instanceof Error ? e.message : String(e)
      return reply.code(e instanceof LifecycleFailedError ? 409 : 400).send({ error: m })
    }
  })

  app.get('/projects/:id/policy', async (req) => ({
    policy: govern.effectivePolicy((req.params as { id: string }).id),
  }))

  app.put('/projects/:id/policy/:action', async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string }
    const { decision } = (req.body ?? {}) as { decision?: string }
    if (!isGatedAction(action)) return reply.code(400).send({ error: `unknown action: ${action}` })
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'approve') {
      return reply.code(400).send({ error: 'decision must be allow|deny|approve' })
    }
    govern.setPolicy(id, action, decision)
    engine.emit(id, null, 'govern', 'policy.set', { action, decision })
    return { policy: govern.effectivePolicy(id) }
  })

  app.get('/projects/:id/approvals', async (req) => {
    const { id } = req.params as { id: string }
    const status = (req.query as { status?: string }).status
    return { approvals: govern.listApprovals(id, status).map(approvalOut) }
  })

  const decideRoute = (verdict: 'granted' | 'denied') => async (req: { params: unknown; body?: unknown }, reply: FastifyReply) => {
    const { id, aid } = req.params as { id: string; aid: string }
    const always = !!((req.body ?? {}) as { always?: boolean }).always
    const a = govern.decide(id, aid, verdict, always)
    if (!a) return reply.code(404).send({ error: 'approval not found or not pending' })
    engine.emit(id, null, 'govern', verdict === 'granted' ? 'govern.approved' : 'govern.denied', { action: a.action, approvalId: a.id, always })
    return { approval: approvalOut(a) }
  }
  app.post('/projects/:id/approvals/:aid/approve', decideRoute('granted'))
  app.post('/projects/:id/approvals/:aid/deny', decideRoute('denied'))

  // ---- services (services-model parity; ?branch= scopes the dashboard's runtime columns) ----
  app.get('/projects/:id/services', async (req, reply) => {
    const branch = (req.query as { branch?: string }).branch
    try { return { services: await engine.services((req.params as { id: string }).id, branch) } }
    catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : 'project not found' }) }
  })

  app.post('/projects/:id/services', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { type?: unknown; name?: unknown; branch?: unknown; public?: boolean; volumeGib?: number; port?: number; alwaysOn?: boolean; image?: string }
    // Typed at the boundary, BEFORE the governance gate, exactly as the branch routes are.
    // `SERVICE_NAME_RE.test` coerces, so `{"name": 123}` satisfied the lower-kebab rule and the
    // compute path persisted the NUMBER into computeGroups — state that violates its own types and
    // that no later string request compares equal to, so the service could not be addressed again.
    if (typeof body.type !== 'string' || !body.type || typeof body.name !== 'string' || !body.name) {
      return reply.code(400).send({ error: 'type and name required' })
    }
    if (body.branch !== undefined && typeof body.branch !== 'string') {
      return reply.code(400).send({ error: 'branch must be a string' })
    }
    // Bound as locals so the narrowing above holds inside `add` — a property narrowing does not
    // survive into a closure, and re-reading `body.name` there is what let the unchecked value in.
    const { type: svcType, name: svcName, branch: svcBranch } = body as { type: string; name: string; branch?: string }
    if (!gated(id, 'service.add', reply)) return reply
    // `branch` names the branch the service is created on, defaulting to the project's default
    // branch — the cloud's shape (platform server.ts:1492) and what the docs promise. Postgres,
    // storage and managed databases are created on THAT branch only: each is real infrastructure
    // with its own credentials, and fanning them out meant an agent adding a database on its own
    // branch also built one on main. A compute group is the exception: it is a registration and
    // nothing else until a deploy puts a container on a branch, so it stays project-level and
    // `branch` does not apply to it. `image` is accepted and ignored — the image reaches a service
    // through deploy.
    const add = async (): Promise<unknown> => {
      const on = { ...(svcBranch !== undefined ? { branch: svcBranch } : {}) }
      if (svcType === 'postgres') return engine.addDbService(id, svcName, on)
      if (svcType === 'storage') return engine.addStorageService(id, svcName, { ...on, ...(body.public !== undefined ? { public: body.public } : {}) })
      if (isManagedDbType(svcType)) return engine.addManagedService(id, svcType as 'redis' | 'mysql' | 'mongodb', svcName, on)
      // volumeGib (compute only) attaches a persistent /data volume (also attachable later via
      // PUT …/volume, and deletable via DELETE …/volume — cloud parity).
      // `branch` does not decide where a compute group lives (it is project-level, above); it
      // decides which branch's always-on the 201 reports, since that differs per branch.
      return engine.addComputeService(id, svcName, body.volumeGib, {
        ...(body.alwaysOn !== undefined ? { alwaysOn: body.alwaysOn } : {}),
        ...(body.port !== undefined ? { port: body.port } : {}),
        ...(svcBranch !== undefined ? { branch: svcBranch } : {}),
      })
    }
    if (!['postgres', 'storage', 'compute'].includes(svcType) && !isManagedDbType(svcType)) {
      return reply.code(400).send({ error: `unknown service type: ${svcType}` })
    }
    try { return reply.code(201).send({ service: await add() }) }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      const code = m.includes('already exists') || m.includes('already used') || m.includes('already used by') ? 409
        : m.includes('is reserved by the daemon') ? 409
        : m.includes('not found') ? 404
        : provisionCode(m)
      return reply.code(code).send({ error: m })
    }
  })

  // ---- service lifecycle + access (contract parity) ----
  // Ungated like the platform; ?branch= scopes the target (default branch otherwise) because
  // oss service ids are stable across branches rather than per-branch rows.
  // A transition the RUNTIME refused is not a bad request: 409, the code this file already uses
  // for "understood, and the state says no" (the teardown envelope). Nothing was recorded when
  // one of these is thrown, so the verb can simply be retried.
  const errCode = (m: string, e?: unknown): number =>
    (e instanceof LifecycleFailedError ? 409 : notFoundish(m) ? 404 : 400)
  for (const verb of ['start', 'stop', 'suspend'] as const) {
    app.post(`/projects/:id/services/:sid/${verb}`, async (req, reply) => {
      const { id, sid } = req.params as { id: string; sid: string }
      if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
      try { return await engine.lifecycle(id, sid, verb, (req.query as { branch?: string }).branch) }
      catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m, e)).send({ error: m }) }
    })
  }

  // Wake one sleeping DATABASE now: the console's "Wake and browse" on a suspended database. A dashboard read never
  // wakes a database (decision 48), and start/stop/suspend are compute's, so without this the Database tab could only
  // wait for some other connection. The scheduler's api door, as `insta compute start` uses: it takes the service's
  // operation lock and waits for readiness. Ungated like the lifecycle verbs.
  app.post('/projects/:id/services/:sid/wake', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    try {
      const { branch, serviceId } = engine.resolveSid(id, sid, (req.query as { branch?: string }).branch)
      const key = engine.serviceKey(branch, serviceId)
      const target = engine.serviceTargets().find((t) => t.key === key)
      if (!target) {
        return reply.code(404).send({ error: `service not found: ${sid} has nothing to wake on this branch` })
      }
      // Databases only. The api door skips the scheduler's refusal to wake a STOPPED compute service, so waking compute
      // here would bring a durably stopped app back up with its stop intent still recorded, running outside the idle
      // sweep and eviction. Compute has `start`, which clears the intent before it wakes.
      if (target.kind === 'compute') {
        return reply.code(400).send({ error: `${sid} is a compute service: wake it with start (insta compute start), which also clears a stop` })
      }
      // A wake that could not finish is not a bad request. The router lane's codes (router/http.ts `failed`): 504 when
      // it timed out, 503 when the service is stopped, has no container, the daemon is shutting down, or it could not be
      // woken, so a client can tell "coming up, retry" from "do not retry".
      try {
        await engine.wake(key, { door: 'api' })
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        return reply.code(classifyWakeError(e) === 'timeout' ? 504 : 503).send({ error: m })
      }
      return { state: engine.stateOf(key) }
    } catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m, e)).send({ error: m }) }
  })

  // Not folded into the verb loop above: a restart is a redeploy, not a desired-state flip, so it
  // takes the deploy path (fresh env) rather than the adapter's lifecycle ops — and therefore the
  // `deploy` gate that POST /deploy stands behind. The verbs above change whether the service runs;
  // this re-mints every credential into a new container.
  app.post('/projects/:id/services/:sid/restart', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'deploy', reply)) return reply
    try { return await engine.restart(id, sid, (req.query as { branch?: string }).branch) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m, e)).send({ error: m }) }
  })

  app.get('/projects/:id/services/:sid/state', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    try { return await engine.serviceState(id, sid, (req.query as { branch?: string }).branch) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
  })

  // A service's secret names (names only). Gated — secrets.read.
  app.get('/projects/:id/services/:sid/secrets', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'secrets.read', reply)) return reply
    // Same branch resolution as every other `/services/:sid/*` route (decision 49): a qualified
    // sid names the branch, then `?branch`, then the default.
    try { return { secrets: engine.serviceSecretNames(id, sid, (req.query as { branch?: string }).branch) } }
    catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  // Storage bucket access mode (anonymous public-read vs private). Gated — service.setAccess.
  app.put('/projects/:id/services/:sid/access', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const body = (req.body ?? {}) as { public?: boolean; branch?: string }
    if (typeof body.public !== 'boolean') return reply.code(400).send({ error: 'public (boolean) required' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'service.setAccess', reply)) return reply
    try { return { service: await engine.setServiceAccess(id, sid, body.public, body.branch) } }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
  })

  // Rename a service and re-key what derives from its name. Gated — service.rename. Every type is
  // renamable: a postgres service moves its container and minted hostname while KEEPING its data
  // directory (the id is immutable, decision 16); a storage rename is a re-key only, because a
  // bucket handle is baked into every object URL and into the key scoped to it.
  app.post('/projects/:id/services/:sid/rename', async (req, reply) => {
    const { id, sid: raw } = req.params as { id: string; sid: string }
    const { name } = (req.body ?? {}) as { name?: unknown }
    // Typed, not just truthy: RegExp.test coerces, so a rename could re-key a service under a
    // non-string name that no later request can match.
    if (typeof name !== 'string' || !name) return reply.code(400).send({ error: 'name required' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    // resolveSid rather than bareSid, per contract section 10, which names rename in that family:
    // a qualified sid that points at a deleted or foreign branch must 404, not have its qualifier
    // discarded and the rename applied to whatever the bare id happens to match.
    let sid: string
    try { sid = engine.resolveSid(id, raw, (req.query as { branch?: string }).branch).serviceId }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
    if (!gated(id, 'service.rename', reply)) return reply
    try {
      const service = sid.startsWith('cp-') ? await engine.renameComputeService(id, sid.slice(3), name)
        : sid.startsWith('pg-') ? await engine.renameDbService(id, sid, name)
        : sid.startsWith('st-') ? await engine.renameStorageService(id, sid, name)
        : await engine.renameManagedService(id, sid, name)
      return { service }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return reply.code(m.includes('already exists') ? 409 : errCode(m)).send({ error: m })
    }
  })

  // ---- volumes + database settings (tier-caps contract parity, platform #166–169) ----
  // Same paths + shapes as the cloud; oss has no billing tiers, so the cap is one fixed generous
  // constant and recorded sizes are advisory (nothing local enforces a byte quota). Ungated, like
  // lifecycle: the cloud gates growth behind the paid tier, which does not exist here — the
  // grow-only and cap validations stay so one CLI sequence behaves identically on both targets.
  app.get('/projects/:id/services/:sid/volume', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    // resolveSid, like DELETE below: contract section 10 says every /services/:sid/* route resolves
    // the qualifier and 404s when the branch is gone or belongs to another project. Stripping it
    // unread meant a stale qualifier read back a silent 200 on a resource it no longer named.
    try {
      const { serviceId } = engine.resolveSid(id, sid, (req.query as { branch?: string }).branch)
      return engine.serviceVolume(id, serviceId)
    }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
  })

  app.put('/projects/:id/services/:sid/volume', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const { sizeGib } = (req.body ?? {}) as { sizeGib?: number }
    if (typeof sizeGib !== 'number') return reply.code(400).send({ error: 'sizeGib (number) required' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    // Same resolution as GET and DELETE: a stale qualifier used to write the project-level record
    // and answer 200, which is the worst of the three because it is a silent successful write.
    try {
      const { serviceId } = engine.resolveSid(id, sid, (req.query as { branch?: string }).branch)
      return await engine.setServiceVolume(id, serviceId, sizeGib)
    }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
  })

  // Delete the /data volume (destroys its data; cloud 2026-08-08 contract). Gated service.remove —
  // the same approval class as deleting the service, because it destroys data the same way. A
  // volumeless service is the cloud's 404, not a silent no-op.
  app.delete('/projects/:id/services/:sid/volume', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'service.remove', reply)) return reply
    // Strips the qualifier and proceeds, like GET and PUT on this same resource (contract section
    // 10, which names `volume` in that family and specifies the response as unchanged). Detaching
    // is project-wide BY DESIGN here: the volume record is a project-level service setting and the
    // engine's contract note calls the rebuild eager across every branch that deploys the group.
    // So the qualifier is redundant rather than dangerous, and refusing it, as an earlier revision
    // of this route did, left a decision-49 client with no id it could send: that form is the only
    // one `GET /services?branch=` hands back off the default branch, and the contract declares it
    // opaque, so "re-send without the branch" asked the caller to parse it.
    // resolveSid, not bareSid: bareSid strips the qualifier without looking at it, so a stale or
    // foreign branch id would be discarded in silence and the detach would go ahead on a project
    // the caller never named. resolveSid validates the branch belongs to this project and throws
    // 'branch not found' otherwise. GET and PUT above now do the same; when this route was fixed
    // first they did not, and the comment here claimed they did.
    try {
      const { serviceId } = engine.resolveSid(id, sid, (req.query as { branch?: string }).branch)
      return await engine.removeServiceVolume(id, serviceId)
    }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return reply.code(m.includes('no volume') ? 404 : errCode(m)).send({ error: m })
    }
  })

  app.get('/projects/:id/database/instance', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { branch?: string; group?: string }
    try { return engine.dbInstance(id, q.branch, q.group) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
  })

  app.patch('/projects/:id/database/settings', async (req, reply) => {
    const { id } = req.params as { id: string }
    // WP3: `scaleToZero`, `idleTimeout`, `cpu` and `memory` are real levers on the branch's own
    // postgres container now, not accepted-and-ignored cloud fields.
    const body = (req.body ?? {}) as {
      volumeSize?: string; storageSize?: string
      scaleToZero?: boolean; idleTimeout?: number | string; cpu?: number | string; memory?: number | string
    }
    const q = req.query as { branch?: string; group?: string }
    try { return await engine.dbSettings(id, body, q.branch, q.group) }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      const status = (e as { status?: number }).status
      return reply.code(typeof status === 'number' ? status : errCode(m)).send({ error: m })
    }
  })

  // ---- database management (password / databases / extensions / insight — cloud parity).
  // Like the cloud: only the password route gates (secrets.read — it returns credentials);
  // database + extension management is ungated. SQL failures map: exists→409, missing→404.
  const dbErr = (reply: FastifyReply, e: unknown): FastifyReply => {
    const m = e instanceof Error ? e.message : String(e)
    const code = m.includes('already exists') ? 409 : m.includes('does not exist') || notFoundish(m) ? 404 : 400
    return reply.code(code).send({ error: m })
  }

  app.post('/projects/:id/database/password', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { password } = (req.body ?? {}) as { password?: string }
    const q = req.query as { branch?: string; group?: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'secrets.read', reply)) return reply
    try { return await engine.dbSetPassword(id, password, q.branch, q.group) }
    catch (e) { return dbErr(reply, e) }
  })

  app.get('/projects/:id/database/databases', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { branch?: string; group?: string }
    try { return await engine.dbListDatabases(id, q.branch, q.group) }
    catch (e) { return dbErr(reply, e) }
  })

  app.post('/projects/:id/database/databases', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { name } = (req.body ?? {}) as { name?: string }
    const q = req.query as { branch?: string; group?: string }
    if (!name) return reply.code(400).send({ error: 'name required' })
    try { return reply.code(201).send(await engine.dbCreateDatabase(id, name, q.branch, q.group)) }
    catch (e) { return dbErr(reply, e) }
  })

  app.delete('/projects/:id/database/databases/:database', async (req, reply) => {
    const { id, database } = req.params as { id: string; database: string }
    const q = req.query as { branch?: string; group?: string }
    try { await engine.dbDeleteDatabase(id, database, q.branch, q.group); return { ok: true } }
    catch (e) { return dbErr(reply, e) }
  })

  app.get('/projects/:id/database/extensions', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { branch?: string; group?: string }
    try { return await engine.dbExtensions(id, q.branch, q.group) }
    catch (e) { return dbErr(reply, e) }
  })

  app.patch('/projects/:id/database/extensions', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { enable?: string[]; disable?: string[] }
    const q = req.query as { branch?: string; group?: string }
    try { return await engine.dbPatchExtensions(id, body, q.branch, q.group) }
    catch (e) { return dbErr(reply, e) }
  })

  app.get('/projects/:id/database/insight', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { branch?: string; group?: string }
    try { return await engine.dbInsight(id, q.branch, q.group) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(obsCode(m)).send({ error: m }) }
  })

  // Machine scaling / instance specs are cloud pricing concepts — clean 501, never a bare 404.
  app.post('/projects/:id/services/:sid/scale', async (_req, reply) => notCloud(reply, 'machine scaling'))
  app.post('/projects/:id/services/:sid/upgrade', async (_req, reply) => notCloud(reply, 'instance spec upgrades'))
  // The service PATCH bundles limits + always-on (both real routes once WP3 lands, region C below).
  app.patch('/projects/:id/services/:sid', async (_req, reply) => notCloud(reply, 'service spec patching'))
  // Cloud deploy plumbing: deploy tokens mint Fly builder credentials (local source deploys will be
  // `docker build`, roadmap Phase 4). Custom domains: region B below.
  app.post('/projects/:id/deploy-token', async (_req, reply) => notCloud(reply, 'deploy tokens (remote builders)'))
  // Managed backups ride the cloud's database infra; locally the database is your container.
  app.post('/projects/:id/backups', async (_req, reply) => notCloud(reply, 'managed backups (locally: pg_dump with the DATABASE_URL from `insta secrets`)'))
  app.get('/projects/:id/backups', async (_req, reply) => notCloud(reply, 'managed backups (locally: pg_dump with the DATABASE_URL from `insta secrets`)'))
  app.delete('/projects/:id/backups/:bid', async (_req, reply) => notCloud(reply, 'managed backups'))
  app.post('/projects/:id/backups/:bid/restore', async (_req, reply) => notCloud(reply, 'managed backups'))
  // GitHub repo connect needs the GitHub App, a public webhook URL and the remote build gateway.
  app.post('/orgs/:id/github/setup', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.post('/orgs/:id/github/setup/complete', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.get('/github/installations', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.get('/github/installations/:iid/repos', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.post('/orgs/:id/github/repos', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.post('/orgs/:id/github/device', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.post('/orgs/:id/github/device/poll', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.post('/projects/:id/github/detect', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.post('/projects/:id/github/public-repo/resolve', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.get('/projects/:id/github/repo-binding', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.post('/projects/:id/github/repo-binding', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.delete('/projects/:id/github/repo-binding', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.get('/projects/:id/github/builds', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.put('/projects/:id/services/:sid/source', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.patch('/projects/:id/services/:sid/source', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.delete('/projects/:id/services/:sid/source', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.post('/projects/:id/services/:sid/source/deploy', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  app.get('/projects/:id/services/:sid/source/builds', async (_req, reply) => notCloud(reply, 'GitHub repo connect'))
  // A local compute service always runs an image, so its source is a real answer, not a 501.
  // Branch-aware like every other `/services/:sid/*` route (decision 49): a qualified sid picks the
  // branch first, then `?branch`, then the default; rows off the default branch carry a qualified
  // id, so the row is matched on its bare service id.
  app.get('/projects/:id/services/:sid/source', async (req, reply) => {
    const { id, sid: raw } = req.params as { id: string; sid: string }
    try {
      const { branch, serviceId } = engine.resolveSid(id, raw, (req.query as { branch?: string }).branch)
      const rows = await engine.services(id, branch.name)
      const svc = rows.find((s) => (parseServiceId(s.id)?.serviceId ?? s.id) === serviceId)
      if (!svc) return reply.code(404).send({ error: 'service not found' })
      if (svc.type !== 'compute') return reply.code(400).send({ error: 'only a compute service has a source' })
      return { source: { type: 'image', image: svc.image ?? null } }
    } catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : 'project not found' }) }
  })
  // Not-yet surfaces (real local answers exist meanwhile):
  app.get('/projects/:id/deploy-events', async (_req, reply) => notYet(reply, 'the deploy-event feed', 'use `insta events` and `insta logs`'))
  // Aliasing one credential onto an env name of your choosing. The credentials themselves are
  // already in every compute container, under their own names and, for the oldest service of each
  // type, the unsuffixed ones as well, so the local answer is to read those. `insta secrets bind`,
  // `unbind`, `bindings` and `sources` all land here, and a bare 404 would read as a broken CLI.
  const noBindings = 'read the credential straight from the container environment (`insta secrets list` names them) or set your own name with `insta secrets set`'
  app.get('/projects/:id/secret-bindings', async (_req, reply) => notYet(reply, 'service credential bindings', noBindings))
  app.put('/projects/:id/secret-bindings/:envName', async (_req, reply) => notYet(reply, 'service credential bindings', noBindings))
  app.delete('/projects/:id/secret-bindings/:envName', async (_req, reply) => notYet(reply, 'service credential bindings', noBindings))

  // Project rename — display name only, like the cloud: every resource keeps its frozen slug.
  app.patch('/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { name } = (req.body ?? {}) as { name?: string }
    if (!name) return reply.code(400).send({ error: 'name required' })
    try { return { project: engine.renameProject(id, name) } }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return reply.code(m.includes('already exists') ? 409 : errCode(m)).send({ error: m })
    }
  })

  // Bulk runtime health: compute + postgres + managed databases from one docker read (the cloud's
  // shape; storage omitted — object storage has no runtime). 'standby' is rest, not failure.
  app.get('/projects/:id/runtime-health', async (req, reply) => {
    const { id } = req.params as { id: string }
    try { return await engine.runtimeHealth(id, (req.query as { branch?: string }).branch) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
  })

  // Branch rename — metadata only, like the cloud: provider resources keep their frozen ref.
  app.patch('/projects/:id/branches/:bid', async (req, reply) => {
    const { id, bid } = req.params as { id: string; bid: string }
    const { name } = (req.body ?? {}) as { name?: unknown }
    // Typed, not just truthy: RegExp.test coerces, so `{"name": 123}` reached the rename itself.
    if (typeof name !== 'string' || !name) return reply.code(400).send({ error: 'name required' })
    try { return { branch: engine.renameBranch(id, bid, name) } }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return reply.code(m.includes('already exists') ? 409 : errCode(m)).send({ error: m })
    }
  })
  // ---- storage objects (platform parity: list / presigned download / presigned upload /
  // delete / bulk delete). Gated per action class — storage.read|write|delete — so file browsing
  // can be granted without credential reads, and writes without removal (same split as the
  // platform). Provider (Garage) failures surface as 502, adapter without object support as 501.
  const objErr = (reply: FastifyReply, e: unknown): FastifyReply => {
    const m = e instanceof Error ? e.message : String(e)
    const code = m.includes('not supported by this storage adapter') ? 501
      : m.includes('could not reach Garage') || m.includes('Garage answered') ? 502
      : errCode(m)
    return reply.code(code).send({ error: m })
  }

  app.get('/projects/:id/services/:sid/objects', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const q = req.query as { branch?: string; prefix?: string; cursor?: string; limit?: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'storage.read', reply)) return reply
    try { return await engine.listServiceObjects(id, sid, { branch: q.branch, prefix: q.prefix, cursor: q.cursor, limit: q.limit ? Number(q.limit) : undefined }) }
    catch (e) { return objErr(reply, e) }
  })

  // Static `objects/download` wins over the parametric listing route.
  app.get('/projects/:id/services/:sid/objects/download', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const q = req.query as { branch?: string; key?: string; disposition?: string }
    if (!q.key) return reply.code(400).send({ error: 'key is required' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'storage.read', reply)) return reply
    const disposition = q.disposition === 'inline' ? 'inline' : 'attachment'
    try { return await engine.presignServiceObjectDownload(id, sid, { branch: q.branch, key: q.key, disposition }) }
    catch (e) { return objErr(reply, e) }
  })

  app.post('/projects/:id/services/:sid/objects/upload', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const q = req.query as { branch?: string }
    const body = (req.body ?? {}) as { key?: string; contentType?: string; size?: number }
    if (!body.key?.trim()) return reply.code(400).send({ error: 'key is required' })
    if (!body.contentType?.trim()) return reply.code(400).send({ error: 'contentType is required' })
    if (typeof body.size !== 'number') return reply.code(400).send({ error: 'size (bytes) is required' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'storage.write', reply)) return reply
    try { return await engine.presignServiceObjectUpload(id, sid, { branch: q.branch, key: body.key, contentType: body.contentType, size: body.size }) }
    catch (e) { return objErr(reply, e) }
  })

  app.delete('/projects/:id/services/:sid/objects', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const q = req.query as { branch?: string; key?: string }
    if (!q.key) return reply.code(400).send({ error: 'key is required' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'storage.delete', reply)) return reply
    try { return await engine.deleteServiceObject(id, sid, { branch: q.branch, key: q.key }) }
    catch (e) { return objErr(reply, e) }
  })

  // POST, not DELETE: a body on DELETE is poorly supported across proxies and generators.
  app.post('/projects/:id/services/:sid/objects/delete', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const q = req.query as { branch?: string }
    const { keys } = (req.body ?? {}) as { keys?: string[] }
    if (!Array.isArray(keys) || keys.length === 0) return reply.code(400).send({ error: 'keys must hold at least one object key' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'storage.delete', reply)) return reply
    try { return await engine.deleteServiceObjects(id, sid, { branch: q.branch, keys }) }
    catch (e) { return objErr(reply, e) }
  })

  // ---- managed data browser (platform parity: the console's redis key browser). Gated `db.read`;
  // a sleeping instance answers 503 (the dashboard's wake gate keys on it), a missing key 404,
  // an adapter without command support 501, and provider (docker) trouble 502.
  const dataErr = (reply: FastifyReply, e: unknown): FastifyReply => {
    const m = e instanceof Error ? e.message : String(e)
    const code = /sleeping/.test(m) ? 503
      : m.includes('not supported by this managed database adapter') ? 501
      : m.includes('only supported for redis') ? 400
      // A docker exec that failed, or a listing the server answered in an unexpected shape, is
      // provider trouble — 502, never a 400 that blames the request for an outage.
      : m.includes('docker ') || m.includes('unexpected shape') ? 502
      : errCode(m)
    return reply.code(code).send({ error: m })
  }

  app.get('/projects/:id/services/:sid/redis/keys', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const q = req.query as { branch?: string; db?: string; cursor?: string; count?: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    const db = q.db === undefined ? 0 : Number(q.db)
    if (!Number.isInteger(db) || db < 0 || db > 15) return reply.code(400).send({ error: 'db must be an integer from 0 to 15' })
    const count = q.count === undefined ? undefined : Number(q.count)
    if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 1000)) return reply.code(400).send({ error: 'count must be an integer from 1 to 1000' })
    if (!gated(id, 'db.read', reply)) return reply
    try { return await engine.redisKeys(id, sid, { branch: q.branch, db, cursor: q.cursor, count }) }
    catch (e) { return dataErr(reply, e) }
  })

  app.get('/projects/:id/services/:sid/redis/stats', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const q = req.query as { branch?: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'db.read', reply)) return reply
    try { return await engine.redisStats(id, sid, { branch: q.branch }) }
    catch (e) { return dataErr(reply, e) }
  })

  app.get('/projects/:id/services/:sid/redis/value', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const q = req.query as { branch?: string; db?: string; key?: string }
    if (!q.key) return reply.code(400).send({ error: 'key is required' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    const db = q.db === undefined ? 0 : Number(q.db)
    if (!Number.isInteger(db) || db < 0 || db > 15) return reply.code(400).send({ error: 'db must be an integer from 0 to 15' })
    if (!gated(id, 'db.read', reply)) return reply
    try { return await engine.redisValue(id, sid, { branch: q.branch, db, key: q.key }) }
    catch (e) { return dataErr(reply, e) }
  })

  // Remove a service and answer the cloud's teardown summary (decision 50): how many containers,
  // buckets and directories went, and how many refused to. EVERY type is removed from ONE branch,
  // resolved exactly as an add resolves one: the qualifier on the id first, then `?branch`, then
  // the default (decision 49). Removing every branch's copy destroyed main's database, and its
  // bytes, when the caller asked to drop the one on `feat`; a compute group was the last arm still
  // doing it, and a group's `/data` volume is per branch, so it took main's volume with it. The
  // project-level registration retires with the last branch that carries the name.
  app.delete('/projects/:id/services/:sid', async (req, reply) => {
    const { id, sid: raw } = req.params as { id: string; sid: string }
    const on = { branch: (req.query as { branch?: string }).branch }
    const sid = bareSid(raw)
    if (!gated(id, 'service.remove', reply)) return reply
    try {
      const teardown = sid.startsWith('cp-') ? await engine.removeComputeService(id, raw, on)
        : sid.startsWith('pg-') ? await engine.removeDbService(id, raw, on)
        : sid.startsWith('st-') ? await engine.removeStorageService(id, raw, on)
        : await engine.removeManagedService(id, raw, on)
      return teardownReply(reply, teardown, `\`insta services remove ${sid}\``)
    } catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  // ---- user-defined secrets (insta secrets set/unset) ----
  app.put('/projects/:id/secrets/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string }
    const body = (req.body ?? {}) as { value?: string; branch?: string; service?: string }
    if (!body.value) return reply.code(400).send({ error: 'value required' })
    if (!gated(id, 'secrets.write', reply)) return reply
    try { engine.setUserSecret(id, name, body.value, body.branch ?? null, body.service ?? null); return { ok: true } }
    catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  // `service` (`<type>/<name>`, as PUT takes it) removes only the copy bound to that service, as the console's
  // Variables tab deletes it; `unbound=true` removes only the branch's unbound copy. With neither, every row with
  // that name and branch goes, as before.
  //
  // Both narrow a BRANCH delete, so both refuse to run without one, and a narrowing the route cannot read exactly
  // is a 400, never the broad delete: without a branch, `unbound=true` meant the project-wide row; a repeated or
  // mis-cased `unbound` fell back to every copy. Checked before the gate so a malformed request queues no approval.
  app.delete('/projects/:id/secrets/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string }
    const { branch, service, unbound } = req.query as { branch?: unknown; service?: unknown; unbound?: unknown }
    if (service !== undefined || unbound !== undefined) {
      if (typeof branch !== 'string' || !branch) return reply.code(400).send({ error: 'service and unbound narrow a branch delete: pass branch' })
      if (service !== undefined && unbound !== undefined) return reply.code(400).send({ error: 'pass service or unbound, not both' })
      if (service !== undefined && (typeof service !== 'string' || !service)) return reply.code(400).send({ error: 'service must be one <type>/<name>' })
      if (unbound !== undefined && unbound !== 'true') return reply.code(400).send({ error: 'unbound takes only true' })
    }
    if (!gated(id, 'secrets.write', reply)) return reply
    engine.unsetUserSecret(id, name, (branch as string | undefined) ?? null,
      typeof service === 'string' ? service : unbound === 'true' ? null : undefined)
    return { ok: true }
  })

  // `limit` is a page size, and `slice(-limit)` reads every other number as "all of it":
  // `limit=0`, `limit=abc` and `limit=-5` each handed back the whole retained set, up to EVENTS_CAP
  // rows, to a poller expecting a page. Junk is the 400 the other query parameters answer with
  // (`component must be ...`), and a large number clamps rather than fails.
  const EVENTS_LIMIT_MAX = 1000
  const eventsLimit = (raw: string | undefined): number | null => {
    if (raw === undefined || raw === '') return 50
    const n = Number(raw)
    return Number.isInteger(n) && n >= 1 ? Math.min(n, EVENTS_LIMIT_MAX) : null
  }

  app.get('/projects/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { branch?: string; limit?: string; kinds?: string }
    const limit = eventsLimit(q.limit)
    if (limit === null) return reply.code(400).send({ error: `limit must be an integer from 1 to ${EVENTS_LIMIT_MAX}` })
    let events = engine.listEvents(id)
    if (q.branch) events = events.filter((e) => e.branch === q.branch)
    // `kinds` (comma-separated) filters BEFORE the limit slice, so a page asked for deploy events
    // spends its budget on deploy events — the audit stream also carries browse-rate reads
    // (db.read, db.query, storage.objects.*) that would otherwise push them off the page.
    if (q.kinds) {
      const wanted = new Set(q.kinds.split(',').map((k) => k.trim()).filter(Boolean))
      if (wanted.size) events = events.filter((e) => wanted.has(e.kind))
    }
    return { events: events.slice(-limit).map(eventOut) }
  })

  // Agent event ingest (the CLI observe hook uploads credential-audit findings here).
  app.post('/projects/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { kind?: string; branch?: string; payload?: unknown; dedup_key?: string; source?: string }
    if (!body.kind) return reply.code(400).send({ error: 'kind required' })
    engine.emit(id, body.branch ?? null, (body.source as AuditEvent['source']) ?? 'agent', body.kind, body.payload ?? {}, body.dedup_key ?? null)
    return reply.code(201).send({ ok: true })
  })

  // ---- package regions (contract 00 section 1.3): new routes go here, right before the dashboard
  // block. The 501 stubs each region replaces were moved in by the scaffold, so the owner deletes
  // them inside its own region. Region A = WP1, B = WP2, C = WP3, D = WP5.

  // ---- region A (WP1 identity/config) ----
  // /me and /tokens are registered by registerAuth() above: one call site mints the right pair for
  // the run mode, so the local surface stays byte-identical and the server one is guarded.
  // ---- end region A ----

  // ---- region B (WP2 router) ----
  // Custom domains: the cloud's four hidden routes (platform server.ts:2740-2766), rendered by
  // `insta domain attach | check | detach` for bring-your-own names. The envelope carries NO `ssl`,
  // `origin` or `originStatus` key: the CLI reads an `ssl` field as a cloud-plane answer, then
  // demands an ownership TXT record and prints UNCONFIRMED (decision 25).
  const domainQuery = (req: { query: unknown; body: unknown }): { hostname?: unknown; branch?: string; group?: string } => {
    const q = (req.query ?? {}) as { hostname?: string; branch?: string; group?: string }
    const b = (req.body ?? {}) as { hostname?: unknown; branch?: string; group?: string }
    return { hostname: b.hostname ?? q.hostname, branch: b.branch ?? q.branch, group: b.group ?? q.group }
  }
  // The engine throws with a `status`, so one mapper serves all four routes.
  const domainFail = (e: unknown, reply: FastifyReply) => {
    const status = (e as { status?: number }).status
    const message = e instanceof Error ? e.message : String(e)
    return reply.code(typeof status === 'number' ? status : 400).send({ error: message })
  }

  app.post('/projects/:id/compute/domain', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'deploy', reply)) return reply
    try { return await engine.setComputeDomain(id, domainQuery(req)) } catch (e) { return domainFail(e, reply) }
  })

  app.get('/projects/:id/compute/domain', async (req, reply) => {
    const { id } = req.params as { id: string }
    try { return await engine.computeDomainStatus(id, domainQuery(req)) } catch (e) { return domainFail(e, reply) }
  })

  app.get('/projects/:id/compute/domains', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = (req.query ?? {}) as { branch?: string; group?: string }
    try { return { items: await engine.listComputeDomains(id, q) } } catch (e) { return domainFail(e, reply) }
  })

  app.delete('/projects/:id/compute/domain', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'deploy', reply)) return reply
    try { return engine.removeComputeDomain(id, domainQuery(req)) } catch (e) { return domainFail(e, reply) }
  })
  // ---- end region B ----

  // ---- region C (WP3 scheduler) ----
  // The two service knobs the scheduler makes real: the cgroup ceiling (`insta compute limits`) and
  // the opt-out from sleep (`insta compute always-on`). Both resolve the branch from a qualified sid
  // first (decision 49) and then act on the BARE service id, because limits and an explicit
  // always-on are project-level settings that apply to the service on every branch. With no
  // explicit always-on the branch decides (`effectiveAlwaysOn`), and `null` goes back to that.
  const sidOf = (req: { params: unknown; query: unknown }): string => {
    const { id, sid } = req.params as { id: string; sid: string }
    return engine.resolveSid(id, sid, (req.query as { branch?: string }).branch).serviceId
  }
  /** A limits failure's status: the engine attaches 502 to a partial resize; the rest is the usual
   *  404-or-400 split. */
  const limitsFail = (e: unknown, reply: FastifyReply): FastifyReply => {
    const m = e instanceof Error ? e.message : String(e)
    const status = (e as { status?: number }).status
    return reply.code(typeof status === 'number' ? status : errCode(m)).send({ error: m })
  }

  app.get('/projects/:id/services/:sid/limits', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    try { return engine.serviceLimits(id, sidOf(req)) } catch (e) { return limitsFail(e, reply) }
  })

  // Gated `service.upgrade`, like the cloud (it changes what the machine costs to run).
  app.put('/projects/:id/services/:sid/limits', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'service.upgrade', reply)) return reply
    const body = (req.body ?? {}) as { memoryMb?: unknown; cpu?: unknown }
    if (typeof body.memoryMb !== 'number') return reply.code(400).send({ error: 'memoryMb required (MB, a multiple of 256)' })
    if (body.cpu !== undefined && typeof body.cpu !== 'number') return reply.code(400).send({ error: 'cpu must be a number of vCPU' })
    try {
      const { service, limits, cap } = await engine.setServiceLimits(id, sidOf(req), { memoryMb: body.memoryMb, cpu: body.cpu })
      return { service, limits, cap }
    } catch (e) { return limitsFail(e, reply) }
  })

  app.put('/projects/:id/services/:sid/always-on', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    const { enabled } = (req.body ?? {}) as { enabled?: unknown }
    // A boolean pins the service on every branch; null clears it back to the default.
    if (enabled !== null && typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be a boolean, or null to follow the default' })
    }
    try { return await engine.setAlwaysOn(id, sidOf(req), enabled as boolean | null) } catch (e) { return limitsFail(e, reply) }
  })
  // ---- end region C ----

  // ---- region D (WP5 templates/parity) ----
  // The bundled template registry and the deployment routes, plus per-service credentials.

  /** A branch-qualified service id (`<branchId>:pg-db`, decision 49) stripped to its bare id. The
   *  engine resolves the branch from the SAME qualifier, so a route that needs only the id (a
   *  project-level remove or rename) takes this and nothing else. */
  const bareSid = (sid: string): string => (parseServiceId(sid)?.serviceId ?? sid)

  /** A provisioning failure's status: 507 when dockerd is out of network subnets (the message the
   *  engine rethrows), the caller's default otherwise. */
  const provisionCode = (m: string, fallback = 400): number => (m.includes('no free network subnets') ? 507 : fallback)

  // Public in server mode (cloud `security: []`, openapi.yaml:7702 and 7727), and CDN-cacheable
  // the same way the cloud's are.
  app.get('/templates', async (req, reply) => {
    const q = req.query as { query?: string; category?: string }
    reply.header('cache-control', 'public, max-age=300')
    return engine.templates.listTemplates({ query: q.query, category: q.category })
  })

  app.get('/templates/:code', async (req, reply) => {
    const { code } = req.params as { code: string }
    reply.header('cache-control', 'public, max-age=300')
    try { return engine.templates.getTemplate(code) }
    catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : `template not found: ${code}` }) }
  })

  // Deploy a template. Gated service.add + secrets.write + deploy, and service.upgrade when the
  // manifest declares a volume (decision 45) — the gate list is manifest-dependent, so it runs
  // INSIDE create(), after the idempotency decision: an echo of a finished deployment must not be
  // refusable by a policy changed since, and must never consume a single-use approval.
  app.post('/projects/:id/template-deployments', async (req, reply) => {
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as Record<string, unknown>
    let refused = false
    try {
      const out = await engine.executor.create(id, {
        templateCode: (b.templateCode ?? b.code) as string | undefined,
        templateVersion: b.templateVersion as string | undefined,
        manifest: b.manifest,
        branchId: b.branchId as string | undefined,
        branch: b.branch as string | undefined,
        variables: b.variables as Record<string, string> | undefined,
        deploymentId: b.deploymentId as string | undefined,
      }, async (actions) => {
        for (const action of actions) {
          if (!gated(id, action, reply)) { refused = true; throw new GateRefused() }
        }
      })
      return reply.code(202).send({ deploymentId: out.deployment.id, deployment: out.deployment })
    } catch (e) {
      // The gate already answered (403 or 202 approval_required): nothing more to send.
      if (refused && e instanceof GateRefused) return reply
      // The machine-readable half of "you forgot these": callers prompt from the list and retry.
      if (e instanceof MissingTemplateVariablesError) {
        return reply.code(400).send({ error: 'missing_variables', missing: e.missing, missingVariables: e.missing })
      }
      const m = e instanceof Error ? e.message : String(e)
      const status = e instanceof TemplateError ? e.status : e instanceof ManifestError ? 400 : provisionCode(m)
      return reply.code(status).send({ error: m })
    }
  })

  // Unwrapped, like the cloud (platform server.ts:2721): the CLI's watcher reads the row directly.
  app.get('/template-deployments/:did', async (req, reply) => {
    const { did } = req.params as { did: string }
    try { return engine.executor.get(did) }
    catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : 'template deployment not found' }) }
  })

  // One service's credential bundle on one branch, in the host-facing lane form. The branch comes
  // from a qualified sid FIRST, then ?branch, then the default (decision 49): the CLI lists
  // ?branch=<b>, takes the id it is given, and calls this with no branch at all.
  app.get('/projects/:id/services/:sid/credentials', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'secrets.read', reply)) return reply
    try {
      const credentials = engine.credentials(id, sid, (req.query as { branch?: string }).branch)
      engine.emit(id, null, 'govern', 'secrets.read', { service: bareSid(sid) })
      return { credentials }
    } catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
  })
  // ---- end region D ----

  // ---- region G (git push-to-deploy): bind a compute group to a GitHub repo; a push to the tracked
  // branch hits POST /webhooks/git/<id> (HMAC-verified, OUTSIDE the auth guard) and the daemon builds
  // the repo with `docker build <git-context>` (BuildKit fetches it, no local clone) and redeploys.
  // Self-hosted equivalent of the cloud's GitHub App flow (which stays 501): the auth model here is a
  // per-service Personal Access Token, or a public repo (no token).
  const findBinding = (projectId: string, branchId: string, group: string): GitBindingRecord | undefined =>
    Object.values(loadState().gitBindings ?? {}).find((r) => r.projectId === projectId && r.branchId === branchId && r.group === group)
  /** Resolve a service id (bare `cp-web` or branch-qualified `<branchId>:cp-web`) to its branch and
   *  compute group, using the same convention as every other service route. Null for a bad id, a
   *  missing branch/service, or a non-compute type. */
  const gitTarget = (req: FastifyRequest): { id: string; branch: Branch; group: string } | null => {
    const { id, sid } = req.params as { id: string; sid: string }
    const q = (req.query ?? {}) as { branch?: string }
    let resolved: { branch: Branch; serviceId: string }
    try { resolved = engine.resolveSid(id, sid, typeof q.branch === 'string' ? q.branch : undefined) }
    catch { return null }
    const parsed = parseServiceId(resolved.serviceId)
    if (!parsed || parsed.type !== 'compute') return null
    return { id, branch: resolved.branch, group: parsed.name }
  }

  // Per-binding build serialization + NEWEST-COMMIT-wins coalescing: while one build runs, only the
  // pending job with the newest commit timestamp is kept, and `doGitDeploy` additionally refuses to
  // deploy a commit that is not strictly newer than the binding's last-deployed one. Together these
  // mean an out-of-order or redelivered older push can never overwrite a newer deployment, whatever
  // order GitHub delivers pushes in. A job carries its commit `sha`/`ts`; `webhook` distinguishes a
  // push (governed, staleness-checked) from the already-authorized initial connect build.
  type GitJob = { sha?: string; ts?: number; webhook: boolean }
  // `done` is the promise of the in-flight runner (all coalesced jobs), so unbind/rebind can wait for
  // a build to finish before removing the binding — see settleGit.
  const gitBuilds = new Map<string, { running: boolean; next: GitJob | null; done: Promise<void> | null }>()

  /** Resolve once the binding has no build in flight. Unbind/rebind await this so a DELETE (or a
   *  replacement) cannot return while a webhook build it already validated is still deploying. */
  const settleGit = async (bindingId: string): Promise<void> => { await gitBuilds.get(bindingId)?.done }

  // A hung `docker build` must not wedge its binding forever (the per-binding queue would never
  // drain), and a burst of pushes across many bindings must not fork-bomb the box with concurrent
  // builds. So a build has a hard timeout and all builds share a small daemon-wide semaphore. The
  // per-binding serialization + coalescing above still stands; this only bounds the heavy step.
  const GIT_BUILD_TIMEOUT_MS = 20 * 60_000
  const GIT_BUILD_CONCURRENCY = 2
  let gitBuildSlots = GIT_BUILD_CONCURRENCY
  const gitBuildWaiters: Array<() => void> = []
  // In-flight build children, so daemon shutdown can kill them and await the runners rather than
  // stranding a `docker build` past app.close() (which would reset the concurrency limit on restart).
  const activeGitBuilds = new Set<{ kill: () => void }>()
  let gitShuttingDown = false
  app.addHook('onClose', async () => {
    // Order matters: flip the flag FIRST so runners stop consuming queued/coalesced jobs, then kill
    // the active children and release any semaphore waiters so a blocked runner unblocks and exits
    // without starting a new build. Only then await the runners to finish.
    gitShuttingDown = true
    for (const q of gitBuilds.values()) q.next = null
    for (const b of activeGitBuilds) b.kill()
    while (gitBuildWaiters.length) gitBuildWaiters.shift()?.()
    await Promise.allSettled([...gitBuilds.values()].map((q) => q.done ?? Promise.resolve()))
  })
  const acquireBuildSlot = async (): Promise<() => void> => {
    if (gitBuildSlots <= 0) await new Promise<void>((resolve) => gitBuildWaiters.push(resolve))
    gitBuildSlots--
    let released = false
    return () => { if (released) return; released = true; gitBuildSlots++; gitBuildWaiters.shift()?.() }
  }
  /** Run one build under the global semaphore with a hard timeout; the timeout kills the child so a
   *  hung fetch/build cannot hold the slot or the binding. */
  const runBuild = async (spec: { args: string[]; env: Record<string, string> }): Promise<void> => {
    const release = await acquireBuildSlot()
    try {
      // A runner blocked on the semaphore and woken by shutdown (a killed build freed a slot) must not
      // spawn a new child after the close hook's one kill pass. THROW, never return: a resolved
      // runBuild is indistinguishable from a completed build, and doGitDeploy would then "deploy" a tag
      // that was never built and persist it as deployed. Throwing lands in doGitDeploy's catch, which
      // emits git.deploy.failed and rmis the (nonexistent) tag — the correct disposition.
      if (gitShuttingDown) throw new Error('daemon shutting down; build not started')
      const call = dockerCall(spec.args, { env: spec.env })
      activeGitBuilds.add(call)
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; call.kill() }, GIT_BUILD_TIMEOUT_MS)
      try { await call.done } catch (e) { throw timedOut ? new Error(`build exceeded ${GIT_BUILD_TIMEOUT_MS / 1000}s and was terminated`) : e } finally { clearTimeout(timer); activeGitBuilds.delete(call) }
    } finally { release() }
  }
  /** Reclaim a binding's superseded build images, keeping `keep` (the tag currently deployed, or null
   *  to try them all). `docker rmi` refuses an image a running container still uses, so the live one
   *  is never removed even if two bindings' short tag prefixes collide. Best-effort: never throws. */
  const pruneBuildImages = async (repo: string, keep: string | null): Promise<void> => {
    try {
      const out = (await docker(['images', repo, '--format', '{{.Repository}}:{{.Tag}}'])).toString()
      for (const t of out.split('\n').map((s) => s.trim())) {
        if (!t || t === keep || t.endsWith(':<none>')) continue
        try { await docker(['rmi', t]) } catch { /* in use, or already gone */ }
      }
    } catch { /* listing failed; skip */ }
  }

  /** Build the commit and redeploy the group. Governance and staleness are checked for a webhook
   *  push (the connect build is already authorized by its route); the build is re-validated under the
   *  service lock by deployFromGit, so a target removed/renamed mid-build never deploys. Emits git.*
   *  events (visible in `insta events`) and never throws. */
  const doGitDeploy = async (bindingId: string, job: GitJob): Promise<void> => {
    const { sha, ts, webhook } = job
    const st0 = loadState()
    const rec = st0.gitBindings?.[bindingId]
    if (!rec) return
    const branch0 = Object.values(st0.branches).find((b) => b.id === rec.branchId)
    if (!branch0 || !branch0.apps?.[rec.group]) return
    const branchName = branch0.name
    if (webhook) {
      // A push auto-deploys only when the project's deploy policy is `allow`. A webhook cannot take
      // part in an interactive approval, so `approval_required` (and `deny`) hold the push instead of
      // deploying — recorded as an event; the operator deploys the commit manually or sets the policy
      // to `allow`. effectivePolicy is a pure read: it never creates a pending approval (which a
      // webhook could never resume), so there is no lost-work or double-approval hazard.
      const policy = govern.effectivePolicy(rec.projectId).deploy
      if (policy !== 'allow') {
        engine.emit(rec.projectId, branchName, 'resource', 'git.deploy.blocked', { group: rec.group, sha: sha ?? null, reason: policy === 'deny' ? 'deploy denied by policy' : 'push-to-deploy needs an "allow" deploy policy; deploy this commit manually or change the policy' })
        return
      }
      // Reject a redelivered or out-of-order push: the same commit already deployed, or a commit whose
      // (clamped) ordering key is not newer than the last one deployed. `<=`, not `<`: two commits that
      // share a one-second timestamp must not both win, and `ts` is already clamped to arrival time so
      // a future/missing timestamp can never appear "newest" and wedge the binding.
      const last = rec.binding
      if ((sha && last.lastDeployedSha === sha) || (ts !== undefined && last.lastDeployedAt !== undefined && ts <= last.lastDeployedAt)) {
        engine.emit(rec.projectId, branchName, 'resource', 'git.deploy.skipped', { group: rec.group, sha: sha ?? null, reason: 'stale push (already deployed or not newer than the current deployment)' })
        return
      }
    }
    if (gitShuttingDown) return // the daemon is closing; don't start a new build the shutdown can't drain
    const tag = imageTag(bindingId, sha)
    engine.emit(rec.projectId, branchName, 'resource', 'git.build', { repo: `${rec.binding.owner}/${rec.binding.repo}`, group: rec.group, sha: sha ?? null })
    try {
      // Pin the checkout to the pushed commit SHA (webhook) or the ref (initial connect). The PAT is
      // handed to BuildKit as the GIT_AUTH_TOKEN env-secret, never on the command line. No mergeStderr:
      // BuildKit logs the failure reason to stderr, and only when stderr is NOT merged does docker()
      // fold it into the rejection — so a failed build's git.deploy.failed event carries a real reason.
      const spec = dockerBuildSpec(rec.binding, tag, sha ?? rec.binding.ref)
      await runBuild(spec)
      // deployFromGit re-validates the binding + existing group and preserves its configured port,
      // all under the service lock, so a target removed during the build is not re-materialised and a
      // non-8080 service is not reset to 8080. null => the target is gone; do not deploy.
      const res = await engine.deployFromGit(rec.projectId, rec.branchId, rec.group, bindingId, tag)
      if (!res) {
        // The image we just built is not deployed anywhere: drop it so a removed target does not leak one.
        try { await docker(['rmi', tag]) } catch { /* already gone */ }
        engine.emit(rec.projectId, branchName, 'resource', 'git.deploy.skipped', { group: rec.group, sha: sha ?? null, reason: 'binding or service removed during build' })
        return
      }
      // Record what we deployed AND when: the ordering guard above reads these back.
      if (webhook && sha) mutate((st) => { const r = st.gitBindings?.[bindingId]; if (r) { r.binding.lastDeployedSha = sha; if (ts !== undefined) r.binding.lastDeployedAt = ts } })
      engine.emit(rec.projectId, res.branch, 'resource', 'git.deploy', { group: rec.group, image: tag, sha: sha ?? null, port: res.port })
      // Reclaim this binding's now-superseded images (keep the one just deployed). Every push mints a
      // new tag, so without this the daemon's disk grows without bound (a real failure, seen in the wild).
      // BuildKit's build CACHE (git sources + layers) is separate and NOT reclaimed here: a coarse
      // prune of the default builder would evict unrelated workloads' cache, so a dedicated builder
      // with its own GC policy is tracked as a follow-up (#166); operators can `docker builder prune`.
      await pruneBuildImages(tag.split(':')[0], tag)
    } catch (e) {
      // A build that produced an image but never deployed leaves an unused tag behind; drop it.
      try { await docker(['rmi', tag]) } catch { /* build may have failed before any image existed */ }
      engine.emit(rec.projectId, branchName, 'resource', 'git.deploy.failed', { group: rec.group, sha: sha ?? null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Kick off (or coalesce into) a build for a binding. Detached, so the webhook answers fast. */
  const runGitDeploy = (bindingId: string, job: GitJob): void => {
    if (gitShuttingDown) return // no new dispatch once the daemon is closing
    const q = gitBuilds.get(bindingId) ?? { running: false, next: null, done: null }
    gitBuilds.set(bindingId, q)
    // Coalesce by commit time, not arrival order: keep the pending job with the newest ts, so a
    // delayed older push does not become the one that runs after the current build finishes.
    if (q.running) { if (!q.next || (job.ts ?? 0) >= (q.next.ts ?? 0)) q.next = job; return }
    q.running = true
    // The runner NEVER rejects: settleGit awaits q.done from DELETE/rebind, so a rejection would turn
    // an unexpected build error into a 500 (or an unhandled rejection). doGitDeploy has its own
    // build/deploy try; catch here covers a throw from a state read/emit BEFORE it, clears the pending
    // job, and lets finally drain the queue so the binding is never wedged.
    q.done = (async () => {
      try {
        let cur: GitJob | null = job
        // Stop consuming jobs once shutdown starts, so app.close() cannot leave a new build running
        // past the daemon restart.
        while (cur && !gitShuttingDown) { await doGitDeploy(bindingId, cur); cur = gitShuttingDown ? null : q.next; q.next = null }
      } catch (e) {
        q.next = null
        console.warn(`git build runner for ${bindingId} failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        q.running = false
        // Drop the idle queue so repeated bind/delete/rebind cannot leak Map entries; the get, the
        // !next check and the delete all run synchronously here, so nothing can re-arm q in between.
        if (gitBuilds.get(bindingId) === q && !q.next) gitBuilds.delete(bindingId)
      }
    })()
  }

  app.post('/projects/:id/services/:sid/git', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'deploy', reply)) return reply
    const t = gitTarget(req)
    if (!t) return reply.code(404).send({ error: 'no such compute service on that branch' })
    // Attach to an existing compute group so the redeploy reuses its port (deploy it once first).
    if (!t.branch.apps?.[t.group]) return reply.code(400).send({ error: `no compute service "${t.group}" on ${t.branch.name}; deploy it once first, then connect the repo` })
    const body = (req.body ?? {}) as { repo?: unknown; ref?: unknown; token?: unknown }
    let owner: string, repoName: string, ref: string
    try { const p = parseRepo(body.repo); owner = p.owner; repoName = p.repo; ref = normalizeRef(body.ref) }
    catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) }) }
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    const rec: GitBindingRecord = { binding: newBinding(owner, repoName, ref, token, Date.now()), projectId: id, branchId: t.branch.id, branchName: t.branch.name, group: t.group }
    // Any binding this replaces: remove it, then wait for its in-flight build to settle before the new
    // one starts, so the old repository cannot deploy over the new binding after it is exposed.
    const replaced: string[] = []
    mutate((s) => {
      s.gitBindings ??= {}
      for (const [k, v] of Object.entries(s.gitBindings)) if (v.projectId === id && v.branchId === t.branch.id && v.group === t.group) { replaced.push(k); delete s.gitBindings[k] }
      s.gitBindings[rec.binding.id] = rec
    })
    await Promise.all(replaced.map(settleGit))
    runGitDeploy(rec.binding.id, { webhook: false }) // the initial build; already authorized by the gate above
    const webhookUrl = `${cfg.apiUrl.replace(/\/+$/, '')}/webhooks/git/${rec.binding.id}`
    return reply.code(202).send({
      ok: true, binding: bindingOut(rec),
      webhook: { url: webhookUrl, secret: rec.binding.webhookSecret, contentType: 'application/json', events: ['push'] },
      note: `add this webhook to the repo (Settings > Webhooks, content type application/json); a push to ${ref} rebuilds and redeploys. The first build is running now.`,
    })
  })

  app.get('/projects/:id/services/:sid/git', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    const t = gitTarget(req)
    const rec = t ? findBinding(id, t.branch.id, t.group) : undefined
    return rec ? { binding: bindingOut(rec) } : reply.code(404).send({ error: 'no repo connected to this service' })
  })

  app.delete('/projects/:id/services/:sid/git', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'deploy', reply)) return reply
    const t = gitTarget(req)
    const rec = t ? findBinding(id, t.branch.id, t.group) : undefined
    if (!rec) return reply.code(404).send({ error: 'no repo connected to this service' })
    // Remove the binding first (so no NEW build can start), then wait for any in-flight build to
    // finish: a webhook cannot deploy after this route returns, and its own validated build has
    // drained. deployFromGit re-checks the binding under the lock, so a build that has not yet
    // reached that check simply skips.
    mutate((s) => { if (s.gitBindings) delete s.gitBindings[rec.binding.id] })
    await settleGit(rec.binding.id)
    // Reclaim this binding's build images. The service keeps running after unbind, so its live image
    // is in use and rmi skips it; only the superseded tags are removed.
    await pruneBuildImages(imageTag(rec.binding.id).split(':')[0], null)
    return { ok: true }
  })

  // The push webhook: OUTSIDE the auth guard (GitHub cannot present a token), verified by the
  // per-binding HMAC over the raw body. Answers 202 at once and builds detached (GitHub's 10 s budget).
  // A raised bodyLimit (default 1 MB) so a large-but-valid push is not 413'd before HMAC/branch
  // filtering; kept modest because the raw body is buffered before the signature is checked.
  app.post('/webhooks/git/:bindingId', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const { bindingId } = req.params as { bindingId: string }
    const rec = loadState().gitBindings?.[bindingId]
    if (!rec) return reply.code(404).send({ error: 'unknown webhook' })
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? ''
    if (!verifySignature(rec.binding.webhookSecret, Buffer.from(raw, 'utf8'), req.headers['x-hub-signature-256'])) {
      return reply.code(401).send({ error: 'signature mismatch' })
    }
    const event = req.headers['x-github-event']
    if (event === 'ping') return { ok: true, pong: true }
    const push = pushRef(event, req.body)
    if (!push) return { ok: true, ignored: 'not a push to a branch' }
    if (push.branch !== rec.binding.ref) return { ok: true, ignored: `push to ${push.branch}, tracking ${rec.binding.ref}` }
    runGitDeploy(bindingId, { sha: push.sha, ts: push.ts, webhook: true })
    return reply.code(202).send({ ok: true, building: push.sha })
  })
  // ---- end region G ----

  // ---- local dashboard: serve ui/dist when built (same origin as the API — localhost trust,
  // no CORS, no auth). API routes above always win; unknown non-API GETs fall back to the SPA.
  const uiDist = cfg.uiDist
  if (existsSync(join(uiDist, 'index.html'))) {
    // index: false, so fastifyStatic never serves index.html raw: every shell response is injected.
    app.register(fastifyStatic, { root: uiDist, wildcard: false, index: false })
    const shellHtml = readFileSync(join(uiDist, 'index.html'), 'utf8')
    const sendShell = (reply: FastifyReply): FastifyReply => {
      // setupRequired is read per request: it flips to false the moment the admin is created.
      const boot = JSON.stringify({
        mode: cfg.mode,
        setupRequired: cfg.auth.enabled && !loadState().identity?.admin,
        // What a new service gets when nobody says otherwise, so the dashboard's switch starts
        // there instead of sending its own opinion on every create.
        alwaysOnDefault: cfg.sleep.alwaysOnDefault,
        apiUrl: cfg.apiUrl,
        consoleUrl: cfg.consoleUrl,
      }).replace(/</g, '\\u003c')
      const script = `<script>window.__INSTA_OSS__=${boot}</script>`
      const html = shellHtml.includes('</head>') ? shellHtml.replace('</head>', `${script}</head>`) : script + shellHtml
      return reply.type('text/html; charset=utf-8').send(html)
    }
    app.get('/', async (_req, reply) => sendShell(reply))
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !isApiPath(req.url)) return sendShell(reply)
      return reply.code(404).send({ error: 'not found' })
    })
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send(
      '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:40rem;margin:4rem auto"><h2>InstaCloud OSS daemon</h2><p>The API is up. To get the dashboard, build the UI once:</p><pre>npm run build:ui</pre><p>then restart <code>instad</code>.</p></body>'))
  }

  return app
}
