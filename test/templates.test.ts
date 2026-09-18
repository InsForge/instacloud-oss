// The bundled catalog, the manifest module and the deployment executor, over the fake adapters and
// the REAL `templates/` directory (contract 00 section 9 rows for GET /templates,
// GET /templates/:code, POST /projects/:id/template-deployments, GET /template-deployments/:id).
// Docker is mocked; the health probe is injected, and one case pins what the DEFAULT probe dials.
import { test, expect, afterEach, beforeEach, vi } from 'vitest'

// `dockerCall` is the same seam with a handle on the child: the scheduler's runtime verbs go
// through it so a timed-out call can be killed and waited for. A factory that returns only
// `docker` leaves it undefined for every importer, so it is mocked here too, over the same fake.
vi.mock('../src/docker', () => ({
  docker: vi.fn((args: string[] = []) => fakeDocker(args)),
  dockerCall: (args: string[] = []) => ({ done: fakeDocker(args), kill: () => {} }),
}))

/** The docker seam, with the ONE fidelity the database health gate needs: `docker ps -a` answers
 *  from `FakeRuntime`, the single fake container store (decision 53), which the fake postgres
 *  adapter fills when it provisions. `runtimeHealth` shells that read directly rather than going
 *  through the runtime, so a seam that answered nothing reported every provisioned database as
 *  `none` -- a container docker says is absent -- and a gate that requires positive evidence
 *  would fail a template whose database is perfectly fine. A case that WANTS an absent or
 *  unreadable database says so: `dockerPsFails` for unreadable, a `db.provision` that skips the
 *  store for absent. */
let dockerPsFails = false
function fakeDocker(args: string[] = []): Promise<Buffer> {
  if (args[0] === 'ps') {
    if (dockerPsFails) return Promise.reject(new Error('Cannot connect to the Docker daemon'))
    const rows = [...runtime.store.entries()].map(([name, c]) => `${name}\t${c.state}`)
    return Promise.resolve(Buffer.from(rows.length ? `${rows.join('\n')}\n` : ''))
  }
  if (args[0] === 'rm') for (const a of args.slice(1)) if (!a.startsWith('-')) runtime.drop(a)
  return Promise.resolve(Buffer.from(''))
}

import { buildServer } from '../src/server'
import { Engine } from '../src/engine'
import { TemplateExecutor } from '../src/templates/executor'
import {
  collectVariables, generateValue, manifestDigest, parseTemplateManifest, resolveTemplateString,
} from '../src/templates/manifest'
import { loadState } from '../src/state'
import { hostArch, initHostArch } from '../src/hostarch'
import { calls, db, makeEngine, resetFakes, runtime, testConfig } from './fakes'

// Every declared healthcheck answers 200 unless a case changes this.
let probeStatus: (path: string) => number
let probed: Array<{ url: string; headers: Record<string, string> }>
let engine: Engine
let app: ReturnType<typeof buildServer>
let executor: TemplateExecutor

const fastConfig = (over: Record<string, string> = {}) => testConfig({
  INSTA_OSS_TEMPLATE_HEALTH_TIMEOUT_MS: '60',
  INSTA_OSS_TEMPLATE_HEALTH_POLL_MS: '5',
  ...over,
})

function build(over: Record<string, string> = {}): void {
  const cfg = fastConfig(over)
  engine = makeEngine(cfg)
  executor = new TemplateExecutor(engine, {
    httpProbe: async (url, headers) => { probed.push({ url, headers }); return probeStatus(new URL(url).pathname) },
  })
  engine.executor = executor
  app = buildServer(engine, cfg)
}

beforeEach(() => {
  resetFakes()
  probeStatus = () => 200
  probed = []
  dockerPsFails = false
  // Pinned, not inherited: what a template may run on is the box's architecture, and a suite whose
  // answers changed with the runner's CPU would assert nothing on one of them.
  initHostArch('amd64')
  build()
})

afterEach(() => { initHostArch(null) })

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload })
const get = (url: string) => app.inject({ method: 'GET', url })
const put = (url: string, payload?: unknown) => app.inject({ method: 'PUT', url, payload })

async function project(name = 'demo'): Promise<string> {
  return (await post('/orgs/local/projects', { name })).json().project.id
}

/** Deploy and wait for the background run to settle. */
async function deploy(id: string, body: Record<string, unknown>): Promise<ReturnType<typeof post> extends Promise<infer R> ? R : never> {
  const r = await post(`/projects/${id}/template-deployments`, body)
  await executor.idle()
  return r
}

// ---- catalog -----------------------------------------------------------------------------------

test('GET /templates lists the bundled non-draft codes with every list field typed', async () => {
  const r = await get('/templates')
  expect(r.statusCode).toBe(200)
  expect(r.headers['cache-control']).toBe('public, max-age=300')
  const { templates, hostArchitecture } = r.json()
  // openclaw declares meta.draft, so it is not in the listing.
  expect(templates.map((t: { code: string }) => t.code)).toEqual(['9router', 'claude-code', 'codex', 'dsh', 'hermes', 'n8n', 'pi', 'twenty'])
  const n8n = templates.find((t: { code: string }) => t.code === 'n8n')
  expect(n8n).toMatchObject({
    version: '1.3.2', name: 'n8n', category: 'automation', tags: ['automation', 'ai'],
    requiredVarCount: 0, totalProjects: 0, activeProjects: 0, deploymentCount: 0, activeDeploymentCount: 0,
    license: 'LicenseRef-n8n-Sustainable-Use-License', architectures: ['amd64', 'arm64'],
  })
  // The two halves of "can I run this here": the box on the envelope, the template on every row.
  expect(hostArchitecture).toBe('amd64')
  for (const entry of templates as Array<{ code: string; architectures: string[] }>) {
    expect(entry.architectures, entry.code).toContain('amd64')
  }
  // null, NOT 0, when nothing has concluded: no data is not a 0 percent success rate.
  expect(n8n.successRate).toBeNull()
  expect(n8n.logoUrl).toMatch(/^data:image\/svg\+xml;base64,/)
  expect(Date.parse(n8n.updatedAt)).toBeGreaterThan(0)
  // The README belongs to the detail view, never to a listing.
  expect(n8n.readme).toBeUndefined()
})

test('GET /templates filters by exact category and free-text query', async () => {
  expect((await get('/templates?category=automation')).json().templates.map((t: { code: string }) => t.code)).toEqual(['n8n'])
  expect((await get('/templates?category=AUTOMATION')).json().templates.map((t: { code: string }) => t.code)).toEqual(['n8n'])
  expect((await get('/templates?query=hermes')).json().templates.map((t: { code: string }) => t.code)).toEqual(['hermes'])
  expect((await get('/templates?query=nothing-matches')).json().templates).toEqual([])
})

test('GET /templates/:code carries the detail fields; a draft and an unknown code are 404', async () => {
  const r = await get('/templates/n8n')
  expect(r.statusCode).toBe(200)
  const t = r.json().template
  expect(t).toMatchObject({ code: 'n8n', version: '1.3.2', maintainer: 'official', source: 'official', documentationUrl: 'https://docs.n8n.io' })
  expect(t.architectures).toEqual(['amd64', 'arm64'])
  expect(r.json().hostArchitecture).toBe('amd64')
  expect(t.variables).toEqual({ required: [], optional: [] })
  // The five env groups are normalized onto every service, even the ones the author left out.
  expect(Object.keys(t.services.n8n.env).sort()).toEqual(['fixed', 'generated', 'optional', 'platform', 'required'])
  expect(t.services.n8n).toMatchObject({ type: 'web', port: 5678, healthcheck: '/healthz', alwaysOn: true, volume: true })
  // The README is served with the GitHub-only deploy button stripped.
  expect(t.readme).toContain('# n8n')
  expect(t.readme).not.toContain('deploy-button.svg')
  expect((await get('/templates/openclaw')).statusCode).toBe(404)
  expect((await get('/templates/openclaw')).json().error).toBe('template not found: openclaw')
  expect((await get('/templates/nope')).statusCode).toBe(404)
})

test('a required variable reaches the listing so a form can be rendered from it', async () => {
  const cc = (await get('/templates')).json().templates.find((t: { code: string }) => t.code === 'claude-code')
  expect(cc.requiredVarCount).toBe(2)
  expect(cc.requiredVars.map((v: { name: string }) => v.name)).toEqual(['ADMIN_USERNAME', 'ADMIN_PASSWORD'])
  const detail = (await get('/templates/claude-code')).json().template
  expect(detail.variables.required.map((v: { name: string }) => v.name)).toEqual(['ADMIN_USERNAME', 'ADMIN_PASSWORD'])
  expect(detail.variables.optional.map((v: { name: string }) => v.name)).toEqual(['ANTHROPIC_API_KEY'])
})

// ---- manifest module ---------------------------------------------------------------------------

const base = { code: 'x', version: '1', services: { web: { type: 'web', image: 'i', healthcheck: '/', port: 8080 } } }
const parse = (doc: unknown, opts?: { rejectAuthoredSizing?: boolean }) => parseTemplateManifest(doc, opts)
const refuses = (doc: unknown, re: RegExp, opts?: { rejectAuthoredSizing?: boolean }): void => {
  expect(() => parse(doc, opts)).toThrow(re)
}

test('manifest parity: the refusals the platform makes, one case each', () => {
  // A duplicate env name across groups has no single source.
  refuses({ ...base, services: { web: { ...base.services.web, env: { fixed: { A: '1' }, optional: { A: {} } } } } },
    /declared in both fixed and optional/)
  // A generator ref inside a fixed value cannot be recovered on retry.
  refuses({ ...base, generated: { tok: 'secret:8' }, services: { web: { ...base.services.web, env: { fixed: { A: '${tok}' } } } } },
    /generator refs are not allowed inside fixed values/)
  // A platform credential ref belongs under env.platform, and the message says so.
  refuses({ ...base, services: { web: { ...base.services.web, env: { fixed: { A: '${{services.db.DATABASE_URL}}' } } } } },
    /belong under env.platform, not fixed/)
  // A postgres service is bare: it has no url to reference and nothing to configure.
  refuses({ ...base, services: { web: { ...base.services.web, env: { fixed: { A: '${services.db.url}' } } }, db: { type: 'postgres' } } },
    /is a managed postgres/)
  refuses({ ...base, services: { db: { type: 'postgres', image: 'postgres:16' } } }, /carries no image/)
  // A web service must declare a healthcheck, and it must be a path on the service itself.
  refuses({ ...base, services: { web: { type: 'web', image: 'i' } } }, /must declare a healthcheck path/)
  refuses({ ...base, services: { web: { ...base.services.web, healthcheck: '//evil.example/x' } } }, /single-slash absolute path/)
  refuses({ ...base, services: { web: { ...base.services.web, healthcheck: 'https://evil.example/x' } } }, /absolute path/)
  // A constraint over an undeclared variable could never be satisfied.
  refuses({ ...base, constraints: [{ oneOf: ['NOPE'] }] }, /references undeclared variable 'NOPE'/)
  // Generators: the one family, with a bounded length.
  refuses({ ...base, generated: { tok: 'uuid' } }, /unknown generator 'uuid'/)
  refuses({ ...base, generated: { Tok: 'secret:8' } }, /generator names must be lower_snake/)
  // Every meta link is rendered, so every one is held to absolute https.
  refuses({ ...base, meta: { links: { upstream: 'http://x.example' } } }, /absolute https URL/)
  refuses({ ...base, meta: { tags: 'automation' } }, /meta.tags must be an array/)
  // The logo is read from the template's own directory and served on a PUBLIC route.
  refuses({ ...base, meta: { logo: '../../../../etc/hosts.png' } }, /inside the template directory/)
  refuses({ ...base, meta: { logo: '/etc/hosts.png' } }, /inside the template directory/)
  expect(parse({ ...base, meta: { logo: './logo.svg' } }).meta?.logo).toBe('./logo.svg')
  // An authored size is refused; a STORED one is read leniently and dropped.
  refuses({ ...base, services: { web: { ...base.services.web, volume: { sizeGib: 20 } } } }, /the size is the daemon's to choose/, { rejectAuthoredSizing: true })
  expect(parse({ ...base, services: { web: { ...base.services.web, volume: { sizeGib: 20 } } } }).services.web.volume).toBe(true)
})

// The parser claims to apply the engine's grammar, and it did not: both regexes were local copies
// permitting a trailing hyphen, which the engine rejects. A code or service name ending in `-`
// therefore passed validation here and failed partway through DEPLOYMENT, after preliminary state
// such as the template's branch had already been created. Both now come from src/names.ts.
test('manifest names are held to the engine grammar, trailing hyphen included', () => {
  refuses({ ...base, code: 'api-' }, /code/)
  refuses({ ...base, services: { 'web-': { ...base.services.web } } }, /web-|service name/)
  // The shapes that were always legal still parse.
  expect(parse({ ...base, code: 'api-1' }).code).toBe('api-1')
  expect(Object.keys(parse({ ...base, services: { 'web-1': { ...base.services.web } } }).services)).toEqual(['web-1'])

  // The 39-character cap the parser has always applied survives being shared with the engine: an
  // unbounded expression would silently have removed it.
  expect(parse({ ...base, code: 'c'.repeat(39) }).code).toBe('c'.repeat(39))
  refuses({ ...base, code: 'c'.repeat(40) }, /code/)
  expect(Object.keys(parse({ ...base, services: { ['s'.repeat(39)]: { ...base.services.web } } }).services))
    .toEqual(['s'.repeat(39)])
  refuses({ ...base, services: { ['s'.repeat(40)]: { ...base.services.web } } }, /service name|s{10}/)
})

test('manifestDigest is stable under key reordering and moves with content', () => {
  const a = parse({ code: 'x', version: '1', generated: { t: 'secret:8' }, services: { web: { type: 'web', image: 'i', healthcheck: '/', port: 8080 } } })
  const b = parse({ services: { web: { healthcheck: '/', port: 8080, image: 'i', type: 'web' } }, version: '1', generated: { t: 'secret:8' }, code: 'x' })
  expect(manifestDigest(a)).toBe(manifestDigest(b))
  // variableOrder is presentation, not identity.
  expect(manifestDigest({ ...a, variableOrder: ['ZZZ'] })).toBe(manifestDigest(a))
  expect(manifestDigest(parse({ ...base, services: { web: { ...base.services.web, image: 'other' } } }))).not.toBe(manifestDigest(a))
})

test('generateValue honours secret:N; resolveTemplateString resolves services and generators', () => {
  expect(generateValue('secret:32')).toHaveLength(32)
  expect(generateValue('secret:7')).toHaveLength(7)
  expect(generateValue('secret:32')).not.toBe(generateValue('secret:32'))
  const ctx = { generators: { tok: 'abc' }, services: { web: { host: 'h', url: 'http://h:8080' } } }
  expect(resolveTemplateString('${services.web.url}/x', ctx)).toBe('http://h:8080/x')
  expect(resolveTemplateString('${services.web.host}', ctx)).toBe('h')
  expect(resolveTemplateString('${tok}', ctx)).toBe('abc')
  expect(() => resolveTemplateString('${nope}', ctx)).toThrow(/undeclared generator 'nope'/)
  expect(() => resolveTemplateString('${services.ghost.url}', ctx)).toThrow(/unknown service 'ghost'/)
})

test('collectVariables merges a name declared twice and keeps declaration order', () => {
  const m = parse({
    code: 'x', version: '1',
    services: {
      a: { type: 'web', image: 'i', healthcheck: '/', env: { optional: { SHARED: { description: 'from a' } }, required: { FIRST: {} } } },
      b: { type: 'web', image: 'i', healthcheck: '/', env: { required: { SHARED: {} } } },
    },
  })
  // Declaration order is required-then-optional per service, in service order.
  const vars = collectVariables(m)
  expect(vars.map((v) => v.name)).toEqual(['FIRST', 'SHARED'])
  const shared = vars.find((v) => v.name === 'SHARED')!
  expect(shared.required).toBe(true)             // required ANYWHERE is required
  expect(shared.description).toBe('from a')      // the first description wins
})

// ---- deploy: the happy path --------------------------------------------------------------------

test('deploying n8n reaches succeeded: services, secrets, volume, attribution and events', async () => {
  const id = await project()
  const r = await post(`/projects/${id}/template-deployments`, { templateCode: 'n8n', branch: 'main' })
  expect(r.statusCode).toBe(202)
  const { deploymentId, deployment } = r.json()
  expect(deployment).toMatchObject({ status: 'running', step: 'create_services', templateCode: 'n8n', templateVersion: '1.3.2' })
  expect(deployment.services).toEqual([{ name: 'n8n', state: 'pending' }])
  await executor.idle()

  const view = (await get(`/template-deployments/${deploymentId}`)).json()
  expect(view.status).toBe('succeeded')
  expect(view.step).toBe('health_check')
  expect(view.services[0]).toMatchObject({ name: 'n8n', serviceId: 'cp-n8n', state: 'healthy' })
  expect(view.services[0].url).toBe('http://n8n-demo-main.localhost:8080')
  expect(view.error).toBeUndefined()

  // The pinned image was deployed on the branch the request named.
  expect(calls.some((c) => c.startsWith('deploy:demo-main:n8n:docker.io/n8nio/n8n:2.36.5'))).toBe(true)
  // Fixed values with a service ref resolved to the router URL; the generator is 32 chars.
  const secrets = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  expect(secrets.N8N_WEBHOOK_URL).toBe('http://n8n-demo-main.localhost:8080')
  expect(secrets.N8N_EDITOR_BASE_URL).toBe(secrets.N8N_WEBHOOK_URL)
  expect(secrets.N8N_ENCRYPTION_KEY).toHaveLength(32)
  expect(secrets.N8N_USER_FOLDER).toBe('/data')

  // alwaysOn, the volume the manifest asked for, and the template attribution on the row.
  const row = (await get(`/projects/${id}/services`)).json().services.find((x: { id: string }) => x.id === 'cp-n8n')
  expect(row).toMatchObject({ always_on: true, volume_gib: 10, template_code: 'n8n', template_deployment_id: deploymentId })
  expect(calls).toContain('deploy.volume:demo-main:n8n:' + calls.filter((c) => c.startsWith('deploy.volume:demo-main:n8n:'))[0].split(':').slice(3).join(':'))

  const kinds = (await get(`/projects/${id}/events`)).json().events.map((e: { kind: string }) => e.kind)
  expect(kinds).toContain('template.deploy')
  expect(kinds).toContain('template.deploy.succeeded')
})

test('the probe is called with the service Host and the healthcheck path, not a public URL', async () => {
  const id = await project()
  await deploy(id, { templateCode: 'n8n', branch: 'main' })
  expect(probed.length).toBeGreaterThan(0)
  expect(probed[0].url).toBe('http://n8n-demo-main.localhost:8080/healthz')
  expect(probed[0].headers.Host).toBe('n8n-demo-main.localhost:8080')
  expect(probed[0].headers['X-Forwarded-Proto']).toBe('http')
})

test('missing variables answer the machine-readable 400 and create nothing', async () => {
  const id = await project()
  const r = await post(`/projects/${id}/template-deployments`, { templateCode: 'claude-code', branch: 'main' })
  expect(r.statusCode).toBe(400)
  expect(r.json().error).toBe('missing_variables')
  expect(r.json().missing.map((m: { name: string }) => m.name)).toEqual(['ADMIN_USERNAME', 'ADMIN_PASSWORD'])
  expect(r.json().missing[0]).toMatchObject({ key: 'ADMIN_USERNAME' })
  expect((await get(`/projects/${id}/services`)).json().services).toEqual([])
  expect(Object.keys(loadState().templateDeployments ?? {})).toHaveLength(0)

  // With both provided it is accepted.
  const ok = await deploy(id, { templateCode: 'claude-code', branch: 'main', variables: { ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'b' } })
  expect(ok.statusCode).toBe(202)
  const secrets = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  expect(secrets.ADMIN_USERNAME).toBe('a')
  expect(secrets.ANTHROPIC_API_KEY).toBeUndefined()   // an unprovided optional is never written
})

test('a version mismatch, a draft code and an unrunnable manifest are refused before anything runs', async () => {
  const id = await project()
  const mismatch = await post(`/projects/${id}/template-deployments`, { templateCode: 'n8n', templateVersion: '0.0.1', branch: 'main' })
  expect(mismatch.statusCode).toBe(404)
  expect(mismatch.json().error).toBe('template version not found: n8n@0.0.1 (the registry serves 1.3.2)')
  expect((await post(`/projects/${id}/template-deployments`, { templateCode: 'openclaw', branch: 'main' })).statusCode).toBe(404)
  expect((await post(`/projects/${id}/template-deployments`, { branch: 'main' })).statusCode).toBe(400)

  const build = { code: 'b', version: '1', services: { web: { type: 'web', build: '.', healthcheck: '/' } } }
  const r1 = await post(`/projects/${id}/template-deployments`, { manifest: build, branch: 'main' })
  expect(r1.statusCode).toBe(400)
  expect(r1.json().error).toMatch(/support image services only/)
  const worker = { code: 'w', version: '1', services: { job: { type: 'worker', image: 'i' } } }
  const r2 = await post(`/projects/${id}/template-deployments`, { manifest: worker, branch: 'main' })
  expect(r2.statusCode).toBe(400)
  expect(r2.json().error).toMatch(/support web services only/)
  // A branch that does not exist is a 404, before any variable check.
  expect((await post(`/projects/${id}/template-deployments`, { templateCode: 'claude-code', branch: 'ghost' })).statusCode).toBe(404)
})

test('a template whose image this box cannot run is refused before any service exists', async () => {
  const id = await project()
  initHostArch('arm64')
  const amd64Only = {
    code: 'legacy', version: '1',
    services: { web: { type: 'web', image: 'ghcr.io/x/legacy:1', healthcheck: '/', port: 8080 } },
    meta: { architectures: ['amd64'] },
  }
  const r = await post(`/projects/${id}/template-deployments`, { manifest: amd64Only, branch: 'main' })
  expect(r.statusCode).toBe(400)
  // Both architectures named, and the way out named: the pull's own message says neither.
  expect(r.json().error).toContain('legacy@1 publishes amd64 images only, and this machine is arm64')
  expect(r.json().error).toContain('insta deploy --image')
  // Nothing was created and nothing was recorded: refused before the 202, not during the run.
  expect(Object.keys(loadState().templateDeployments ?? {})).toHaveLength(0)
  expect((await get(`/projects/${id}/services`)).json().services).toEqual([])

  // The same manifest on a box that CAN run it is accepted, so the refusal is about the pair and
  // not about the field being present.
  initHostArch('amd64')
  expect((await post(`/projects/${id}/template-deployments`, { manifest: amd64Only, branch: 'main' })).statusCode).toBe(202)
  await executor.idle()
})

test('a manifest that claims no architecture is deployed, not guessed at', async () => {
  const id = await project()
  initHostArch('arm64')
  const silent = { code: 'silent', version: '1', services: { web: { type: 'web', image: 'ghcr.io/x/silent:1', healthcheck: '/', port: 8080 } } }
  const r = await post(`/projects/${id}/template-deployments`, { manifest: silent, branch: 'main' })
  expect(r.statusCode).toBe(202)
  await executor.idle()
  // An inline manifest a caller composed says nothing about a registry, so silence must not become
  // "runs nowhere" (which is what refusing on an unstated field would amount to).
  expect(parseTemplateManifest(silent).meta?.architectures).toBeUndefined()
})

test('the manifest parser refuses an architecture nothing could satisfy', () => {
  const withArch = (architectures: unknown) => ({ ...base, meta: { architectures } })
  expect(parseTemplateManifest(withArch(['amd64', 'arm64'])).meta?.architectures).toEqual(['amd64', 'arm64'])
  refuses(withArch('amd64'), /meta\.architectures must be a non-empty array/)
  refuses(withArch([]), /meta\.architectures must be a non-empty array/)
  refuses(withArch(['riscv64']), /'riscv64' is not one of amd64, arm64/)
  refuses(withArch(['arm64', 'arm64']), /lists the same architecture twice/)
  // Stored exactly as authored, so manifestDigest still matches the platform's, which spreads meta
  // verbatim and does not know this key.
  const doc = { ...base, meta: { architectures: ['arm64', 'amd64'] } }
  expect(manifestDigest(parseTemplateManifest(doc))).toBe(manifestDigest(parseTemplateManifest(JSON.parse(JSON.stringify(doc)))))
  expect(manifestDigest(parseTemplateManifest(doc))).not.toBe(manifestDigest(parseTemplateManifest({ ...base, meta: { architectures: ['amd64'] } })))
})

test('hostArch falls back to this process and takes the probed value when there is one', () => {
  initHostArch(null)
  expect(hostArch()).toBe(process.arch === 'x64' ? 'amd64' : process.arch)
  initHostArch('  arm64  ')
  expect(hostArch()).toBe('arm64')
  initHostArch('')
  expect(hostArch()).toBe(process.arch === 'x64' ? 'amd64' : process.arch)
})

test('gating: service.add, secrets.write, deploy in order, then service.upgrade for a volume', async () => {
  const id = await project()
  await put(`/projects/${id}/policy/deploy`, { decision: 'approve' })
  const r = await post(`/projects/${id}/template-deployments`, { templateCode: 'n8n', branch: 'main' })
  expect(r.statusCode).toBe(202)
  expect(r.json()).toMatchObject({ status: 'approval_required', action: 'deploy' })
  // service.add and secrets.write passed first, so nothing was created before the refusal.
  expect(Object.keys(loadState().templateDeployments ?? {})).toHaveLength(0)

  // n8n declares a volume, so service.upgrade is asked for too (decision 45).
  await put(`/projects/${id}/policy/deploy`, { decision: 'allow' })
  await put(`/projects/${id}/policy/service.upgrade`, { decision: 'deny' })
  const denied = await post(`/projects/${id}/template-deployments`, { templateCode: 'n8n', branch: 'main' })
  expect(denied.statusCode).toBe(403)

  // With the grant in place the POST goes through.
  await put(`/projects/${id}/policy/service.upgrade`, { decision: 'allow' })
  const ok = await deploy(id, { templateCode: 'n8n', branch: 'main' })
  expect(ok.statusCode).toBe(202)
})

test('a second copy into the same branch mints n8n-2 beside the first', async () => {
  const id = await project()
  await deploy(id, { templateCode: 'n8n', branch: 'main' })
  await deploy(id, { templateCode: 'n8n', branch: 'main' })
  const names = (await get(`/projects/${id}/services`)).json().services.map((x: { name: string }) => x.name).sort()
  expect(names).toEqual(['n8n', 'n8n-2'])
  // Each copy has its own generated key: the second must not read the first's secret.
  const secrets = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  expect(secrets.N8N_ENCRYPTION_KEY).toHaveLength(32)
  const tree = (await get(`/projects/${id}/secrets/tree`)).json()
  const bound = tree.branches[0].services.filter((x: { type: string }) => x.type === 'compute')
  expect(bound.map((x: { name: string }) => x.name).sort()).toEqual(['n8n', 'n8n-2'])
})

test('with no branch named, the fresh-branch default mints n8n then n8n-2', async () => {
  const id = await project()
  const first = await deploy(id, { templateCode: 'n8n' })
  const second = await deploy(id, { templateCode: 'n8n' })
  const branches = (await get(`/projects/${id}/branches`)).json().branches.map((b: { name: string }) => b.name).sort()
  expect(branches).toEqual(['main', 'n8n', 'n8n-2'])
  // A fresh branch is NOT the default one, so its services() rows are branch-qualified. The
  // deployment record still carries the BARE id, which is what every later step addresses.
  const ids = []
  for (const r of [first, second]) {
    const view = (await get(`/template-deployments/${r.json().deploymentId}`)).json()
    expect(view.status).toBe('succeeded')
    ids.push(view.services[0].serviceId)
  }
  // The second copy is `n8n-2` even though its branch is brand new: an oss compute service is a
  // PROJECT-level registration materialised on every branch (the same deviation `services add`
  // already documents), so the first copy's name is taken project-wide and the ladder steps past
  // it. Each branch still runs its own container.
  expect(ids).toEqual(['cp-n8n', 'cp-n8n-2'])
  expect(calls.filter((c) => c.startsWith('deploy:demo-n8n:n8n:')).length).toBe(1)
  expect(calls.filter((c) => c.startsWith('deploy:demo-n8n-2:n8n-2:')).length).toBe(1)
})

test('a health failure fails the run, names the last status and redacts the log tail', async () => {
  const id = await project()
  probeStatus = () => 500
  // The mock reads the generated key at CALL time: the run mints it, then the tail echoes it, which
  // is exactly the accident `redactLogTail` exists for.
  const generatedKey = (): string =>
    (loadState().userSecrets[id] ?? []).find((u) => u.name === 'N8N_ENCRYPTION_KEY')?.value ?? ''
  vi.mocked((await import('../src/docker')).docker).mockImplementation(async (args: string[]) => (
    args[0] === 'logs' ? Buffer.from(`2026-09-08T00:00:00Z boot failed with key ${generatedKey()}`) : fakeDocker(args)
  ))
  const r = await post(`/projects/${id}/template-deployments`, { templateCode: 'n8n', branch: 'main' })
  const { deploymentId } = r.json()
  await executor.idle()
  const view = (await get(`/template-deployments/${deploymentId}`)).json()
  expect(view.status).toBe('failed')
  expect(view.step).toBe('health_check')
  expect(view.error).toMatch(/^n8n: not healthy within 0s \(last status: HTTP 500 on \/healthz\)$/)
  // The tail is DURABLE and this route serves it, so the key the run generated must not be in it.
  const key = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets.N8N_ENCRYPTION_KEY as string
  expect(key).toHaveLength(32)
  expect(view.logsTail).toContain('boot failed with key [redacted]')
  expect(view.logsTail).not.toContain(key)
  expect((await get(`/projects/${id}/events`)).json().events.map((e: { kind: string }) => e.kind)).toContain('template.deploy.failed')
})

test('a 401 counts as healthy; an off-origin healthcheck is refused without a probe', async () => {
  const id = await project()
  probeStatus = () => 401
  const ok = await deploy(id, { templateCode: 'claude-code', branch: 'main', variables: { ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'b' } })
  expect((await get(`/template-deployments/${ok.json().deploymentId}`)).json().status).toBe('succeeded')

  // A healthcheck the parser accepts but that resolves off-origin never reaches the probe. The
  // grammar refuses `//host` and any scheme, so this is only reachable through a stored manifest.
  const manifest = { code: 'q', version: '1', services: { web: { type: 'web', image: 'i', port: 8080, healthcheck: '/ok' } } }
  probeStatus = (path) => (path === '/ok' ? 200 : 500)
  const dep = await deploy(id, { manifest, branch: 'main' })
  const web = (await get(`/template-deployments/${dep.json().deploymentId}`)).json()
    .services.find((x: { name: string }) => x.name === 'web') as { name: string; url: string }
  // ...and the refusal itself, which no manifest can reach through the grammar: the executor is
  // driven directly with the off-origin path a STORED row could carry.
  const before = probed.length
  const entry = {
    serviceName: web.name, type: 'web' as const, image: 'i', port: 8080,
    healthcheck: 'https://evil.example/x', url: web.url, env: {}, state: 'deployed' as const,
  }
  const verdict = await (executor as unknown as {
    awaitHealthy(p: string, b: string, e: typeof entry): Promise<{ healthy: boolean; reason?: string }>
  }).awaitHealthy(id, 'main', entry)
  expect(verdict.healthy).toBe(false)
  expect(verdict.reason).toMatch(/resolves off the service origin \(https:\/\/evil.example\) - refusing to probe it/)
  expect(probed.length).toBe(before)
})

test('idempotency: the same id echoes, a changed manifest 409s, and a resume completes the run', async () => {
  const id = await project()
  const deploymentId = '11111111-2222-4333-8444-555555555555'
  probeStatus = () => 500
  const first = await deploy(id, { templateCode: 'n8n', branch: 'main', deploymentId })
  expect(first.statusCode).toBe(202)
  expect((await get(`/template-deployments/${deploymentId}`)).json().status).toBe('failed')
  const key = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets.N8N_ENCRYPTION_KEY
  expect(key).toHaveLength(32)

  // A DIFFERENT manifest under the same id is a hard 409, never a silent redeploy.
  const conflict = await post(`/projects/${id}/template-deployments`, {
    manifest: { code: 'n8n', version: '1.3.2', services: { n8n: { type: 'web', image: 'other', healthcheck: '/healthz' } } },
    branch: 'main', deploymentId,
  })
  expect(conflict.statusCode).toBe(409)
  expect(conflict.json().error).toMatch(/must resend the same manifest/)

  // The same manifest resumes: no duplicate service, the SAME generated key, and it now succeeds.
  probeStatus = () => 200
  const resumed = await deploy(id, { templateCode: 'n8n', branch: 'main', deploymentId })
  expect(resumed.statusCode).toBe(202)
  expect((await get(`/template-deployments/${deploymentId}`)).json().status).toBe('succeeded')
  expect((await get(`/projects/${id}/services`)).json().services.filter((x: { type: string }) => x.type === 'compute')).toHaveLength(1)
  expect((await get(`/projects/${id}/secrets?branch=main`)).json().secrets.N8N_ENCRYPTION_KEY).toBe(key)

  // A finished deployment answers the echo, and never runs again.
  calls.length = 0
  const echo = await post(`/projects/${id}/template-deployments`, { templateCode: 'n8n', branch: 'main', deploymentId })
  expect(echo.statusCode).toBe(202)
  expect(echo.json().deployment.status).toBe('succeeded')
  expect(calls.filter((c) => c.startsWith('deploy:'))).toHaveLength(0)
  // A non-UUID id is refused outright.
  expect((await post(`/projects/${id}/template-deployments`, { templateCode: 'n8n', deploymentId: 'nope' })).statusCode).toBe(400)
})

test('abandonStale fails a running record with the restart message', async () => {
  const id = await project()
  const deploymentId = '99999999-2222-4333-8444-555555555555'
  probeStatus = () => 200
  await deploy(id, { templateCode: 'n8n', branch: 'main', deploymentId })
  // Put it back into `running`, as a killed daemon would have left it.
  const { mutate } = await import('../src/state')
  mutate((s) => { s.templateDeployments[deploymentId].status = 'running' })
  expect(executor.abandonStale()).toEqual([deploymentId])
  const view = (await get(`/template-deployments/${deploymentId}`)).json()
  expect(view.status).toBe('failed')
  expect(view.error).toMatch(/^the daemon restarted while the template deployment was running/)
  // ...and a restart-abandoned row does not count against the template's success rate.
  expect((await get('/templates')).json().templates.find((t: { code: string }) => t.code === 'n8n').successRate).toBeNull()
})

/** The manifest both database-gate cases deploy: one postgres and one app that depends on it. */
const stackManifest = {
  code: 'stack', version: '1',
  services: {
    store: { type: 'postgres' },
    app: { type: 'web', image: 'app:1', port: 8080, healthcheck: '/' },
  },
}

test('a database docker says is ABSENT fails the run instead of passing the gate', async () => {
  // `runtimeHealth` reports `none` for a container docker answered about and did not list. That
  // used to pass the gate on the reasoning that the adapter had just provisioned it, so the run
  // finished `succeeded` having never proved the database exists, and the app was deployed
  // against it. Only `healthy` and `standby` are evidence now; `none` polls and then fails.
  const id = await project()
  // Provision without putting a container in the store: the adapter returns, docker says no.
  const provision = vi.spyOn(db, 'provision').mockImplementation(async (t) => {
    calls.push(`db.provision:${t.container}`)
    return { url: `postgres://postgres:pw@${t.container}:5432/app` }
  })
  const r = await deploy(id, { manifest: stackManifest, branch: 'main' }).finally(() => { provision.mockRestore() })
  const view = (await get(`/template-deployments/${r.json().deploymentId}`)).json()
  expect(view.status).toBe('failed')
  expect(view.step).toBe('deploy')
  expect(view.error).toBe('store: not ready within 0s (last status: none)')
  // ...and the app never went out against a database that may not be there.
  expect(calls.filter((c) => c.startsWith('deploy:'))).toEqual([])
})

test('a database docker cannot be ASKED about fails the run instead of passing the gate', async () => {
  // The other half of the same rule: `unknown` is what `runtimeHealth` reports when the docker
  // read itself failed, which is the absence of evidence rather than evidence of health. The
  // container here is genuinely fine -- the store has it running -- and the run still fails,
  // because a deploy that cannot be checked is not a deploy that passed.
  const id = await project()
  dockerPsFails = true
  const r = await deploy(id, { manifest: stackManifest, branch: 'main' })
  const view = (await get(`/template-deployments/${r.json().deploymentId}`)).json()
  expect(view.status).toBe('failed')
  expect(view.error).toBe('store: not ready within 0s (last status: unknown)')
  expect(calls.filter((c) => c.startsWith('deploy:'))).toEqual([])
  // The database really was up: this is the probe failing, not the container.
  dockerPsFails = false
  const health = (await get(`/projects/${id}/runtime-health?branch=main`)).json()
  expect(health.services.find((x: { serviceId: string }) => x.serviceId === 'pg-store').status).toBe('healthy')
})

test('a run that cannot read its credentials WITHHOLDS the log tail rather than publishing it', async () => {
  // The redaction list is built from what the run wrote, and a `credentials()` read that fails
  // used to be swallowed: the list came up short and the tail was persisted on the deployment
  // row, and served by `GET /template-deployments/:id`, with a database password in it. A tail
  // that cannot be shown to be clean is not published.
  const id = await project()
  probeStatus = () => 500
  vi.mocked((await import('../src/docker')).docker).mockImplementation(async (args: string[]) => (
    args[0] === 'logs'
      ? Buffer.from('2026-09-08T00:00:00Z boot failed: dsn=postgres://postgres:hunter2hunter2@io-demo-main-pg-store:5432/app')
      : fakeDocker(args)
  ))
  const creds = vi.spyOn(engine, 'credentials').mockImplementation(() => { throw new Error('docker could not answer') })
  const r = await deploy(id, { manifest: stackManifest, branch: 'main' }).finally(() => { creds.mockRestore() })
  const view = (await get(`/template-deployments/${r.json().deploymentId}`)).json()
  // `partial`: the database entry did come up, so the store counts as live and only the app failed.
  expect(view.status).toBe('partial')
  expect(view.logsTail).toContain('log tail withheld')
  expect(view.logsTail).not.toContain('hunter2hunter2')
})

test('a database that comes up LATE is polled until it does, not failed on the first read', async () => {
  // The other half of R3 (`plans/impl/05-templates-parity.md:69`): postgres entries go healthy
  // once the container RUNS, POLLING up to the health timeout. Strictness on its own would just
  // be the opposite defect -- a database that needs a second poll would fail a deployment that
  // is fine -- so the gate is bound in both directions.
  build({ INSTA_OSS_TEMPLATE_HEALTH_TIMEOUT_MS: '5000' })
  const id = await project()
  const provision = vi.spyOn(db, 'provision').mockImplementation(async (t) => {
    calls.push(`db.provision:${t.container}`)
    // Not there when the gate first looks, there a few polls later.
    setTimeout(() => { runtime.put(t.container, 'running') }, 40)
    return { url: `postgres://postgres:pw@${t.container}:5432/app` }
  })
  const r = await deploy(id, { manifest: stackManifest, branch: 'main' }).finally(() => { provision.mockRestore() })
  const view = (await get(`/template-deployments/${r.json().deploymentId}`)).json()
  expect(view.error).toBeUndefined()
  expect(view.status).toBe('succeeded')
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(true)
})

test('an inline manifest with a postgres service binds its DATABASE_URL into the app', async () => {
  const id = await project()
  // An older postgres already holds the canonical alias, so the binding has to name the NEW one.
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'db' })
  const manifest = {
    code: 'stack', version: '1',
    services: {
      store: { type: 'postgres' },
      app: {
        type: 'web', image: 'app:1', port: 8080, healthcheck: '/',
        env: { platform: { DATABASE_URL_APP: '${{services.store.DATABASE_URL}}' } },
      },
    },
  }
  const r = await deploy(id, { manifest, branch: 'main' })
  expect(r.statusCode).toBe(202)
  const view = (await get(`/template-deployments/${r.json().deploymentId}`)).json()
  expect(view.error).toBeUndefined()
  expect(view.status).toBe('succeeded')
  expect(view.services.map((x: { name: string }) => x.name).sort()).toEqual(['app', 'store'])
  // A postgres service was created (its own container) and the app deploy carries the BOUND name
  // pointing at THAT service, not at the older `db` that owns the canonical alias.
  expect(calls).toContain('db.provision:io-demo-main-pg-store')
  const bindings = loadState().branches[Object.keys(loadState().branches)[0]].bindings ?? []
  expect(bindings).toEqual([{ envName: 'DATABASE_URL_APP', target: 'compute/app', source: 'postgres/store', sourceName: 'DATABASE_URL' }])
  const secrets = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  // The alias still belongs to the older `db` service, and every DSN is the host-facing lane form.
  expect(secrets.DATABASE_URL).toBe(secrets.DATABASE_URL_DB)
  expect(secrets.DATABASE_URL).not.toBe(secrets.DATABASE_URL_STORE)
  expect(secrets.DATABASE_URL).toMatch(/^postgres:\/\/postgres:pw@127\.0\.0\.1:2\d{4}\/app$/)
})

// A real template-created binding, not a synthesized tree: the secret inventory has to say that
// DATABASE_URL_APP is a BINDING and where it reads from. It used to land in `secrets` next to the
// user secrets with `minted` empty, so every surface read it as an editable user secret — and both
// edits are lies. `unsetUserSecret` never removes a binding, so Delete reported success while the
// name stayed; and `envFor` applies `bindingsFor` LAST, so an Edit wrote a row the container never
// sees.
test('a template binding is reported as a binding, with its source, not as a user secret', async () => {
  const id = await project()
  const manifest = {
    code: 'stack', version: '1',
    services: {
      store: { type: 'postgres' },
      app: {
        type: 'web', image: 'app:1', port: 8080, healthcheck: '/',
        env: {
          platform: {
            DATABASE_URL_APP: '${{services.store.DATABASE_URL}}',
            // A second binding under a name the daemon does NOT reserve, so the collision below is
            // reachable: `isReservedSecret` refuses `DATABASE_URL_*`, but an author may bind a
            // credential into any env name they like.
            APP_DB: '${{services.store.DATABASE_URL}}',
          },
        },
      },
    },
  }
  expect((await deploy(id, { manifest, branch: 'main' })).statusCode).toBe(202)

  const tree = (await get(`/projects/${id}/secrets/tree`)).json()
  const env = tree.branches.find((b: { name: string }) => b.name === 'main')
  const app = env.services.find((s: { type: string; name: string }) => s.type === 'compute' && s.name === 'app')

  // Still in the inventory of names the group's env carries...
  expect(app.secrets).toContain('DATABASE_URL_APP')
  // ...but declared a binding, with the service and credential it reads from.
  expect(app.bindings).toEqual([
    { envName: 'APP_DB', source: 'postgres/store', sourceName: 'DATABASE_URL', shadowsUserSecret: false },
    { envName: 'DATABASE_URL_APP', source: 'postgres/store', sourceName: 'DATABASE_URL', shadowsUserSecret: false },
  ])
  // And NOT minted: the two platform-owned kinds are distinct and neither is a user secret.
  expect(app.minted).toEqual([])

  // A user secret bound to the same group is still just a user secret, so the distinction is real
  // rather than "everything on a compute group is a binding".
  expect((await put(`/projects/${id}/secrets/MY_OWN`, { value: 'v', branch: 'main', service: 'compute/app' })).statusCode).toBe(200)
  const after = (await get(`/projects/${id}/secrets/tree`)).json()
  const app2 = after.branches.find((b: { name: string }) => b.name === 'main')
    .services.find((s: { type: string; name: string }) => s.type === 'compute' && s.name === 'app')
  expect(app2.secrets).toEqual(expect.arrayContaining(['DATABASE_URL_APP', 'MY_OWN']))
  expect(app2.bindings.map((x: { envName: string }) => x.envName)).toEqual(['APP_DB', 'DATABASE_URL_APP'])

  // Only a compute group is a binding target: the postgres service reports none.
  const store = after.branches.find((b: { name: string }) => b.name === 'main')
    .services.find((s: { type: string; name: string }) => s.type === 'postgres' && s.name === 'store')
  expect(store.bindings).toEqual([])
  expect(app2.bindings.every((x: { shadowsUserSecret: boolean }) => !x.shadowsUserSecret)).toBe(true)

  // A user secret of the SAME name as a binding IS reachable: `isReservedSecret` refuses the
  // platform's own `DATABASE_URL_*` forms, but a binding may use any env name, and `APP_DB` is not
  // reserved. The container still receives ONE value — the binding's, applied last — so the
  // inventory lists the name once and says a dead user row is underneath it. Concatenating listed
  // it twice and drew two rows for one variable.
  expect((await put(`/projects/${id}/secrets/DATABASE_URL_APP`, { value: 'mine', branch: 'main', service: 'compute/app' })).statusCode).toBe(400)
  expect((await put(`/projects/${id}/secrets/APP_DB`, { value: 'mine', branch: 'main', service: 'compute/app' })).statusCode).toBe(200)
  const clash = (await get(`/projects/${id}/secrets/tree`)).json()
    .branches.find((b: { name: string }) => b.name === 'main')
    .services.find((s: { type: string; name: string }) => s.type === 'compute' && s.name === 'app')
  expect(clash.secrets.filter((n: string) => n === 'APP_DB')).toHaveLength(1)
  expect(clash.bindings.find((x: { envName: string }) => x.envName === 'APP_DB'))
    .toEqual({ envName: 'APP_DB', source: 'postgres/store', sourceName: 'DATABASE_URL', shadowsUserSecret: true })
})

test('the per-type cap is enforced synchronously, before any service is created', async () => {
  build({ INSTA_OSS_MAX_SERVICES_PER_TYPE: '1' })
  const id = await project()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'web' })
  const r = await post(`/projects/${id}/template-deployments`, { templateCode: 'n8n', branch: 'main' })
  expect(r.statusCode).toBe(400)
  expect(r.json().error).toMatch(/limit of 1 compute services/)
  expect(Object.keys(loadState().templateDeployments ?? {})).toHaveLength(0)
})

// The DEFAULT probe (decision 58): one request to the daemon's own HTTP port carrying the service's
// Host header, which is the router's HTTP lane. It never resolves the public name (on a NAT'd or
// sslip.io box that name may not point back at this machine) and never speaks TLS.
test('the default health probe dials 127.0.0.1:<cfg.port> with the service Host, not the public name', async () => {
  const { createServer } = await import('node:http')
  const seen: Array<{ url?: string; host?: string; proto?: string }> = []
  const stand = createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, proto: req.headers['x-forwarded-proto'] as string | undefined })
    res.writeHead(200).end('ok')
  })
  const port = await new Promise<number>((resolve) => stand.listen(0, '127.0.0.1', () => {
    const a = stand.address()
    resolve(typeof a === 'object' && a ? a.port : 0)
  }))
  try {
    // No injected probe: this engine uses the executor's own default.
    const cfg = fastConfig({ INSTA_OSS_PORT: String(port) })
    const plain = makeEngine(cfg)
    const server = buildServer(plain, cfg)
    const id = (await server.inject({ method: 'POST', url: '/orgs/local/projects', payload: { name: 'demo' } })).json().project.id
    const manifest = { code: 'probe', version: '1', services: { web: { type: 'web', image: 'i', port: 8080, healthcheck: '/healthz?x=1' } } }
    const r = await server.inject({ method: 'POST', url: `/projects/${id}/template-deployments`, payload: { manifest, branch: 'main' } })
    expect(r.statusCode).toBe(202)
    await plain.executor.idle()
    expect((await server.inject({ method: 'GET', url: `/template-deployments/${r.json().deploymentId}` })).json().status).toBe('succeeded')
    expect(seen[0]).toEqual({ url: '/healthz?x=1', host: `web-demo-main.localhost:${port}`, proto: 'http' })
    await server.close()
  } finally {
    stand.close()
  }
})

test('GET /template-deployments/:id is 404 for an unknown id', async () => {
  expect((await get('/template-deployments/11111111-2222-4333-8444-555555555555')).statusCode).toBe(404)
  expect((await get('/template-deployments/11111111-2222-4333-8444-555555555555')).json().error).toBe('template deployment not found')
})

// The 39-character branch-name cap opened exactly one gap: `resolveBranch` mints `<code>-2` for the
// second copy, so a code of 38 or 39 characters is legal on its own but 40 or 41 with the suffix.
// It used to reach `assertBranchName` and surface as the route's default 400 "branch name must be
// lower-kebab" - a rule the author's code did not break - AFTER governance had run, so a single-use
// approval could be consumed by it. The service-name copy path has always refused this case with a
// purpose-built 409 naming the real cause; the branch path now matches.
test('a template code too long to suffix is refused by NAME LENGTH, not by the kebab rule', async () => {
  const id = await project()
  const code = 'c'.repeat(39)
  const manifest = { code, version: '1', services: { web: { type: 'web', image: 'nginx:alpine', healthcheck: '/' } } }

  const first = await post(`/projects/${id}/template-deployments`, { manifest })
  expect(first.statusCode).toBe(202)
  expect((await get(`/projects/${id}/branches`)).json().branches.map((b: { name: string }) => b.name)).toContain(code)

  const second = await post(`/projects/${id}/template-deployments`, { manifest })
  expect(second.statusCode).toBe(409)
  expect(second.json().error).toContain('too long to copy')
  expect(second.json().error).toContain('39-character branch-name limit')
  expect(second.json().error).not.toContain('lower-kebab')

  // Nothing was created for the refused attempt.
  const names = (await get(`/projects/${id}/branches`)).json().branches.map((b: { name: string }) => b.name)
  expect(names.filter((n: string) => n.startsWith('c')).length).toBe(1)
})

// The positive half: a normal code still takes a second branch, so the guard above refuses only
// what it must. A LONG-but-legal code cannot be used here — two long names collide on the
// truncated resource ref (`branch ... already exists as ...`) well before the cap matters, which is
// a separate, pre-existing constraint with its own clear error.
test('a normal code still takes a second branch', async () => {
  const id = await project()
  const code = 'demo-app'
  const manifest = { code, version: '1', services: { web: { type: 'web', image: 'nginx:alpine', healthcheck: '/' } } }
  expect((await post(`/projects/${id}/template-deployments`, { manifest })).statusCode).toBe(202)
  expect((await post(`/projects/${id}/template-deployments`, { manifest })).statusCode).toBe(202)
  const names = (await get(`/projects/${id}/branches`)).json().branches.map((b: { name: string }) => b.name)
  expect(names).toContain(code)
  expect(names).toContain(`${code}-2`)
})
