// Contract tests: the daemon must serve the exact shapes the stock `insta` CLI consumes.
// Fake adapters (test/fakes.ts) — no Docker needed. docker() is mocked (engine only uses it for
// networks and the ps snapshots). Package regions sit at the END of this file (contract 00 §1.3).
import { test, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// `dockerCall` is the same seam with a handle on the child: the scheduler's runtime verbs go
// through it so a timed-out call can be killed and waited for. A factory that returns only
// `docker` leaves it undefined for every importer, so it is mocked here too, over the same fake.
vi.mock('../src/docker', () => ({
  docker: vi.fn((args: string[] = []) => fakeDocker(args)),
  dockerCall: (args: string[] = []) => ({ done: fakeDocker(args), kill: () => {} }),
}))

/** The docker seam these tests run on. It answers nothing for almost everything, with ONE
 *  fidelity the fakes need: a `docker rm` really removes the container from `FakeRuntime`, which
 *  is the single fake container store (decision 53). The engine removes a compute container by
 *  shelling docker directly, and every teardown now PROVES a container is gone by reading
 *  `docker ps -a` afterwards, so a mock that does not mirror the removal would report a
 *  container that is still there and fail a teardown that in fact succeeded. */
function fakeDocker(args: string[] = []): Promise<Buffer> {
  if (args[0] === 'rm') for (const a of args.slice(1)) if (!a.startsWith('-')) runtime.drop(a)
  return Promise.resolve(Buffer.from(''))
}

import { docker as dockerFn } from '../src/docker'
import { buildServer } from '../src/server'
import { Engine } from '../src/engine'
import type { Branch, ComputeAdapter, StorageAdapter } from '../src/types'
import { flushTouchLater, loadState, mutate } from '../src/state'
import { calls, data, db, compute, storage, managed, makeEngine, resetFakes, runtime, serverConfig, testConfig } from './fakes'
import { SuppliedCertWatch, suppliedCert, suppliedFiles } from '../src/router/certs'

let app: ReturnType<typeof buildServer>
/** The engine `app` is built on: tests that spy on an engine method need THIS instance. */
let engine: Engine
beforeEach(() => {
  resetFakes()
  engine = makeEngine()
  app = buildServer(engine)
})

// A test that fails or TIMES OUT never reaches its own cleanup line, and two kinds of mock
// outlive it: `vi.spyOn` spies (which `resetFakes()` knows nothing about) and `dockerFn`'s
// implementation, which is sticky across tests. The concurrency tests below exist precisely to
// detect a wedge, so leaving their restoration to a line after the assertions would leak a
// paused gate into every later test in this file the first time one of them fired.
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(dockerFn).mockImplementation(fakeDocker)
})

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload })
const get = (url: string) => app.inject({ method: 'GET', url })
const put = (url: string, payload?: unknown) => app.inject({ method: 'PUT', url, payload })
const patch = (url: string, payload?: unknown) => app.inject({ method: 'PATCH', url, payload })
const del_ = (url: string) => app.inject({ method: 'DELETE', url })

// Project create is EMPTY on both targets (contract 00 section 9: `resources: []`), so the fixture
// adds the postgres + storage pair every downstream test assumes — the same two calls the CLI's
// own onboarding makes. Tests that pin CREATE itself post to /orgs/local/projects directly.
async function createProject(name = 'demo'): Promise<string> {
  const r = await post('/orgs/local/projects', { name })
  const id = r.json().project.id
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'db' })
  await post(`/projects/${id}/services`, { type: 'storage', name: 'store' })
  return id
}

test('me/orgs stubs satisfy the CLI (orgs[0].id drives project create)', async () => {
  expect((await get('/me')).json().user.id).toBe('local')
  const orgs = (await get('/orgs')).json().orgs
  expect(orgs).toHaveLength(1)
  expect(orgs[0].id).toBe('local')
})

test('project create returns {project, defaultBranch, resources: []} and provisions NOTHING', async () => {
  const r = await post('/orgs/local/projects', { name: 'demo' })
  expect(r.statusCode).toBe(201)
  const body = r.json()
  expect(body.project.name).toBe('demo')
  expect(body.defaultBranch.name).toBe('main')
  // EMPTY, like the cloud: a project is a branch and nothing else until services are added.
  expect(body.resources).toEqual([])
  expect(calls).not.toContain('db.provision:io-demo-main-pg-db')
  expect(calls).not.toContain('st.provision:demo-main:store')
  // ...and the two adds provision the pair on the default branch.
  const id = body.project.id
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'db' })
  await post(`/projects/${id}/services`, { type: 'storage', name: 'store' })
  expect(calls).toContain('db.provision:io-demo-main-pg-db')
  expect(calls).toContain('st.provision:demo-main:store')
})

test('branch create clones data + redeploys apps; branches list has is_default/status', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  const r = await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect(r.statusCode).toBe(201)
  expect(r.json().branch.name).toBe('feat')
  expect(calls).toContain('db.fork:io-demo-main-pg-db->io-demo-feat-pg-db')
  expect(calls).toContain('st.clone:io-demo-main-store->io-demo-feat-store') // storage branching = bucket copy
  // redeploy wired to the CLONE's bucket; SAME listen port (3000), shifted host mapping (4000)
  expect(calls).toContain('deploy:demo-feat:default:app:1:s3=io-demo-feat-store:p=3000->4000')

  const branches = (await get(`/projects/${id}/branches`)).json().branches
  expect(branches.map((b: { name: string }) => b.name).sort()).toEqual(['feat', 'main'])
  expect(branches.find((b: { name: string }) => b.name === 'main').is_default).toBe(true)

  const feat = branches.find((b: { name: string }) => b.name === 'feat')
  const del = await app.inject({ method: 'DELETE', url: `/projects/${id}/branches/${feat.id}` })
  expect(del.statusCode).toBe(200)
  // The cloud's teardown summary (decision 50): compute, the postgres container, the bucket and
  // the branch's data roots, counted.
  expect(del.json().teardown).toMatchObject({ failed: 0 })
  expect(del.json().teardown.destroyed).toBeGreaterThan(0)
})

test('branch create with excludeServices forks nothing: no services, secrets or bindings copied', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await put(`/projects/${id}/secrets/API_KEY`, { value: 'k', branch: 'main' })

  const r = await post(`/projects/${id}/branches`, { name: 'empty', from: 'main', excludeServices: true })
  expect(r.statusCode).toBe(201)
  expect(r.json().branch.name).toBe('empty')
  // None of the parent's services materialise: no database fork, no bucket copy, no redeploy —
  // anchored to the adapter verbs the fork would use, not to the branch name as a substring
  // (bookkeeping calls legitimately carry the name in paths).
  expect(calls.filter((c) => /^(db\.fork|db\.provision|st\.provision|st\.clone|deploy|md\.provision):/.test(c) && c.includes('empty'))).toEqual([])
  const row = Object.values(loadState().branches).find((b) => b.name === 'empty')!
  expect(Object.keys(row.databases ?? {})).toEqual([])
  expect(Object.keys(row.buckets ?? {})).toEqual([])
  expect(Object.keys(row.apps ?? {})).toEqual([])
  // The parent's branch-scoped user secrets are NOT inherited...
  expect(loadState().userSecrets[id]?.filter((u) => u.branch === 'empty')).toEqual([])
  // ...and the event still records what the branch was cut from, marked as an empty cut.
  const ev = loadState().events.filter((e) => e.kind === 'branch.created' && e.branch === 'empty')
  expect(ev).toHaveLength(1)
  expect(ev[0].payload).toMatchObject({ from: 'main', excludedServices: true })
  // A malformed flag is a 400, not a silent full fork.
  const bad = await post(`/projects/${id}/branches`, { name: 'empty2', from: 'main', excludeServices: 'yes' })
  expect(bad.statusCode).toBe(400)
})

test('secrets returns the branch bundle (seam) and is gateable', async () => {
  const id = await createProject()
  const r = await get(`/projects/${id}/secrets?branch=main`)
  expect(r.statusCode).toBe(200)
  // ONE host-facing string (contract section 10): the bundle carries the same lane DSN the
  // credentials route answers, because this is what `insta run` and `insta secrets -o .env` inject
  // into a HOST process.
  const laneDsn = (await get(`/projects/${id}/services/pg-db/credentials`)).json().credentials.DATABASE_URL as string
  expect(laneDsn).toMatch(/^postgres:\/\/postgres:pw@127\.0\.0\.1:2\d{4}\/app$/)
  expect(r.json().secrets.DATABASE_URL).toBe(laneDsn)
  expect(r.json().secrets.BUCKET_NAME).toBe('io-demo-main-store') // S3 bundle rides the same seam

  await app.inject({ method: 'PUT', url: `/projects/${id}/policy/secrets.read`, payload: { decision: 'approve' } })
  const gatedRes = await get(`/projects/${id}/secrets?branch=main`)
  expect(gatedRes.statusCode).toBe(202)
  expect(gatedRes.json()).toMatchObject({ status: 'approval_required', action: 'secrets.read' })
})

test('project.delete defaults to allow, like the cloud: a plain delete just works', async () => {
  // The cloud flipped every governance default to allow in platform #267. This daemon still
  // defaulted project.delete to approve, so the same `insta project delete` stopped at
  // "approval required" here and simply worked there.
  const id = await createProject()
  expect((await get(`/projects/${id}/policy`)).json().policy['project.delete']).toBe('allow')
  const del = await app.inject({ method: 'DELETE', url: `/projects/${id}` })
  expect(del.statusCode).toBe(200)
  expect(del.json().teardown).toMatchObject({ failed: 0 })
  expect(del.json().teardown.destroyed).toBeGreaterThan(0)
  expect((await get('/orgs/local/projects')).json().projects).toHaveLength(0)
})

test('project.delete opted into approve: 202 → approve → retry succeeds → grant consumed', async () => {
  const id = await createProject()
  await app.inject({ method: 'PUT', url: `/projects/${id}/policy/project.delete`, payload: { decision: 'approve' } })
  const first = await app.inject({ method: 'DELETE', url: `/projects/${id}` })
  expect(first.statusCode).toBe(202)
  const approvalId = first.json().approvalId

  const approvals = (await get(`/projects/${id}/approvals?status=pending`)).json().approvals
  expect(approvals.map((a: { id: string }) => a.id)).toContain(approvalId)

  const ap = await post(`/projects/${id}/approvals/${approvalId}/approve`)
  expect(ap.statusCode).toBe(200)
  expect(ap.json().approval.action).toBe('project.delete')

  const second = await app.inject({ method: 'DELETE', url: `/projects/${id}` })
  expect(second.statusCode).toBe(200) // consumed the grant
  expect(second.json().teardown).toMatchObject({ failed: 0 })
  expect(second.json().teardown.destroyed).toBeGreaterThan(0)   // `failed: 0` alone passes on a no-op
  expect((await get('/orgs/local/projects')).json().projects).toHaveLength(0)
})

test('approve --always flips the policy to allow (no more prompts)', async () => {
  const id = await createProject()
  await app.inject({ method: 'PUT', url: `/projects/${id}/policy/project.delete`, payload: { decision: 'approve' } })
  const first = await app.inject({ method: 'DELETE', url: `/projects/${id}` })
  await post(`/projects/${id}/approvals/${first.json().approvalId}/approve`, { always: true })
  expect((await get(`/projects/${id}/policy`)).json().policy['project.delete']).toBe('allow')
})

test('policy deny blocks with 403', async () => {
  const id = await createProject()
  await app.inject({ method: 'PUT', url: `/projects/${id}/policy/deploy`, payload: { decision: 'deny' } })
  const r = await post(`/projects/${id}/deploy`, { image: 'x', branch: 'main' })
  expect(r.statusCode).toBe(403)
})

test('events: resource timeline + agent ingest with dedup', async () => {
  const id = await createProject()
  await post(`/projects/${id}/events`, { kind: 'cred.leak', source: 'agent', dedup_key: 'k1', payload: { sev: 'high' } })
  await post(`/projects/${id}/events`, { kind: 'cred.leak', source: 'agent', dedup_key: 'k1' }) // duplicate
  const events = (await get(`/projects/${id}/events`)).json().events
  expect(events.filter((e: { kind: string }) => e.kind === 'cred.leak')).toHaveLength(1)
  expect(events.map((e: { kind: string }) => e.kind)).toContain('project.created')
  expect(events[0]).toHaveProperty('created_at') // CLI prints e.created_at
})

test('events: limit is a bounded page, and junk is a 400 rather than the whole retained set', async () => {
  const id = await createProject()
  for (let i = 0; i < 5; i++) await post(`/projects/${id}/events`, { kind: `k${i}`, source: 'agent' })
  const total = (await get(`/projects/${id}/events`)).json().events.length
  expect(total).toBeGreaterThan(2)

  // A page is a page.
  expect((await get(`/projects/${id}/events?limit=2`)).json().events).toHaveLength(2)
  // ...and each of these used to fall through `slice(-limit)` as "give me everything".
  for (const bad of ['0', '-5', 'abc', '1.5', 'Infinity']) {
    const r = await get(`/projects/${id}/events?limit=${bad}`)
    expect([bad, r.statusCode]).toEqual([bad, 400])
    expect(r.json().error).toContain('limit must be an integer')
  }
  // An oversized page clamps instead of failing, and absent or empty keeps the default.
  expect((await get(`/projects/${id}/events?limit=999999`)).json().events).toHaveLength(total)
  expect((await get(`/projects/${id}/events?limit=`)).json().events).toHaveLength(total)
})

test('manifest detail: project/branches/resources with ref.url', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'backend' })
  const d = (await get(`/projects/${id}`)).json()
  expect(d.project.org_id).toBe('local')
  const kinds = d.resources.map((r: { kind: string }) => r.kind)
  expect(kinds).toEqual(expect.arrayContaining(['postgres', 'storage', 'compute']))
  expect(d.resources.every((r: { ref: { url?: string; bucket?: string } }) => r.ref.url || r.ref.bucket)).toBe(true)
})

test('cloud-only surfaces (billing/usage/tokens) return 501 with a clear message', async () => {
  for (const url of ['/orgs/local/billing', '/projects/x/usage']) {
    const r = await get(url)
    expect(r.statusCode).toBe(501)
    expect(r.json().error).toMatch(/cloud-only/)
  }
  // metrics/logs are real (docker-backed) now — unknown project is a 404, not a stub
  expect((await get('/projects/x/metrics')).statusCode).toBe(404)
  expect((await get('/projects/x/logs')).statusCode).toBe(404)
})

// The 501 sweep, split per region (contract 00 §1.1): a package deletes rows ONLY from its own
// sub-array when it lands the real route; NOT_CLOUD_REST stays cloud-only for good.
const NOT_CLOUD_WP1: Array<[string, string]> = [
  ['GET', '/tokens'], ['POST', '/tokens'], ['DELETE', '/tokens/t1'],
]
// WP2: the four compute/domain routes are real now (contract 00 section 9), so this sub-array is
// empty; the sweep still concatenates it so the shape of the test does not move.
const NOT_CLOUD_WP2: Array<[string, string]> = []
// WP3: GET/PUT limits and PUT always-on are real routes now (contract 00 section 9), so this
// sub-array is empty; the sweep still concatenates it so the shape of the test does not move.
const NOT_CLOUD_WP3: Array<[string, string]> = []
const NOT_CLOUD_REST: Array<[string, string]> = [
  ['GET', '/projects/x/usage/daily'], ['GET', '/projects/x/utilisation'],
  ['GET', '/orgs/local/members'], ['PUT', '/orgs/local/members/u1'], ['DELETE', '/orgs/local/members/u1'],
  ['POST', '/orgs/local/invitations'], ['GET', '/orgs/local/invitations'], ['DELETE', '/orgs/local/invitations/i1'],
  ['POST', '/invitations/accept'],
  ['GET', '/images/inspect'],
  ['PATCH', '/projects/x/services/cp-x'],
  ['POST', '/projects/x/deploy-token'],
  ['POST', '/projects/x/backups'], ['GET', '/projects/x/backups'], ['DELETE', '/projects/x/backups/b1'], ['POST', '/projects/x/backups/b1/restore'],
  ['GET', '/orgs/local/billing/cycle'], ['GET', '/orgs/local/billing/overview'],
  ['POST', '/orgs/local/billing/checkout'], ['POST', '/orgs/local/billing/portal'],
  // GitHub repo connect and the per-service source routes: no GitHub App, no public webhook URL,
  // no remote build gateway on a single box. `GET .../source` is the one real answer (below).
  ['POST', '/orgs/local/github/setup'], ['POST', '/orgs/local/github/setup/complete'],
  ['GET', '/github/installations'], ['GET', '/github/installations/7/repos'],
  ['POST', '/projects/x/github/detect'], ['POST', '/projects/x/github/public-repo/resolve'],
  ['GET', '/projects/x/github/repo-binding'], ['POST', '/projects/x/github/repo-binding'], ['DELETE', '/projects/x/github/repo-binding'],
  ['GET', '/projects/x/github/builds'],
  ['PUT', '/projects/x/services/cp-x/source'], ['PATCH', '/projects/x/services/cp-x/source'], ['DELETE', '/projects/x/services/cp-x/source'],
  ['POST', '/projects/x/services/cp-x/source/deploy'], ['GET', '/projects/x/services/cp-x/source/builds'],
]

test('every cloud-only or not-yet route answers a clean 501, never a bare 404', async () => {
  const cloudOnly: Array<[string, string]> = [...NOT_CLOUD_WP1, ...NOT_CLOUD_WP2, ...NOT_CLOUD_WP3, ...NOT_CLOUD_REST]
  for (const [method, url] of cloudOnly) {
    const r = await app.inject({ method: method as 'GET', url })
    expect(r.statusCode, `${method} ${url}`).toBe(501)
    expect(r.json().error, `${method} ${url}`).toMatch(/cloud-only/)
  }
  const notYetRoutes: Array<[string, string]> = [
    ['GET', '/projects/x/deploy-events'],
    // `insta secrets bind` / `unbind` / `bindings` / `sources` all reach these three.
    ['GET', '/projects/x/secret-bindings'],
    ['PUT', '/projects/x/secret-bindings/MY_VAR'],
    ['DELETE', '/projects/x/secret-bindings/MY_VAR'],
  ]
  for (const [method, url] of notYetRoutes) {
    const r = await app.inject({ method: method as 'GET', url })
    expect(r.statusCode, `${method} ${url}`).toBe(501)
    expect(r.json().error, `${method} ${url}`).toMatch(/not implemented by InstaCloud OSS yet/)
  }
})

test('regions returns the single local region in the CLI shape', async () => {
  const r = await get('/regions')
  expect(r.statusCode).toBe(200)
  expect(r.json().regions).toEqual([{ slug: 'local', label: 'Local (this machine)' }])
})

// ---- services-model parity (Phase 1.5) ----

test('services list: fixed postgres+storage + compute groups; CLI shape', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  const { services } = (await get(`/projects/${id}/services`)).json()
  const types = services.map((s: { type: string }) => s.type)
  expect(types).toEqual(expect.arrayContaining(['postgres', 'storage', 'compute']))
  const api = services.find((s: { name: string }) => s.name === 'api')
  expect(api).toMatchObject({ id: 'cp-api', type: 'compute', status: 'ready', machine_count: 1 })
})

test('services add: compute, a SECOND postgres and a public bucket; duplicates 409; junk type 400', async () => {
  const id = await createProject()
  const r = await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })
  expect(r.statusCode).toBe(201)
  expect(r.json().service).toMatchObject({ id: 'cp-worker', type: 'compute', name: 'worker' })
  expect((await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })).statusCode).toBe(409)
  // A second postgres is its own container on every branch, not an idempotent no-op.
  const pg = await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics' })
  expect(pg.statusCode).toBe(201)
  expect(pg.json().service).toMatchObject({ id: 'pg-analytics', type: 'postgres', name: 'analytics', status: 'ready', pg_version: 16 })
  expect(calls).toContain('db.provision:io-demo-main-pg-analytics')
  // The name is taken now, on every branch.
  expect((await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics' })).statusCode).toBe(409)
  // Default private, which is a documented promise: no access call is made at all.
  const priv = await post(`/projects/${id}/services`, { type: 'storage', name: 'quiet' })
  expect(priv.statusCode).toBe(201)
  expect(priv.json().service).toMatchObject({ id: 'st-quiet', type: 'storage', name: 'quiet', public: false })
  expect(calls.some((c) => c.startsWith('st.access:io-demo-main-quiet'))).toBe(false)
  const st = await post(`/projects/${id}/services`, { type: 'storage', name: 'blobs', public: true })
  expect(st.statusCode).toBe(201)
  expect(st.json().service).toMatchObject({ id: 'st-blobs', type: 'storage', name: 'blobs', public: true })
  expect(calls).toContain('st.provision:demo-main:blobs')
  expect(calls).toContain('st.access:io-demo-main-blobs:true')
  expect((await post(`/projects/${id}/services`, { type: 'queue', name: 'q' })).statusCode).toBe(400)
  // Grammar and the per-type cap are the cloud's, with the env var named.
  expect((await post(`/projects/${id}/services`, { type: 'postgres', name: 'Bad Name' })).statusCode).toBe(400)
})

test('services remove: compute, postgres and storage all tear down and report the summary', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  const del = await app.inject({ method: 'DELETE', url: `/projects/${id}/services/cp-api` })
  expect(del.statusCode).toBe(200)
  expect(del.json().teardown).toMatchObject({ failed: 0 })
  expect(del.json().teardown.destroyed).toBeGreaterThan(0)
  const { services } = (await get(`/projects/${id}/services`)).json()
  expect(services.some((s: { name: string }) => s.name === 'api')).toBe(false)

  // postgres and storage remove for real now (decision 50), counting one container / bucket per branch
  const pg = await app.inject({ method: 'DELETE', url: `/projects/${id}/services/pg-db` })
  expect(pg.statusCode).toBe(200)
  expect(pg.json().teardown).toMatchObject({ failed: 0 })
  expect(pg.json().teardown.destroyed).toBeGreaterThan(0)
  expect(calls).toContain('db.destroy:io-demo-main-pg-db')
  const st = await app.inject({ method: 'DELETE', url: `/projects/${id}/services/st-store` })
  expect(st.statusCode).toBe(200)
  expect(calls).toContain('st.destroy:io-demo-main-store')
  expect((await get(`/projects/${id}/services`)).json().services).toEqual([])
  expect((await app.inject({ method: 'DELETE', url: `/projects/${id}/services/pg-ghost` })).statusCode).toBe(404)
  // ...and a compute name nothing claims is a 404 too, not an empty teardown reported as success.
  expect((await app.inject({ method: 'DELETE', url: `/projects/${id}/services/cp-ghost` })).statusCode).toBe(404)
})

// The compute arm of the same rule (decision 49 + 50). A group's registration is project-level,
// but its container and the bytes of its `/data` volume are per branch, so a remove on `feat`
// that swept every branch destroyed main's container and deleted main's volume — a 200 answering
// a request that carried the branch twice, in the qualified id and in `?branch`.
test('services remove: a compute group goes from ONE branch; main keeps its container, its volume bytes and its row', async () => {
  const id = await createProject()
  expect((await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 5 })).statusCode).toBe(201)
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  expect((await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })).statusCode).toBe(201)
  // The fork carries the group onto feat with a volume directory of its own.
  expect(calls.some((c) => /^deploy\.volume:demo-feat:api:/.test(c))).toBe(true)

  // The id the CLI would use: it picks the row from the branch-scoped list (decision 49).
  const featRows = (await get(`/projects/${id}/services?branch=feat`)).json().services as Array<{ id: string; name: string }>
  const featId = featRows.find((r) => r.name === 'api')!.id
  expect(featId).toMatch(/^[0-9a-f-]{36}:cp-api$/)

  calls.length = 0
  vi.mocked(dockerFn).mockClear()
  const del = await app.inject({ method: 'DELETE', url: `/projects/${id}/services/${encodeURIComponent(featId)}?branch=feat` })
  expect(del.statusCode).toBe(200)
  // One container and one volume directory: feat's, and only feat's.
  expect(del.json().teardown).toEqual({ destroyed: 2, failed: 0 })
  const rm = vi.mocked(dockerFn).mock.calls.map((c) => (c[0] as string[]).join(' ')).filter((c) => c.startsWith('rm '))
  expect(rm).toEqual(['rm -f -v io-demo-feat-app-api'])
  const removed = calls.filter((c) => c.startsWith('data.remove:'))
  expect(removed.some((c) => /\/vol\/demo-feat\//.test(c))).toBe(true)
  expect(removed.some((c) => /\/vol\/demo-main\//.test(c))).toBe(false)

  // main still runs the group, still lists it, and still owns the volume record.
  const mainRows = (await get(`/projects/${id}/services?branch=main`)).json().services as Array<{ id: string; name: string; volume_gib: number | null }>
  const onMain = mainRows.find((r) => r.name === 'api')
  expect(onMain).toMatchObject({ id: 'cp-api', volume_gib: 5 })
  expect((await get(`/projects/${id}/services/cp-api/volume`)).json())
    .toEqual({ volume: { sizeGib: 5, mountPath: '/data' }, cap: { volumeGib: 100 } })
  // ...and feat keeps the project-level registration in its list, with no container behind it,
  // which is what an undeployed group looks like on any branch.
  const after = (await get(`/projects/${id}/services?branch=feat`)).json().services as Array<{ name: string; runtime?: string }>
  expect(after.find((r) => r.name === 'api')).toMatchObject({ runtime: 'none' })

  // The registration retires only with the LAST carrier.
  const last = await app.inject({ method: 'DELETE', url: `/projects/${id}/services/cp-api?branch=main` })
  expect(last.statusCode).toBe(200)
  expect(last.json().teardown).toEqual({ destroyed: 2, failed: 0 })
  for (const b of ['main', 'feat']) {
    const rows = (await get(`/projects/${id}/services?branch=${b}`)).json().services as Array<{ name: string }>
    expect(rows.some((r) => r.name === 'api')).toBe(false)
  }
  expect((await get(`/projects/${id}/services/cp-api/volume`)).statusCode).toBe(404)
})

// A branch-scoped read filters registrations with `carries()`, and a filter discriminates on the
// MISS. `dbHandle` and `bucketHandle` asked `dbList`/`stList` before their branch-local test, and
// both reach `getProject` -> `loadState()`, a `structuredClone` of every project, branch, event
// and secret. That made the clone count the PRODUCT of branches and registrations: this shape,
// at 26 branches carrying 5 databases each, took `GET /secrets/tree` into the seconds. The bound
// below is linear in branches + registrations, so the product ordering cannot come back.
test('GET /secrets/tree clones the state a linear number of times, not branches x registrations', async () => {
  const engine = makeEngine()
  const srv = buildServer(engine)
  const { project } = await engine.createProject('demo')
  const id = project.id
  const branches = ['main']
  for (let b = 1; b < 8; b++) { await engine.createBranch(id, `b${b}`, 'main'); branches.push(`b${b}`) }
  // Each branch carries 3 of its OWN, so every other registration is a miss on every branch.
  for (const name of branches) for (let d = 0; d < 3; d++) await engine.addDbService(id, `${name}-${d}`, { branch: name })
  // MANAGED services too, and not as decoration: `aliasedManagedIds` lives only on that arm, and a
  // postgres-only fixture never enters it. Calling it per managed service instead of once per
  // branch took this route from 27 clones to 51 while this guard stayed green, because the shape
  // it measured could not reach the code that regressed.
  for (const name of branches) for (let d = 0; d < 3; d++) await engine.addManagedService(id, 'redis', `rd-${name}-${d}`, { branch: name })
  const regs = engine.getProject(id)!.dbServices!.length + engine.getProject(id)!.managedServices!.length
  expect([branches.length, regs]).toEqual([8, 48])

  let clones = 0
  const real = engine.getProject.bind(engine)
  engine.getProject = (pid: string) => { clones++; return real(pid) }
  const tree = await srv.inject({ method: 'GET', url: `/projects/${id}/secrets/tree` })
  expect(tree.statusCode).toBe(200)
  // The answer is still right: every branch lists exactly the three services it carries.
  const rows = tree.json().branches as Array<{ name: string; services: Array<{ type: string; name: string }> }>
  expect(rows).toHaveLength(8)
  for (const b of rows) {
    expect(b.services.filter((x) => x.type === 'postgres').map((x) => x.name).sort())
      .toEqual([`${b.name}-0`, `${b.name}-1`, `${b.name}-2`])
    expect(b.services.filter((x) => x.type === 'redis').map((x) => x.name).sort())
      .toEqual([`rd-${b.name}-0`, `rd-${b.name}-1`, `rd-${b.name}-2`])
  }
  // Linear in branches + registrations, plus at most two spare clones per branch for the
  // per-branch invariants. The old bound was 2 x (branches + regs), which on this fixture is 112 —
  // loose enough that hoisting `aliasedManagedIds` out of the managed map changed the measured
  // count from 83 to 59 without either number touching it. Measured here: 59 hoisted, 83 per
  // service, so the bound has to sit between them or this guard is decoration.
  expect(clones).toBeLessThanOrEqual(branches.length + regs + 2 * branches.length)
})

test('removing ONE of two storage services leaves the shared object store on the branch network', async () => {
  const id = await createProject()
  expect((await post(`/projects/${id}/services`, { type: 'storage', name: 'blobs' })).statusCode).toBe(201)
  calls.length = 0
  // Buckets are per service, the object store container is one per box: the branch keeps it while
  // any other bucket on that network is live.
  const first = await app.inject({ method: 'DELETE', url: `/projects/${id}/services/st-store` })
  expect(first.statusCode).toBe(200)
  expect(calls).toContain('st.destroy:io-demo-main-store')
  expect(calls.some((c) => c.startsWith('st.detach:'))).toBe(false)
  // The survivor is still a real bucket with its endpoint minted.
  const secrets = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets as Record<string, string>
  expect(secrets.BUCKET_NAME).toBe('io-demo-main-blobs')
  // Host-facing, like every DSN in the bundle: the stored value names the object store on the
  // branch network, and `insta secrets -o .env` feeds a process on the HOST (contract section 10).
  expect(secrets.AWS_ENDPOINT_URL_S3).toBe('http://127.0.0.1:3900')
  expect(secrets.AWS_ENDPOINT_URL_S3_BLOBS).toBe('http://127.0.0.1:3900')
  // ...and the LAST bucket takes the attachment with it.
  const last = await app.inject({ method: 'DELETE', url: `/projects/${id}/services/st-blobs` })
  expect(last.statusCode).toBe(200)
  expect(calls).toContain('st.detach:io-demo-main')
})

// ---- user-defined secrets (insta secrets set/unset) ----

test('secrets set/unset: project-wide + branch override, merged into the bundle + deploy env', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect((await app.inject({ method: 'PUT', url: `/projects/${id}/secrets/MY_FLAG`, payload: { value: 'proj' } })).statusCode).toBe(200)
  await app.inject({ method: 'PUT', url: `/projects/${id}/secrets/MY_FLAG`, payload: { value: 'feat-only', branch: 'feat' } })

  expect((await get(`/projects/${id}/secrets?branch=main`)).json().secrets.MY_FLAG).toBe('proj')
  expect((await get(`/projects/${id}/secrets?branch=feat`)).json().secrets.MY_FLAG).toBe('feat-only')

  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  expect(calls.some((c) => c.includes('deploy:demo-main'))).toBe(true) // env carried via adapter (see fake)

  await app.inject({ method: 'DELETE', url: `/projects/${id}/secrets/MY_FLAG?branch=feat` })
  expect((await get(`/projects/${id}/secrets?branch=feat`)).json().secrets.MY_FLAG).toBe('proj') // falls back to project-wide
})

test('secrets set rejects reserved names and is gateable via secrets.write', async () => {
  const id = await createProject()
  expect((await app.inject({ method: 'PUT', url: `/projects/${id}/secrets/DATABASE_URL`, payload: { value: 'x' } })).statusCode).toBe(400)
  expect((await app.inject({ method: 'PUT', url: `/projects/${id}/secrets/AWS_SECRET_ACCESS_KEY`, payload: { value: 'x' } })).statusCode).toBe(400)
  await app.inject({ method: 'PUT', url: `/projects/${id}/policy/secrets.write`, payload: { decision: 'approve' } })
  expect((await app.inject({ method: 'PUT', url: `/projects/${id}/secrets/OK_NAME`, payload: { value: 'x' } })).statusCode).toBe(202)
})

test('branch create clones the parent branch-scoped user secrets', async () => {
  const id = await createProject()
  await app.inject({ method: 'PUT', url: `/projects/${id}/secrets/ONLY_MAIN`, payload: { value: 'v', branch: 'main' } })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect((await get(`/projects/${id}/secrets?branch=feat`)).json().secrets.ONLY_MAIN).toBe('v')
})

test('org-level usage returns the friendly cloud-only 501 (CLI >=0.0.4 default path)', async () => {
  const r = await get('/orgs/local/usage')
  expect(r.statusCode).toBe(501)
  expect(r.json().error).toMatch(/cloud-only/)
})

test('redeploying to a branch keeps its allocated host port (regression: collided with main)', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' }) // feat allocated 3000->4000
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'feat', port: 3000 }) // redeploy new image
  expect(calls).toContain('deploy:demo-feat:default:app:2:s3=io-demo-feat-store:p=3000->4000') // NOT ->3000
})

// ---- dashboard additions ----

test('services carry dashboard fields (runtime/endpoint/updated_at) and are branch-aware', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })

  const main = (await get(`/projects/${id}/services`)).json().services // defaults to the default branch
  const db = main.find((s: { id: string }) => s.id === 'pg-db')
  expect(db.domain).toBe('pg-db-demo-main.localhost')
  expect(db.endpoint).toMatch(/^127\.0\.0\.1:2\d{4}$/)
  expect(db.runtime).toBe('online') // WP3: the fake adapter's container is running, and `runtime` reads that one store
  const cp = main.find((s: { id: string }) => s.id === 'cp-default')
  expect(cp.domain).toBe('default-demo-main.localhost')
  expect(cp.endpoint).toBe('default-demo-main.localhost:8080')
  expect(cp.updated_at).toBeTruthy()
  expect(cp.status).toBe('ready') // CLI-printed field untouched

  // Off the default branch every row id carries the branch qualifier (decision 49), because the
  // CLI takes an id from THIS list and calls the follow-up route with no branch at all.
  const featId = (await get(`/projects/${id}/branches`)).json().branches.find((b: { name: string }) => b.name === 'feat').id
  const feat = (await get(`/projects/${id}/services?branch=feat`)).json().services
  expect(feat.find((s: { id: string }) => s.id === `${featId}:cp-default`).endpoint).toBe('default-demo-feat.localhost:8080')
  expect(feat.map((s: { id: string }) => s.id)).toContain(`${featId}:pg-db`)
  expect((await get(`/projects/${id}/services?branch=nope`)).statusCode).toBe(404)
})

test('registered-but-undeployed compute reports runtime none', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })
  const { services } = (await get(`/projects/${id}/services`)).json()
  expect(services.find((s: { id: string }) => s.id === 'cp-worker').runtime).toBe('none')
})

test('dashboard serving: SPA fallback for non-API GETs; API routes always win', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const dist = mkdtempSync(join(tmpdir(), 'io-ui-'))
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<html>dash</html>')
  process.env.INSTA_OSS_UI_DIST = dist
  const ui = buildServer(new Engine(db, compute, storage, managed))
  delete process.env.INSTA_OSS_UI_DIST

  expect((await ui.inject({ method: 'GET', url: '/' })).body).toContain('dash')
  expect((await ui.inject({ method: 'GET', url: '/p/some-project/main/services' })).body).toContain('dash')
  const api = await ui.inject({ method: 'GET', url: '/projects/nope' })
  expect(api.statusCode).toBe(404)
  expect(api.json().error).toBeTruthy() // JSON error, not the SPA shell
  const gh = await ui.inject({ method: 'GET', url: '/github/nope' })
  expect(gh.statusCode).toBe(404)
  expect(gh.json().error).toBeTruthy()
})

test('dashboard serving: without a build, / explains how to get the UI', async () => {
  process.env.INSTA_OSS_UI_DIST = join(tmpdir(), 'io-ui-definitely-missing')
  const bare = buildServer(new Engine(db, compute, storage, managed))
  delete process.env.INSTA_OSS_UI_DIST
  const r = await bare.inject({ method: 'GET', url: '/' })
  expect(r.body).toContain('build:ui')
})

// ---- contract parity: secrets tree, service secrets, merge, lifecycle, access ----

test('secrets tree: minted creds under their service; user secrets grouped by binding', async () => {
  const id = await createProject()
  await put(`/projects/${id}/secrets/GLOBAL_KEY`, { value: 'v' })
  await put(`/projects/${id}/secrets/BRANCH_KEY`, { value: 'v', branch: 'main' })
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api' })
  await put(`/projects/${id}/secrets/API_KEY`, { value: 'v', branch: 'main', service: 'compute/api' })
  const tree = (await get(`/projects/${id}/secrets/tree`)).json()
  expect(tree.projectWide).toEqual(['GLOBAL_KEY'])
  const main = tree.branches.find((b: { name: string }) => b.name === 'main')
  expect(main.isDefault).toBe(true)
  expect(main.unbound).toEqual(['BRANCH_KEY'])
  expect(main.services.find((s: { type: string }) => s.type === 'postgres').secrets).toContain('DATABASE_URL')
  expect(main.services.find((s: { type: string }) => s.type === 'storage').secrets).toContain('BUCKET_NAME')
  expect(main.services.find((s: { name: string }) => s.name === 'api').secrets).toEqual(['API_KEY'])
})

// A service's Variables tab deletes a variable naming that service, and the Secrets page's Shared tab an unbound one
// with `unbound=true`. Either narrows the delete to that copy: a name that has since been rebound elsewhere survives.
test('DELETE /secrets/:name with service or unbound removes only that copy', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api' })
  await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })
  await put(`/projects/${id}/secrets/API_KEY`, { value: 'v', branch: 'main', service: 'compute/api' })
  const bound = async () => (await get(`/projects/${id}/secrets/tree`)).json()
    .branches.find((b: { name: string }) => b.name === 'main')
    .services.find((s: { name: string }) => s.name === 'api').secrets as string[]

  await app.inject({ method: 'DELETE', url: `/projects/${id}/secrets/API_KEY?branch=main&service=compute/worker` })
  expect(await bound()).toEqual(['API_KEY'])
  await app.inject({ method: 'DELETE', url: `/projects/${id}/secrets/API_KEY?branch=main&unbound=true` })
  expect(await bound()).toEqual(['API_KEY'])
  const res = await app.inject({ method: 'DELETE', url: `/projects/${id}/secrets/API_KEY?branch=main&service=compute/api` })
  expect(res.statusCode).toBe(200)
  expect(await bound()).toEqual([])
})

// `unbound=true` takes the branch's unbound copy and leaves a same-named project-wide one, which the branch then
// falls back to. A narrowing the route cannot read exactly is a 400 that deletes nothing: without a branch it used to
// reach the project-wide row, and a repeated or mis-cased `unbound` fell back to the broad delete.
test('DELETE /secrets/:name narrowing needs a branch and one exact value, or deletes nothing', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api' })
  await put(`/projects/${id}/secrets/SHARED`, { value: 'proj' })
  await put(`/projects/${id}/secrets/SHARED`, { value: 'branch', branch: 'main' })
  await put(`/projects/${id}/secrets/API_KEY`, { value: 'v', branch: 'main', service: 'compute/api' })
  const main = async () => (await get(`/projects/${id}/secrets?branch=main`)).json().secrets as Record<string, string>
  const del = (qs: string) => app.inject({ method: 'DELETE', url: `/projects/${id}/secrets/${qs}` })

  for (const qs of [
    'SHARED?unbound=true',
    'API_KEY?service=compute/api',
    'API_KEY?branch=main&unbound=TRUE',
    'API_KEY?branch=main&unbound=true&unbound=true',
    'API_KEY?branch=main&service=compute/api&service=compute/api',
    'API_KEY?branch=main&service=compute/api&unbound=true',
    'API_KEY?branch=main&service=',
  ]) {
    expect((await del(qs)).statusCode, qs).toBe(400)
  }
  expect((await main()).SHARED).toBe('branch')
  expect((await get(`/projects/${id}/secrets/tree`)).json().projectWide).toEqual(['SHARED'])
  expect((await main()).API_KEY).toBe('v')

  expect((await del('SHARED?branch=main&unbound=true')).statusCode).toBe(200)
  expect((await main()).SHARED).toBe('proj')
  expect((await get(`/projects/${id}/secrets/tree`)).json().projectWide).toEqual(['SHARED'])
})

// `secrets` merges platform-minted credentials with the user secrets bound to that service, and
// the two have different reach: a minted credential goes to EVERY compute group in the branch, a
// bound one only to its own service. Without `minted` a caller cannot answer "what can this app
// read", and the dashboard answered it as "every name under every service" — showing one app
// another app's bound secrets.
test('secrets tree separates minted credentials from service-bound user secrets', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api' })
  await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })
  await put(`/projects/${id}/secrets/API_KEY`, { value: 'v', branch: 'main', service: 'compute/api' })
  await put(`/projects/${id}/secrets/WORKER_KEY`, { value: 'v', branch: 'main', service: 'compute/worker' })
  await put(`/projects/${id}/secrets/PG_OWNED`, { value: 'v', branch: 'main', service: 'postgres/db' })

  const main = (await get(`/projects/${id}/secrets/tree`)).json()
    .branches.find((b: { name: string }) => b.name === 'main')
  const svc = (name: string) => main.services.find((s: { name: string }) => s.name === name)

  // A compute group mints nothing, and each sees only its own bound secret.
  expect(svc('api').minted).toEqual([])
  expect(svc('api').secrets).toEqual(['API_KEY'])
  expect(svc('worker').secrets).toEqual(['WORKER_KEY'])
  expect(svc('api').secrets).not.toContain('WORKER_KEY')

  // Postgres mints DATABASE_URL for every app, but a secret BOUND to postgres is not minted: it
  // is in `secrets` and must stay out of `minted`, or apps would be told they receive it.
  expect(svc('db').minted).toContain('DATABASE_URL')
  expect(svc('db').secrets).toContain('PG_OWNED')
  expect(svc('db').minted).not.toContain('PG_OWNED')
})

// The managed arm of the same property, and the one this test originally missed. A managed
// service's env carries BOTH the suffixed bundle and, for the branch's oldest service of that
// type, the canonical unsuffixed aliases (managedSecretsFor). `minted` reported only the suffixed
// half, so the one name most apps actually read — REDIS_URL — was listed nowhere in the dashboard,
// and a user could type it into Add Secret and get a bare 400 for a reserved name.
test('minted covers the canonical managed aliases the oldest service of a type also holds', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/services`, { type: 'redis', name: 'sessions' })

  const main = (await get(`/projects/${id}/secrets/tree`)).json()
    .branches.find((b: { name: string }) => b.name === 'main')
  const svc = (name: string) => main.services.find((s: { name: string }) => s.name === name)

  // The oldest redis holds the aliases, so it mints the canonical names AND its own suffixed set.
  expect(svc('cache').minted).toContain('REDIS_URL')
  expect(svc('cache').minted).toContain('REDIS_URL_CACHE')
  // The second one only ever has its suffixed set: the aliases are not its to hold.
  expect(svc('sessions').minted).toContain('REDIS_URL_SESSIONS')
  expect(svc('sessions').minted).not.toContain('REDIS_URL')
})

// "Deleted" and "has no branches" have to be distinguishable, or a client cannot tell a stale
// link from a real project. This route answered 200 with an empty list either way, so the
// dashboard's deleted-project redirect keyed on a 404 that never arrived and instead walked into
// a shell full of failing requests.
test('branches of a project that does not exist is a 404, not an empty list', async () => {
  const gone = await get('/projects/00000000-0000-0000-0000-000000000000/branches')
  expect(gone.statusCode).toBe(404)
  expect(gone.json().error).toBe('project not found')
  // A real project still answers with its branches.
  const id = await createProject()
  const ok = await get(`/projects/${id}/branches`)
  expect(ok.statusCode).toBe(200)
  expect(ok.json().branches.length).toBeGreaterThan(0)
})

// A group can be created two ways, and only one of them used to stamp createdAt. `insta deploy
// --group <name>` materialises the group with no prior add, so the service row fell back to
// `updatedAt` — which every redeploy rewrites — and the dashboard's Created column walked forward
// on each deploy. The earlier created_at test only exercised addComputeService, so it passed
// either way.
test('created_at of a deploy-materialised group does not move on a redeploy', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'viadeploy' })
  const first = (await get(`/projects/${id}/services?branch=main`)).json()
    .services.find((s: { name: string }) => s.name === 'viadeploy').created_at
  expect(first).toEqual(expect.any(String))

  await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'main', port: 3000, group: 'viadeploy' })
  const second = (await get(`/projects/${id}/services?branch=main`)).json()
    .services.find((s: { name: string }) => s.name === 'viadeploy')
  expect(second.created_at).toBe(first)
  // The redeploy did land, so this is not a stale row.
  expect(second.image).toBe('app:2')
})

// The UPGRADE path, which the test above cannot reach: a group direct-deployed by an OLDER daemon
// has a host but no createdAt. Gating the stamp on `minting` meant it would never mint again, so
// it would never be stamped, and its Created column would walk forward for the life of the
// install — exactly the bug the stamp was added to fix, surviving for every existing group.
test('created_at is backfilled for a group deployed before the stamp existed, and does not move after', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'legacy' })

  // Rewind to the pre-stamp shape: the row keeps its host and updatedAt, the stamp is removed.
  const bid = await branchOf(id)
  let priorUpdatedAt = 0
  mutate((s) => {
    priorUpdatedAt = s.branches[bid].apps.legacy.updatedAt!
    delete s.projects[id].serviceSettings!['cp-legacy']
  })
  expect(loadState().branches[bid].apps.legacy.host).toBeDefined()

  // Pre-backfill the row falls back to updatedAt, which the next deploy rewrites.
  const before = (await get(`/projects/${id}/services?branch=main`)).json()
    .services.find((s: { name: string }) => s.name === 'legacy').created_at
  expect(Date.parse(before)).toBe(priorUpdatedAt)

  await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'main', port: 3000, group: 'legacy' })
  const after = (await get(`/projects/${id}/services?branch=main`)).json()
    .services.find((s: { name: string }) => s.name === 'legacy')
  // Backfilled with the date the user was already reading, not with now: it stops moving without
  // jumping on the upgrade deploy.
  expect(Date.parse(after.created_at)).toBe(priorUpdatedAt)
  expect(after.image).toBe('app:2')

  // And it stays put on every deploy after that.
  await post(`/projects/${id}/deploy`, { image: 'app:3', branch: 'main', port: 3000, group: 'legacy' })
  const third = (await get(`/projects/${id}/services?branch=main`)).json()
    .services.find((s: { name: string }) => s.name === 'legacy')
  expect(third.created_at).toBe(after.created_at)
})

// The stamp is PROJECT-level and `services()` reads it for every branch, while `minting` is
// per-branch. Deploying a legacy group onto a branch that does not carry it yet makes `minting`
// true THERE, so keying the backfill off it stamped now and jumped the Created date of the copy
// that had been running on main all along — a worse version of the bug being fixed.
test('deploying a legacy group onto a new branch does not jump the existing copy\'s created_at', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'shared' })

  // Rewind to the pre-stamp shape, and age main's deploy so "now" is clearly distinguishable.
  const mainBid = await branchOf(id)
  const aged = Date.now() - 5 * 24 * 60 * 60 * 1000
  mutate((s) => {
    s.branches[mainBid].apps.shared.updatedAt = aged
    delete s.projects[id].serviceSettings!['cp-shared']
  })

  // A second branch that does NOT carry the group, then a deploy of it there: minting is true.
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  const featBid = await branchOf(id, 'feat')
  mutate((s) => { delete s.branches[featBid].apps.shared })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'feat', port: 3000, group: 'shared' })

  // main's Created is the oldest deploy still on record, not the moment feat was deployed.
  const onMain = (await get(`/projects/${id}/services?branch=main`)).json()
    .services.find((s: { name: string }) => s.name === 'shared')
  expect(Date.parse(onMain.created_at)).toBe(aged)
  // And the project-level stamp means feat reads the same date, rather than two different ones.
  const onFeat = (await get(`/projects/${id}/services?branch=feat`)).json()
    .services.find((s: { name: string }) => s.name === 'shared')
  expect(onFeat.created_at).toBe(onMain.created_at)
})

// The dashboard's Environments table reads its branches from GET /projects/:id (one call for the
// branches AND what each carries, as the console does), not from /branches. The Created column
// therefore needs created_at on THAT payload; it was only on /branches, so every row showed an
// em dash while a test covering only /branches stayed green.
test('project detail carries created_at on its branches, like the branches route', async () => {
  const id = await createProject()
  const detail = (await get(`/projects/${id}`)).json()
  const main = detail.branches.find((b: { name: string }) => b.name === 'main')
  expect(main.created_at).toEqual(expect.any(String))
  expect(new Date(main.created_at).getTime()).toBeGreaterThan(0)
  // And the two payloads agree, since the page can arrive from either.
  const listed = (await get(`/projects/${id}/branches`)).json()
    .branches.find((b: { name: string }) => b.name === 'main')
  expect(main.created_at).toBe(listed.created_at)
})

// The other half of why listing the canonical names matters: they are RESERVED, so a user cannot
// take one. Before `minted` carried them, the dashboard showed REDIS_URL nowhere and yet refused
// it here, which reads as arbitrary.
test('a canonical managed name is reserved, which is why the inventory has to show it', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  const r = await put(`/projects/${id}/secrets/REDIS_URL`, { value: 'mine', branch: 'main' })
  expect(r.statusCode).toBeGreaterThanOrEqual(400)
  expect(r.json().error).toContain('reserved')
})

test('secrets tree is gated by secrets.read', async () => {
  const id = await createProject()
  await put(`/projects/${id}/policy/secrets.read`, { decision: 'approve' })
  expect((await get(`/projects/${id}/secrets/tree`)).statusCode).toBe(202)
})

test('secret service binding requires a branch and an existing service', async () => {
  const id = await createProject()
  expect((await put(`/projects/${id}/secrets/X`, { value: 'v', service: 'compute/api' })).statusCode).toBe(400)
  expect((await put(`/projects/${id}/secrets/X`, { value: 'v', branch: 'main', service: 'compute/nope' })).statusCode).toBe(400)
})

test('service secrets endpoint returns names only, per service', async () => {
  const id = await createProject()
  // The oldest postgres holds the canonical alias AND its own suffixed name (platform parity).
  expect((await get(`/projects/${id}/services/pg-db/secrets`)).json().secrets).toEqual(['DATABASE_URL', 'DATABASE_URL_DB'])
  expect((await get(`/projects/${id}/services/st-store/secrets`)).json().secrets).toContain('AWS_ACCESS_KEY_ID')
  expect((await get(`/projects/${id}/services/cp-nope/secrets`)).statusCode).toBe(404)
})

test('a service-bound secret is injected only into its own compute group', async () => {
  const envs: Record<string, string[]> = {}
  const localCompute: ComputeAdapter = {
    deploy: async (_r, o) => { envs[o.group] = Object.keys(o.envVars); return { url: `http://localhost:${o.hostPort ?? o.port}` } },
    destroy: async () => {},
  }
  const local = buildServer(new Engine(db, localCompute, storage, managed))
  const lpost = (url: string, payload?: unknown) => local.inject({ method: 'POST', url, payload })
  const id = (await lpost('/orgs/local/projects', { name: 'bind-demo' })).json().project.id
  await lpost(`/projects/${id}/services`, { type: 'compute', name: 'api' })
  await lpost(`/projects/${id}/services`, { type: 'compute', name: 'worker' })
  await local.inject({ method: 'PUT', url: `/projects/${id}/secrets/ONLY_API`, payload: { value: 'v', branch: 'main', service: 'compute/api' } })
  await lpost(`/projects/${id}/deploy`, { image: 'a:1', branch: 'main', group: 'api' })
  await lpost(`/projects/${id}/deploy`, { image: 'a:1', branch: 'main', group: 'worker' })
  expect(envs.api).toContain('ONLY_API')
  expect(envs.worker).not.toContain('ONLY_API')
})

test('branch merge is structural + additive: missing compute groups materialize on the target', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  await post(`/projects/${id}/deploy`, { image: 'worker:1', branch: 'feat', port: 3100, group: 'worker' })
  const r = await post(`/projects/${id}/branches/main/merge`, { from: 'feat' })
  expect(r.statusCode).toBe(200)
  expect(r.json().created).toEqual([{ type: 'compute', name: 'worker' }])
  expect(r.json().skipped).toEqual(expect.arrayContaining([
    { type: 'postgres', name: 'db', reason: 'exists' },
    { type: 'storage', name: 'store', reason: 'exists' },
    { type: 'compute', name: 'default', reason: 'exists' },
  ]))
  // the new group runs against MAIN's own resources — no data or creds carried from feat
  expect(calls.some((c) => c.startsWith('deploy:demo-main:worker:worker:1:s3=io-demo-main-store'))).toBe(true)
  // re-merge is idempotent
  expect((await post(`/projects/${id}/branches/main/merge`, { from: 'feat' })).json().created).toEqual([])
  // errors: same branch / unknown source → 400; unknown target → 404
  expect((await post(`/projects/${id}/branches/main/merge`, { from: 'main' })).statusCode).toBe(400)
  expect((await post(`/projects/${id}/branches/main/merge`, { from: 'nope' })).statusCode).toBe(400)
  expect((await post(`/projects/${id}/branches/nope/merge`, { from: 'feat' })).statusCode).toBe(404)
})

test('compute lifecycle: stop sets desired intent; state reports desired vs live', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  const r = await post(`/projects/${id}/services/cp-default/stop`)
  expect(r.statusCode).toBe(200)
  expect(r.json().service.desired_state).toBe('stopped')
  // WP3 (decision 53): liveState reads the ONE container store the fake adapter just moved, so a
  // stopped service reports `stopped` where the fake used to answer `running` unconditionally.
  expect(r.json().state).toBe('stopped')
  expect(calls).toContain('compute.stop:demo-main:default')
  const st = (await get(`/projects/${id}/services/cp-default/state`)).json()
  expect(st).toEqual({ desiredState: 'stopped', state: 'stopped' })
  await post(`/projects/${id}/services/cp-default/start`)
  expect((await get(`/projects/${id}/services/cp-default/state`)).json().desiredState).toBe('running')
  // lifecycle is compute-only; unknown services 404
  expect((await post(`/projects/${id}/services/pg-db/stop`)).statusCode).toBe(400)
  expect((await get(`/projects/${id}/services/cp-nope/state`)).statusCode).toBe(404)
})

test('compute restart REDEPLOYS the recorded image (fresh env), and refuses a stopped service', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  calls.length = 0
  const r = await post(`/projects/${id}/services/cp-default/restart`)
  expect(r.statusCode).toBe(200)
  // A redeploy of the SAME image on the SAME host mapping, not an adapter start/stop: env is
  // assembled at deploy time, so this is the only path that carries a changed secret in.
  expect(calls.some((c) => c.startsWith('deploy:demo-main:default:app:1:'))).toBe(true)
  expect(calls.some((c) => c.startsWith('compute.start:') || c.startsWith('compute.stop:'))).toBe(false)
  expect(r.json().state).toBe('running')

  // Stopped is a persistent intent — a restart must not quietly bring it back.
  await post(`/projects/${id}/services/cp-default/stop`)
  calls.length = 0
  const stopped = await post(`/projects/${id}/services/cp-default/restart`)
  expect(stopped.statusCode).toBe(400)
  expect(stopped.json().error).toMatch(/insta compute start/)
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(false)

  // compute-only, unknown services 404
  expect((await post(`/projects/${id}/services/pg-db/restart`)).statusCode).toBe(400)
  expect((await post(`/projects/${id}/services/cp-nope/restart`)).statusCode).toBe(404)

  // ...and a compute service that EXISTS but was never deployed has no image to re-run. Its own
  // branch in engine.restart, distinct from the two above.
  await post(`/projects/${id}/services`, { type: 'compute', name: 'bare' })
  const bare = await post(`/projects/${id}/services/cp-bare/restart`)
  expect(bare.statusCode).toBe(400)
  expect(bare.json().error).toMatch(/no machines yet/)
})

// A transition that DID NOT HAPPEN must not be recorded as one. These three used to answer 200
// with the requested `desiredState` written and the scheduler told `onStopped`/`onPaused`, which
// puts `exited`/`paused` into the snapshot the idle sweep and the eviction pass reason from: not
// a missing error but a fabricated runtime fact, on a box that rations RAM by that snapshot.

// A multi-branch rename is a SEQUENCE of docker calls under one lock. The lock makes it
// exclusive; it does not make it atomic, and the records were written only after every branch's
// container had moved. A failure partway therefore left state naming the old container on every
// branch while some containers already carried the new one: routing and lifecycle addressed a
// container that does not exist, a teardown proved the old name gone and dropped the row over a
// live container under the new one, and the retry could not win either way.

test('a MANAGED rename that fails on the second branch moves its containers back too', async () => {
  // The managed path has the same shape and the same fix, and it had one more problem of its
  // own: it moved the scheduler's ledger key inside the loop, before any record was written, so
  // a failure left the ledger keyed to a service id nothing resolved. The rekey now happens
  // after the records, as the compute path already did it.
  const id = await createProject()
  expect((await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })).statusCode).toBe(201)
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  calls.length = 0

  const real = managed.rename!.bind(managed)
  const rename = vi.spyOn(managed, 'rename').mockImplementation(async (container: string, to: string) => {
    if (container.includes('demo-feat')) throw new Error('docker refused the rename')
    return real(container, to)
  })
  let r
  try {
    r = await post(`/projects/${id}/services/rd-cache/rename`, { name: 'kv' })
  } finally {
    rename.mockRestore()
  }
  expect(r.statusCode).toBeGreaterThanOrEqual(400)
  expect(r.json().error).toContain('docker refused the rename')
  expect(r.json().error).toContain('Nothing was renamed')

  for (const ref of ['demo-main', 'demo-feat']) {
    expect(runtime.stateOfContainer(`io-${ref}-rd-cache`), ref).toBeDefined()
    expect(runtime.stateOfContainer(`io-${ref}-rd-kv`), ref).toBeUndefined()
  }
  // The records never moved either, so the service is still addressable by the id it had.
  expect((await get(`/projects/${id}/services`)).json().services.some((x: { id: string }) => x.id === 'rd-cache')).toBe(true)
  expect((await post(`/projects/${id}/services/rd-cache/rename`, { name: 'kv' })).statusCode).toBe(200)
})

test('a rename that fails on the SECOND branch moves every container back', async () => {
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  calls.length = 0

  const real = compute.rename!.bind(compute)
  const rename = vi.spyOn(compute, 'rename').mockImplementation(async (ref: string, from: string, to: string) => {
    if (ref.includes('feat') && to === 'api') throw new Error('docker refused the rename')
    return real(ref, from, to)
  })
  let r
  try {
    r = await post(`/projects/${id}/services/cp-web/rename`, { name: 'api' })
  } finally {
    rename.mockRestore()
  }
  expect(r.statusCode).toBeGreaterThanOrEqual(400)
  expect(r.json().error).toContain('docker refused the rename')
  expect(r.json().error).toContain('Nothing was renamed')

  // Every branch is internally consistent again: the row and the container agree, on the OLD
  // name, everywhere.
  for (const ref of ['demo-main', 'demo-feat']) {
    expect(runtime.stateOfContainer(`io-${ref}-app-web`), ref).toBeDefined()
    expect(runtime.stateOfContainer(`io-${ref}-app-api`), ref).toBeUndefined()
  }
  // The clone's copy is asleep from birth, so what matters is that the row is still the OLD
  // name and still has a container behind it, not which of the two live states it is in.
  const rows = (await get(`/projects/${id}/services?branch=feat`)).json().services as Array<{ name: string; runtime?: string }>
  expect(rows.find((x) => x.name === 'web')?.runtime).not.toBe('none')
  expect(rows.some((x) => x.name === 'api')).toBe(false)

  // Routing still resolves, cleanup still finds the container it names...
  const feat = await branchOf(id, 'feat')
  const del = await app.inject({ method: 'DELETE', url: `/projects/${id}/branches/${feat}` })
  expect(del.statusCode).toBe(200)
  expect(del.json().teardown.failed).toBe(0)
  expect(runtime.stateOfContainer('io-demo-feat-app-web')).toBeUndefined()

  // ...and the same rename, run again, works.
  expect((await post(`/projects/${id}/services/cp-web/rename`, { name: 'api' })).statusCode).toBe(200)
  expect(runtime.stateOfContainer('io-demo-main-app-api')).toBeDefined()
})

test('a rename whose UNDO also fails names what is stuck, and the retry finishes it', async () => {
  // The compensation can fail too: docker is misbehaving, that is why we are here. It must not
  // replace the original error, and what it could not move back has to be named -- and the
  // forward pass reads the CONTAINERS rather than assuming, so re-running the same command
  // renames only the branches that still need it.
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  calls.length = 0

  const real = compute.rename!.bind(compute)
  const rename = vi.spyOn(compute, 'rename').mockImplementation(async (ref: string, from: string, to: string) => {
    if (ref.includes('feat') && to === 'api') throw new Error('docker refused the rename')
    if (to === 'web') throw new Error('and refused to move it back')      // the undo
    return real(ref, from, to)
  })
  let r
  try {
    r = await post(`/projects/${id}/services/cp-web/rename`, { name: 'api' })
  } finally {
    rename.mockRestore()
  }
  expect(r.statusCode).toBeGreaterThanOrEqual(400)
  const { error } = r.json() as { error: string }
  expect(error).toContain('docker refused the rename')            // the original, first
  expect(error).toContain('and refused to move it back')          // ...and what is stuck
  expect(error).toContain('io-demo-main-app-api (branch main)')
  expect(error).toContain('re-running')

  // main is left carrying the new container name with the records unchanged, which is exactly
  // the state the retry is built to read.
  expect(runtime.stateOfContainer('io-demo-main-app-api')).toBeDefined()
  expect(runtime.stateOfContainer('io-demo-feat-app-web')).toBeDefined()

  calls.length = 0
  const again = await post(`/projects/${id}/services/cp-web/rename`, { name: 'api' })
  expect(again.statusCode).toBe(200)
  // main was already renamed and is NOT renamed twice; feat is the only one that moves.
  expect(calls.filter((c) => c.startsWith('compute.rename:demo-main:'))).toEqual([])
  expect(calls).toContain('compute.rename:demo-feat:web->api')
  for (const ref of ['demo-main', 'demo-feat']) {
    expect(runtime.stateOfContainer(`io-${ref}-app-api`), ref).toBeDefined()
    expect(runtime.stateOfContainer(`io-${ref}-app-web`), ref).toBeUndefined()
  }
  const rows = (await get(`/projects/${id}/services?branch=feat`)).json().services as Array<{ name: string; runtime?: string }>
  expect(rows.find((x) => x.name === 'api')?.runtime).not.toBe('none')
})

test('healthz carries what a supplied certificate has left, and nothing when there is none', async () => {
  // `--tls custom` is the only mode whose certificate nothing renews, so `healthz` carries the
  // remaining lifetime unconditionally: a monitor alerts on the margin its operator wants rather
  // than on the 21 days the daemon warns at. Absent in every other mode.
  expect((await get('/healthz')).json()).toEqual({ ok: true })

  const crt = join('test', 'fixtures', 'local', 'router.test', 'router.test.crt')
  const base = testConfig()
  const cfg = { ...base, tls: { ...base.tls, certFile: crt, keyFile: crt } }
  const withCert = buildServer(makeEngine(cfg), cfg)
  const body = (await withCert.inject({ method: 'GET', url: '/healthz' })).json() as {
    ok: boolean; certificate?: { notAfter: string; daysLeft: number; secondsLeft: number }
  }
  expect(body.ok).toBe(true)
  expect(Date.parse(body.certificate!.notAfter)).toBeGreaterThan(0)
  expect(body.certificate!.daysLeft).toBe(Math.floor(body.certificate!.secondsLeft / 86_400))

  // A path that cannot be read reports NOTHING rather than a reassuring number.
  const broken = { ...base, tls: { ...base.tls, certFile: '/nope/missing.crt', keyFile: '/nope/missing.key' } }
  expect((await buildServer(makeEngine(broken), broken).inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true })

  // HALF a pair is not a supplied certificate. With only the certificate configured the router
  // serves nothing supplied and goes on issuing per hostname, so an endpoint that reported one
  // would assert the exact property the box was not providing -- in the field an operator reads
  // to confirm it. Config refuses this combination outright; the endpoint is gated on the pair
  // as well, because the two must never disagree about what the box is doing.
  for (const half of [{ certFile: crt, keyFile: null }, { certFile: null, keyFile: crt }]) {
    const cfgHalf = { ...base, tls: { ...base.tls, ...half } }
    expect(suppliedFiles(cfgHalf)).toBeNull()
    expect((await buildServer(makeEngine(cfgHalf), cfgHalf).inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true })
  }

  // ...and the endpoint does NO file I/O per request. It is unauthenticated and polled
  // continuously, so a read per hit is a handle anyone can pull on to stall the event loop.
  let reads = 0
  const watch = new SuppliedCertWatch(crt, { read: (path, at) => { reads++; return suppliedCert(path, at) } })
  const polled = buildServer(makeEngine(cfg), cfg, { certWatch: watch })
  expect(reads).toBe(1)
  for (let i = 0; i < 25; i++) {
    expect((await polled.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
  }
  expect(reads).toBe(1)
})

/** These cases mint a certificate with the `openssl` CLI: Node parses X.509 but cannot issue
 *  it, and a fixture cannot be "30 days from now" a year after it was committed. Declared and
 *  skipped by name where openssl is absent (see the README), rather than failing at the spawn. */
const hasOpenssl = spawnSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).status === 0

test.skipIf(!hasOpenssl)('healthz follows a RENEWED certificate, the way a renewal actually happens', async () => {
  // Measured on a live box: after writing the new pair alongside and renaming it over the live
  // names, `/healthz` kept reporting the OLD certificate -- same notAfter, same daysLeft, only
  // secondsLeft ticking down. A cache invalidated by time reports the certificate it read at
  // boot, and after a renewal it is wrong in the REASSURING direction, on the one field whose
  // purpose is to warn before an expiry. This is that procedure, end to end through the route.
  const dir = mkdtempSync(join(tmpdir(), 'io-healthz-tls-'))
  const mint = (out: string, days: number): void => {
    const r = spawnSync('sh', ['-c',
      `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days ${days} -keyout ${join(dir, 'k.pem')} -out ${out} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test' 2>/dev/null`,
    ], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`)
  }
  try {
    const live = join(dir, 'live.crt')
    mint(live, 30)
    const base = testConfig()
    const cfg = { ...base, tls: { ...base.tls, certFile: live, keyFile: join(dir, 'k.pem') } }
    // The watch the daemon refreshes on its beat. The request path reads nothing, so the test
    // drives the beat the way main.ts's timer does.
    const watch = new SuppliedCertWatch(live)
    const app2 = buildServer(makeEngine(cfg), cfg, { certWatch: watch })
    const read = async (): Promise<{ notAfter: string; daysLeft: number }> =>
      ((await app2.inject({ method: 'GET', url: '/healthz' })).json() as { certificate: { notAfter: string; daysLeft: number } }).certificate

    const before = await read()
    // Not an exact day count: `-days 30` lands on the boundary and a second of elapsed time
    // decides 29 vs 30. What matters is that the number MOVES with the file.
    expect(before.daysLeft).toBeGreaterThanOrEqual(29)
    expect(before.daysLeft).toBeLessThanOrEqual(30)

    mint(join(dir, 'next.crt'), 90)
    renameSync(join(dir, 'next.crt'), live)
    watch.refresh()

    const after = await read()
    expect(after.notAfter).not.toBe(before.notAfter)          // it MOVED
    expect(after.daysLeft).toBeGreaterThan(before.daysLeft + 55)

    // ...and a certificate that goes away takes the field with it rather than leaving the last
    // good number in place.
    rmSync(live)
    watch.refresh()
    expect((await app2.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a volume delete on a SUSPENDED service succeeds, and leaves it suspended', async () => {
  // `removeServiceVolumeLocked` redeployed each branch without the mount and then re-asserted
  // the recorded intent itself -- but `deploy()` already re-asserts it, with the exact verb, on
  // the replacement container. Two pauses. That was harmless while the re-assert swallowed its
  // failures, and making it fail-closed turned it into a deterministic break of every
  // `volume delete` on a suspended service, because `docker pause` on an already-paused
  // container exits 1 (`docker stop` on an exited one exits 0, which is why the stopped arm
  // never showed it).
  const id = await createProject()
  expect((await post(`/projects/${id}/services`, { type: 'compute', name: 'web', volumeGib: 1 })).statusCode).toBe(201)
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'web' })
  expect((await post(`/projects/${id}/services/cp-web/suspend`)).statusCode).toBe(200)
  calls.length = 0

  const r = await del_(`/projects/${id}/services/cp-web/volume`)
  expect(r.statusCode).toBe(200)
  expect(r.json()).toMatchObject({ removed: true })
  // Exactly ONE re-assert, and it is the deploy's.
  expect(calls.filter((c) => c === 'compute.suspend:demo-main:web')).toHaveLength(1)
  // ...and the service came out the way it went in: suspended, on a paused container, with the
  // volume gone.
  expect((await get(`/projects/${id}/services/cp-web/state`)).json().desiredState).toBe('suspended')
  expect(runtime.stateOfContainer('io-demo-main-app-web')).toBe('paused')
  expect((await get(`/projects/${id}/services/cp-web/volume`)).json().volume).toBeNull()
})

test('a RE-ENTRANT wake is not bounded: the lock is held until the wake finishes', async () => {
  // `wake()` bounds its caller so a held connection cannot wait for ever. That bound belongs to
  // the ACQUISITION, not to the call: `insta compute start` reaches the wake from inside
  // `lifecycleLocked`, which already owns the key, so `withOp` makes no second acquisition and
  // the only real one belongs to the engine op on the stack. Releasing that caller on a timer
  // unwinds the outer op and leaves the wake starting, probing and evicting with nothing in the
  // lock queue: a concurrent stop then writes `stopped` and the orphaned wake starts the
  // container anyway -- running, intent stopped, refused at the traffic door and never a
  // candidate for eviction. What the contract bounds is a held client connection, and an api
  // start is not one.
  const cfg = testConfig({ INSTA_OSS_WAKE_TIMEOUT_SEC: '1' })
  const slow = makeEngine(cfg)
  const slowApp = buildServer(slow, cfg)
  const { project } = await slow.createProject('demo')
  await slow.deploy(project.id, 'main', { image: 'app:1', port: 3000, group: 'web' })
  const container = 'io-demo-main-app-web'
  await slow.lifecycle(project.id, 'cp-web', 'stop')

  let release!: () => void
  const gate = new Promise<void>((r) => { release = () => { r() } })
  const realStart = runtime.start.bind(runtime)
  const started = vi.spyOn(runtime, 'start').mockImplementation(async (c: string) => { await gate; await realStart(c) })
  // The adapter's start is the hint; the scheduler's is the one that hangs.
  const adapterStart = vi.spyOn(compute, 'start').mockResolvedValue(undefined)
  try {
    const starting = slowApp.inject({ method: 'POST', url: `/projects/${project.id}/services/cp-web/start` })
    // Well past the bound this call would have had.
    await new Promise((r) => setTimeout(r, 1200))

    // The key is still held, so nothing else can touch this service.
    let stopped = false
    const stopping = slowApp.inject({ method: 'POST', url: `/projects/${project.id}/services/cp-web/stop` }).then((r) => { stopped = true; return r })
    await settle()
    expect(stopped).toBe(false)

    release()
    expect((await starting).statusCode).toBe(200)
    expect((await stopping).statusCode).toBe(200)
    // ...and the two ran in order, so the end state is one thing and not two: the intent and the
    // container agree.
    expect((await slowApp.inject({ method: 'GET', url: `/projects/${project.id}/services/cp-web/state` })).json())
      .toMatchObject({ desiredState: 'stopped' })
    expect(runtime.stateOfContainer(container)).toBe('exited')
  } finally {
    started.mockRestore()
    adapterStart.mockRestore()
  }
})

test('a stop the runtime refuses is not reported as a stop', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  const container = 'io-demo-main-app-default'
  const stop = vi.spyOn(compute, 'stop').mockRejectedValueOnce(new Error('container is in use'))
  try {
    const r = await post(`/projects/${id}/services/cp-default/stop`)
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toContain('could not stop default')
  } finally {
    stop.mockRestore()
  }
  // The row keeps the previous intent...
  expect((await get(`/projects/${id}/services/cp-default/state`)).json().desiredState).toBe('running')
  // ...and the scheduler was not told a stop happened: the container is still running, and it
  // still reads that way through the ONE fake container store.
  expect(runtime.stateOfContainer(container)).toBe('running')
  expect(engine.stateOf(`${await branchOf(id)}:cp-default`)).toBe('running')
})

test('a suspend the runtime refuses is not reported as a suspend', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  const suspend = vi.spyOn(compute, 'suspend').mockRejectedValueOnce(new Error('cannot pause'))
  try {
    const r = await post(`/projects/${id}/services/cp-default/suspend`)
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toContain('could not suspend default')
  } finally {
    suspend.mockRestore()
  }
  expect((await get(`/projects/${id}/services/cp-default/state`)).json().desiredState).toBe('running')
  expect(runtime.stateOfContainer('io-demo-main-app-default')).toBe('running')
  expect(engine.stateOf(`${await branchOf(id)}:cp-default`)).toBe('running')
})

test('a redeploy that cannot re-assert the standing intent says so instead of claiming it', async () => {
  // The comment on that re-assert calls it the guarantee that the row does not lie. It swallowed
  // its own failure, and `afterDeploy` then told the scheduler `onPaused` for a container that
  // had just been started and never paused.
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  expect((await post(`/projects/${id}/services/cp-default/suspend`)).statusCode).toBe(200)
  const suspend = vi.spyOn(compute, 'suspend').mockRejectedValueOnce(new Error('cannot pause'))
  let r
  try {
    r = await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'main', port: 3000 })
  } finally {
    suspend.mockRestore()
  }
  expect(r.statusCode).toBe(409)
  expect(r.json().error).toContain('RUNNING against a suspended intent')
  // The deploy DID happen, so the row keeps the new image and the standing intent...
  const app = loadState().branches[await branchOf(id)].apps.default
  expect(app.image).toBe('app:2')
  expect(app.desiredState).toBe('suspended')
  // ...and what the scheduler was told is what is true: the replacement is up, not paused.
  expect(runtime.stateOfContainer('io-demo-main-app-default')).toBe('running')
  expect(engine.stateOf(`${await branchOf(id)}:cp-default`)).toBe('running')
})

// A deploy must not clear the standing lifecycle intent: `stop` then a redeploy leaves the service
// stopped on the platform, and restart makes the window reachable from an operation that just
// checked that intent. The container has to honour it too — a preserved intent the container
// contradicts is a row that lies, which is worse than the clobber it replaced.
test('a redeploy preserves desired lifecycle intent AND the container honours it', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await post(`/projects/${id}/services/cp-default/stop`)
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'main', port: 3000 })
  expect((await get(`/projects/${id}/services/cp-default/state`)).json().desiredState).toBe('stopped')
  expect(calls).toContain('compute.stop:demo-main:default')   // the new container did not stay up
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(true)
})

// The re-assert reads the intent that is current when it runs, not a snapshot from before the
// container work. A `start` landing mid-deploy must win — otherwise the deploy stops the
// replacement and the row is left saying `running` for a stopped container, the same class of lie
// as clobbering the intent, just in the other direction.
// Driven through the Engine, not HTTP: both entry points register on the per-app chain
// synchronously before returning, so calling them in order pins the interleaving. Through
// `app.inject` the routing hops decide which handler reaches the chain first, and the race this
// guards becomes unpinnable.
test('a lifecycle change landing mid-deploy is neither lost nor undone', async () => {
  const engine = new Engine(db, compute, storage, managed)
  const { project } = await engine.createProject('demo')
  const id = project.id
  await engine.deploy(id, 'main', { image: 'app:1', port: 3000, group: 'default' })
  await engine.lifecycle(id, 'cp-default', 'stop')

  // Hold the adapter inside compute.deploy, so `start` is issued while the redeploy is in flight.
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  const realDeploy = compute.deploy
  compute.deploy = async (ref, o) => { await held; return realDeploy(ref, o) }
  calls.length = 0
  try {
    const deploying = engine.deploy(id, 'main', { image: 'app:2', port: 3000, group: 'default' })
    const starting = engine.lifecycle(id, 'cp-default', 'start')
    release()
    await deploying; await starting
  } finally { compute.deploy = realDeploy }   // a rejection must not leak the override into later tests

  // They did not interleave: the start waited for the redeploy instead of landing inside it.
  // Unserialized, the start runs while compute.deploy is held — i.e. before the deploy is recorded.
  expect(calls.indexOf('compute.start:demo-main:default'))
    .toBeGreaterThan(calls.findIndex((c) => c.startsWith('deploy:demo-main:default:app:2')))
  // ...and the later intent stands, with the container agreeing: `start` is last, no stop after it.
  expect(await engine.serviceState(id, 'cp-default')).toMatchObject({ desiredState: 'running' })
  expect(calls.lastIndexOf('compute.start:demo-main:default')).toBeGreaterThan(calls.lastIndexOf('compute.stop:demo-main:default'))
})

// A restart re-runs what the service runs NOW. Snapshotting the image before joining the queue
// would make a restart issued behind a deploy re-run the older image and silently roll it back.
test('a restart queued behind a deploy re-runs the NEW image, not a pre-queue snapshot', async () => {
  const engine = new Engine(db, compute, storage, managed)
  const { project } = await engine.createProject('demo')
  const id = project.id
  await engine.deploy(id, 'main', { image: 'app:1', port: 3000, group: 'default' })

  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  const realDeploy = compute.deploy
  compute.deploy = async (ref, o) => { await held; return realDeploy(ref, o) }
  calls.length = 0
  try {
    const deploying = engine.deploy(id, 'main', { image: 'app:2', port: 3000, group: 'default' })
    const restarting = engine.restart(id, 'cp-default')   // queued behind it, snapshot would say app:1
    release()
    await deploying; await restarting
  } finally { compute.deploy = realDeploy }

  const deploys = calls.filter((c) => c.startsWith('deploy:demo-main:default:'))
  expect(deploys.length).toBe(2)
  expect(deploys.every((c) => c.startsWith('deploy:demo-main:default:app:2'))).toBe(true)
})

// Every entry point on the chain has to read the branch INSIDE it. `lifecycle` was the one that
// still didn't: a stop queued behind a service's first deploy saw a branch with no app record yet
// and silently did nothing — no adapter call, no state write, and a 200 saying it had.
test('a stop queued behind the first deploy is not silently dropped', async () => {
  const engine = new Engine(db, compute, storage, managed)
  const { project } = await engine.createProject('demo')
  const id = project.id
  // Register the group without deploying it: the app record — the thing the stale snapshot lacked —
  // only appears on the first deploy. Set up over HTTP; it shares the same state file.
  await post(`/projects/${id}/services`, { type: 'compute', name: 'default' })

  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  const realDeploy = compute.deploy
  compute.deploy = async (ref, o) => { await held; return realDeploy(ref, o) }
  calls.length = 0
  try {
    const deploying = engine.deploy(id, 'main', { image: 'app:1', port: 3000, group: 'default' })
    const stopping = engine.lifecycle(id, 'cp-default', 'stop')   // queued: no app record exists yet
    release()
    await deploying; await stopping
  } finally { compute.deploy = realDeploy }

  expect(calls).toContain('compute.stop:demo-main:default')
  expect((await engine.serviceState(id, 'cp-default')).desiredState).toBe('stopped')
})

// STOPPED gets start:false; SUSPENDED must not. Suspend is `docker pause`, and a container created
// but never started cannot be paused — the pause fails, the container stays `created`, and state()
// reports `stopped`, contradicting the intent the re-assert just preserved.
test('only a stopped service skips starting its replacement; a suspended one must start', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await post(`/projects/${id}/services/cp-default/stop`)
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'main', port: 3000 })
  expect(calls).toContain('deploy.nostart:demo-main:default')

  await post(`/projects/${id}/services/cp-default/suspend`)
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'app:3', branch: 'main', port: 3000 })
  expect(calls).not.toContain('deploy.nostart:demo-main:default')   // it has to run before it can pause
  expect(calls).toContain('compute.suspend:demo-main:default')
})

// The exact verb, not a coarser one: oss allows a suspended volume-bearing service, so a redeploy
// of a SUSPENDED service must land back on suspend rather than being rewritten to stop.
test('a redeploy of a suspended service re-suspends rather than stopping it', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await post(`/projects/${id}/services/cp-default/suspend`)
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'main', port: 3000 })
  expect((await get(`/projects/${id}/services/cp-default/state`)).json().desiredState).toBe('suspended')
  expect(calls).toContain('compute.suspend:demo-main:default')
  expect(calls).not.toContain('compute.stop:demo-main:default')
})

// Restart reaches engine.deploy(), which re-mints DATABASE_URL, the S3 bundle and every bound
// secret into a new container — so it stands behind the same policy as `POST /deploy`, exactly as
// the platform gates it. An ungated door here would mean a `deploy: deny` an operator set is
// simply not on.
test('compute restart is gated on `deploy`, like every other door that redeploys', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await put(`/projects/${id}/policy/deploy`, { decision: 'deny' })
  calls.length = 0
  const denied = await post(`/projects/${id}/services/cp-default/restart`)
  expect(denied.statusCode).toBe(403)
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(false)

  await put(`/projects/${id}/policy/deploy`, { decision: 'approve' })
  const relayed = await post(`/projects/${id}/services/cp-default/restart`)
  expect(relayed.statusCode).toBe(202)
  expect(relayed.json().approvalId).toBeTruthy()
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(false)

  // ...and stop/start stay ungated under the same policy, so a wedged container is still cyclable.
  expect((await post(`/projects/${id}/services/cp-default/stop`)).statusCode).toBe(200)
  expect((await post(`/projects/${id}/services/cp-default/start`)).statusCode).toBe(200)
})

test('storage access mode flips public/private; scale/upgrade stay clean 501s', async () => {
  const id = await createProject()
  const r = await put(`/projects/${id}/services/st-store/access`, { public: true })
  expect(r.statusCode).toBe(200)
  expect(r.json().service).toMatchObject({ id: 'st-store', public: true })
  expect(calls).toContain('st.access:io-demo-main-store:true')
  expect((await get(`/projects/${id}/services`)).json().services.find((s: { id: string }) => s.id === 'st-store').public).toBe(true)
  expect((await put(`/projects/${id}/services/pg-db/access`, { public: true })).statusCode).toBe(400)
  expect((await put(`/projects/${id}/services/st-store/access`, {})).statusCode).toBe(400)
  expect((await post(`/projects/${id}/services/cp-x/scale`, { machineCount: 2 })).statusCode).toBe(501)
  expect((await post(`/projects/${id}/services/cp-x/upgrade`, { spec: '2vcpu-2gb' })).statusCode).toBe(501)
})

// ---- observability: logs, metrics, operations, database ----

test('logs endpoint tails containers with the cloud LogsResult shape (db works locally too)', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  vi.mocked(dockerFn).mockImplementation(async (args: string[]) =>
    Buffer.from(args[0] === 'logs' ? '2026-07-22T01:00:00.000Z hello\nno-timestamp-line\n' : ''))
  const r = (await get(`/projects/${id}/logs?component=compute&branch=main&limit=50`)).json()
  expect(r.source).toBe('docker-logs')
  expect(r.lines.find((l: { ts: string }) => l.ts)).toMatchObject({ ts: '2026-07-22T01:00:00.000Z', message: 'hello', instance: 'io-demo-main-app-default' })
  expect(r.lines.find((l: { ts: string }) => !l.ts)).toMatchObject({ message: 'no-timestamp-line' })
  const dbLogs = (await get(`/projects/${id}/logs?component=db`)).json()
  expect(dbLogs.lines.length).toBeGreaterThan(0) // the cloud returns a provider note for db; locally it is a real container
  vi.mocked(dockerFn).mockImplementation(fakeDocker)
})

// runtimeLogs reads every container in the component, merges, sorts, and only THEN slices to the
// limit. So a noisy neighbour can fill the whole window and a quiet service reads as having no
// logs at all. The dashboard used to fetch the component stream and filter in the browser, which
// is exactly this trap; `group` narrows at the source instead.
test('group keeps a quiet service readable when a noisy sibling would fill the whole limit', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'quiet' })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'noisy' })

  vi.mocked(dockerFn).mockImplementation(async (args: string[]) => {
    if (args[0] !== 'logs') return Buffer.from('')
    const container = args[args.length - 1]
    // The noisy one is both LOUDER and NEWER, so the merged tail is entirely its own.
    if (container.endsWith('-app-noisy')) {
      return Buffer.from(
        Array.from({ length: 50 }, (_, i) => `2026-07-22T02:00:${String(i).padStart(2, '0')}.000Z noise ${i}`).join('\n') + '\n')
    }
    return Buffer.from('2026-07-22T01:00:00.000Z quiet line\n')
  })

  // Unfiltered, at a limit the noisy service alone exceeds, the quiet line is gone.
  const merged = (await get(`/projects/${id}/logs?component=compute&branch=main&limit=10`)).json()
  expect(merged.lines.some((l: { message: string }) => l.message === 'quiet line')).toBe(false)

  // Asked for by group, it survives: the truncation happens after picking the container.
  const scoped = (await get(`/projects/${id}/logs?component=compute&branch=main&limit=10&group=quiet`)).json()
  expect(scoped.lines.some((l: { message: string }) => l.message === 'quiet line')).toBe(true)
  expect(scoped.lines.some((l: { message: string }) => l.message.startsWith('noise'))).toBe(false)

  vi.mocked(dockerFn).mockImplementation(fakeDocker)
})

// The `db` arm of `?group=` is the one the dashboard's change was ABOUT — a postgres service named
// `pg` is indistinguishable from the branch's default database by container label, which is why the
// client-side name filter was deleted. Every other component's group arm is covered; this one was
// only ever exercised WITHOUT a group, so the arm the UI now depends on was untested.
test('group picks one postgres service out of several, for logs and for metrics', async () => {
  const id = await createProject()
  expect((await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics' })).statusCode).toBe(201)

  const seen: string[][] = []
  vi.mocked(dockerFn).mockImplementation(async (args: string[]) => {
    seen.push(args)
    if (args[0] === 'logs') return Buffer.from(`2026-07-22T01:00:00.000Z from ${args[args.length - 1]}\n`)
    if (args[0] === 'stats') {
      const names = args.filter((a) => a.startsWith('io-'))
      return Buffer.from(names.map((n) => `{"Name":"${n}","CPUPerc":"1.00%","MemUsage":"10MiB / 4GiB"}`).join('\n') + '\n')
    }
    return Buffer.from('')
  })

  // Unscoped, both database containers are read.
  const all = (await get(`/projects/${id}/logs?component=db&branch=main&limit=50`)).json()
  const allInstances = new Set(all.lines.map((l: { instance: string }) => l.instance))
  expect(allInstances.size).toBeGreaterThan(1)

  // Scoped, exactly the named one.
  const scoped = (await get(`/projects/${id}/logs?component=db&branch=main&limit=50&group=analytics`)).json()
  const scopedInstances = [...new Set(scoped.lines.map((l: { instance: string }) => l.instance))] as string[]
  expect(scopedInstances).toHaveLength(1)
  expect(scopedInstances[0]).toContain('analytics')

  // And the same narrowing reaches `docker stats`, not just the log tail.
  seen.length = 0
  const m = (await get(`/projects/${id}/metrics?component=db&branch=main&group=analytics`)).json()
  const statsArgs = seen.find((a) => a[0] === 'stats') ?? []
  expect(statsArgs.filter((a) => a.startsWith('io-'))).toHaveLength(1)
  expect(m.series.every((s: { labels?: { instance?: string } }) => s.labels?.instance?.includes('analytics'))).toBe(true)

  vi.mocked(dockerFn).mockImplementation(fakeDocker)
})

// A wake that could not finish answers the router lane's codes, not 400: 504 when it timed out, 503 otherwise, so a
// client can tell "coming up, retry" from "do not retry".
test('POST /services/:sid/wake answers 504 for a wake that timed out and 503 for one that could not finish', async () => {
  const id = await createProject()
  const services = (await get(`/projects/${id}/services?branch=main`)).json().services as Array<{ id: string; type: string }>
  const pg = services.find((s) => s.type === 'postgres')!
  const wake = vi.spyOn(engine, 'wake')
  try {
    wake.mockRejectedValueOnce(new Error('this request timed out after 60 s waiting for the service to wake'))
    const timedOut = await post(`/projects/${id}/services/${pg.id}/wake?branch=main`, {})
    expect(timedOut.statusCode).toBe(504)
    expect(timedOut.json().error).toMatch(/timed out/)

    wake.mockRejectedValueOnce(new Error('could not make room to wake the service'))
    const noRoom = await post(`/projects/${id}/services/${pg.id}/wake?branch=main`, {})
    expect(noRoom.statusCode).toBe(503)

    // Resolution errors keep their codes: a branch that does not exist is still 404, and never reaches the wake.
    const calls = wake.mock.calls.length
    expect((await post(`/projects/${id}/services/${pg.id}/wake?branch=nope`, {})).statusCode).toBe(404)
    expect(wake.mock.calls.length).toBe(calls)
  } finally {
    wake.mockRestore()
  }
})

// The Database tab's Wake and browse. A dashboard read never wakes a database, so the tab asks for the wake: through
// the scheduler's api door, on the key the scheduler knows the service by. Something with nothing to schedule is 404.
test('POST /services/:sid/wake wakes a sleeping database through the api door, 404s what has nothing to wake, and refuses compute', async () => {
  const id = await createProject()
  const services = (await get(`/projects/${id}/services?branch=main`)).json().services as Array<{ id: string; type: string }>
  const pg = services.find((s) => s.type === 'postgres')!
  const storage = services.find((s) => s.type === 'storage')!
  const target = engine.serviceTargets().find((t) => t.serviceId === pg.id)
  expect(target).toBeDefined()
  const wake = vi.spyOn(engine, 'wake').mockResolvedValue(undefined)
  try {
    const res = await post(`/projects/${id}/services/${pg.id}/wake?branch=main`, {})
    expect(res.statusCode).toBe(200)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(target!.key, { door: 'api' })

    const none = await post(`/projects/${id}/services/${storage.id}/wake?branch=main`, {})
    expect(none.statusCode).toBe(404)
    expect((await post('/projects/nope/services/pg-db/wake', {})).statusCode).toBe(404)
    expect(wake).toHaveBeenCalledTimes(1)

    // Compute is refused: the api door would wake a durably STOPPED app without clearing its stop intent. `start` does.
    await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
    const app = ((await get(`/projects/${id}/services?branch=main`)).json().services as Array<{ id: string; type: string }>)
      .find((s) => s.type === 'compute')!
    expect(engine.serviceTargets().some((t) => t.serviceId === app.id)).toBe(true)
    const compute = await post(`/projects/${id}/services/${app.id}/wake?branch=main`, {})
    expect(compute.statusCode).toBe(400)
    expect(compute.json().error).toMatch(/start/)
    expect(wake).toHaveBeenCalledTimes(1)
  } finally {
    wake.mockRestore()
  }
})

// A service's Metrics tab asks with `group`. With nothing deployed for it, the note used to say "nothing deployed on
// this branch" even while the branch ran a database, which the tab then showed as its reason.
test('metrics with nothing to measure name the service when asked for one, and the branch when not', async () => {
  const id = await createProject()
  const scoped = (await get(`/projects/${id}/metrics?component=compute&branch=main&group=web`)).json()
  expect(scoped.series).toEqual([])
  expect(scoped.note).toBe('nothing deployed for this service')
  const branch = (await get(`/projects/${id}/metrics?component=compute&branch=main`)).json()
  expect(branch.note).toBe('nothing deployed on this branch')
})

test('metrics endpoint answers in the cloud series names (cpu_cores in vCPU, memory_used_bytes), labelled by service', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  vi.mocked(dockerFn).mockImplementation(async (args: string[]) =>
    Buffer.from(args[0] === 'stats' ? '{"Name":"io-demo-main-app-default","CPUPerc":"1.25%","MemUsage":"12MiB / 4GiB","NetIO":"1kB / 2kB"}\n' : ''))
  // Nothing sampled yet (the sampler is main.ts's), so this is the one live reading.
  const r = (await get(`/projects/${id}/metrics?component=compute&branch=main`)).json()
  expect(r.source).toBe('docker-stats')
  expect(r.note).toBeUndefined()
  const cpu = r.series.find((s: { name: string }) => s.name === 'cpu_cores')
  expect(cpu.unit).toBe('vCPU')
  expect(cpu.labels.group).toBe('default')
  expect(cpu.points[0][1]).toBe(0.0125)
  expect(r.series.find((s: { name: string }) => s.name === 'memory_used_bytes').points[0][1]).toBe(12 * 1024 * 1024)
  vi.mocked(dockerFn).mockImplementation(fakeDocker)
})

test('metrics endpoint rejects a window that is not unix seconds and a step', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  for (const q of ['step=fast', 'from=yesterday', 'from=200&to=100']) {
    const res = await get(`/projects/${id}/metrics?component=compute&branch=main&${q}`)
    expect(res.statusCode).toBe(400)
  }
})

// Fastify parses a repeated key into an array; that is malformed input and a 400, not a 500 from
// calling string methods on it.
test('metrics endpoint answers a repeated window parameter with 400, not 500', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  for (const q of ['step=60s&step=5m', 'from=100&from=200', 'to=100&to=200']) {
    const res = await get(`/projects/${id}/metrics?component=compute&branch=main&${q}`)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/once/)
  }
})

test('operations lists the resource timeline newest-first (control-plane shape)', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  const { operations } = (await get(`/projects/${id}/operations?limit=10`)).json()
  expect(operations[0]).toMatchObject({ action: 'deploy', status: 'finished' })
  expect(operations.map((o: { action: string }) => o.action)).toContain('project.created')
})

test('database metrics/activity/query-stats run SQL with the cloud shapes', async () => {
  const id = await createProject()
  const m = (await get(`/projects/${id}/database/metrics`)).json()
  expect(m).toMatchObject({ connections: { active: 1, idle: 2, total: 3, max: 100 }, dbSizeBytes: 123456 })
  expect(m.cacheHitRatio).toBeCloseTo(0.9)
  const a = (await get(`/projects/${id}/database/activity`)).json()
  expect(a.queries[0]).toMatchObject({ pid: 42, state: 'active' })
  const qs = (await get(`/projects/${id}/database/query-stats?sort=calls&limit=5`)).json()
  expect(qs).toMatchObject({ extensionReady: true })
  expect(qs.stats[0]).toMatchObject({ queryId: 'q1', calls: 3 })
  expect((await get('/projects/nope/database/metrics')).statusCode).toBe(404)
})

test('service rename: re-keys group, containers, bindings; conflicts 409; postgres moves its container', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  await put(`/projects/${id}/secrets/API_KEY`, { value: 'v', branch: 'main', service: 'compute/api' })
  const r = await post(`/projects/${id}/services/cp-api/rename`, { name: 'gateway' })
  expect(r.statusCode).toBe(200)
  expect(r.json().service).toMatchObject({ id: 'cp-gateway', type: 'compute', name: 'gateway' })
  expect(calls).toContain('compute.rename:demo-main:api->gateway')
  const { services } = (await get(`/projects/${id}/services`)).json()
  expect(services.map((s: { name: string }) => s.name)).toContain('gateway')
  expect(services.map((s: { name: string }) => s.name)).not.toContain('api')
  // the secret binding followed the rename
  const tree = (await get(`/projects/${id}/secrets/tree`)).json()
  expect(tree.branches[0].services.find((s: { name: string }) => s.name === 'gateway').secrets).toEqual(['API_KEY'])
  // conflicts, validation, fixed pair, unknown service
  await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })
  expect((await post(`/projects/${id}/services/cp-worker/rename`, { name: 'gateway' })).statusCode).toBe(409)
  expect((await post(`/projects/${id}/services/cp-gateway/rename`, { name: 'Bad_Name' })).statusCode).toBe(400)
  // postgres renames for real now: the container and the minted hostname move, the data
  // directory keeps its immutable id (decision 16).
  const pgRename = await post(`/projects/${id}/services/pg-db/rename`, { name: 'primary' })
  expect(pgRename.statusCode).toBe(200)
  expect(pgRename.json().service).toMatchObject({ id: 'pg-primary', type: 'postgres', name: 'primary' })
  expect(calls).toContain('db.rename:io-demo-main-pg-db->io-demo-main-pg-primary')
  expect((await post(`/projects/${id}/services/cp-nope/rename`, { name: 'x' })).statusCode).toBe(404)
})

// ---- volumes + database settings (tier-caps contract parity, platform #166–169) ----

test('compute volume: attach at create, mounted at /data on deploy, GET/PUT mirror the cloud shapes', async () => {
  const id = await createProject()
  const r = await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 5 })
  expect(r.statusCode).toBe(201)
  expect(r.json().service).toMatchObject({ id: 'cp-api', type: 'compute', name: 'api', volume_gib: 5 })

  // services list carries the platform Service.volume_gib field (null when no volume)
  await post(`/projects/${id}/services`, { type: 'compute', name: 'plain' })
  const { services } = (await get(`/projects/${id}/services`)).json()
  expect(services.find((s: { id: string }) => s.id === 'cp-api').volume_gib).toBe(5)
  expect(services.find((s: { id: string }) => s.id === 'cp-plain').volume_gib).toBeNull()

  // deploy bind-mounts the branch's own directory under the data dir at /data (WP4, decision 56)
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  expect(calls.some((c) => /^deploy\.volume:demo-main:api:\/.+\/vol\/demo-main\/[0-9a-f]{8}$/.test(c))).toBe(true)

  // GET …/volume: {volume:{sizeGib,mountPath}|null, cap:{volumeGib}}
  expect((await get(`/projects/${id}/services/cp-api/volume`)).json())
    .toEqual({ volume: { sizeGib: 5, mountPath: '/data' }, cap: { volumeGib: 100 } })
  expect((await get(`/projects/${id}/services/cp-plain/volume`)).json())
    .toEqual({ volume: null, cap: { volumeGib: 100 } })

  // PUT …/volume grows (advisory locally); response = {service, volume, cap}
  const grow = await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 7 })
  expect(grow.statusCode).toBe(200)
  expect(grow.json()).toMatchObject({
    service: { id: 'cp-api', volume_gib: 7 },
    volume: { sizeGib: 7, mountPath: '/data' },
    cap: { volumeGib: 100 },
  })
  // no-op re-submit succeeds (a settings form saved unmoved must not fail)
  expect((await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 7 })).statusCode).toBe(200)
})

test('compute volume rules: grow-only 400, cap + validation, compute-only', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 5 })
  const shrink = await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 3 })
  expect(shrink.statusCode).toBe(400)
  expect(shrink.json().error).toMatch(/can only grow/)
  expect((await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 101 })).statusCode).toBe(400) // over cap
  expect((await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 1.5 })).statusCode).toBe(400) // whole Gi only
  expect((await put(`/projects/${id}/services/cp-api/volume`, {})).statusCode).toBe(400)
  expect((await put(`/projects/${id}/services/pg-db/volume`, { sizeGib: 20 })).statusCode).toBe(400) // compute only
  expect((await get(`/projects/${id}/services/pg-db/volume`)).statusCode).toBe(400)
  expect((await get(`/projects/${id}/services/cp-nope/volume`)).statusCode).toBe(404)
  expect((await get(`/projects/nope/services/cp-api/volume`)).statusCode).toBe(404)
  // create-time validation
  expect((await post(`/projects/${id}/services`, { type: 'compute', name: 'v2', volumeGib: 0 })).statusCode).toBe(400)
  expect((await post(`/projects/${id}/services`, { type: 'compute', name: 'v2', volumeGib: 101 })).statusCode).toBe(400)
})

test('attach-after-create (platform #185 parity): PUT on a volumeless service attaches, attached:true, next deploy mounts', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'later' })
  expect((await get(`/projects/${id}/services/cp-later/volume`)).json().volume).toBeNull()
  const attach = await put(`/projects/${id}/services/cp-later/volume`, { sizeGib: 2 })
  expect(attach.statusCode).toBe(200)
  expect(attach.json()).toMatchObject({ attached: true, volume: { sizeGib: 2, mountPath: '/data' } })
  // attach validates like create: cap + whole-Gi still apply to a FIRST size
  await post(`/projects/${id}/services`, { type: 'compute', name: 'later2' })
  expect((await put(`/projects/${id}/services/cp-later2/volume`, { sizeGib: 101 })).statusCode).toBe(400)
  // the disk materializes on the next deploy — mounted by volume id, cloud-identical flow
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'later' })
  expect(calls.some((c) => /^deploy\.volume:demo-main:later:\/.+\/vol\/demo-main\/[0-9a-f]{8}$/.test(c))).toBe(true)
  // from here it is an ordinary volume: a grow is a grow, not another attach
  const grow = await put(`/projects/${id}/services/cp-later/volume`, { sizeGib: 3 })
  expect(grow.statusCode).toBe(200)
  expect(grow.json().attached).toBeUndefined()
})

test('volume delete (cloud 2026-08-08 contract): eager rebuild without the mount, read-back null, re-attach = new attach', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 5 })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  calls.length = 0
  // All three verbs on this resource take the qualified id and strip it (contract section 10 names
  // `volume` in that family). Detaching is project-wide by design, so the qualifier is redundant
  // rather than a scoping request: what matters is that DELETE accepts the SAME id GET and PUT do,
  // because that is the only form `GET /services?branch=` hands a caller off the default branch and
  // decision 49 declares it opaque, so there is no bare id for such a client to fall back to.
  const branchId = (await get(`/projects/${id}/branches`)).json().branches[0].id as string
  expect((await get(`/projects/${id}/services/${branchId}:cp-api/volume`)).statusCode).toBe(200)
  expect((await put(`/projects/${id}/services/${branchId}:cp-api/volume`, { sizeGib: 10 })).statusCode).toBe(200)

  // A qualified id is resolved, not merely stripped: a stale or foreign branch id must 404 rather
  // than have its qualifier discarded and the detach proceed on a project the caller never named.
  const gone = '00000000-0000-4000-8000-000000000000'
  const foreign = await del_(`/projects/${id}/services/${gone}:cp-api/volume`)
  expect(foreign.statusCode).toBe(404)
  // All three verbs on this resource resolve the qualifier, not just DELETE. A stale one used to
  // read back a 200 and, worse, WRITE the project-level record and answer 200, which is a silent
  // successful write against a branch that no longer exists.
  expect((await get(`/projects/${id}/services/${gone}:cp-api/volume`)).statusCode).toBe(404)
  expect((await put(`/projects/${id}/services/${gone}:cp-api/volume`, { sizeGib: 99 })).statusCode).toBe(404)
  expect((await post(`/projects/${id}/services/${gone}:cp-api/rename`, { name: 'nope' })).statusCode).toBe(404)
  const stillThere = (await get(`/projects/${id}/services/cp-api/volume`)).json().volume
  expect(stillThere).not.toBeNull()
  expect(stillThere.sizeGib).toBe(10)

  const del = await del_(`/projects/${id}/services/${branchId}:cp-api/volume`)
  expect(del.statusCode).toBe(200)
  expect(del.json()).toMatchObject({ removed: true, volume: null, service: { volume_gib: null } })
  // EAGER: the deployed branch was rebuilt WITHOUT the mount right away — no deploy.volume call.
  expect(calls.some((c) => c.startsWith('deploy:demo-main:api'))).toBe(true)
  expect(calls.some((c) => c.startsWith('deploy.volume:'))).toBe(false)
  expect((await get(`/projects/${id}/services/cp-api/volume`)).json().volume).toBeNull()
  // double delete = the cloud's 404, not a silent no-op
  const again = await del_(`/projects/${id}/services/cp-api/volume`)
  expect(again.statusCode).toBe(404)
  expect(again.json().error).toMatch(/no volume/)
  // the door is reopened: re-attach works as an ordinary NEW attach
  expect((await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 1 })).json()).toMatchObject({ attached: true })
})

test('volume delete sweeps EVERY deployed branch: both rebuilt without the mount, both volumes cleaned', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 2 })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' }) // branch inherits the deployed app
  calls.length = 0
  expect((await del_(`/projects/${id}/services/cp-api/volume`)).statusCode).toBe(200)
  // The per-branch loop hit BOTH branches, and neither rebuild carried the mount.
  expect(calls.some((c) => c.startsWith('deploy:demo-main:api'))).toBe(true)
  expect(calls.some((c) => c.startsWith('deploy:demo-feat:api'))).toBe(true)
  expect(calls.some((c) => c.startsWith('deploy.volume:'))).toBe(false)
  expect((await get(`/projects/${id}/services/cp-api/volume`)).json().volume).toBeNull()
})

test('volume delete preserves lifecycle intent EXACTLY: suspended stays suspended, stopped stays stopped', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 2 })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  // Suspended service (allowed with a volume here, unlike the cloud) — delete must land back on
  // 'suspend', not rewrite desiredState to 'stopped' (r2d2 finding).
  await post(`/projects/${id}/services/cp-api/suspend`)
  expect((await del_(`/projects/${id}/services/cp-api/volume`)).statusCode).toBe(200)
  // desiredState is the recorded intent (the fake adapter's live state is a constant), and intent
  // is exactly what the regression lost.
  expect((await get(`/projects/${id}/services/cp-api/state`)).json()).toMatchObject({ desiredState: 'suspended' })
  expect(calls.some((c) => c.startsWith('compute.suspend:demo-main:api'))).toBe(true)
  // And the stopped case stays stopped.
  expect((await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 1 })).statusCode).toBe(200)
  await post(`/projects/${id}/services/cp-api/stop`)
  expect((await del_(`/projects/${id}/services/cp-api/volume`)).statusCode).toBe(200)
  expect((await get(`/projects/${id}/services/cp-api/state`)).json()).toMatchObject({ desiredState: 'stopped' })
})

test('compute volume survives a service rename (record follows, docker volume name is id-keyed)', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 5 })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  const volName = calls.find((c) => c.startsWith('deploy.volume:'))!.split(':')[3]
  await post(`/projects/${id}/services/cp-api/rename`, { name: 'gateway' })
  expect((await get(`/projects/${id}/services/cp-gateway/volume`)).json().volume).toEqual({ sizeGib: 5, mountPath: '/data' })
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'main', port: 3000, group: 'gateway' })
  expect(calls).toContain(`deploy.volume:demo-main:gateway:${volName}`) // same volume, data kept
})

test('an adapter without volume support rejects volume-carrying services with a clear error', async () => {
  const noVol: ComputeAdapter = { deploy: async () => ({ url: 'http://x' }), destroy: async () => {} }
  const local = buildServer(new Engine(db, noVol, storage, managed))
  const lpost = (url: string, payload?: unknown) => local.inject({ method: 'POST', url, payload })
  const id = (await lpost('/orgs/local/projects', { name: 'novol' })).json().project.id
  const r = await lpost(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 5 })
  expect(r.statusCode).toBe(400)
  expect(r.json().error).toMatch(/not supported by this compute adapter/)
  expect((await lpost(`/projects/${id}/services`, { type: 'compute', name: 'api' })).statusCode).toBe(201) // no volume: fine
})

test('database instance read + settings PATCH: volumeSize parity (grow-only, advisory locally)', async () => {
  const id = await createProject()
  const info = (await get(`/projects/${id}/database/instance`)).json()
  expect(info).toMatchObject({ name: 'db', volumeSize: '10Gi', volumeGib: 10, cap: { volumeGib: 100 } })
  expect(info.storageSize).toBe('10Gi') // deprecated alias still mirrored, like the platform

  const up = await patch(`/projects/${id}/database/settings`, { volumeSize: '20Gi' })
  expect(up.statusCode).toBe(200)
  expect(up.json()).toMatchObject({ volumeSize: '20Gi', volumeGib: 20 })
  expect((await get(`/projects/${id}/database/instance`)).json().volumeGib).toBe(20)

  // grow-only + whole-Gi validation + cap; no-op re-submit succeeds
  expect((await patch(`/projects/${id}/database/settings`, { volumeSize: '20Gi' })).statusCode).toBe(200)
  const shrink = await patch(`/projects/${id}/database/settings`, { volumeSize: '5Gi' })
  expect(shrink.statusCode).toBe(400)
  expect(shrink.json().error).toMatch(/can only grow/)
  expect((await patch(`/projects/${id}/database/settings`, { volumeSize: '5G' })).statusCode).toBe(400)
  expect((await patch(`/projects/${id}/database/settings`, { volumeSize: '500Mi' })).statusCode).toBe(400)
  expect((await patch(`/projects/${id}/database/settings`, { volumeSize: '101Gi' })).statusCode).toBe(400)
  // deprecated alias accepted; unrelated cloud-lever settings are accepted and ignored
  expect((await patch(`/projects/${id}/database/settings`, { storageSize: '30Gi' })).statusCode).toBe(200)
  expect((await patch(`/projects/${id}/database/settings`, { scaleToZero: true, idleTimeout: 60 })).statusCode).toBe(200)
  expect((await patch(`/projects/nope/database/settings`, { volumeSize: '20Gi' })).statusCode).toBe(404)
  expect((await get(`/projects/${id}/database/instance?branch=nope`)).statusCode).toBe(404)
})

test('database volumeSize is per-branch and the setting clones with the branch', async () => {
  const id = await createProject()
  await patch(`/projects/${id}/database/settings`, { volumeSize: '20Gi' })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect((await get(`/projects/${id}/database/instance?branch=feat`)).json().volumeGib).toBe(20) // inherited
  await patch(`/projects/${id}/database/settings?branch=feat`, { volumeSize: '40Gi' })
  expect((await get(`/projects/${id}/database/instance?branch=feat`)).json().volumeGib).toBe(40)
  expect((await get(`/projects/${id}/database/instance`)).json().volumeGib).toBe(20) // main untouched
})

// ---- managed databases: redis | mysql | mongodb (cloud parity, platform #235/#236) ----

test('managed db add: 201 row shape the CLI renders; per-branch container; still 400 on junk types', async () => {
  const id = await createProject()
  const r = await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  expect(r.statusCode).toBe(201)
  expect(r.json().service).toMatchObject({ id: 'rd-cache', type: 'redis', name: 'cache', status: 'ready', port: 6379, volume_gib: 1 })
  expect(calls).toContain('md.provision:io-demo-main-rd-cache')

  const services = (await get(`/projects/${id}/services`)).json().services
  const row = services.find((s: { id: string }) => s.id === 'rd-cache')
  expect(row).toMatchObject({ type: 'redis', port: 6379, volume_gib: 1, domain: 'redis-cache-demo-main.localhost' })
  expect(row.endpoint).toMatch(/^127\.0\.0\.1:2\d{4}$/)

  expect((await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })).statusCode).toBe(409)
  expect((await post(`/projects/${id}/services`, { type: 'kafka', name: 'x' })).statusCode).toBe(400)
})

test('managed db add is gated (service.add): 202 approval flow', async () => {
  const id = await createProject()
  await put(`/projects/${id}/policy/service.add`, { decision: 'approve' })
  const r = await post(`/projects/${id}/services`, { type: 'mysql', name: 'mysql-db' })
  expect(r.statusCode).toBe(202)
  expect(r.json()).toMatchObject({ status: 'approval_required', action: 'service.add' })
})

test('managed db secrets: suffixed bundle + canonical aliases for the oldest per type', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache-two' })
  await post(`/projects/${id}/services`, { type: 'mysql', name: 'mysql-db' })
  const s = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  // suffixed names for every service (envSuffix: kebab -> SNAKE)
  // Host-facing lane form, one string per service across secrets and credentials (contract §10);
  // the service identity is the lane it owns, so no two bundles share an address.
  const credOf = async (sid: string): Promise<Record<string, string>> =>
    (await get(`/projects/${id}/services/${sid}/credentials`)).json().credentials as Record<string, string>
  expect(s.REDIS_URL_CACHE).toMatch(/^redis:\/\/default:.+@127\.0\.0\.1:2\d{4}\/0$/)
  expect(s.REDIS_URL_CACHE).toBe((await credOf('rd-cache')).REDIS_URL)
  expect(s.REDIS_URL_CACHE_TWO).toBe((await credOf('rd-cache-two')).REDIS_URL)
  expect(s.REDIS_URL_CACHE_TWO).not.toBe(s.REDIS_URL_CACHE)
  expect(s.MYSQL_URL_MYSQL_DB).toMatch(/^mysql:\/\/insta:.+@127\.0\.0\.1:2\d{4}\/app$/)
  expect(s.MYSQL_URL_MYSQL_DB).toBe((await credOf('my-mysql-db')).MYSQL_URL)
  // canonical aliases follow the OLDEST service of each type
  expect(s.REDIS_URL).toBe(s.REDIS_URL_CACHE)
  expect(s.REDIS_PASSWORD).toBe(s.REDIS_PASSWORD_CACHE)
  expect(s.MYSQL_URL).toBe(s.MYSQL_URL_MYSQL_DB)
  expect(s.MYSQL_DATABASE).toBe('app')
  // distinct passwords per service
  expect(s.REDIS_PASSWORD_CACHE).not.toBe(s.REDIS_PASSWORD_CACHE_TWO)
  // canonical names are reserved from user secrets
  expect((await put(`/projects/${id}/secrets/REDIS_URL`, { value: 'x' })).statusCode).toBe(400)
  expect((await put(`/projects/${id}/secrets/MONGODB_PASSWORD`, { value: 'x' })).statusCode).toBe(400)
})

test('branch create gives managed dbs a FRESH empty instance + fresh password (no data clone)', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect(calls).toContain('md.provision:io-demo-feat-rd-cache')
  const main = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  const feat = (await get(`/projects/${id}/secrets?branch=feat`)).json().secrets
  // Its own instance means its own lane: the branch bundles never share an address.
  expect(feat.REDIS_URL).toMatch(/^redis:\/\/default:.+@127\.0\.0\.1:2\d{4}\/0$/)
  expect(feat.REDIS_URL).toBe((await get(`/projects/${id}/services/rd-cache/credentials?branch=feat`)).json().credentials.REDIS_URL)
  expect(feat.REDIS_URL).not.toBe(main.REDIS_URL)
  expect(feat.REDIS_PASSWORD).not.toBe(main.REDIS_PASSWORD)
})

test('compute deploys receive the managed-db bundle in env', async () => {
  const seen: Record<string, string>[] = []
  const capture: ComputeAdapter = {
    deploy: async (_ref, o) => { seen.push(o.envVars); return { url: `http://localhost:${o.hostPort}` } },
    destroy: async () => {},
  }
  const local = buildServer(new Engine(db, capture, storage, managed))
  const r = await local.inject({ method: 'POST', url: '/orgs/local/projects', payload: { name: 'demo' } })
  const pid = r.json().project.id
  await local.inject({ method: 'POST', url: `/projects/${pid}/services`, payload: { type: 'mongodb', name: 'mongo-db' } })
  await local.inject({ method: 'POST', url: `/projects/${pid}/services`, payload: { type: 'storage', name: 'store' } })
  await local.inject({ method: 'POST', url: `/projects/${pid}/deploy`, payload: { image: 'app:1', branch: 'main', port: 3000 } })
  // The deploy env is the same host-facing bundle, containerized: 127.0.0.1 becomes the gateway
  // name a container can dial (contract §10, `containerize`).
  expect(seen[0].MONGODB_URL).toMatch(/^mongodb:\/\/root:.+@host\.docker\.internal:2\d{4}\/admin\?authSource=admin$/)
  expect(seen[0].MONGODB_HOST).toBe('host.docker.internal')
  expect(seen[0].MONGODB_URL_MONGO_DB).toBe(seen[0].MONGODB_URL)
  // The object store is the exception the contract names: a container resolves it on the branch
  // network, so the deploy keeps the stored name where the host-facing bundle says 127.0.0.1:3900.
  expect(seen[0].AWS_ENDPOINT_URL_S3).toBe('http://io-garage:3900')
})

test('managed db remove: destroys on every branch, drops rows + secrets; rename re-keys everything', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })

  // rename: adapter renames per branch; id + suffixed names + canonical alias host re-key
  const rn = await post(`/projects/${id}/services/rd-cache/rename`, { name: 'kv' })
  expect(rn.statusCode).toBe(200)
  expect(rn.json().service).toMatchObject({ id: 'rd-kv', name: 'kv', type: 'redis' })
  expect(calls).toContain('md.rename:io-demo-main-rd-cache->io-demo-main-rd-kv')
  expect(calls).toContain('md.rename:io-demo-feat-rd-cache->io-demo-feat-rd-kv')
  const s = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  expect(s.REDIS_URL_KV).toBe((await get(`/projects/${id}/services/rd-kv/credentials`)).json().credentials.REDIS_URL)
  expect(s.REDIS_URL_KV).toMatch(/^redis:\/\/default:.+@127\.0\.0\.1:2\d{4}\/0$/)
  expect(s.REDIS_URL_CACHE).toBeUndefined()
  expect(s.REDIS_URL).toBe(s.REDIS_URL_KV)

  // service secret names (names only) + tree place the minted names under the service
  const names = (await get(`/projects/${id}/services/rd-kv/secrets`)).json().secrets
  expect(names).toContain('REDIS_URL_KV')
  const tree = (await get(`/projects/${id}/secrets/tree`)).json()
  const mainBranch = tree.branches.find((b: { name: string }) => b.name === 'main')
  expect(mainBranch.services.find((x: { type: string }) => x.type === 'redis')).toMatchObject({ name: 'kv' })

  // merge reports it as existing structure (data never merges)
  const merge = await post(`/projects/${id}/branches/main/merge`, { from: 'feat' })
  expect(merge.json().skipped).toContainEqual({ type: 'redis', name: 'kv', reason: 'exists' })

  // remove is per branch, like add: one call per branch that carries it, and the registration
  // retires behind the last carrier.
  const featSid = (await get(`/projects/${id}/services?branch=feat`)).json().services
    .find((x: { name: string }) => x.name === 'kv').id as string

  // A secret bound to the service on feat, so removal has something branch-scoped to clean up.
  expect((await put(`/projects/${id}/secrets/FEAT_TOKEN`,
    { value: 'feat-only', branch: 'feat', service: 'redis/kv' })).statusCode).toBe(200)
  // The bound-name inventory is per branch: main must not borrow feat's.
  expect((await get(`/projects/${id}/services/rd-kv/secrets`)).json().secrets).not.toContain('FEAT_TOKEN')
  expect((await get(`/projects/${id}/services/${featSid}/secrets`)).json().secrets).toContain('FEAT_TOKEN')

  expect((await del_(`/projects/${id}/services/${featSid}`)).statusCode).toBe(200)
  expect(calls).toContain('md.destroy:io-demo-feat-rd-kv')
  // The secrets bound to the service on THIS branch go with it, even though the registration
  // survives for main. Left behind, they came back from the branch bundle as ordinary secrets:
  // the credentials of a service that no longer exists on that branch.
  expect(Object.keys((await get(`/projects/${id}/secrets?branch=feat`)).json().secrets))
    .not.toContain('FEAT_TOKEN')
  expect(loadState().projects[id].managedServices?.map((x) => x.id)).toEqual(['rd-kv'])
  const del = await del_(`/projects/${id}/services/rd-kv`)
  expect(del.statusCode).toBe(200)
  expect(calls).toContain('md.destroy:io-demo-main-rd-kv')
  expect(loadState().projects[id].managedServices).toEqual([])
  const after = (await get(`/projects/${id}/services`)).json().services
  expect(after.find((x: { id: string }) => x.id === 'rd-kv')).toBeUndefined()
  expect((await get(`/projects/${id}/secrets?branch=main`)).json().secrets.REDIS_URL).toBeUndefined()
})

// ---- storage objects (platform parity: list / presign download / presign upload / delete) ----

test('object list: shape + paging params + storage.read gate', async () => {
  const id = await createProject()
  const r = await get(`/projects/${id}/services/st-store/objects?prefix=img/&limit=5`)
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({
    objects: [{ key: 'a.txt', size: 3, lastModified: '2026-08-18T00:00:00Z', etag: '"x"' }],
    nextCursor: 'page2',
  })
  expect(calls).toContain('st.list:io-demo-main-store:prefix=img/:limit=5')

  await put(`/projects/${id}/policy/storage.read`, { decision: 'approve' })
  const gatedRes = await get(`/projects/${id}/services/st-store/objects`)
  expect(gatedRes.statusCode).toBe(202)
  expect(gatedRes.json()).toMatchObject({ status: 'approval_required', action: 'storage.read' })
})

test('object download presign: {url, expiresAt}; key required; branch-scoped creds', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect((await get(`/projects/${id}/services/st-store/objects/download`)).statusCode).toBe(400)
  const r = await get(`/projects/${id}/services/st-store/objects/download?key=a.txt&branch=feat&disposition=inline`)
  expect(r.statusCode).toBe(200)
  expect(r.json().url).toContain('io-demo-feat-store/a.txt') // the FEAT bucket, not main's
  expect(r.json().expiresAt).toBeTruthy()
  expect(calls).toContain('st.presignGet:io-demo-feat-store:a.txt:inline')
})

test('object upload presign: {url, fields, expiresAt}; validates body; storage.write gate; 5GiB cap', async () => {
  const id = await createProject()
  expect((await post(`/projects/${id}/services/st-store/objects/upload`, { key: 'x' })).statusCode).toBe(400)
  expect((await post(`/projects/${id}/services/st-store/objects/upload`, { key: 'x', contentType: 'text/plain', size: 6 * 1024 * 1024 * 1024 })).statusCode).toBe(400)
  const r = await post(`/projects/${id}/services/st-store/objects/upload`, { key: 'x.txt', contentType: 'text/plain', size: 10 })
  expect(r.statusCode).toBe(200)
  expect(r.json().fields.key).toBe('x.txt')
  expect(calls).toContain('st.presignPost:io-demo-main-store:x.txt:text/plain:10')

  await put(`/projects/${id}/policy/storage.write`, { decision: 'deny' })
  expect((await post(`/projects/${id}/services/st-store/objects/upload`, { key: 'x.txt', contentType: 'text/plain', size: 10 })).statusCode).toBe(403)
})

test('object delete: single {deleted:true} + bulk {deleted, failed}; storage.delete gate; storage-only', async () => {
  const id = await createProject()
  const one = await del_(`/projects/${id}/services/st-store/objects?key=a.txt`)
  expect(one.statusCode).toBe(200)
  expect(one.json()).toEqual({ deleted: true })
  expect(calls).toContain('st.rm:io-demo-main-store:a.txt')

  const bulk = await post(`/projects/${id}/services/st-store/objects/delete`, { keys: ['a.txt', 'b.txt'] })
  expect(bulk.statusCode).toBe(200)
  expect(bulk.json()).toEqual({ deleted: 2, failed: [] })
  expect((await post(`/projects/${id}/services/st-store/objects/delete`, {})).statusCode).toBe(400)

  // only storage services hold objects
  expect((await get(`/projects/${id}/services/pg-db/objects`)).statusCode).toBe(400)

  await put(`/projects/${id}/policy/storage.delete`, { decision: 'approve' })
  expect((await del_(`/projects/${id}/services/st-store/objects?key=a.txt`)).statusCode).toBe(202)
})

test('object routes answer 501 when the storage adapter has no object support', async () => {
  const bare: StorageAdapter = {
    provision: storage.provision, cloneInto: storage.cloneInto, destroy: storage.destroy,
  }
  const local = buildServer(new Engine(db, compute, bare, managed))
  const r = await local.inject({ method: 'POST', url: '/orgs/local/projects', payload: { name: 'demo' } })
  const pid = r.json().project.id
  await local.inject({ method: 'POST', url: `/projects/${pid}/services`, payload: { type: 'storage', name: 'store' } })
  const res = await local.inject({ method: 'GET', url: `/projects/${pid}/services/st-store/objects` })
  expect(res.statusCode).toBe(501)
  expect(res.json().error).toMatch(/not supported by this storage adapter/)
})

// ---- database management: password / databases / extensions / insight (cloud parity) ----

test('db password: rotates, re-mints DATABASE_URL, gated secrets.read', async () => {
  const id = await createProject()
  const r = await post(`/projects/${id}/database/password`, { password: "s3cr'et" })
  expect(r.statusCode).toBe(200)
  expect(r.json().password).toBe("s3cr'et")
  expect(r.json().connString).toContain(`:${encodeURIComponent("s3cr'et")}@`)
  expect(calls.some((c) => c.startsWith('db.query:alter user postgres'))).toBe(true)
  // the seam now mints the rotated URL
  const secrets = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  expect(secrets.DATABASE_URL).toBe(r.json().connString)
  // omitted password = generated
  const gen = await post(`/projects/${id}/database/password`, {})
  expect(gen.json().password.length).toBeGreaterThan(20)

  await put(`/projects/${id}/policy/secrets.read`, { decision: 'approve' })
  expect((await post(`/projects/${id}/database/password`, {})).statusCode).toBe(202)
})

test('db databases: list with connString, create 201, delete guards primary/system, 404 on ghost', async () => {
  const id = await createProject()
  const list = (await get(`/projects/${id}/database/databases`)).json().databases
  expect(list.map((d: { name: string }) => d.name)).toEqual(['app', 'postgres'])
  expect(list[0].connString).toContain('/app')

  const created = await post(`/projects/${id}/database/databases`, { name: 'analytics' })
  expect(created.statusCode).toBe(201)
  expect(created.json()).toMatchObject({ name: 'analytics' })
  expect(created.json().connString).toContain('/analytics')
  expect((await post(`/projects/${id}/database/databases`, { name: 'bad name!' })).statusCode).toBe(400)

  expect((await del_(`/projects/${id}/database/databases/app`)).statusCode).toBe(400)      // primary
  expect((await del_(`/projects/${id}/database/databases/postgres`)).statusCode).toBe(400) // system
  expect((await del_(`/projects/${id}/database/databases/ghost`)).statusCode).toBe(404)
  const dropped = await del_(`/projects/${id}/database/databases/analytics`)
  expect(dropped.statusCode).toBe(200)
  expect(dropped.json()).toEqual({ ok: true })
  expect(calls.some((c) => c.startsWith('db.query:drop database'))).toBe(true)
})

test('db extensions: view marks required; patch enables/disables; refuses required + unknown', async () => {
  const id = await createProject()
  const view = (await get(`/projects/${id}/database/extensions`)).json()
  expect(view.enabled).toEqual(['pg_stat_statements', 'plpgsql'])
  expect(view.available.find((a: { name: string }) => a.name === 'pg_stat_statements').required).toBe(true)
  expect(view.available.find((a: { name: string }) => a.name === 'vector').required).toBeUndefined()

  const patched = await patch(`/projects/${id}/database/extensions`, { enable: ['vector'] })
  expect(patched.statusCode).toBe(200)
  expect(calls.some((c) => c.startsWith('db.query:create extension'))).toBe(true)
  expect((await patch(`/projects/${id}/database/extensions`, { disable: ['pg_stat_statements'] })).statusCode).toBe(400)
  expect((await patch(`/projects/${id}/database/extensions`, { enable: ['not-a-thing'] })).statusCode).toBe(400)
})

test('db insight: DbInsight shape — sizes, tables, vacuum (null lastVacuum omitted), unused indexes', async () => {
  const id = await createProject()
  const r = await get(`/projects/${id}/database/insight`)
  expect(r.statusCode).toBe(200)
  const insight = r.json()
  expect(insight.collected).toBe(true)
  expect(insight.sizes).toEqual({ databaseBytes: 9000, tablesBytes: 5000, indexesBytes: 2000, walBytes: 100 })
  expect(insight.tables[0]).toEqual({ name: 'users', liveRows: 10, dataBytes: 4096, indexBytes: 1024, seqScans: 5, idxScans: 7 })
  expect(insight.vacuum.totalDeadRows).toBe(2)
  expect(insight.vacuum.tables[0]).toEqual({ name: 'users', deadRows: 2, deadPct: 16.7, xidAge: 55 }) // lastVacuum null → omitted
  expect(insight.unusedIndexes).toEqual([{ name: 'idx_dead', table: 'users', sizeBytes: 512, scans: 0 }])
})

// ---- runtime-health + branch rename (contract parity) ----

test('runtime-health: one docker read maps pg + managed + compute to the cloud vocabulary', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/services`, { type: 'compute', name: 'web' })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', group: 'web', port: 3000 })
  await post(`/projects/${id}/services`, { type: 'compute', name: 'idle' }) // registered, never deployed

  vi.mocked(dockerFn).mockImplementation(async (args: readonly string[]) => {
    if (args[0] === 'ps' && args[1] === '-a') {
      return Buffer.from('io-demo-main-pg-db\trunning\nio-demo-main-rd-cache\tpaused\nio-demo-main-app-web\texited\n')
    }
    return Buffer.from('')
  })
  const r = await get(`/projects/${id}/runtime-health`)
  expect(r.statusCode).toBe(200)
  const byId = Object.fromEntries(r.json().services.map((s: { serviceId: string }) => [s.serviceId, s]))
  expect(byId['pg-db']).toMatchObject({ status: 'healthy', machines: 1, failing: 0 })
  expect(byId['rd-cache']).toMatchObject({ status: 'standby', machines: 1, failing: 0 })     // paused = suspend intent
  expect(byId['cp-web']).toMatchObject({ status: 'crashed', machines: 1, failing: 1 })       // exited against running intent
  expect(byId['cp-idle']).toMatchObject({ status: 'none', machines: 0, failing: 0 })         // never deployed
  vi.mocked(dockerFn).mockImplementation(fakeDocker)
})

test('branch rename: metadata-only — resources keep their frozen ref; guards default/conflict', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  await put(`/projects/${id}/secrets/FEAT_ONLY`, { value: 'v', branch: 'feat' })
  const feat = (await get(`/projects/${id}/branches`)).json().branches.find((b: { name: string }) => b.name === 'feat')

  const r = await patch(`/projects/${id}/branches/${feat.id}`, { name: 'exp' })
  expect(r.statusCode).toBe(200)
  expect(r.json().branch).toMatchObject({ id: feat.id, name: 'exp', is_default: false })

  // the seam still mints the FROZEN ref's resources, and branch-scoped secrets followed the name
  const secrets = (await get(`/projects/${id}/secrets?branch=exp`)).json().secrets
  // The bundle is the lane form now (contract §10); the FROZEN ref is what the route key still names.
  expect(secrets.DATABASE_URL).toMatch(/^postgres:\/\/postgres:pw@127\.0\.0\.1:2\d{4}\/app$/)
  expect(secrets.DATABASE_URL).toBe((await get(`/projects/${id}/services/pg-db/credentials?branch=exp`)).json().credentials.DATABASE_URL)
  expect((await get(`/projects/${id}/database/instance?branch=exp`)).json().routeKey).toBe('pg-db-demo-feat')
  expect(secrets.FEAT_ONLY).toBe('v')
  expect((await get(`/projects/${id}/secrets?branch=feat`)).statusCode).toBe(404) // old name gone

  // deploys on the renamed branch keep landing on the frozen ref
  await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'exp', port: 3000 })
  expect(calls.some((c) => c.startsWith('deploy:demo-feat:default:app:2'))).toBe(true)

  // guards: default branch, name conflicts, junk names
  const main = (await get(`/projects/${id}/branches`)).json().branches.find((b: { name: string }) => b.name === 'main')
  expect((await patch(`/projects/${id}/branches/${main.id}`, { name: 'other' })).statusCode).toBe(400)
  await post(`/projects/${id}/branches`, { name: 'feat2', from: 'main' })
  const feat2 = (await get(`/projects/${id}/branches`)).json().branches.find((b: { name: string }) => b.name === 'feat2')
  expect((await patch(`/projects/${id}/branches/${feat2.id}`, { name: 'exp' })).statusCode).toBe(409)
  expect((await patch(`/projects/${id}/branches/${feat2.id}`, { name: 'Bad Name' })).statusCode).toBe(400)
})

// ---- project rename (display-name-only, frozen ref slug — contract parity) ----

test('project rename: display name only; resources AND future branches keep the frozen slug', async () => {
  const id = await createProject() // 'demo' → frozen slug 'demo'
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })

  const r = await patch(`/projects/${id}`, { name: 'Shop Backend' }) // any display name, like the cloud
  expect(r.statusCode).toBe(200)
  expect(r.json().project).toMatchObject({ id, name: 'Shop Backend' })
  expect((await get('/orgs/local/projects')).json().projects[0].name).toBe('Shop Backend')

  // existing resources keep serving under the frozen slug (the DSN is lane-form, so the frozen ref
  // shows in the route key the lane dispatches on)
  expect((await get(`/projects/${id}/secrets?branch=main`)).json().secrets.DATABASE_URL).toMatch(/^postgres:\/\/postgres:pw@127\.0\.0\.1:2\d{4}\/app$/)
  expect((await get(`/projects/${id}/database/instance`)).json().routeKey).toBe('pg-db-demo-main')
  // a branch created AFTER the rename still keys on the frozen slug, not the new name
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect(calls).toContain('db.fork:io-demo-main-pg-db->io-demo-feat-pg-db')

  // guards: junk names 400, duplicate display name 409
  expect((await patch(`/projects/${id}`, { name: '  ' })).statusCode).toBe(400)
  expect((await patch(`/projects/${id}`, { name: 'x'.repeat(101) })).statusCode).toBe(400)
  await post('/orgs/local/projects', { name: 'other' })
  expect((await patch(`/projects/${id}`, { name: 'other' })).statusCode).toBe(409)
})

test('create-project guards frozen slugs: a renamed project still owns its original resource names', async () => {
  const id = await createProject() // 'demo', slug frozen
  await patch(`/projects/${id}`, { name: 'shop' })
  // the display name 'demo' is free again, but the SLUG demo is still owned → 409, not a collision
  const r = await post('/orgs/local/projects', { name: 'demo' })
  expect(r.statusCode).toBe(409)
  expect(r.json().error).toMatch(/already exists/)
})

// ---- managed-db observability: component=redis|mysql|mongodb (cloud parity, platform #243) ----

test('metrics/logs target managed-db containers per type; junk components 400', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/services`, { type: 'mysql', name: 'mysql-db' })

  const observed: string[][] = []
  vi.mocked(dockerFn).mockImplementation(async (args: readonly string[]) => {
    if (args[0] === 'stats' || args[0] === 'logs') observed.push([...args])
    return Buffer.from('')
  })
  await get(`/projects/${id}/metrics?component=redis`)
  expect(observed.pop()).toContain('io-demo-main-rd-cache')
  await get(`/projects/${id}/logs?component=mysql&group=mysql-db&limit=5`)
  expect(observed.pop()).toContain('io-demo-main-my-mysql-db')
  // group resolves INSIDE the type — a redis named like a compute group must not leak across
  await get(`/projects/${id}/metrics?component=redis&group=nope`)
  expect((await get(`/projects/${id}/metrics?component=redis&group=nope`)).json().series).toEqual([])
  vi.mocked(dockerFn).mockImplementation(fakeDocker)

  const bad = await get(`/projects/${id}/metrics?component=kafka`)
  expect(bad.statusCode).toBe(400)
  expect(bad.json().error).toBe('component must be db|compute|redis|mysql|mongodb')
  expect((await get(`/projects/${id}/logs?component=junk`)).statusCode).toBe(400)
})

// ---- package regions (contract 00 §1.3): each package appends its contract tests between its own
// markers; existing assertions above change only at the lines its plan lists.

// Scaffold (decision 17): the postgres handle is READ from the row. A branch provisioned before the
// scaffold has no `databases` entry and still runs today's `io-<ref>-pg` container, which every read
// and the teardown must keep hitting until WP4's boot migration renames it.
test('a pre-scaffold branch row (no databases) keeps resolving its legacy io-<ref>-pg container', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  // The pre-WP5 shape: the deprecated single-service fields, and no `databases`/`buckets` rows.
  // migrateState presents them as pg-db / st-store on every parse.
  mutate((s) => {
    for (const b of Object.values(s.branches)) {
      if (b.projectId !== id) continue
      b.dbUrl = b.databases!['pg-db'].url
      b.bucket = b.buckets!['st-store'].bucket
      b.s3 = b.buckets!['st-store'].env
      delete b.databases
      delete b.buckets
    }
  })

  // WP3: `host`/`port` are the row's LANE address (contract 00 section 10), not the container name.
  // The legacy container is still what the daemon dials underneath, which the DSN and the teardown
  // assertions below are what pin.
  const legacyInstance = (await get(`/projects/${id}/database/instance`)).json()
  expect(legacyInstance.host).toBe('127.0.0.1')
  expect(String(legacyInstance.port)).toMatch(/^2\d{4}$/)
  const featBranchId = (await get(`/projects/${id}/branches`)).json().branches.find((b: { name: string }) => b.name === 'feat').id
  const services = (await get(`/projects/${id}/services?branch=feat`)).json().services
  expect(services.find((s: { id: string }) => s.id === `${featBranchId}:pg-db`).endpoint).toMatch(/^127\.0\.0\.1:2\d{4}$/)
  // the legacy DSN still comes off `dbUrl`, rewritten onto the lane like every other one
  expect((await get(`/projects/${id}/secrets?branch=main`)).json().secrets.DATABASE_URL)
    .toBe(`postgres://postgres:pw@${String(legacyInstance.host)}:${String(legacyInstance.port)}/app`)

  const feat = (await get(`/projects/${id}/branches`)).json().branches.find((b: { name: string }) => b.name === 'feat')
  await app.inject({ method: 'DELETE', url: `/projects/${id}/branches/${feat.id}` })
  expect(calls).toContain('db.destroy:io-demo-feat-pg')
  expect(calls).not.toContain('db.destroy:io-demo-feat-pg-db')
})

// ---- region WP1 (identity/config) ----
test('local mode: /me is exactly the builtin local user, with no via field', async () => {
  const res = await get('/me')
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ user: { id: 'local', email: null, name: 'local' } })
})

test('local mode: the tokens routes stay 501 and no identity route is mounted', async () => {
  for (const res of [await get('/tokens'), await post('/tokens', { name: 'x' }), await del_('/tokens/x')]) {
    expect(res.statusCode).toBe(501)
    expect(res.json().error).toContain('cloud-only')
  }
  expect((await get('/orgs')).statusCode).toBe(200)
  expect((await post('/api/auth/sign-up/email', { email: 'a@b.test', password: 'hunter2hunter2' })).statusCode).toBe(404)
  expect((await post('/auth/login', { email: 'a@b.test', password: 'hunter2hunter2' })).statusCode).toBe(404)
})

test('local mode: state.json carries no identity block', async () => {
  const { loadState } = await import('../src/state')
  await createProject('identity-free')
  expect(loadState().identity).toBeUndefined()
})

test('the API prefixes cover the identity surface, so a GET there is never the SPA shell', async () => {
  const { API_PREFIXES, isApiPath } = await import('../src/server')
  expect(API_PREFIXES).toContain('/api')
  expect(API_PREFIXES).toContain('/auth')
  expect(API_PREFIXES).toContain('/tls')
  expect(isApiPath('/api/auth/get-session')).toBe(true)
  expect(isApiPath('/auth/login')).toBe(true)
  expect(isApiPath('/tls/ask?domain=x')).toBe(true)
  expect(isApiPath('/assets/index.js')).toBe(false)
})

// WP7 (plan 07 tests, added in region WP1 as that plan directs): every SPA route the dashboard
// owns must reach the shell, and an API prefix must never be shadowed by one of them.
test('dashboard serving: identity and gallery routes reach the SPA shell', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const dist = mkdtempSync(join(tmpdir(), 'io-ui-'))
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<html>dash</html>')
  process.env.INSTA_OSS_UI_DIST = dist
  const ui = buildServer(new Engine(db, compute, storage, managed))
  delete process.env.INSTA_OSS_UI_DIST

  for (const url of ['/setup', '/login', '/account/tokens', '/p/x/main/templates']) {
    expect((await ui.inject({ method: 'GET', url })).body).toContain('dash')
  }
  // `/tokens` is an API prefix: the gallery and account routes never shadow a JSON route.
  expect((await ui.inject({ method: 'GET', url: '/tokens' })).body).not.toContain('dash')
})
// ---- end region WP1 ----

// ---- region WP2 (router) ----
// Hostname collisions across the ONE label space (contract 00 section 10): compute mints
// `<group>-<ref>`, postgres `pg-<name>-<ref>` and a managed database `<type>-<name>-<ref>`, so a
// group called `pg-db` or `redis-cache` is spelled exactly like the database beside it. buildTable
// keeps the FIRST route on a duplicate and only logs the second, so an unchecked mint silently
// shadows a database whose credentials still hand that hostname to every client. Every path that
// mints one reserves it first, and a collision is a refusal with nothing created.
import { loadState } from '../src/state'
import { buildTable } from '../src/router/table'

const hostReservations = (): Record<string, string> => loadState().hostReservations ?? {}

test('a direct deploy whose group would mint the postgres hostname is refused and creates nothing', async () => {
  const id = await createProject()
  // `db` is the postgres service the fixture added: its hostname is pg-db-demo-main.localhost,
  // which is also what a compute group called `pg-db` would mint.
  const r = await post(`/projects/${id}/deploy`, { image: 'app:1', port: 3000, group: 'pg-db' })
  expect(r.statusCode).toBe(400)
  expect(r.json().error).toContain('pg-db-demo-main.localhost')
  expect(r.json().error).toContain('pg-db')

  // Nothing was created: no container, no group on the branch, no row in the services list, and
  // no reservation left behind for the next request to trip over.
  expect(calls.filter((c) => c.startsWith('deploy:'))).toEqual([])
  expect(loadState().branches[await branchOf(id)].apps['pg-db']).toBeUndefined()
  const rows = (await get(`/projects/${id}/services`)).json().services
  expect(rows.map((s: { id: string }) => s.id)).not.toContain('cp-pg-db')
  // ...and the database still owns the name.
  expect(rows.find((s: { id: string }) => s.id === 'pg-db').domain).toBe('pg-db-demo-main.localhost')
  expect(hostReservations()).toEqual({})
})

test('a direct deploy whose group would mint a managed database hostname is refused and creates nothing', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  calls.length = 0

  const r = await post(`/projects/${id}/deploy`, { image: 'app:1', port: 3000, group: 'redis-cache' })
  expect(r.statusCode).toBe(400)
  expect(r.json().error).toContain('redis-cache-demo-main.localhost')

  expect(calls.filter((c) => c.startsWith('deploy:'))).toEqual([])
  expect(loadState().branches[await branchOf(id)].apps['redis-cache']).toBeUndefined()
  expect(hostReservations()).toEqual({})
  // The redis service is untouched and still answers on the name its credentials advertise.
  const rows = (await get(`/projects/${id}/services`)).json().services
  expect(rows.find((s: { id: string }) => s.id === 'rd-cache').domain).toBe('redis-cache-demo-main.localhost')
})

test('adding a managed database whose hostname a deployed group already holds is refused and provisions nothing', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', port: 3000, group: 'redis-cache' })
  calls.length = 0

  // The other direction: the group is there first, so the redis add is the one that must refuse.
  const r = await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  expect(r.statusCode).toBe(409)
  expect(r.json().error).toContain('redis-cache-demo-main.localhost')

  expect(calls.filter((c) => c.startsWith('md.provision:'))).toEqual([])
  const rows = (await get(`/projects/${id}/services`)).json().services
  expect(rows.map((s: { id: string }) => s.id)).not.toContain('rd-cache')
  expect(loadState().projects[id].managedServices ?? []).toEqual([])
  expect(hostReservations()).toEqual({})
})

test('renaming a managed database onto a deployed group hostname is refused and renames nothing', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/deploy`, { image: 'app:1', port: 3000, group: 'redis-live' })
  calls.length = 0

  const r = await post(`/projects/${id}/services/rd-cache/rename`, { name: 'live' })
  expect(r.statusCode).toBe(409)
  expect(r.json().error).toContain('redis-live-demo-main.localhost')

  expect(calls.filter((c) => c.startsWith('md.rename:'))).toEqual([])
  const rows = (await get(`/projects/${id}/services`)).json().services
  expect(rows.map((s: { id: string }) => s.id)).toContain('rd-cache')
  expect(rows.map((s: { id: string }) => s.id)).not.toContain('rd-live')
  expect(hostReservations()).toEqual({})
})

// A rename changes the name the label is built from, so it has to re-mint the hostname. Moving
// `apps[old]` to `apps[new]` and leaving its recorded `host` alone left the group answering on the
// OLD name (buildTable reads `app.host` first) while `<new-group>-<ref>` resolved nowhere at all.
// Only mode, domain and port are read off this config, and they match the engine's.
const tableNow = (): ReturnType<typeof buildTable> => buildTable(loadState(), testConfig(), () => { /* quiet */ })

test('renaming a compute group re-mints its hostname: the new name routes, the old one stops', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', port: 3000, group: 'api' })
  const bid = await branchOf(id)
  expect(tableNow().byHost('api-demo-main.localhost')?.key).toBe(`${bid}:cp-api`)

  expect((await post(`/projects/${id}/services/cp-api/rename`, { name: 'gateway' })).statusCode).toBe(200)

  // The services list reports the NEW domain and endpoint, not the name it was created under.
  const row = (await get(`/projects/${id}/services`)).json().services.find((s: { id: string }) => s.id === 'cp-gateway')
  expect(row.domain).toBe('gateway-demo-main.localhost')
  expect(row.endpoint).toBe('gateway-demo-main.localhost:8080')
  // ...because the row itself was re-minted, url included.
  const app = loadState().branches[bid].apps.gateway
  expect(app.host).toBe('gateway-demo-main.localhost')
  expect(app.url).toBe('http://gateway-demo-main.localhost:8080')

  // Host dispatch reaches the container on the new hostname...
  const t = tableNow()
  expect(t.byHost('gateway-demo-main.localhost')).toMatchObject({ key: `${bid}:cp-gateway`, container: 'io-demo-main-app-gateway', port: 3000 })
  // ...and the old hostname routes nowhere, rather than at a container docker has already renamed.
  expect(t.byHost('api-demo-main.localhost')).toBeUndefined()
  expect(hostReservations()).toEqual({})
})

test('a compute rename onto a hostname another service holds is refused and renames nothing', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', port: 3000, group: 'api' })
  calls.length = 0
  // `pg-db` is the postgres service's label, so the group must not be allowed to take it.
  const r = await post(`/projects/${id}/services/cp-api/rename`, { name: 'pg-db' })
  expect(r.statusCode).toBe(409)
  expect(r.json().error).toContain('pg-db-demo-main.localhost')
  expect(calls.filter((c) => c.startsWith('compute.rename:'))).toEqual([])
  expect(tableNow().byHost('api-demo-main.localhost')?.key).toBe(`${await branchOf(id)}:cp-api`)
  expect(hostReservations()).toEqual({})
})

test('a group name that is not lower-kebab is refused on the deploy that would mint it', async () => {
  const id = await createProject()
  const r = await post(`/projects/${id}/deploy`, { image: 'app:1', port: 3000, group: 'Web_1' })
  expect(r.statusCode).toBe(400)
  expect(r.json().error).toBe('service name must be lower-kebab (a-z, 0-9, -)')
  expect(calls.filter((c) => c.startsWith('deploy:'))).toEqual([])
})

// Rename enforced this and create did not, so the API accepted a branch whose own hostname and
// URLs could not address it: `web-demo-my branch.<domain>` is not a host, and `/p/<id>/a/b` is not
// a route. The dashboard showed it as created and then could not navigate to it.
test('a branch name that is not lower-kebab is refused on create, as it already was on rename', async () => {
  const id = await createProject()
  for (const bad of ['my branch', 'a/b', 'x?', 'UPPER', '-lead', 'trail-']) {
    const r = await post(`/projects/${id}/branches`, { name: bad })
    expect(r.statusCode, bad).toBe(400)
    expect(r.json().error, bad).toBe('branch name must be lower-kebab (a-z, 0-9, -)')
  }
  // The rule is a floor, not a ban: a normal name still creates.
  expect((await post(`/projects/${id}/branches`, { name: 'feat-1' })).statusCode).toBe(201)
})

// RegExp.test coerces, so a truthy non-string body value passed the name check and only failed
// later, where provisioning calls string methods on it: a 409/500-shaped error for what is plainly
// a malformed request. The boundary types it now.
test('a branch name that is not a string is a 400, on create and on rename', async () => {
  const id = await createProject()
  for (const bad of [123, true, ['x'], { name: 'x' }]) {
    const r = await post(`/projects/${id}/branches`, { name: bad })
    expect(r.statusCode, JSON.stringify(bad)).toBe(400)
    expect(r.json().error, JSON.stringify(bad)).toBe('name required')
  }
  expect((await post(`/projects/${id}/branches`, { name: 'ok-1', from: 7 })).statusCode).toBe(400)

  const made = await post(`/projects/${id}/branches`, { name: 'renameable' })
  expect(made.statusCode).toBe(201)
  const bid = made.json().branch.id
  const r = await patch(`/projects/${id}/branches/${bid}`, { name: 123 })
  expect(r.statusCode).toBe(400)
  expect(r.json().error).toBe('name required')
})

// The SERVICE half of the same coercion. This one is worse than a wrong status code: the compute
// path persisted the non-string into `computeGroups` and answered 201 with it, so the state held a
// value its own types forbid and no later string request compared equal to it — the service could
// not be addressed, renamed or removed again.
test('a service name that is not a string is a 400, on create and on rename', async () => {
  const id = await createProject()
  for (const bad of [123, true, ['x'], { name: 'x' }]) {
    const r = await post(`/projects/${id}/services`, { type: 'compute', name: bad, port: 3000 })
    expect(r.statusCode, JSON.stringify(bad)).toBe(400)
    expect(r.json().error, JSON.stringify(bad)).toBe('type and name required')
  }
  // A non-string TYPE is refused the same way, rather than reaching the unknown-type branch with
  // a coerced value.
  expect((await post(`/projects/${id}/services`, { type: 7, name: 'api', port: 3000 })).statusCode).toBe(400)
  expect((await post(`/projects/${id}/services`, { type: 'compute', name: 'api', port: 3000, branch: 7 })).statusCode).toBe(400)

  // Nothing was persisted by any of the above: the project still carries no compute group.
  expect(loadState().projects[id].computeGroups ?? []).toEqual([])

  // The rule is a floor, not a ban: a real name still creates, and rename types its input too.
  const ok = await post(`/projects/${id}/services`, { type: 'compute', name: 'api', port: 3000 })
  expect(ok.statusCode).toBe(201)
  const bad = await post(`/projects/${id}/services/cp-api/rename`, { name: 123 })
  expect(bad.statusCode).toBe(400)
  expect(bad.json().error).toBe('name required')
  // And the service kept the name it had.
  expect((await get(`/projects/${id}/services`)).json().services.map((s: { name: string }) => s.name)).toContain('api')
})

// docs/projects/branches.mdx states 39 characters, and the template parser enforced the same cap
// for codes. Sharing one expression between them is only correct if it carries the cap: an
// unbounded one silently removed the parser's and let these routes accept what the docs refuse.
test('a branch name is capped at 39 characters, on create and on rename', async () => {
  const id = await createProject()
  const at39 = 'b'.repeat(39)
  const at40 = 'b'.repeat(40)

  expect((await post(`/projects/${id}/branches`, { name: at40 })).statusCode).toBe(400)
  const ok = await post(`/projects/${id}/branches`, { name: at39 })
  expect(ok.statusCode).toBe(201)

  // Rename is held to the same boundary, and to the same STATUS. `>= 400` left the documented
  // "a malformed name answers 400" unverified on this route: unlike create, rename has no explicit
  // lower-kebab mapping and reaches it through errCode's default, which is worth pinning.
  const bid = ok.json().branch.id
  const renamed = await patch(`/projects/${id}/branches/${bid}`, { name: at40 })
  expect(renamed.statusCode).toBe(400)
  expect(renamed.json().error).toContain('lower-kebab')
})

// A service name is a DNS label (`<group>-<project>-<branch>.<domain>`), and RFC 1123 forbids a
// leading or trailing hyphen. Three of the four checks in the engine had drifted apart: compute
// rename refused a trailing hyphen, while add-service and managed rename accepted it and minted a
// name whose hostname is invalid. Which names were legal depended on the route you took.
test('a trailing hyphen is refused by every service-name route, not just some', async () => {
  const id = await createProject()
  const add = await post(`/projects/${id}/services`, { type: 'compute', name: 'api-' })
  expect(add.statusCode).toBe(400)
  expect(add.json().error).toBe('service name must be lower-kebab (a-z, 0-9, -)')

  const addManaged = await post(`/projects/${id}/services`, { type: 'redis', name: 'cache-' })
  expect(addManaged.statusCode).toBe(400)

  // And the names that were always legal still are.
  expect((await post(`/projects/${id}/services`, { type: 'compute', name: 'api-1' })).statusCode).toBe(201)
})

test('a redeploy re-checks nothing it already owns: the second deploy of a group still lands', async () => {
  const id = await createProject()
  expect((await post(`/projects/${id}/deploy`, { image: 'app:1', port: 3000, group: 'web' })).statusCode).toBe(200)
  const again = await post(`/projects/${id}/deploy`, { image: 'app:2', port: 3000, group: 'web' })
  expect(again.statusCode).toBe(200)
  expect(calls.filter((c) => c.startsWith('deploy:demo-main:web:'))).toHaveLength(2)
  expect(hostReservations()).toEqual({})
})

// Decision 5: every name a container on the branch must resolve to the box becomes an
// `--add-host <name>:host-gateway`, because public DNS cannot be trusted to send it there. The
// group's OWN name is in that set — docs/self-hosting/domains "Inside a branch" promises an app can
// use the compute hostnames of its own branch — and a first deploy is where it is easiest to lose:
// `apps[g].host` is written only after the container exists.
const aliasesOf = (ref: string, group: string): string[] => {
  const prefix = `deploy.aliases:${ref}:${group}:`
  const line = calls.find((c) => c.startsWith(prefix))
  return line === undefined ? [] : line.slice(prefix.length).split(',')
}

test('a first deploy hands the container its OWN hostname, not just its siblings', async () => {
  const id = await createProject()
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'app:1', port: 3000, group: 'web' })
  // Without this the brand new container is the one name it cannot reach: its own router URL.
  expect(aliasesOf('demo-main', 'web')).toContain('web-demo-main.localhost')
  // ...and everything it already carried is still there.
  expect(aliasesOf('demo-main', 'web')).toContain('pg-db-demo-main.localhost')
  expect(aliasesOf('demo-main', 'web')).toContain('host.docker.internal')

  // A second group's first deploy carries its own name AND the group already deployed.
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'api:1', port: 3000, group: 'api' })
  expect(aliasesOf('demo-main', 'api')).toContain('api-demo-main.localhost')
  expect(aliasesOf('demo-main', 'api')).toContain('web-demo-main.localhost')

  // A redeploy reads the recorded host and lists it exactly once (the set is keyed by name).
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'app:2', port: 3000, group: 'web' })
  expect(aliasesOf('demo-main', 'web').filter((h) => h === 'web-demo-main.localhost')).toHaveLength(1)
})

test('server mode: a first deploy resolves its own hostname alongside api and the object store', async () => {
  const engine = makeEngine(serverConfig())
  const { project } = await engine.createProject('demo')
  await engine.addDbService(project.id, 'db')
  calls.length = 0
  await engine.deploy(project.id, 'main', { image: 'app:1', port: 3000, group: 'web' })
  const aliases = aliasesOf('demo-main', 'web')
  expect(aliases).toContain('web-demo-main.example.test')
  expect(aliases).toContain('pg-db-demo-main.example.test')
  expect(aliases).toContain('api.example.test')
  expect(aliases).toContain('s3.example.test')
})

// A branch reserves its NAME and its `ref` the same way, and for the same reason: the ref names the
// network, every container, every bucket and every data directory, so two creates that both pass a
// check-then-act uniqueness test build one stack twice — and the loser's compensation then removes
// the branch root the winner just filled.
const branchReservations = (): Record<string, string> => loadState().branchReservations ?? {}

test('two concurrent createBranch calls for one name: one wins, the other is refused, and the winner survives', async () => {
  // Driven on the engine rather than through inject, because inject dispatches on a macrotask: the
  // first request would run to completion in microtasks and the second would never overlap it.
  const engine = makeEngine()
  const { project } = await engine.createProject('demo')
  await engine.addDbService(project.id, 'db')
  await engine.addStorageService(project.id, 'store')
  calls.length = 0
  vi.mocked(dockerFn).mockClear()

  // BOTH calls are made in one tick, so the second enters createBranch while the first is suspended
  // mid-provision: both see a state with no `feat` branch, which is the interleaving a pre-check
  // outside the lock cannot see.
  const settled = await Promise.allSettled([
    engine.createBranch(project.id, 'feat'),
    engine.createBranch(project.id, 'feat'),
  ])
  const won = settled.filter((r) => r.status === 'fulfilled')
  const lost = settled.filter((r) => r.status === 'rejected')
  expect(won).toHaveLength(1)
  expect(lost).toHaveLength(1)
  expect(String((lost[0] as PromiseRejectedResult).reason)).toContain('branch "feat" already exists')

  // One branch, one stack: the loser provisioned no second copy of the same ref.
  const rows = engine.listBranches(project.id).filter((b) => b.name === 'feat')
  expect(rows).toHaveLength(1)
  expect(rows[0].id).toBe((won[0] as PromiseFulfilledResult<{ id: string }>).value.id)
  expect(calls.filter((c) => c.startsWith('db.fork:'))).toEqual(['db.fork:io-demo-main-pg-db->io-demo-feat-pg-db'])
  expect(calls.filter((c) => c.startsWith('st.provision:'))).toEqual(['st.provision:demo-feat:store'])

  // ...and, the part a destructive compensation has to fail on: NOTHING of the winner's was torn
  // down. No container destroyed, no bucket destroyed, no branch-root directory removed, and the
  // branch network still there.
  expect(calls.filter((c) => /^(db|st|md)\.destroy:/.test(c))).toEqual([])
  expect(calls.filter((c) => c.startsWith('data.remove:'))).toEqual([])
  expect(vi.mocked(dockerFn).mock.calls.map((c) => (c[0] as string[]).join(' '))).not.toContain('network rm io-demo-feat')
  // The winner's own records survived intact, so its credentials still point at live resources.
  const winner = loadState().branches[rows[0].id]
  expect(winner.databases?.['pg-db']?.container).toBe('io-demo-feat-pg-db')
  expect(winner.buckets?.['st-store']?.bucket).toBe('io-demo-feat-store')
  // The claim retires with the row it protected: a later create of the same name is refused by the
  // row, never by a leaked reservation.
  expect(branchReservations()).toEqual({})
})

// A branch NAME is unique per project; the `ref` has to be unique per DAEMON. `ref` is
// `<projectSlug>-<branchSlug>` and a hyphen lives inside both halves, so project `demo-a` with
// branch `main` and project `demo` with branch `a-main` spell one ref: one network, one set of
// container names, and one set of data roots, because `branchRoots(ref)` keys on the ref alone.
// Left unguarded, the second create adopts the first's storage and a later delete of either takes
// the other project's postgres bytes with it, 200 and all.
test('a branch ref is unique across PROJECTS: `demo` + `a-main` cannot take `demo-a` + `main`', async () => {
  const a = (await post('/orgs/local/projects', { name: 'demo-a' })).json().project.id
  const d = (await post('/orgs/local/projects', { name: 'demo' })).json().project.id
  await post(`/projects/${d}/services`, { type: 'postgres', name: 'db' })
  calls.length = 0
  vi.mocked(dockerFn).mockClear()

  const clash = await post(`/projects/${d}/branches`, { name: 'a-main' })
  expect(clash.statusCode).toBe(409)
  expect(clash.json().error).toContain('both name the resources demo-a-main')
  expect(clash.json().error).toContain('in project "demo-a"')
  // Refused before anything was made, and before anything of the VICTIM's was touched.
  expect(calls).toEqual([])
  expect(vi.mocked(dockerFn).mock.calls.map((c) => (c[0] as string[]).join(' '))).toEqual([])
  expect(branchReservations()).toEqual({})
  // `demo-a` still owns the ref, with its branch row intact.
  const aMain = (await get(`/projects/${a}/branches`)).json().branches
  expect(aMain.map((b: { name: string }) => b.name)).toEqual(['main'])
  expect(loadState().branches[aMain[0].id].ref).toBe('demo-a-main')
})

test('...and the other order: a PROJECT whose default branch would take a live ref is refused whole', async () => {
  const d = (await post('/orgs/local/projects', { name: 'demo' })).json().project.id
  await post(`/projects/${d}/services`, { type: 'postgres', name: 'db' })
  expect((await post(`/projects/${d}/branches`, { name: 'a-main' })).statusCode).toBe(201)
  calls.length = 0

  const clash = await post('/orgs/local/projects', { name: 'demo-a' })
  expect(clash.statusCode).toBe(409)
  expect(clash.json().error).toContain('both name the resources demo-a-main')
  // No half-made project survives the refusal, and the victim's stack is untouched: a create that
  // compensated over the ref would have removed `demo`/`a-main`'s database and its bytes.
  expect((await get('/orgs/local/projects')).json().projects.map((p: { name: string }) => p.name)).toEqual(['demo'])
  expect(calls.filter((c) => /\.destroy:|^data\.remove:/.test(c))).toEqual([])
  expect(branchReservations()).toEqual({})
  expect(loadState().branches[await branchOf(d, 'a-main')].databases?.['pg-db']?.container).toBe('io-demo-a-main-pg-db')
})

// The arm above races a branch that provisions a database and a bucket, so the loser can be
// stopped by a hostname collision on its way in. The destructive arm is an EMPTY project: there
// is no hostname to compare, and `docker network create` failing because the network already
// exists is deliberately swallowed (the ref claim is what makes reusing it safe). Only the ref
// reservation stands between two creates and one shared stack here.
test('two concurrent createBranch calls on an EMPTY project: still one branch, and nothing torn down', async () => {
  const engine = makeEngine()
  const { project } = await engine.createProject('demo')   // no services at all
  calls.length = 0
  vi.mocked(dockerFn).mockClear()

  const settled = await Promise.allSettled([
    engine.createBranch(project.id, 'feat'),
    engine.createBranch(project.id, 'feat'),
  ])
  expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const lost = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult
  expect(String(lost.reason)).toContain('branch "feat" already exists')

  // One row, one network, and the loser removed neither the network nor the branch root of the
  // winner it collided with.
  expect(engine.listBranches(project.id).filter((b) => b.name === 'feat')).toHaveLength(1)
  const dockerArgs = vi.mocked(dockerFn).mock.calls.map((c) => (c[0] as string[]).join(' '))
  expect(dockerArgs.filter((a) => a === 'network create io-demo-feat')).toHaveLength(1)
  expect(dockerArgs).not.toContain('network rm io-demo-feat')
  expect(calls.filter((c) => c.startsWith('data.remove:'))).toEqual([])
  expect(branchReservations()).toEqual({})
})

test('a failed branch create gives its ref claim back, and compensates only its own resources', async () => {
  const id = await createProject()
  const fork = vi.spyOn(db, 'fork').mockRejectedValueOnce(new Error('boom'))
  const bad = await post(`/projects/${id}/branches`, { name: 'feat' })
  expect(bad.statusCode).toBeGreaterThanOrEqual(400)
  // It owned the ref, so it is allowed to remove the branch root it was filling...
  expect(calls.some((c) => c.startsWith('data.remove:'))).toBe(true)
  // ...and it hands the claim straight back, or the retry below would refuse itself as in flight.
  expect(branchReservations()).toEqual({})

  fork.mockRestore()
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  expect(branchReservations()).toEqual({})
})

// The arm above fails INSIDE `provisionBranch`, where the rollback already lived. Everything
// `createBranch` does AFTER `provisionBranch` returns — the /data volume forks, the bucket object
// copies, the compute redeploys, the inherited secrets — happens with the branch ROW already
// committed, and `provisionBranch`'s rollback cannot reach any of it. A failure there used to
// return an error and leave a half-built branch standing under a name that was now taken: the
// retry was refused with `already exists`, and the user's only way forward was to delete a branch
// that had never finished being created. Each of those steps is failed in turn below, and the
// answer has to be the same every time: nothing of the branch survives, and the name is free.

/** A source branch that exercises every post-commit step: a database, a bucket, and a compute
 *  group with a /data volume deployed on it (so `forkVolumes` has a real directory to clone). */
async function sourceWithEveryStep(): Promise<string> {
  const id = (await post('/orgs/local/projects', { name: 'demo' })).json().project.id
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'db' })
  await post(`/projects/${id}/services`, { type: 'storage', name: 'store' })
  await post(`/projects/${id}/services`, { type: 'compute', name: 'web', volumeGib: 1 })
  await post(`/projects/${id}/deploy`, { image: 'app:1', port: 3000, group: 'web' })
  await put(`/projects/${id}/secrets/API_KEY`, { value: 'from-main', branch: 'main' })
  calls.length = 0
  return id
}

/** Everything a failed create must leave behind: nothing. Read fresh from state each time. */
function assertNothingOfFeatSurvives(id: string): void {
  const st = loadState()
  expect(Object.values(st.branches).filter((b) => b.projectId === id && b.name === 'feat')).toEqual([])
  expect(branchReservations()).toEqual({})
  expect(st.laneReservations ?? {}).toEqual({})
  // The inherited secret copy goes with the branch that would have owned it, so a retry inherits
  // ONE copy rather than stacking a second on top of the first.
  expect((st.userSecrets[id] ?? []).filter((u) => u.branch === 'feat')).toEqual([])
  // ...and the resources the create had already built are gone: the clone's own containers,
  // bucket, network and bytes, and NOT the source's.
  expect(calls).toContain('compute.destroy:demo-feat')
  expect(calls).toContain('db.destroy:io-demo-feat-pg-db')
  expect(calls).toContain('st.destroy:io-demo-feat-store')
  expect(calls.some((c) => c.startsWith('data.remove:') && c.includes('demo-feat'))).toBe(true)
  expect(calls.filter((c) => /:io-demo-main|:demo-main|data\.remove:.*demo-main/.test(c) && /destroy|remove/.test(c))).toEqual([])
}

/** The retry the user makes next has to be an ordinary create, not a collision. */
async function assertRetryWorks(id: string): Promise<void> {
  const retry = await post(`/projects/${id}/branches`, { name: 'feat' })
  expect(retry.statusCode).toBe(201)
  const st = loadState()
  const row = Object.values(st.branches).find((b) => b.projectId === id && b.name === 'feat')!
  expect(row.databases?.['pg-db']?.container).toBe('io-demo-feat-pg-db')
  expect(row.buckets?.['st-store']?.bucket).toBe('io-demo-feat-store')
  expect(row.apps.web).toBeDefined()
  expect((st.userSecrets[id] ?? []).filter((u) => u.branch === 'feat')).toHaveLength(1)
  expect(branchReservations()).toEqual({})
}

test('post-commit step 1 (the /data volume fork) fails: nothing of the branch survives and the retry works', async () => {
  const id = await sourceWithEveryStep()
  const clone = vi.spyOn(data, 'cloneTree').mockRejectedValueOnce(new Error('clone boom'))
  const bad = await post(`/projects/${id}/branches`, { name: 'feat' })
  expect(bad.statusCode).toBeGreaterThanOrEqual(400)
  expect(bad.json().error).toContain('clone boom')
  assertNothingOfFeatSurvives(id)
  clone.mockRestore()
  await assertRetryWorks(id)
})

test('post-commit step 2 (the bucket object copy) fails: nothing of the branch survives and the retry works', async () => {
  const id = await sourceWithEveryStep()
  const cloneInto = vi.spyOn(storage, 'cloneInto').mockRejectedValueOnce(new Error('bucket boom'))
  const bad = await post(`/projects/${id}/branches`, { name: 'feat' })
  expect(bad.statusCode).toBeGreaterThanOrEqual(400)
  expect(bad.json().error).toContain('bucket boom')
  assertNothingOfFeatSurvives(id)
  cloneInto.mockRestore()
  await assertRetryWorks(id)
})

test('post-commit step 3 (the compute redeploy) fails: nothing of the branch survives and the retry works', async () => {
  const id = await sourceWithEveryStep()
  const deploy = vi.spyOn(compute, 'deploy').mockRejectedValueOnce(new Error('deploy boom'))
  const bad = await post(`/projects/${id}/branches`, { name: 'feat' })
  expect(bad.statusCode).toBeGreaterThanOrEqual(400)
  expect(bad.json().error).toContain('deploy boom')
  assertNothingOfFeatSurvives(id)
  // The hostname the deploy minted for the clone's group went back too, or the retry's own deploy
  // would be refused as a collision with a branch that does not exist.
  expect(Object.keys(loadState().hostReservations ?? {})).toEqual([])
  deploy.mockRestore()
  await assertRetryWorks(id)
})

test('post-commit step 4 (the last one, after the secrets are cloned) fails: the secret copies go too', async () => {
  const id = await sourceWithEveryStep()
  // The inherited secrets and bindings are a synchronous state write with no failure of its own,
  // so the step AFTER it is what proves its compensation: by then the copies exist.
  const sleep = vi.spyOn(engine, 'sleepNewBranch').mockRejectedValueOnce(new Error('sleep boom'))
  const bad = await post(`/projects/${id}/branches`, { name: 'feat' })
  expect(bad.statusCode).toBeGreaterThanOrEqual(400)
  expect(bad.json().error).toContain('sleep boom')
  assertNothingOfFeatSurvives(id)
  // The source's own secret is untouched: only the copies made for the branch that failed go.
  expect((loadState().userSecrets[id] ?? []).filter((u) => u.branch === 'main').map((u) => u.name)).toEqual(['API_KEY'])
  sleep.mockRestore()
  await assertRetryWorks(id)
})

/** The id of the half-built clone, read out of state from inside a failing post-commit step. */
function featId(projectId: string): string {
  return Object.values(loadState().branches).find((b) => b.projectId === projectId && b.name === 'feat')!.id
}

test('a branch RENAMED mid-create still has its inherited secret copies unwound', async () => {
  const id = await sourceWithEveryStep()
  // `renameBranch` moves no container, so it takes no operation lock and is free to land at any
  // await the create makes. It carries the branch's secret rows to the new name with it, and the
  // compensation used to look for the OLD name only: the copies survived under the new one, and
  // the retry then inherited a second set on top of them.
  const sleep = vi.spyOn(engine, 'sleepNewBranch').mockImplementationOnce(async () => {
    engine.renameBranch(id, featId(id), 'feat-renamed')
    throw new Error('sleep boom')
  })
  const bad = await post(`/projects/${id}/branches`, { name: 'feat' })
  expect(bad.statusCode).toBeGreaterThanOrEqual(400)
  expect(bad.json().error).toContain('sleep boom')

  const st = loadState()
  expect(Object.values(st.branches).filter((b) => b.projectId === id && b.name !== 'main')).toEqual([])
  // Under NEITHER name, and the source's own row is untouched.
  expect((st.userSecrets[id] ?? []).filter((u) => u.branch !== 'main')).toEqual([])
  expect((st.userSecrets[id] ?? []).map((u) => `${u.name}@${u.branch}`)).toEqual(['API_KEY@main'])
  sleep.mockRestore()
  await assertRetryWorks(id)
})

test('the unwind never takes the secrets of a branch that now owns the freed name', async () => {
  const id = await sourceWithEveryStep()
  const sleep = vi.spyOn(engine, 'sleepNewBranch').mockImplementationOnce(async () => {
    const clone = featId(id)
    engine.renameBranch(id, clone, 'feat-renamed')
    // Someone else takes the name the rename freed, with a secret of their own. (Written straight
    // into state: a real create here would queue on the locks this operation holds.)
    mutate((st) => {
      st.branches['other-branch'] = { ...st.branches[clone], id: 'other-branch', name: 'feat', ref: 'demo-feat-other' }
      st.userSecrets[id] = [...(st.userSecrets[id] ?? []), { name: 'THEIRS', value: 'v', branch: 'feat' }]
    })
    throw new Error('sleep boom')
  })
  await post(`/projects/${id}/branches`, { name: 'feat' })
  sleep.mockRestore()

  const st = loadState()
  // The failed create's own copies are gone; the other branch's row keeps its secret.
  expect((st.userSecrets[id] ?? []).map((u) => `${u.name}@${u.branch}`).sort()).toEqual(['API_KEY@main', 'THEIRS@feat'])
  expect(Object.keys(st.branches)).toContain('other-branch')
})

test('a create whose CLEANUP fails keeps a row naming the resources, and the delete retries it', async () => {
  const id = await sourceWithEveryStep()
  const cloneInto = vi.spyOn(storage, 'cloneInto').mockRejectedValueOnce(new Error('bucket boom'))
  // The teardown that follows cannot remove the clone's database container. Dropping the row anyway
  // would leave that container holding its port and its RAM with nothing naming it: invisible to
  // `branch list`, to project delete and to the operator, and never retried by anything.
  const destroy = vi.spyOn(db, 'destroy').mockRejectedValueOnce(new Error('container is in use'))

  const bad = await post(`/projects/${id}/branches`, { name: 'feat' })
  expect(bad.statusCode).toBeGreaterThanOrEqual(400)
  expect(bad.json().error).toContain('bucket boom')
  // The user is told what state the name is in, on the same error.
  expect(bad.json().error).toContain('cleanup-failed')
  cloneInto.mockRestore()
  destroy.mockRestore()

  // The row is still there, marked, and it still names the branch's resources.
  const row = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')!
  expect(row.status).toBe('cleanup-failed')
  expect(row.databases?.['pg-db']?.container).toBe('io-demo-feat-pg-db')
  // The event says so too, with the counts.
  const ev = loadState().events.filter((e) => e.kind === 'branch.cleanupFailed')
  expect(ev).toHaveLength(1)
  expect((ev[0].payload as { teardown: { failed: number } }).teardown.failed).toBe(1)
  // The secret copies still go: the kept row is a handle for finishing the teardown, not a branch,
  // and leaving them would hand a double set to the create that follows the delete.
  expect((loadState().userSecrets[id] ?? []).filter((u) => u.branch === 'feat')).toEqual([])

  // The tradeoff, stated: the name is NOT free while that row stands.
  const retry = await post(`/projects/${id}/branches`, { name: 'feat' })
  expect(retry.statusCode).toBeGreaterThanOrEqual(400)
  expect(retry.json().error).toContain('already exists')

  // ...and the handle works: the delete runs the same demolition, this time all of it, and the
  // name comes back.
  const del = await app.inject({ method: 'DELETE', url: `/projects/${id}/branches/${row.id}` })
  expect(del.statusCode).toBe(200)
  expect(del.json().teardown.failed).toBe(0)
  await assertRetryWorks(id)
})

test('a compensation that fails in its own bookkeeping still reports the create failure', async () => {
  const id = await sourceWithEveryStep()
  // The router blows up, but only once the create is already unwinding (invalidating the table is
  // one of the last things the compensation does). The user must still be told `bucket boom`, the
  // failure they can act on, and not `router boom` from the cleanup that ran afterwards.
  let unwinding = false
  engine.router = { invalidate: () => { if (unwinding) throw new Error('router boom') } }
  const cloneInto = vi.spyOn(storage, 'cloneInto').mockImplementationOnce(async () => {
    unwinding = true
    throw new Error('bucket boom')
  })

  const bad = await post(`/projects/${id}/branches`, { name: 'feat' })
  cloneInto.mockRestore()
  engine.router = { invalidate: () => { /* back to the no-op */ } }

  expect(bad.statusCode).toBeGreaterThanOrEqual(400)
  expect(bad.json().error).toContain('bucket boom')
  expect(bad.json().error).not.toContain('router boom')
  // ...and the state work that ran BEFORE the throw stands: the row is gone, so the name is free
  // and the retry is an ordinary create.
  expect(Object.values(loadState().branches).filter((b) => b.projectId === id).map((b) => b.name)).toEqual(['main'])
  await assertRetryWorks(id)
})

test('a network that refuses to go is a FAILED teardown, so the row is kept rather than dropped', async () => {
  const id = await sourceWithEveryStep()
  const cloneInto = vi.spyOn(storage, 'cloneInto').mockRejectedValueOnce(new Error('bucket boom'))
  // Every container, bucket and directory goes; only the NETWORK refuses, the way dockerd refuses
  // one that still has an endpoint attached. That used to be swallowed whole -- the counter never
  // saw it, `unwindBranch` read `failed: 0`, and the row was deleted over a network that is still
  // standing and that nothing will ever come back for.
  vi.mocked(dockerFn).mockImplementation(async (args: string[]) => {
    if (args[0] === 'network' && args[1] === 'rm') throw new Error('network io-demo-feat has active endpoints')
    return Buffer.from('')   // `network inspect` succeeds: the network is still there
  })

  const bad = await post(`/projects/${id}/branches`, { name: 'feat' })
  expect(bad.statusCode).toBeGreaterThanOrEqual(400)
  cloneInto.mockRestore()
  vi.mocked(dockerFn).mockImplementation(fakeDocker)

  // The row stays, marked, so the leftover network has something naming it and `branch delete`
  // can retry the demolition.
  const row = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')
  expect(row?.status).toBe('cleanup-failed')
  expect(bad.json().error).toContain('cleanup-failed')
  const ev = loadState().events.filter((e) => e.kind === 'branch.cleanupFailed')
  expect(ev).toHaveLength(1)
  expect((ev[0].payload as { teardown: { failed: number } }).teardown.failed).toBe(1)
})

test('a probe that cannot answer is not evidence the network is gone', async () => {
  const id = await sourceWithEveryStep()
  const cloneInto = vi.spyOn(storage, 'cloneInto').mockRejectedValueOnce(new Error('bucket boom'))
  // The removal fails, and the probe that would say whether the network survived cannot answer
  // either: a daemon that is not talking, a template error, a permission failure. None of those
  // is absence. Treating them as absence reports a clean demolition and deletes the row over a
  // network that may still be standing, which is the whole point of counting these steps.
  vi.mocked(dockerFn).mockImplementation(async (args: string[]) => {
    if (args[0] === 'network' && (args[1] === 'rm' || args[1] === 'inspect')) {
      throw new Error('docker network rm io-demo-feat -> exit 1: Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
    }
    return Buffer.from('')
  })

  const bad = await post(`/projects/${id}/branches`, { name: 'feat' })
  cloneInto.mockRestore()
  vi.mocked(dockerFn).mockImplementation(fakeDocker)

  expect(bad.statusCode).toBeGreaterThanOrEqual(400)
  const row = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')
  expect(row?.status).toBe('cleanup-failed')
})

test('a network that was already gone is not counted as a failure', async () => {
  const id = await sourceWithEveryStep()
  // `network rm` fails because there is nothing to remove, which is the ordinary outcome of a
  // retried teardown. Counting that would report a clean delete as failed for ever after.
  vi.mocked(dockerFn).mockImplementation(async (args: string[]) => {
    if (args[0] === 'network' && (args[1] === 'rm' || args[1] === 'inspect')) throw new Error('Error: No such network')
    return Buffer.from('')
  })
  const bid = await branchOf(id, 'main')
  await post(`/projects/${id}/branches`, { name: 'feat' })
  const featId = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')!.id
  expect(featId).not.toBe(bid)

  const del = await app.inject({ method: 'DELETE', url: `/projects/${id}/branches/${featId}` })
  vi.mocked(dockerFn).mockImplementation(fakeDocker)
  expect(del.statusCode).toBe(200)
  expect(del.json().teardown.failed).toBe(0)
  expect(Object.values(loadState().branches).filter((b) => b.projectId === id).map((b) => b.name)).toEqual(['main'])
})

/** Let queued microtasks and timers run, so anything that COULD proceed already has. */
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)) }

/** A create paused inside a post-commit step: the row is committed and the branch resolves by
 *  name, but the volume forks, bucket copies, deploys and secrets are not done. */
function pauseInPostCommit(): { entered: Promise<void>; release(): void; restore(): void; fail(): void } {
  let enter!: () => void
  let go!: () => void
  let failing = false
  const entered = new Promise<void>((r) => { enter = r })
  const gate = new Promise<void>((r) => { go = r })
  const spy = vi.spyOn(storage, 'cloneInto').mockImplementationOnce(async () => {
    enter()
    await gate
    if (failing) throw new Error('bucket boom')
  })
  return { entered, release: () => { go() }, restore: () => { spy.mockRestore() }, fail: () => { failing = true } }
}

test('the branch a create has committed is private until the create finishes: a deploy queues', async () => {
  const id = await sourceWithEveryStep()
  const paused = pauseInPostCommit()

  const create = post(`/projects/${id}/branches`, { name: 'feat' })
  await paused.entered
  // The row IS committed and resolvable by name at this point: that is the window.
  expect(Object.values(loadState().branches).some((b) => b.projectId === id && b.name === 'feat')).toBe(true)

  let done = false
  const deploy = post(`/projects/${id}/deploy`, { image: 'app:2', port: 3000, group: 'web', branch: 'feat' }).then((r) => { done = true; return r })
  await settle()
  // Without the branch key this deploy runs INSIDE the create, on a branch that is half built.
  expect(done).toBe(false)
  expect(calls.filter((c) => c.startsWith('deploy:demo-feat:web:app:2'))).toEqual([])

  paused.release()
  expect((await create).statusCode).toBe(201)
  expect((await deploy).statusCode).toBe(200)
  paused.restore()
  // ...and it landed AFTER the create's own redeploy of that group, not on top of it.
  const order = calls.filter((c) => c.startsWith('deploy:demo-feat:web:'))
  expect(order.map((c) => c.split(':')[3])).toEqual(['app', 'app'])
  expect(order[0]).toContain('app:1')
  expect(order[1]).toContain('app:2')
})

test('a delete of the branch being created queues behind it and then runs, with no deadlock', async () => {
  const id = await sourceWithEveryStep()
  const paused = pauseInPostCommit()

  const create = post(`/projects/${id}/branches`, { name: 'feat' })
  await paused.entered
  const bid = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')!.id

  let done = false
  const del = app.inject({ method: 'DELETE', url: `/projects/${id}/branches/${bid}` }).then((r) => { done = true; return r })
  await settle()
  expect(done).toBe(false)
  // The create is not blocked BY the delete either: releasing it finishes both, in order.
  paused.release()
  expect((await create).statusCode).toBe(201)
  expect((await del).statusCode).toBe(200)
  paused.restore()
  expect(Object.values(loadState().branches).filter((b) => b.projectId === id && b.name === 'feat')).toEqual([])
})

test('a concurrent deploy is not torn down by the compensation of the create it raced', async () => {
  const id = await sourceWithEveryStep()
  const paused = pauseInPostCommit()

  const create = post(`/projects/${id}/branches`, { name: 'feat' })
  await paused.entered
  const deploy = post(`/projects/${id}/deploy`, { image: 'app:2', port: 3000, group: 'web', branch: 'feat' })
  await settle()

  // The create now fails, so its compensation tears the branch down. Held behind the branch key,
  // the deploy has built nothing for that compensation to destroy; it runs afterwards and finds
  // no branch. Unheld, it built a container inside the window and `unwindBranch` destroyed it.
  paused.fail()
  paused.release()
  expect((await create).statusCode).toBeGreaterThanOrEqual(400)
  const answer = await deploy
  paused.restore()
  expect(answer.statusCode).toBe(400)
  expect(answer.json().error).toContain('not found')
  expect(calls.filter((c) => c.startsWith('deploy:demo-feat:web:app:2'))).toEqual([])
  assertNothingOfFeatSurvives(id)
  await assertRetryWorks(id)
})

/** A create paused INSIDE `provisionBranch`, before the branch row is committed. That is a
 *  different window from `pauseInPostCommit`: here the branch exists NOWHERE in state, so a
 *  project delete listing this project's branches cannot see it and cannot take its keys. */
function pauseBeforeCommit(): { entered: Promise<void>; release(): void; restore(): void } {
  let enter!: () => void
  let go!: () => void
  const entered = new Promise<void>((r) => { enter = r })
  const gate = new Promise<void>((r) => { go = r })
  const real = db.fork
  const spy = vi.spyOn(db, 'fork').mockImplementationOnce(async (src, dst, opts) => {
    enter()
    await gate
    return real(src, dst, opts)
  })
  return { entered, release: () => { go() }, restore: () => { spy.mockRestore() } }
}

test('a project delete that overlaps a branch create still takes the clone with it', async () => {
  const id = await sourceWithEveryStep()
  const paused = pauseBeforeCommit()

  const create = post(`/projects/${id}/branches`, { name: 'feat' })
  await paused.entered
  // The window: the clone's row is not committed, so every branch list of this project says
  // `main` and nothing else. A delete's key set is built from exactly that list.
  expect(Object.values(loadState().branches).filter((b) => b.projectId === id).map((b) => b.name)).toEqual(['main'])

  // Driven on the engine: `DELETE /projects/:id` is govern-gated to `approve` by default, and
  // this is a test about the lock, not about the gate.
  let done = false
  const del = engine.destroyProject(id).then((t) => { done = true; return t })
  await settle()
  // It queues: on the source branch's keys before, on the project key now.
  expect(done).toBe(false)

  try {
    paused.release()
    expect((await within(10_000, create, 'the branch create')).statusCode).toBe(201)
    expect(await within(10_000, del, 'the project delete')).toMatchObject({ failed: 0 })

    // Nothing of either branch survives, and the clone's resources were DESTROYED rather than
    // abandoned: without a key covering the whole project, the delete ran on its stale list and
    // left feat's container, bucket, network and bytes behind under a row whose project was gone.
    const st = loadState()
    expect(Object.values(st.branches).filter((b) => b.projectId === id).map((b) => b.name)).toEqual([])
    expect(st.projects[id]).toBeUndefined()
    expect(calls).toContain('db.destroy:io-demo-feat-pg-db')
    expect(calls).toContain('st.destroy:io-demo-feat-store')
    expect(calls).toContain('compute.destroy:demo-feat')
    expect(calls.some((c) => c.startsWith('data.remove:') && c.includes('demo-feat'))).toBe(true)
  } finally {
    // A gate released only after the assertions is a gate a failure leaves shut.
    paused.release()
    paused.restore()
  }
})

test('a project delete that overlaps the CREATE OF THE PROJECT takes its default branch with it', async () => {
  // The case where the project key is the ONLY thing standing between the two: a project with no
  // source branch yet. The two tests around this one create a CLONE, and a clone's key set
  // already carries the source branch's keys, which the delete acquires too, so they queue with
  // or without `projectOp` and cannot grade it. Here the project row exists and its default
  // branch row does not, so the delete's pre-lock branch list is empty and its key set with it.
  let enter!: () => void
  let go!: () => void
  const entered = new Promise<void>((r) => { enter = r })
  const gate = new Promise<void>((r) => { go = r })
  vi.mocked(dockerFn).mockImplementation(async (args: string[]) => {
    if (args[0] === 'network' && args[1] === 'create') { enter(); await gate }
    return Buffer.from('')
  })

  const create = engine.createProject('demo2')
  await entered
  const pid = Object.values(loadState().projects).find((p) => p.name === 'demo2')!.id
  // The project is visible; its default branch is committed nowhere, so a delete's
  // pre-lock branch list is empty and its key set with it.
  expect(Object.values(loadState().branches).filter((b) => b.projectId === pid)).toEqual([])

  let done = false
  const del = engine.destroyProject(pid).then((t) => { done = true; return t })
  await settle()
  expect(done).toBe(false)          // must QUEUE behind the create, on the project key

  go()
  await create
  await del
  vi.mocked(dockerFn).mockImplementation(fakeDocker)

  // No branch row may outlive the project it points at.
  expect(loadState().projects[pid]).toBeUndefined()
  expect(Object.values(loadState().branches).filter((b) => b.projectId === pid)).toEqual([])
})

test('...and the other order: a create that queued behind a project delete builds nothing', async () => {
  const id = await sourceWithEveryStep()
  // The delete is held mid-demolition, so the create arrives while the project row still exists
  // and is refused only when it reaches the front of the queue.
  let enter!: () => void
  let go!: () => void
  const entered = new Promise<void>((r) => { enter = r })
  const gate = new Promise<void>((r) => { go = r })
  const real = db.destroy
  const spy = vi.spyOn(db, 'destroy').mockImplementationOnce(async (c) => { enter(); await gate; return real(c) })

  const del = engine.destroyProject(id)
  await entered
  let done = false
  const create = post(`/projects/${id}/branches`, { name: 'feat' }).then((r) => { done = true; return r })
  await settle()
  expect(done).toBe(false)

  go()
  expect(await del).toMatchObject({ failed: 0 })
  const answer = await create
  spy.mockRestore()

  // The create read its project and its source branch before the lock; both are gone by the time
  // it runs, so it re-reads and refuses instead of provisioning a stack nothing names.
  expect(answer.statusCode).toBeGreaterThanOrEqual(400)
  expect(answer.json().error).toContain('project not found')
  expect(calls.filter((c) => c.includes('demo-feat'))).toEqual([])
  expect(Object.values(loadState().branches).filter((b) => b.projectId === id).map((b) => b.name)).toEqual([])
})

test('a source renamed while the create waited is read again, not remembered by its old name', async () => {
  const id = await sourceWithEveryStep()
  // A source branch that is not `main`, because only a non-default branch can be renamed.
  expect((await post(`/projects/${id}/branches`, { name: 'alpha' })).statusCode).toBe(201)
  const alpha = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'alpha')!
  expect((await get(`/projects/${id}/secrets?branch=alpha`)).json().secrets.API_KEY).toBe('from-main')

  // Hold alpha's branch key, so a create from it queues instead of running. `renameBranch` takes
  // no operation lock at all (it moves no container), so it lands inside that window: this is
  // the interleaving, not a contrivance.
  let release!: () => void
  const held = new Promise<void>((r) => { release = () => { r() } })
  const holder = engine.withOp([engine.branchOp(alpha)], () => held)

  let done = false
  const create = post(`/projects/${id}/branches`, { name: 'feat', from: 'alpha' }).then((r) => { done = true; return r })
  await settle()
  expect(done).toBe(false)
  expect((await app.inject({ method: 'PATCH', url: `/projects/${id}/branches/${alpha.id}`, payload: { name: 'beta' } })).statusCode).toBe(200)
  release()
  await holder

  expect((await create).statusCode).toBe(201)
  // The clone inherits its parent's branch-scoped secrets BY NAME: read from the snapshot, the
  // create looks for rows on `alpha`, the rename moved them to `beta`, and the clone inherits
  // nothing.
  expect((await get(`/projects/${id}/secrets?branch=feat`)).json().secrets.API_KEY).toBe('from-main')
  // ...and the event names the branch it actually forked, which is the one that answers today.
  const ev = loadState().events.filter((e) => e.kind === 'branch.created' && e.branch === 'feat')
  expect(ev).toHaveLength(1)
  expect((ev[0].payload as { from: string }).from).toBe('beta')
})

test('a source renamed DURING the provisioning window still hands its secrets to the clone', async () => {
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/branches`, { name: 'alpha' })).statusCode).toBe(201)
  const alpha = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'alpha')!
  expect((await get(`/projects/${id}/secrets?branch=alpha`)).json().secrets.API_KEY).toBe('from-main')

  // Paused inside a post-commit step: PAST the re-read at the top of `createBranchLocked` and
  // before the secret copy, with the provision chain, the volume forks and the bucket clones
  // already behind it. That is the long window, and `renameBranch` needs no lock to land in it.
  const paused = pauseInPostCommit()
  const create = post(`/projects/${id}/branches`, { name: 'feat', from: 'alpha' })
  await paused.entered
  expect((await app.inject({ method: 'PATCH', url: `/projects/${id}/branches/${alpha.id}`, payload: { name: 'beta' } })).statusCode).toBe(200)
  paused.release()
  expect((await create).statusCode).toBe(201)
  paused.restore()

  // The clone still inherits: the copy reads the parent's name from the state it is holding, so
  // there is no window between the read and the filter that uses it.
  expect((await get(`/projects/${id}/secrets?branch=feat`)).json().secrets.API_KEY).toBe('from-main')
  // ...and the event names the branch as it stands now, not as the create first saw it.
  const ev = loadState().events.filter((e) => e.kind === 'branch.created' && e.branch === 'feat')
  expect(ev).toHaveLength(1)
  expect((ev[0].payload as { from: string }).from).toBe('beta')
})

/** Bound a promise, so a wedged chain fails the test with a legible message instead of running
 *  out the runner's clock. */
async function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let t!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not finish within ${ms}ms: the provision chain is wedged`)), ms) })])
  } finally {
    clearTimeout(t)
  }
}

test('a service added inside a queued create window cannot wedge the provision chain', async () => {
  const id = await sourceWithEveryStep()
  const mainRow = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'main')!
  // The fork opens the wake door the way the real adapter does: `forkByBasebackup` calls
  // `ensureSourceRunning` unconditionally, and under this PR's own at-rest rule a fork of a live
  // parent ALWAYS streams, so this is the common path and not a corner. The first fork also
  // parks, so the third call below lands while the create is mid-provision.
  let enterFork!: () => void
  let goFork!: () => void
  const inFork = new Promise<void>((r) => { enterFork = r })
  const forkGate = new Promise<void>((r) => { goFork = r })
  let forks = 0
  const fork = vi.spyOn(db, 'fork').mockImplementation(async (src, dst, opts) => {
    calls.push(`db.fork:${src.container}->${dst.container}`)
    if (forks++ === 0) { enterFork(); await forkGate }
    await opts?.ensureSourceRunning?.()
    return { url: src.url.replace(src.container, dst.container), method: 'basebackup', ms: 1 }
  })

  // 1. Something is in flight on main, so the create QUEUES with its key set already enqueued
  //    from the pre-lock snapshot: {main:pg-db}, and no key for a service that does not exist yet.
  let release!: () => void
  const held = new Promise<void>((r) => { release = () => { r() } })
  const holder = engine.withOp([engine.branchOp(mainRow)], () => held)
  let created = false
  const create = post(`/projects/${id}/branches`, { name: 'feat' }).then((r) => { created = true; return r })
  await settle()
  expect(created).toBe(false)

  // 2. A second postgres is added to main INSIDE that window. With no operation key of its own it
  //    slips in, and the create's re-read then forks a service whose key it never acquired.
  const add = post(`/projects/${id}/services`, { type: 'postgres', name: 'db2', branch: 'main' })
  await settle()
  release()
  await holder

  // 3. A second create from the same parent arrives while the first is mid-fork. Its key set is
  //    read NOW, so it contains main:pg-db2, which nothing is ahead of: it takes that chain and
  //    then waits on the branch key the first create holds. The first create's fork of db2 then
  //    wakes main:pg-db2 and queues behind it. Circular wait, inside the engine-wide provision
  //    chain, which has no timeout anywhere.
  await inFork
  const create2 = post(`/projects/${id}/branches`, { name: 'feat2', from: 'main' })
  await settle()
  goFork()

  expect((await within(10_000, create, 'the first branch create')).statusCode).toBe(201)
  expect((await within(10_000, add, 'the service add')).statusCode).toBe(201)
  expect((await within(10_000, create2, 'the second branch create')).statusCode).toBe(201)
  fork.mockRestore()
  // ...and the chain is not wedged for the rest of the daemon either: `serialize('provision')` is
  // engine-wide, so a project create in an UNRELATED project is the honest liveness check.
  expect((await within(10_000, post('/orgs/local/projects', { name: 'unrelated' }), 'an unrelated project create')).statusCode).toBe(201)
})

test('a service add ALREADY IN FLIGHT when the create snapshots cannot wedge the chain either', async () => {
  // The other ordering, and the one the branch key on the adds does NOT cover: the add is
  // already holding `branchOp(main)` when `createBranch` takes its pre-lock snapshot, so the
  // create records the OLD service list, queues on that key, and the add then materialises the
  // service before it lets go. Under the lock the create re-reads a longer list and would fork a
  // service its acquisition never named, whose wake is then a second acquisition.
  const id = await sourceWithEveryStep()
  let enterAdd!: () => void
  let goAdd!: () => void
  const inAdd = new Promise<void>((r) => { enterAdd = r })
  const addGate = new Promise<void>((r) => { goAdd = r })
  // Gated, then handed to the real fake: it registers the container with `FakeRuntime`, which is
  // what a later wake of that service resolves through.
  const realProvision = db.provision.bind(db)
  const provision = vi.spyOn(db, 'provision').mockImplementationOnce(async (t, opts) => {
    enterAdd()
    await addGate
    return realProvision(t, opts)
  })
  let enterFork!: () => void
  let goFork!: () => void
  const inFork = new Promise<void>((r) => { enterFork = r })
  const forkGate = new Promise<void>((r) => { goFork = r })
  let forks = 0
  const fork = vi.spyOn(db, 'fork').mockImplementation(async (src, dst, opts) => {
    calls.push(`db.fork:${src.container}->${dst.container}`)
    if (forks++ === 0) { enterFork(); await forkGate }
    await opts?.ensureSourceRunning?.()
    return { url: src.url.replace(src.container, dst.container), method: 'basebackup', ms: 1 }
  })

  try {
    // 1. The add is IN FLIGHT, holding main's branch key.
    const add = post(`/projects/${id}/services`, { type: 'postgres', name: 'db2', branch: 'main' })
    await inAdd

    // 2. The create snapshots now: `{main:pg-db}`, with nothing for a service that is being
    //    created as it looks.
    let created = false
    const create = post(`/projects/${id}/branches`, { name: 'feat' }).then((r) => { created = true; return r })
    await settle()
    expect(created).toBe(false)

    // 3. The add finishes and db2 exists. The create acquires, re-reads a longer list, and has
    //    to widen its acquisition before it forks anything.
    goAdd()
    expect((await within(10_000, add, 'the service add')).statusCode).toBe(201)

    // 4. A second create from the same parent lands mid-fork and takes main:pg-db2's chain if
    //    the first create never acquired it. That is the circular wait.
    await inFork
    const create2 = post(`/projects/${id}/branches`, { name: 'feat2', from: 'main' })
    await settle()
    goFork()

    expect((await within(10_000, create, 'the first branch create')).statusCode).toBe(201)
    expect((await within(10_000, create2, 'the second branch create')).statusCode).toBe(201)
    // The clone really did carry both databases, so the widened acquisition forked them.
    const feat = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')!
    expect(Object.keys(feat.databases ?? {}).sort()).toEqual(['pg-db', 'pg-db2'])
    // ...and the engine-wide provision chain is still alive for everyone else.
    expect((await within(10_000, post('/orgs/local/projects', { name: 'unrelated2' }), 'an unrelated project create')).statusCode).toBe(201)
  } finally {
    provision.mockRestore()
    fork.mockRestore()
  }
})

test('a service rename that lands while a create is queued cannot give the clone no database', async () => {
  // The create re-reads the source row, passes its key check, and THEN waits in the engine-wide
  // provision chain. A rename ahead of it in that chain changes the service id while it waits.
  // `provisionBranch` filters a freshly read registration list through the row the create
  // captured, so the new id is looked up in the old row, finds nothing, and the database drops
  // out of the fork list with no error at all: 201, and a clone with no database.
  const id = await sourceWithEveryStep()
  let enterRename!: () => void
  let goRename!: () => void
  const inRename = new Promise<void>((r) => { enterRename = r })
  const renameGate = new Promise<void>((r) => { goRename = r })
  const realRename = db.rename!.bind(db)
  const rename = vi.spyOn(db, 'rename').mockImplementationOnce(async (container, to) => {
    enterRename()
    await renameGate
    return realRename(container, to)
  })

  try {
    // 1. The rename is in flight, inside `serialize('provision')`.
    const renaming = post(`/projects/${id}/services/pg-db/rename`, { name: 'db2' })
    await inRename

    // 2. The create arrives. Its row still says `pg-db`.
    let created = false
    const create = post(`/projects/${id}/branches`, { name: 'feat' }).then((r) => { created = true; return r })
    await settle()
    expect(created).toBe(false)

    // 3. The rename completes and the registration is now `pg-db2`.
    goRename()
    expect((await within(10_000, renaming, 'the service rename')).statusCode).toBe(200)
    expect((await within(10_000, create, 'the branch create')).statusCode).toBe(201)

    // The clone carries the database under its new id, and a fork was actually issued for it.
    const feat = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')!
    expect(Object.keys(feat.databases ?? {})).toEqual(['pg-db2'])
    expect(calls.filter((c) => c.startsWith('db.fork:'))).toHaveLength(1)
  } finally {
    rename.mockRestore()
  }
})

test('a rename granted after a create commits still holds the NEW branch: the key set re-drives', async () => {
  // `renameKeys` is a SNAPSHOT taken before the acquisition. The reachable ordering is this one:
  // a create is in flight and has not committed its row, so the rename's set names `main` and
  // nothing else; the create then commits `feat` and finishes; the rename is granted next and
  // renames feat's container and row while holding no key of feat's at all. Anything else on
  // feat -- a deploy, a create forking it, a delete -- then runs straight through the rename.
  const id = await sourceWithEveryStep()
  const paused = pauseBeforeCommit()
  const create = post(`/projects/${id}/branches`, { name: 'feat' })
  await paused.entered
  // The window: every branch list of this project says `main`, which is what the rename keys on.
  expect(Object.values(loadState().branches).filter((b) => b.projectId === id).map((b) => b.name)).toEqual(['main'])

  let enterRename!: () => void
  let goRename!: () => void
  const inRename = new Promise<void>((r) => { enterRename = r })
  const renameGate = new Promise<void>((r) => { goRename = r })
  const realRename = db.rename!.bind(db)
  const renameSpy = vi.spyOn(db, 'rename').mockImplementation(async (container, to) => {
    enterRename()
    await renameGate
    return realRename(container, to)
  })

  try {
    // Queued behind the create on main's branch key, with a key set that predates `feat`.
    const renaming = post(`/projects/${id}/services/pg-db/rename`, { name: 'db2' })
    await settle()
    paused.release()
    expect((await within(10_000, create, 'the branch create')).statusCode).toBe(201)
    await within(10_000, inRename, 'the rename reaching its adapter')

    // The rename is now inside its body, renaming a service that `feat` carries too. A deploy to
    // feat must therefore QUEUE. It takes no provision-chain slot, so the only thing that can
    // hold it is the operation key -- which the rename only holds because it re-drove its set.
    let deployed = false
    const deploy = post(`/projects/${id}/deploy`, { image: 'app:2', port: 3000, group: 'web', branch: 'feat' }).then((r) => { deployed = true; return r })
    await settle()
    expect(deployed).toBe(false)

    goRename()
    expect((await within(10_000, renaming, 'the rename')).statusCode).toBe(200)
    expect((await within(10_000, deploy, 'the deploy')).statusCode).toBe(200)
    // ...and the rename did reach feat, which is what made feat's keys affected keys.
    expect(calls).toContain('db.rename:io-demo-feat-pg-db->io-demo-feat-pg-db2')
    expect(Object.keys(loadState().branches[await branchOf(id, 'feat')].databases ?? {})).toEqual(['pg-db2'])
  } finally {
    renameSpy.mockRestore()
    paused.restore()
  }
})

test('a removal queued behind a rename refuses instead of destroying the renamed service', async () => {
  // Third instance of one shape: an operation that resolves a service identity BEFORE its lock
  // and acts on it afterwards. The removal waits behind the rename (they share the key now),
  // the rename moves the id, and the snapshot the removal is holding then names a service that
  // no longer exists. The data directory id is immutable across a rename, so acting on it
  // deletes the RENAMED database's bytes and leaves its row and registration in place.
  const id = await sourceWithEveryStep()
  let enterRename!: () => void
  let goRename!: () => void
  const inRename = new Promise<void>((r) => { enterRename = r })
  const renameGate = new Promise<void>((r) => { goRename = r })
  const realRename = db.rename!.bind(db)
  const rename = vi.spyOn(db, 'rename').mockImplementationOnce(async (container, to) => {
    enterRename()
    await renameGate
    return realRename(container, to)
  })

  try {
    const renaming = post(`/projects/${id}/services/pg-db/rename`, { name: 'db2' })
    await inRename
    let removed = false
    const removal = del_(`/projects/${id}/services/pg-db`).then((r) => { removed = true; return r })
    await settle()
    expect(removed).toBe(false)

    goRename()
    expect((await within(10_000, renaming, 'the rename')).statusCode).toBe(200)
    const answer = await within(10_000, removal, 'the removal')

    // It refuses, naming what happened, and destroys nothing.
    expect(answer.statusCode).toBeGreaterThanOrEqual(400)
    expect(answer.json().error).toContain('changed while this removal was queued')
    expect(calls.filter((c) => c.startsWith('data.remove:'))).toEqual([])
    // The renamed service is intact: its registration, its row, and therefore its bytes.
    const rows = (await get(`/projects/${id}/services?branch=main`)).json().services as Array<{ id: string }>
    expect(rows.some((r) => r.id === 'pg-db2')).toBe(true)
    expect(loadState().branches[await branchOf(id, 'main')].databases?.['pg-db2']).toBeDefined()
  } finally {
    rename.mockRestore()
  }
})

test('a branch delete whose container refuses to go keeps its data and its row', async () => {
  // `count()` swallowed every teardown failure into a counter and carried on, so a FAILED
  // `docker rm` was followed by deleting the bind-mounted data directory that container was
  // still writing, and then by dropping the row that named both. Docker refusing a removal, or
  // being unavailable, took the database files out from under a surviving Postgres.
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  const feat = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')!
  calls.length = 0
  const destroy = vi.spyOn(db, 'destroy').mockRejectedValueOnce(new Error('container is in use'))

  let del
  try {
    del = await del_(`/projects/${id}/branches/${feat.id}`)
  } finally {
    destroy.mockRestore()
  }

  // 409, not 200: the branch is still there, and a client that reads 200 as "gone" would show
  // it vanishing and reappearing on the next refresh.
  expect(del.statusCode).toBe(409)
  expect(del.json().teardown.failed).toBeGreaterThan(0)
  // ...with an `error` beside it, or every client renders a bare "HTTP 409" for exactly the
  // outcome this status exists to communicate. It names what refused and how to retry.
  expect(del.json().error).toContain('io-demo-feat-pg-db')
  expect(del.json().error).toContain('insta branch delete')
  // The envelope itself stays the documented pair, with no extra fields on it.
  expect(Object.keys(del.json().teardown).sort()).toEqual(['destroyed', 'failed'])
  // The bytes stay: something is still mounting them.
  expect(calls.filter((c) => c.startsWith('data.remove:'))).toEqual([])
  // ...and so does the row, marked, so the survivor is still named by something and
  // `insta branch delete` can retry exactly this demolition.
  expect(loadState().branches[feat.id]?.status).toBe('cleanup-failed')
})

test('a project delete holds the keys of a branch that committed while it queued', async () => {
  // The delete's key set is a snapshot; a branch that commits between it and the acquisition is
  // in the re-read LIST but none of its keys were acquired, so a deploy on that branch could run
  // straight through its teardown and leave a container behind. Closed by the same union
  // re-drive `createBranch` uses, and this is the test that runs an operation ON that branch.
  const id = await sourceWithEveryStep()
  const paused = pauseBeforeCommit()
  const create = post(`/projects/${id}/branches`, { name: 'feat' })
  await paused.entered

  // The delete snapshots now: main only, because feat's row does not exist yet.
  let deleted = false
  const del = engine.destroyProject(id).then((t) => { deleted = true; return t })
  await settle()
  expect(deleted).toBe(false)

  // Pause the delete INSIDE feat's teardown, so the deploy below lands while it is running.
  // Both gates are released in a `finally`: these tests exist to detect a wedge, so the case
  // they are written for is the one that never reaches a cleanup line after the assertions.
  let enterTeardown!: () => void
  let goTeardown!: () => void
  const inTeardown = new Promise<void>((r) => { enterTeardown = r })
  const teardownGate = new Promise<void>((r) => { goTeardown = r })
  const realStDestroy = storage.destroy.bind(storage)
  const stDestroy = vi.spyOn(storage, 'destroy').mockImplementation(async (bucket, network) => {
    if (bucket.includes('demo-feat')) { enterTeardown(); await teardownGate }
    return realStDestroy(bucket, network)
  })

  try {
    paused.release()
    expect((await within(10_000, create, 'the branch create')).statusCode).toBe(201)
    await within(10_000, inTeardown, 'the teardown of feat')

    let deployed = false
    const deploy = post(`/projects/${id}/deploy`, { image: 'app:2', port: 3000, group: 'web', branch: 'feat' })
      .then((r) => { deployed = true; return r })
    await settle()
    // Without the re-drive this deploy runs INSIDE the teardown, on a branch being demolished.
    expect(deployed).toBe(false)

    goTeardown()
    await within(10_000, del, 'the project delete')
    const answer = await within(10_000, deploy, 'the deploy')

    // It ran after the teardown, found nothing, and built nothing.
    expect(answer.statusCode).toBeGreaterThanOrEqual(400)
    expect(calls.filter((c) => c.startsWith('deploy:demo-feat:web:app:2'))).toEqual([])
    expect(Object.values(loadState().branches).filter((b) => b.projectId === id).map((b) => b.name)).toEqual([])
  } finally {
    goTeardown()
    paused.release()
    paused.restore()
    stDestroy.mockRestore()
  }
})

test('a network create that failed for any other reason fails the branch, it is not "already exists"', async () => {
  // Everything but subnet exhaustion used to be read as "the network is already there", so a
  // permission error, a daemon that is not answering or an invalid configuration all reported
  // success. A project starts EMPTY now, so that could commit a READY default branch with no
  // network at all, and the truth would surface much later on an unrelated service operation.
  const id = await sourceWithEveryStep()
  vi.mocked(dockerFn).mockImplementation(async (args: string[]) => {
    if (args[0] === 'network' && args[1] === 'create') throw new Error('Error response from daemon: permission denied')
    // ...and the verification cannot answer either, which is not evidence that it exists.
    if (args[0] === 'network' && args[1] === 'inspect') throw new Error('Cannot connect to the Docker daemon')
    return Buffer.from('')
  })

  let bad
  try {
    bad = await post(`/projects/${id}/branches`, { name: 'feat' })
  } finally {
    vi.mocked(dockerFn).mockImplementation(fakeDocker)
  }

  expect(bad.statusCode).toBeGreaterThanOrEqual(400)
  expect(bad.json().error).toContain('could not create the branch network')
  // No half-made branch, and the ref claim is back so the retry is an ordinary create.
  expect(Object.values(loadState().branches).filter((b) => b.projectId === id).map((b) => b.name)).toEqual(['main'])
  expect(branchReservations()).toEqual({})
})

test('...and a network that dockerd CONFIRMS is already there is still reused', async () => {
  // The interrupted-create case the old catch existed for: the create fails because the network
  // is there, dockerd says so when asked, and the branch is built on it rather than refused.
  const id = await sourceWithEveryStep()
  vi.mocked(dockerFn).mockImplementation(async (args: string[]) => {
    if (args[0] === 'network' && args[1] === 'create') throw new Error('Error response from daemon: network with name io-demo-feat already exists')
    return Buffer.from('')   // `network inspect` answers, so the network is verified present
  })

  let ok
  try {
    ok = await post(`/projects/${id}/branches`, { name: 'feat' })
  } finally {
    vi.mocked(dockerFn).mockImplementation(fakeDocker)
  }

  expect(ok.statusCode).toBe(201)
  expect(loadState().branches[await branchOf(id, 'feat')].databases?.['pg-db']).toBeDefined()
})

test('a volume removal that cannot delete the bytes keeps the record and says so', async () => {
  // It deleted the registration FIRST (deploy reads it to drop the mount), then suppressed the
  // errors of the redeploy and of the directory removal, then reported `removed: true`. A
  // failed `data.remove` therefore left bytes on disk with no registration left to retry
  // through, and the API called it a success.
  const id = await sourceWithEveryStep()
  const remove = vi.spyOn(data, 'remove').mockImplementation(async (path: string) => {
    if (path.includes('/vol/')) throw new Error('device or resource busy')
  })

  let res
  try {
    res = await app.inject({ method: 'DELETE', url: `/projects/${id}/services/cp-web/volume` })
  } finally {
    remove.mockRestore()
  }

  expect(res.statusCode).toBeGreaterThanOrEqual(400)
  expect(res.json().error).toContain('the volume record is kept so the removal can be retried')
  // The record is back, with its stable id, so the bytes are still named by something.
  const vols = loadState().projects[id].computeVolumes
  expect(vols?.web).toBeDefined()
  // ...and the service still reports its volume, which is what a retry resolves through.
  expect((await get(`/projects/${id}/services/cp-web/volume`)).json().volume).toMatchObject({ mountPath: '/data' })
})

test('a volume removal holds the keys of a branch created while it queued', async () => {
  // It took no key at all, so a create could fork this very volume onto a new branch after the
  // loop took its snapshot: a freshly cloned directory the removal never visits, and a nested
  // `deploy` on a branch whose keys are not held.
  const id = await sourceWithEveryStep()
  const paused = pauseBeforeCommit()
  const create = post(`/projects/${id}/branches`, { name: 'feat' })
  await paused.entered

  // Pause the removal inside main's directory delete, so it is mid-flight and holding keys.
  let enterRemove!: () => void
  let goRemove!: () => void
  const inRemove = new Promise<void>((r) => { enterRemove = r })
  const removeGate = new Promise<void>((r) => { goRemove = r })
  const realRemove = data.remove.bind(data)
  const remove = vi.spyOn(data, 'remove').mockImplementation(async (path: string) => {
    if (path.includes('/vol/demo-main/')) { enterRemove(); await removeGate }
    return realRemove(path)
  })

  try {
    const del = app.inject({ method: 'DELETE', url: `/projects/${id}/services/cp-web/volume` })
    paused.release()
    expect((await within(10_000, create, 'the branch create')).statusCode).toBe(201)
    await within(10_000, inRemove, 'the volume removal')

    let deployed = false
    const deploy = post(`/projects/${id}/deploy`, { image: 'app:3', port: 3000, group: 'web', branch: 'feat' })
      .then((r) => { deployed = true; return r })
    await settle()
    // feat's keys are held by the removal now, so this waits instead of redeploying the group
    // the removal is in the middle of rebuilding.
    expect(deployed).toBe(false)

    goRemove()
    expect((await within(10_000, del, 'the volume removal')).statusCode).toBe(200)
    await within(10_000, deploy, 'the deploy')
    // ...and the clone's copy of the volume was visited too, not left behind.
    expect(calls.some((c) => c.startsWith('data.remove:') && c.includes('/vol/demo-feat/'))).toBe(true)
  } finally {
    goRemove()
    paused.release()
    paused.restore()
    remove.mockRestore()
  }
})

test('an attach cannot land inside a volume removal, so the restore cannot lose it', async () => {
  // The restore the removal does on failure is unconditional, which is only safe if nothing can
  // write that record while the removal runs. `setServiceVolume` is the other half of decision
  // 52's "volume ops" and took no key, so an attach could be lost by the restore, or survive a
  // removal that succeeded.
  const id = await sourceWithEveryStep()
  let enterRemove!: () => void
  let goRemove!: () => void
  const inRemove = new Promise<void>((r) => { enterRemove = r })
  const removeGate = new Promise<void>((r) => { goRemove = r })
  const realRemove = data.remove.bind(data)
  const remove = vi.spyOn(data, 'remove').mockImplementation(async (path: string) => {
    if (path.includes('/vol/')) { enterRemove(); await removeGate }
    return realRemove(path)
  })

  try {
    const del = app.inject({ method: 'DELETE', url: `/projects/${id}/services/cp-web/volume` })
    await within(10_000, inRemove, 'the volume removal')

    let attached = false
    const attach = put(`/projects/${id}/services/cp-web/volume`, { sizeGib: 7 }).then((r) => { attached = true; return r })
    await settle()
    expect(attached).toBe(false)          // it waits for the removal instead of racing its record

    goRemove()
    expect((await within(10_000, del, 'the volume removal')).statusCode).toBe(200)
    expect((await within(10_000, attach, 'the attach')).statusCode).toBe(200)
    // The attach ran after the removal, so it is the state that stands: one record, 7 GiB.
    expect(loadState().projects[id].computeVolumes?.web).toMatchObject({ sizeGib: 7 })
  } finally {
    goRemove()
    remove.mockRestore()
  }
})

// ---- direct service removal is fail-closed too, and holds its key --------------------------------
//
// The branch and project teardowns prove a container is gone before deleting the bytes it
// mounted and the row that names it. The four DIRECT removals did not: they recorded a failed
// `docker rm` and carried on, so a bind-mounted directory was erased from beneath a container
// that is still running and the row that could have retried it was dropped. One failure case per
// type, and one lock case per type whose key was added last round and bound by nothing.

/** Something holds a service's operation key: in practice a rename, a deploy or a lifecycle op. */
function holdKey(key: string): { held: Promise<unknown>; release(): void } {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = () => { r() } })
  const held = engine.withOp([key], () => gate)
  return { held, release }
}

test('a compute removal whose container refuses to go keeps its volume bytes and its row', async () => {
  const id = await sourceWithEveryStep()
  const bid = await branchOf(id, 'main')
  calls.length = 0
  vi.mocked(dockerFn).mockImplementation(async (args: string[]) => {
    if (args[0] === 'rm' && args.includes('io-demo-main-app-web')) throw new Error('container is in use')
    return Buffer.from('')     // ...and `docker ps -a` still lists it, so it is NOT proven gone
  })
  let res
  try {
    res = await del_(`/projects/${id}/services/cp-web`)
  } finally {
    vi.mocked(dockerFn).mockImplementation(fakeDocker)
  }

  expect(res.statusCode).toBe(409)          // the service is still there
  expect(res.json().teardown.failed).toBeGreaterThan(0)
  expect(res.json().error).toContain('io-demo-main-app-web')
  expect(res.json().error).toContain('insta services remove cp-web')
  expect(calls.filter((c) => c.startsWith('data.remove:'))).toEqual([])
  expect(loadState().branches[bid].apps.web).toBeDefined()
})

test('a postgres removal whose container refuses to go keeps its data directory and its row', async () => {
  const id = await sourceWithEveryStep()
  const bid = await branchOf(id, 'main')
  calls.length = 0
  const destroy = vi.spyOn(db, 'destroy').mockRejectedValueOnce(new Error('container is in use'))
  let res
  try {
    res = await del_(`/projects/${id}/services/pg-db`)
  } finally {
    destroy.mockRestore()
  }

  expect(res.json().teardown.failed).toBeGreaterThan(0)
  expect(calls.filter((c) => c.startsWith('data.remove:'))).toEqual([])
  expect(loadState().branches[bid].databases?.['pg-db']).toBeDefined()
})

test('a managed removal whose container refuses to go keeps its data directory and its row', async () => {
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })).statusCode).toBe(201)
  const bid = await branchOf(id, 'main')
  calls.length = 0
  const destroy = vi.spyOn(managed, 'destroy').mockRejectedValueOnce(new Error('container is in use'))
  let res
  try {
    res = await del_(`/projects/${id}/services/rd-cache`)
  } finally {
    destroy.mockRestore()
  }

  expect(res.json().teardown.failed).toBeGreaterThan(0)
  expect(calls.filter((c) => c.startsWith('data.remove:'))).toEqual([])
  expect(loadState().branches[bid].managed?.['rd-cache']).toBeDefined()
})

test('a storage removal whose bucket refuses to go keeps its row', async () => {
  const id = await sourceWithEveryStep()
  const bid = await branchOf(id, 'main')
  const destroy = vi.spyOn(storage, 'destroy').mockRejectedValueOnce(new Error('could not delete bucket io-demo-main-store'))
  let res
  try {
    res = await del_(`/projects/${id}/services/st-store`)
  } finally {
    destroy.mockRestore()
  }

  expect(res.json().teardown.failed).toBeGreaterThan(0)
  // Unregistering over a bucket that is still there leaves objects and keys nobody can reach.
  expect(loadState().branches[bid].buckets?.['st-store']).toBeDefined()
})

test('the compute, managed and storage removals hold their service key', async () => {
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })).statusCode).toBe(201)
  const bid = await branchOf(id, 'main')

  for (const sid of ['cp-web', 'rd-cache', 'st-store']) {
    const holder = holdKey(`${bid}:${sid}`)
    let done = false
    const removal = del_(`/projects/${id}/services/${sid}`).then((r) => { done = true; return r })
    await settle()
    // Each of these took no key at all until last round, and nothing bound the ones that were
    // added: dropping the `withOp` again leaves the suite green without this.
    expect(done, sid).toBe(false)
    holder.release()
    await holder.held
    expect((await within(10_000, removal, `the ${sid} removal`)).statusCode).toBe(200)
  }
})

test('a cleanup-failed branch is refused as a fork source and as a deploy target', async () => {
  // Keeping the row is right, and it is now the NORMAL outcome of a failed teardown, so these
  // rows are common. A half-demolished branch is not a branch to build on: some of its
  // containers and bytes are gone and which is which is exactly what nobody knows, so forking
  // one copies whatever survived into a branch that looks healthy.
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  const feat = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')!
  const destroy = vi.spyOn(db, 'destroy').mockRejectedValueOnce(new Error('container is in use'))
  try {
    expect((await del_(`/projects/${id}/branches/${feat.id}`)).statusCode).toBe(409)
  } finally {
    destroy.mockRestore()
  }
  expect(loadState().branches[feat.id].status).toBe('cleanup-failed')

  const forked = await post(`/projects/${id}/branches`, { name: 'feat2', from: 'feat' })
  expect(forked.statusCode).toBeGreaterThanOrEqual(400)
  expect(forked.json().error).toContain('cannot be forked')
  const deployed = await post(`/projects/${id}/deploy`, { image: 'app:9', port: 3000, group: 'web', branch: 'feat' })
  expect(deployed.statusCode).toBeGreaterThanOrEqual(400)
  expect(deployed.json().error).toContain('cannot be deployed to')
  // ...and every other path that MATERIALISES something onto a branch, not just the two named
  // first: a merge in either direction, and each of the three service adds.
  const merged = await post(`/projects/${id}/branches/feat/merge`, { from: 'main' })
  expect(merged.statusCode).toBeGreaterThanOrEqual(400)
  expect(merged.json().error).toContain('cannot be merged into')
  const mergedFrom = await post(`/projects/${id}/branches/main/merge`, { from: 'feat' })
  expect(mergedFrom.statusCode).toBeGreaterThanOrEqual(400)
  expect(mergedFrom.json().error).toContain('cannot be merged from')
  for (const svc of [{ type: 'postgres', name: 'db9' }, { type: 'storage', name: 'store9' }, { type: 'redis', name: 'cache9' }]) {
    const added = await post(`/projects/${id}/services?branch=feat`, { ...svc, branch: 'feat' })
    expect(added.statusCode, svc.type).toBeGreaterThanOrEqual(400)
    expect(added.json().error, svc.type).toContain('cannot be given new services')
  }
  // ...and the way out is the one the message names: the delete retries the demolition.
  expect((await del_(`/projects/${id}/branches/${feat.id}`)).statusCode).toBe(200)
  expect(loadState().branches[feat.id]).toBeUndefined()
})

test('a lifecycle verb queued behind a compute rename refuses instead of answering "none"', async () => {
  // The last site where an operation acted on an identity it resolved before its lock.
  // `lifecycleLocked` re-reads the branch row but tested the PRE-LOCK group name, so a rename
  // that landed while the verb queued made `branch.apps[group]` undefined, the body was
  // skipped, and it answered 200 {"state":"none"} having done nothing -- the same answer as a
  // group that is registered and never deployed, which is a real case.
  const id = await sourceWithEveryStep()
  let enterRename!: () => void
  let goRename!: () => void
  const inRename = new Promise<void>((r) => { enterRename = r })
  const renameGate = new Promise<void>((r) => { goRename = r })
  const realRename = compute.rename!.bind(compute)
  const rename = vi.spyOn(compute, 'rename').mockImplementation(async (ref, from_, to) => {
    enterRename()
    await renameGate
    return realRename(ref, from_, to)
  })

  try {
    const renaming = post(`/projects/${id}/services/cp-web/rename`, { name: 'api' })
    await within(10_000, inRename, 'the rename')
    let stopped = false
    const stop = post(`/projects/${id}/services/cp-web/stop`).then((r) => { stopped = true; return r })
    await settle()
    expect(stopped).toBe(false)

    goRename()
    expect((await within(10_000, renaming, 'the rename')).statusCode).toBe(200)
    const answer = await within(10_000, stop, 'the stop')

    expect(answer.statusCode).toBeGreaterThanOrEqual(400)
    expect(answer.json().error).toContain('changed while this stop was queued')
    // ...and the group that now exists is untouched: nothing was stopped behind the operator's back.
    expect(loadState().branches[await branchOf(id, 'main')].apps.api?.desiredState).not.toBe('stopped')
  } finally {
    goRename()
    rename.mockRestore()
  }
})

test('the cleanup-failed DEFAULT branch is told to re-run the project delete, not the branch one', async () => {
  // `destroyProject` marks every branch whose teardown failed, the default included, and
  // `insta branch delete` refuses the default branch outright: pointing there is a dead end,
  // and the message was the operator's only way out.
  const id = await sourceWithEveryStep()
  const destroy = vi.spyOn(db, 'destroy').mockRejectedValueOnce(new Error('container is in use'))
  try {
    await engine.destroyProject(id).catch(() => undefined)
  } finally {
    destroy.mockRestore()
  }
  const main = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'main')!
  expect(main.status).toBe('cleanup-failed')
  expect(main.isDefault).toBe(true)

  const deployed = await post(`/projects/${id}/deploy`, { image: 'app:9', port: 3000, group: 'web' })
  expect(deployed.statusCode).toBeGreaterThanOrEqual(400)
  expect(deployed.json().error).toContain('insta project delete')
  expect(deployed.json().error).not.toContain('insta branch delete')
})

test('a registered group that was never deployed is still a no-op, not a refusal', async () => {
  // The case the refusal must not swallow: `services add compute` registers a project-level
  // name, and until a deploy puts a container on a branch the verb has nothing to do there.
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })).statusCode).toBe(201)
  const res = await post(`/projects/${id}/services/cp-worker/stop`)
  expect(res.statusCode).toBe(200)
  expect(res.json().state).toBe('none')
})

test('a branch delete re-drives its keys when a service is added while it queues', async () => {
  // The delete builds `branchKeys` BEFORE it waits. An add only HOLDS the branch key while it
  // provisions, so an add already in flight when the delete snapshots finishes and releases
  // before the delete acquires: its new service is outside the key set the delete is holding.
  // The delete then tears that service down with none of its keys held, and a traffic wake can
  // take the service key independently and race `docker start` against the container removal,
  // the network removal and the data deletion.
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  const feat = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')!

  // 1. An add is IN FLIGHT on feat, holding its branch key.
  let enterAdd!: () => void
  let goAdd!: () => void
  const inAdd = new Promise<void>((r) => { enterAdd = r })
  const addGate = new Promise<void>((r) => { goAdd = r })
  const realProvision = db.provision.bind(db)
  const provision = vi.spyOn(db, 'provision').mockImplementationOnce(async (t, opts) => {
    enterAdd()
    await addGate
    return realProvision(t, opts)
  })

  // 2. ...and the delete snapshots its keys now, without pg-db2, which does not exist yet.
  let enterTeardown!: () => void
  let goTeardown!: () => void
  const inTeardown = new Promise<void>((r) => { enterTeardown = r })
  const teardownGate = new Promise<void>((r) => { goTeardown = r })
  const realStDestroy = storage.destroy.bind(storage)
  const stDestroy = vi.spyOn(storage, 'destroy').mockImplementation(async (bucket, network) => {
    if (bucket.includes('demo-feat')) { enterTeardown(); await teardownGate }
    return realStDestroy(bucket, network)
  })

  try {
    const add = post(`/projects/${id}/services?branch=feat`, { type: 'postgres', name: 'db2', branch: 'feat' })
    await within(10_000, inAdd, 'the service add')
    let deleted = false
    const del = del_(`/projects/${id}/branches/${feat.id}`).then((r) => { deleted = true; return r })
    await settle()
    expect(deleted).toBe(false)

    // 3. The add completes and releases; the delete acquires and re-reads a row carrying db2.
    goAdd()
    expect((await within(10_000, add, 'the service add')).statusCode).toBe(201)
    await within(10_000, inTeardown, 'the teardown of feat')

    // 4. A traffic wake on the NEW service, while the teardown is running. With the re-drive
    //    the delete holds that key, so this waits; without it, it runs INSIDE the teardown and
    //    races `docker start` against the removal.
    let woke = false
    const wake = engine.wake(`${feat.id}:pg-db2`, { door: 'traffic' })
      .then(() => { woke = true }).catch(() => { woke = true })
    await settle()
    expect(woke).toBe(false)

    goTeardown()
    expect((await within(10_000, del, 'the branch delete')).statusCode).toBe(200)
    await within(10_000, wake, 'the wake')
    // The new service went with the branch: its container was destroyed and no row is left.
    expect(calls).toContain('db.destroy:io-demo-feat-pg-db2')
    expect(Object.values(loadState().branches).filter((b) => b.projectId === id).map((b) => b.name)).toEqual(['main'])
  } finally {
    goAdd()
    goTeardown()
    provision.mockRestore()
    stDestroy.mockRestore()
  }
})

test('a container that was never there is not counted as a demolition', async () => {
  // `removeContainer` incremented `destroyed` whenever the container was gone AFTERWARDS,
  // including when it had never been there, so the summary counted work that did not happen.
  // The removal is still attempted; only the COUNT is conditional.
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  const feat = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')!

  // Its postgres container vanished out of band: the row still names it, docker does not have it.
  runtime.drop('io-demo-feat-pg-db')
  const withGhost = (await del_(`/projects/${id}/branches/${feat.id}`)).json().teardown as { destroyed: number; failed: number }

  // ...and the same branch shape with the container really there, as the baseline.
  expect((await post(`/projects/${id}/branches`, { name: 'feat2' })).statusCode).toBe(201)
  const feat2 = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat2')!
  const whole = (await del_(`/projects/${id}/branches/${feat2.id}`)).json().teardown as { destroyed: number; failed: number }

  expect(whole.failed).toBe(0)
  expect(withGhost.failed).toBe(0)
  // Exactly one fewer demolition, because exactly one container was not there to demolish.
  expect(withGhost.destroyed).toBe(whole.destroyed - 1)
})

test('bytes that could not be removed keep the row too, and the advised retry works', async () => {
  // The fail-closed rule reached the CONTAINER arm of all four removals and the BYTES arm of
  // only one (storage). With the container removed and `data.remove` failing, the other three
  // answered 409 saying the row was kept and to retry, dropped the row, the scheduler key and
  // the registration anyway, and the retry then answered 404 -- with the directory still on
  // disk and nothing naming it. Asserting the 409 alone passes on the broken code; what binds
  // it is the row surviving AND the retry working.
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })).statusCode).toBe(201)
  const bid = await branchOf(id, 'main')

  for (const [sid, present] of [['pg-db', 'databases'], ['rd-cache', 'managed'], ['cp-web', 'apps']] as const) {
    const busy = vi.spyOn(data, 'remove').mockImplementation(async (path: string) => {
      if (path.includes('/pg/') || path.includes('/md/') || path.includes('/vol/')) throw new Error('device or resource busy')
    })
    let refused
    try {
      refused = await del_(`/projects/${id}/services/${sid}`)
    } finally {
      busy.mockRestore()
    }

    expect(refused.statusCode, sid).toBe(409)
    expect(refused.json().teardown.failed, sid).toBeGreaterThan(0)
    // The row the 409 says it kept is actually there...
    const row = loadState().branches[bid]
    const held = present === 'apps' ? row.apps.web : present === 'databases' ? row.databases?.['pg-db'] : row.managed?.['rd-cache']
    expect(held, sid).toBeDefined()
    // ...the service still lists, so the id in the retry resolves...
    const rows = (await get(`/projects/${id}/services?branch=main`)).json().services as Array<{ id: string }>
    expect(rows.some((r) => r.id === sid), sid).toBe(true)
    // ...and the retry the message advises actually works, rather than answering 404.
    const retry = await del_(`/projects/${id}/services/${sid}`)
    expect(retry.statusCode, sid).toBe(200)
    expect(retry.json().teardown.failed, sid).toBe(0)
  }
})

test('the branch teardown gates its row on the BYTES arm too, and the retry finishes it', async () => {
  // The same question one level up, answered by measurement rather than by reading: the branch
  // and project teardowns decide the row from the WHOLE counter (`t.failed === 0`), not from
  // the container step, so a data root that refuses keeps the row exactly as a surviving
  // container does. This pins that, because the two arms were fixed in different rounds.
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  const feat = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')!

  const busy = vi.spyOn(data, 'remove').mockImplementation(async (path: string) => {
    if (path.includes('demo-feat')) throw new Error('device or resource busy')
  })
  let refused
  try {
    refused = await del_(`/projects/${id}/branches/${feat.id}`)
  } finally {
    busy.mockRestore()
  }

  // Containers all went; only the bytes refused. The row stays, marked, and says why.
  expect(refused.statusCode).toBe(409)
  expect(refused.json().teardown.failed).toBeGreaterThan(0)
  expect(refused.json().error).toContain('data directory')
  expect(loadState().branches[feat.id]?.status).toBe('cleanup-failed')
  // ...and the retry the message advises finishes the demolition.
  const retry = await del_(`/projects/${id}/branches/${feat.id}`)
  expect(retry.statusCode).toBe(200)
  expect(retry.json().teardown.failed).toBe(0)
  expect(loadState().branches[feat.id]).toBeUndefined()
})

test('a teardown that did not finish keeps the row, the scheduler ledger AND the domains', async () => {
  // The row survives a failed demolition, and so must everything that names it. Forgetting a
  // key whose container is still up drops that service's ledger and its in-flight hold counts,
  // so a container still holding RAM is bookkept as new; releasing the hostnames while the old
  // container is still answering on them lets something else claim them.
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  const feat = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')!
  const key = `${feat.id}:cp-web`
  expect((await post(`/projects/${id}/compute/domain?branch=feat`, { hostname: 'kept.example.com', group: 'web' })).statusCode).toBe(200)

  // Something is in flight on the group when the teardown runs, which is what a hold count is.
  engine.beginHold(key)
  const destroy = vi.spyOn(db, 'destroy').mockRejectedValueOnce(new Error('container is in use'))
  let refused
  try {
    refused = await del_(`/projects/${id}/branches/${feat.id}`)
  } finally {
    destroy.mockRestore()
  }

  expect(refused.statusCode).toBe(409)
  expect(loadState().branches[feat.id]?.status).toBe('cleanup-failed')
  // The scheduler still knows the service: its hold count survived the failed teardown.
  expect(engine.holds(key)).toBe(1)
  // ...and the hostname is still claimed, not free for something else to take.
  expect(loadState().customDomains?.['kept.example.com']).toBeDefined()

  // The retry finishes the demolition and releases all three together.
  engine.endHold(key)
  expect((await del_(`/projects/${id}/branches/${feat.id}`)).statusCode).toBe(200)
  expect(loadState().branches[feat.id]).toBeUndefined()
  expect(loadState().customDomains?.['kept.example.com']).toBeUndefined()
})

test('a SUCCESSFUL create whose destination is renamed mid-flight does not leak its secrets', async () => {
  // The mirror of the source-side bug, and worse. `provisionBranch` commits the clone's row
  // before the post-commit steps, so a rename can move it while the volumes fork and the
  // containers deploy. The secret copy wrote the inherited rows under the name captured at the
  // start, and resolution is BY NAME: the renamed branch does not get them, and the next branch
  // to take the freed old name DOES. A cross-branch leak of credentials.
  const id = await sourceWithEveryStep()
  // Paused inside the clone's own redeploy, which is the last post-commit step before the
  // secrets are copied: the rename then lands in the window the finding is about and the
  // create still SUCCEEDS. (A rename landing earlier, before the redeploy loop resolves the
  // clone by name, fails the create loudly and unwinds it, which is the documented residual.)
  let enterDeploy!: () => void
  let goDeploy!: () => void
  const inDeploy = new Promise<void>((r) => { enterDeploy = r })
  const deployGate = new Promise<void>((r) => { goDeploy = r })
  const realDeploy = compute.deploy.bind(compute)
  const deploySpy = vi.spyOn(compute, 'deploy').mockImplementation(async (ref, o) => {
    if (ref.includes('demo-feat')) { enterDeploy(); await deployGate }
    return realDeploy(ref, o)
  })
  const create = post(`/projects/${id}/branches`, { name: 'feat' })
  await within(10_000, inDeploy, "the clone's redeploy")
  const featId = Object.values(loadState().branches).find((b) => b.projectId === id && b.name === 'feat')!.id

  try {
    // The rename lands in the window: past the row's commit, before the secrets are copied.
    expect((await app.inject({ method: 'PATCH', url: `/projects/${id}/branches/${featId}`, payload: { name: 'renamed' } })).statusCode).toBe(200)
    goDeploy()
    expect((await within(10_000, create, 'the branch create')).statusCode).toBe(201)
  } finally {
    goDeploy()
    deploySpy.mockRestore()
  }

  // Half one: the branch that exists has the secrets it inherited.
  expect((await get(`/projects/${id}/secrets?branch=renamed`)).json().secrets.API_KEY).toBe('from-main')
  // ...and the event names the branch as it stands, not as the create first saw it.
  const ev = loadState().events.filter((e) => e.kind === 'branch.created' && e.branch === 'renamed')
  expect(ev).toHaveLength(1)

  // Half two, THE LEAK. Nothing may be filed under the freed name, or under any name no
  // branch holds: those rows are what a later branch picks up.
  expect((loadState().userSecrets[id] ?? []).filter((u) => u.branch === 'feat')).toEqual([])
  const names = new Set(Object.values(loadState().branches).filter((b) => b.projectId === id).map((b) => b.name))
  for (const u of loadState().userSecrets[id] ?? []) {
    if (u.branch !== null) expect(names.has(u.branch), `${u.name}@${u.branch}`).toBe(true)
  }

  // ...and the branch that later TAKES that name gets only what it inherits itself. (The name
  // frees on the rename but the ref does not, so reusing it means deleting the renamed branch
  // first, which is the reachable path: a branch delete does not sweep secret rows.)
  expect((await del_(`/projects/${id}/branches/${featId}`)).statusCode).toBe(200)
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  const rows = (loadState().userSecrets[id] ?? []).filter((u) => u.branch === 'feat' && u.name === 'API_KEY')
  expect(rows).toHaveLength(1)
  expect((await get(`/projects/${id}/secrets?branch=feat`)).json().secrets.API_KEY).toBe('from-main')
})

test('each cleanup-failed event of a project delete reports THAT branch, not the shared counter', async () => {
  // `destroyProject` runs every branch through ONE `Teardown`. The row, the scheduler keys and
  // the domains moved to the per-branch delta; this event did not, so the second failing branch
  // reported the FIRST one's container as the thing that refused to go, plus a failure count and
  // a destroyed count that were the call's, not the branch's.
  const id = await sourceWithEveryStep()
  for (const name of ['feat-a', 'feat-b']) {
    expect((await post(`/projects/${id}/branches`, { name })).statusCode).toBe(201)
  }
  const realDestroy = db.destroy.bind(db)
  const destroy = vi.spyOn(db, 'destroy').mockImplementation(async (container: string) => {
    if (container.includes('demo-feat-')) throw new Error('container is in use')
    return realDestroy(container)
  })
  try {
    await engine.destroyProject(id)
  } finally {
    destroy.mockRestore()
  }

  const failed = engine.listEvents(id).filter((e) => e.kind === 'branch.cleanupFailed')
  expect(failed.map((e) => e.branch)).toEqual(['feat-a', 'feat-b'])
  for (const e of failed) {
    const teardown = (e.payload as { teardown: { destroyed: number; failed: number; reasons?: string[] } }).teardown
    // One failure, and the container it names is this branch's own.
    expect(teardown.failed).toBe(1)
    expect(teardown.reasons).toHaveLength(1)
    expect(teardown.reasons![0]).toContain(`demo-${e.branch}-`)
  }
  // Two branches of the same shape did the same amount of demolition, and neither of them counts
  // what `main` (torn down first, cleanly) took with it.
  const counts = failed.map((e) => (e.payload as { teardown: { destroyed: number } }).teardown.destroyed)
  expect(counts[0]).toBe(counts[1])
})

test('a branch delete that refuses says why, instead of a blanket 404', async () => {
  // Every throw out of `destroyBranch` used to answer 404. The default branch WAS found, so a
  // 404 sends the operator looking for a branch that is right there, and the retryable lock-set
  // exhaustion (409 on this file's create path) reads as permanent.
  const id = await sourceWithEveryStep()
  const main = await branchOf(id, 'main')
  const def = await app.inject({ method: 'DELETE', url: `/projects/${id}/branches/${main}` })
  expect(def.statusCode).toBe(409)
  expect(def.json().error).toBe('cannot delete the default branch')
  // ...and a branch that really is not there still answers 404.
  const gone = await app.inject({ method: 'DELETE', url: `/projects/${id}/branches/nope` })
  expect(gone.statusCode).toBe(404)
  expect(gone.json().error).toBe('branch not found')
})

test('a successful branch delete takes the branch-scoped secrets with it', async () => {
  // A user secret is keyed by branch NAME and a create inherits by name, so rows a delete left
  // behind are resurrected by the next branch of that name -- shadowing the project-wide value,
  // and handing back a credential the delete may have been retiring.
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  const fid = await branchOf(id, 'feat')
  // A value only `feat` ever held: `main` cannot be the source of what the new branch reads.
  expect((await put(`/projects/${id}/secrets/FEAT_ONLY`, { value: 'feat-secret', branch: 'feat' })).statusCode).toBe(200)

  const del = await app.inject({ method: 'DELETE', url: `/projects/${id}/branches/${fid}` })
  expect(del.statusCode).toBe(200)
  expect(del.json().teardown.failed).toBe(0)
  expect((loadState().userSecrets[id] ?? []).filter((u) => u.branch === 'feat')).toEqual([])

  // ...so a new branch of the same name, forked from a parent that never held it, does not read it.
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  expect((await get(`/projects/${id}/secrets?branch=feat`)).json().secrets.FEAT_ONLY).toBeUndefined()
})

test('a branch delete that FAILED keeps the secrets its retry still needs', async () => {
  // The other arm, on the same gate as the row: a kept `cleanup-failed` row is a branch that
  // still exists, and the retry deploys and reads with those secrets.
  const id = await sourceWithEveryStep()
  expect((await post(`/projects/${id}/branches`, { name: 'feat' })).statusCode).toBe(201)
  const fid = await branchOf(id, 'feat')
  expect((await put(`/projects/${id}/secrets/FEAT_ONLY`, { value: 'feat-secret', branch: 'feat' })).statusCode).toBe(200)

  const destroy = vi.spyOn(db, 'destroy').mockRejectedValueOnce(new Error('container is in use'))
  try {
    const del = await app.inject({ method: 'DELETE', url: `/projects/${id}/branches/${fid}` })
    expect(del.statusCode).toBe(409)
  } finally {
    destroy.mockRestore()
  }
  expect(loadState().branches[fid]?.status).toBe('cleanup-failed')
  expect((loadState().userSecrets[id] ?? []).filter((u) => u.branch === 'feat').map((u) => u.name).sort())
    .toEqual(['API_KEY', 'FEAT_ONLY'])
})

test('a project delete with MIXED results releases each branch by its own outcome', async () => {
  // `destroyProject` shares ONE `Teardown` across every branch and decides each row by the
  // per-branch DELTA. A cumulative `t.failed > 0` guard on the keys and domains therefore
  // disagreed with it: a branch demolished completely AFTER an earlier branch failed kept its
  // scheduler keys and its hostnames while its row was deleted, orphaning both permanently,
  // because a retry only walks branch rows that still exist.
  const id = await sourceWithEveryStep()
  for (const name of ['feat-a', 'feat-b']) {
    expect((await post(`/projects/${id}/branches`, { name })).statusCode).toBe(201)
    expect((await post(`/projects/${id}/compute/domain?branch=${name}`, { hostname: `${name}.example.com`, group: 'web' })).statusCode).toBe(200)
  }
  const branchOfName = (name: string): string =>
    Object.values(loadState().branches).find((b) => b.projectId === id && b.name === name)!.id
  const aId = branchOfName('feat-a')
  const bId = branchOfName('feat-b')
  // The failing branch must be torn down BEFORE the succeeding one for the bug to be reachable.
  const order = engine.listBranches(id).map((b) => b.name)
  expect(order.indexOf('feat-a')).toBeLessThan(order.indexOf('feat-b'))
  engine.beginHold(`${aId}:cp-web`)
  engine.beginHold(`${bId}:cp-web`)

  const realDestroy = db.destroy.bind(db)
  const destroy = vi.spyOn(db, 'destroy').mockImplementation(async (container: string) => {
    if (container.includes('demo-feat-a-')) throw new Error('container is in use')
    return realDestroy(container)
  })
  try {
    await engine.destroyProject(id)
  } finally {
    destroy.mockRestore()
  }

  const st = loadState()
  // The branch that FAILED keeps all three: row, hold, hostname.
  expect(st.branches[aId]?.status).toBe('cleanup-failed')
  expect(engine.holds(`${aId}:cp-web`)).toBe(1)
  expect(st.customDomains?.['feat-a.example.com']).toBeDefined()
  // The branch that SUCCEEDED releases all three, even though an earlier branch had failed.
  expect(st.branches[bId]).toBeUndefined()
  expect(engine.holds(`${bId}:cp-web`)).toBe(0)
  expect(st.customDomains?.['feat-b.example.com']).toBeUndefined()
  // ...and the project row is kept, because a branch row outlived its teardown.
  expect(st.projects[id]).toBeDefined()
})

test('a create that fails post-commit emits no branch.created event', async () => {
  const id = await sourceWithEveryStep()
  const cloneInto = vi.spyOn(storage, 'cloneInto').mockRejectedValueOnce(new Error('bucket boom'))
  await post(`/projects/${id}/branches`, { name: 'feat' })
  cloneInto.mockRestore()
  // `kind`, not `action`: an AuditEvent has no `action`, so the filter this line used to make was
  // empty whatever happened and the test asserted nothing.
  expect(loadState().events.filter((e) => e.kind === 'branch.created' && e.branch === 'feat')).toEqual([])
})

/** The default branch's id (host reservations and app rows are keyed by it). */
async function branchOf(id: string, name = 'main'): Promise<string> {
  return (await get(`/projects/${id}/branches`)).json().branches.find((b: { name: string }) => b.name === name).id
}
// ---- end region WP2 ----

// ---- region WP3 (scheduler) ----
// The scheduler's HTTP surface: always-on, limits, the sleep vocabulary the CLI and the dashboard
// print, and the two database rules (management wakes, observability refuses). Each test builds its
// OWN engine so it can drive the scheduler directly, the way the sweep would.
import { runtime as fakeRuntime } from './fakes'

/** A project on a fresh engine this test can reach into (`app` is rebound to it). */
async function wp3Project(name = 'demo'): Promise<{ engine: Engine; id: string }> {
  const engine = makeEngine()
  app = buildServer(engine)
  const id = await createProject(name)
  return { engine, id }
}

/** The branch's id (what a ServiceKey is built from). */
async function branchId(id: string, name = 'main'): Promise<string> {
  return (await get(`/projects/${id}/branches`)).json().branches.find((b: { name: string }) => b.name === name).id
}

const keyFor = (bid: string, serviceId: string): string => `${bid}:${serviceId}`

test('PUT always-on: 200 with always_on on the row, 400 for postgres and storage, 404 unknown, and an event', async () => {
  const { id } = await wp3Project()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'default' })
  const r = await put(`/projects/${id}/services/cp-default/always-on`, { enabled: true })
  expect(r.statusCode).toBe(200)
  expect(r.json().service).toMatchObject({ id: 'cp-default', always_on: true })
  expect((await get(`/projects/${id}/events`)).json().events.map((e: { kind: string }) => e.kind)).toContain('service.alwaysOn')
  // ...and off again.
  expect((await put(`/projects/${id}/services/cp-default/always-on`, { enabled: false })).json().service.always_on).toBe(false)
  // A database that scales to zero has its own lever (PATCH database/settings), and object storage
  // has no runtime at all.
  for (const sid of ['pg-db', 'st-store']) {
    const bad = await put(`/projects/${id}/services/${sid}/always-on`, { enabled: true })
    expect(bad.statusCode, sid).toBe(400)
    expect(bad.json().error).toBe('alwaysOn is only supported for compute and managed database services')
  }
  expect((await put(`/projects/${id}/services/cp-nope/always-on`, { enabled: true })).statusCode).toBe(404)
  expect((await put(`/projects/${id}/services/cp-default/always-on`, { enabled: 'yes' })).statusCode).toBe(400)
})

test('services rows carry always_on on compute and managed rows only', async () => {
  const { id } = await wp3Project()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'default' })
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  const rows = (await get(`/projects/${id}/services`)).json().services
  const byId = Object.fromEntries(rows.map((r: { id: string }) => [r.id, r]))
  expect(byId['cp-default'].always_on).toBe(false)
  expect(byId['rd-cache'].always_on).toBe(false)
  expect(byId['pg-db'].always_on).toBeUndefined()
  expect(byId['st-store'].always_on).toBeUndefined()
})

test('a branch-qualified sid writes the BARE project-level key and resizes every branch container', async () => {
  const { id } = await wp3Project()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'web' })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'web' })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  const feat = await branchId(id, 'feat')
  calls.length = 0
  // The id the CLI reads off `GET /services?branch=feat` (decision 49).
  const r = await put(`/projects/${id}/services/${feat}:cp-web/limits`, { memoryMb: 512 })
  expect(r.statusCode).toBe(200)
  expect(r.json().limits).toEqual({ cpu: 1, memoryMb: 512 })
  // Both branches' containers are resized, and the SETTING is stored under the bare service id, so
  // `GET limits` with no branch reads it back.
  expect(calls).toContain('runtime.update:io-demo-main-app-web:1/512')
  expect(calls).toContain('runtime.update:io-demo-feat-app-web:1/512')
  expect((await get(`/projects/${id}/services/cp-web/limits`)).json().limits).toEqual({ cpu: 1, memoryMb: 512 })
  expect((await put(`/projects/${id}/services/${feat}:cp-web/always-on`, { enabled: true })).statusCode).toBe(200)
  expect((await get(`/projects/${id}/services`)).json().services.find((x: { id: string }) => x.id === 'cp-web').always_on).toBe(true)
})

test('GET limits: the host ceiling, the cap and the volume; PUT derives cpu and validates the grid', async () => {
  const { id } = await wp3Project()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'web', volumeGib: 3 })
  const unset = (await get(`/projects/${id}/services/cp-web/limits`)).json()
  expect(unset.cap).toEqual({ cpu: 8, memoryMb: 8192, volumeGib: 100 })
  expect(unset.volume).toEqual({ sizeGib: 3, mountPath: '/data' })
  // Unset reports the effective host ceiling snapped to the grid (decision 15).
  expect(unset.limits.cpu).toBeGreaterThanOrEqual(1)
  expect(unset.limits.memoryMb % 256).toBe(0)

  // cpu is derived from the memory when it is not given: 4096 MB needs 2 vCPU.
  expect((await put(`/projects/${id}/services/cp-web/limits`, { memoryMb: 4096 })).json().limits).toEqual({ cpu: 2, memoryMb: 4096 })
  const bad: Array<[Record<string, number>, RegExp]> = [
    [{ memoryMb: 512, cpu: 3 }, /cpu must be one of 1, 2, 4, 6, 8 \(provider vCPU sizes\); got 3/],
    [{ memoryMb: 300 }, /memoryMb must be a multiple of 256; got 300/],
    [{ memoryMb: 8192, cpu: 1 }, /1 vCPU allows 256 to 2048 MB of memory; got 8192/],
    [{ memoryMb: 16384, cpu: 8 }, /8 vCPU supports 2048 to 16384 MB|ceiling/],
  ]
  for (const [body, msg] of bad) {
    const r = await put(`/projects/${id}/services/cp-web/limits`, body)
    expect(r.statusCode, JSON.stringify(body)).toBe(400)
    expect(r.json().error, JSON.stringify(body)).toMatch(msg)
  }
  // The stored ceiling is untouched by every refusal above.
  expect((await get(`/projects/${id}/services/cp-web/limits`)).json().limits).toEqual({ cpu: 2, memoryMb: 4096 })
  expect((await get(`/projects/${id}/services/pg-db/limits`)).statusCode).toBe(400)
  expect((await get(`/projects/${id}/services/cp-nope/limits`)).statusCode).toBe(404)
})

test('a resize that fails on one machine is a 502 and leaves the stored ceiling alone', async () => {
  const { id } = await wp3Project()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect((await put(`/projects/${id}/services/cp-default/limits`, { memoryMb: 512 })).statusCode).toBe(200)
  // The feat container disappears (a hand-removed container, a crashed machine).
  fakeRuntime.drop('io-demo-feat-app-default')
  const r = await put(`/projects/${id}/services/cp-default/limits`, { memoryMb: 1024 })
  expect(r.statusCode).toBe(502)
  expect(r.json().error).toMatch(/resize failed on the compute provider:.*applied to 1\/2 machines; the stored ceiling is unchanged/)
  expect((await get(`/projects/${id}/services/cp-default/limits`)).json().limits).toEqual({ cpu: 1, memoryMb: 512 })
})

test('PUT limits is gated service.upgrade, and a no-op re-submit records no event', async () => {
  const { id } = await wp3Project()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'default' })
  expect((await get(`/projects/${id}/policy`)).json().policy['service.upgrade']).toBe('allow')
  await put(`/projects/${id}/policy/service.upgrade`, { decision: 'approve' })
  const held = await put(`/projects/${id}/services/cp-default/limits`, { memoryMb: 512 })
  expect(held.statusCode).toBe(202)
  expect(held.json()).toMatchObject({ status: 'approval_required', action: 'service.upgrade' })
  await post(`/projects/${id}/approvals/${held.json().approvalId}/approve`)
  expect((await put(`/projects/${id}/services/cp-default/limits`, { memoryMb: 512 })).statusCode).toBe(200)

  await put(`/projects/${id}/policy/service.upgrade`, { decision: 'allow' })
  const before = (await get(`/projects/${id}/events`)).json().events.filter((e: { kind: string }) => e.kind === 'service.limits').length
  expect((await put(`/projects/${id}/services/cp-default/limits`, { memoryMb: 512 })).json().limits).toEqual({ cpu: 1, memoryMb: 512 })
  const after = (await get(`/projects/${id}/events`)).json().events.filter((e: { kind: string }) => e.kind === 'service.limits').length
  expect(after).toBe(before)
})

test('a deploy carries the recorded ceiling into the new container', async () => {
  const { id } = await wp3Project()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'default' })
  await put(`/projects/${id}/services/cp-default/limits`, { memoryMb: 512, cpu: 1 })
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  expect(calls).toContain('deploy.limits:demo-main:default:1/512')
})

test('after a sleep: state suspended against a running intent, runtime asleep, health standby', async () => {
  const { engine, id } = await wp3Project()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  const bid = await branchId(id)
  expect(await engine.sleep(keyFor(bid, 'cp-default'), 'idle')).toBe(true)

  expect((await get(`/projects/${id}/services/cp-default/state`)).json()).toEqual({ desiredState: 'running', state: 'suspended' })
  const row = (await get(`/projects/${id}/services`)).json().services.find((x: { id: string }) => x.id === 'cp-default')
  expect(row.runtime).toBe('asleep')
  expect(row.desired_state).toBe('running')
  // runtime-health separates standby from crashed by the sleep mark, which survives a restart.
  vi.mocked(dockerFn).mockImplementation(async (args: readonly string[]) =>
    args[0] === 'ps' && args[1] === '-a' ? Buffer.from('io-demo-main-app-default\texited\n') : Buffer.from(''))
  const health = (await get(`/projects/${id}/runtime-health`)).json().services
  expect(health.find((r: { serviceId: string }) => r.serviceId === 'cp-default')).toMatchObject({ status: 'standby', failing: 0 })
  vi.mocked(dockerFn).mockImplementation(fakeDocker)
})

test('a user stop reads stopped, and an exit with no sleep mark reads crashed', async () => {
  const { id } = await wp3Project()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await post(`/projects/${id}/services/cp-default/stop`)
  const row = (await get(`/projects/${id}/services`)).json().services.find((x: { id: string }) => x.id === 'cp-default')
  expect(row.runtime).toBe('stopped')
  expect(row.desired_state).toBe('stopped')
  // Back to a running intent, with the container still exited and no sleep mark: that is a crash.
  await post(`/projects/${id}/services/cp-default/start`)
  fakeRuntime.put('io-demo-main-app-default', 'exited')
  vi.mocked(dockerFn).mockImplementation(async (args: readonly string[]) =>
    args[0] === 'ps' && args[1] === '-a' ? Buffer.from('io-demo-main-app-default\texited\n') : Buffer.from(''))
  const health = (await get(`/projects/${id}/runtime-health`)).json().services
  expect(health.find((r: { serviceId: string }) => r.serviceId === 'cp-default')).toMatchObject({ status: 'crashed', failing: 1 })
  vi.mocked(dockerFn).mockImplementation(fakeDocker)
})

test('the start verb wakes an asleep service: docker start, then readiness, then runtime online', async () => {
  const { engine, id } = await wp3Project()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  const bid = await branchId(id)
  await engine.sleep(keyFor(bid, 'cp-default'), 'idle')
  calls.length = 0
  const r = await post(`/projects/${id}/services/cp-default/start`)
  expect(r.statusCode).toBe(200)
  expect(r.json().state).toBe('running')
  expect(calls.some((c) => c === 'runtime.start:io-demo-main-app-default' || c === 'compute.start:demo-main:default')).toBe(true)
  expect((await get(`/projects/${id}/services`)).json().services.find((x: { id: string }) => x.id === 'cp-default').runtime).toBe('online')
})

test('branch create: the clone starts asleep and its databases sleep, unless they are always-on', async () => {
  const { id } = await wp3Project()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  calls.length = 0
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  const feat = await branchId(id, 'feat')
  // Compute: created, never started (asleep from birth).
  expect(calls).toContain('deploy.nostart:demo-feat:default')
  // Databases: provisioned, readied, then slept with the branch-create reason and their own graces.
  expect(calls).toContain('runtime.stop:io-demo-feat-pg-db:30')
  expect(calls).toContain('runtime.stop:io-demo-feat-rd-cache:30')
  const kinds = (await get(`/projects/${id}/events`)).json().events
    .filter((e: { kind: string }) => e.kind === 'service.sleep')
    .map((e: { payload: { reason: string; service: string } }) => `${e.payload.service}:${e.payload.reason}`)
  expect(kinds).toEqual(expect.arrayContaining(['pg-db:branch-create', 'rd-cache:branch-create']))
  const rows = (await get(`/projects/${id}/services?branch=feat`)).json().services
  expect(rows.find((x: { id: string }) => x.id === `${feat}:cp-default`).runtime).toBe('asleep')
  expect(rows.find((x: { id: string }) => x.id === `${feat}:pg-db`).runtime).toBe('asleep')

  // ...and with always-on set on the compute service (a project-level setting), the same clone
  // comes up running. A database's scale-to-zero is per BRANCH, so the clone's own instance starts
  // on the default and sleeps: a preview branch is exactly what should not stay up.
  await put(`/projects/${id}/services/cp-default/always-on`, { enabled: true })
  await patch(`/projects/${id}/database/settings`, { scaleToZero: false })
  calls.length = 0
  await post(`/projects/${id}/branches`, { name: 'keep', from: 'main' })
  expect(calls).not.toContain('deploy.nostart:demo-keep:default')
  expect(calls).toContain('runtime.stop:io-demo-keep-pg-db:30')
  // main's own instance keeps running, though: its always-on is what the flag was set on.
  expect(calls).not.toContain('runtime.stop:io-demo-main-pg-db:30')
})

test('the always-on default: main is always-on like the cloud, a branch clone scales to zero, an explicit setting wins', async () => {
  // The suites pin INSTA_OSS_ALWAYS_ON_DEFAULT off; this one runs on the daemon's own default.
  // Everything that decides sleep (deploy, the clone's start, the scheduler's targets) reads
  // `effectiveAlwaysOn`, so the rule is asserted there, on both kinds of branch.
  const engine = makeEngine(testConfig({ INSTA_OSS_ALWAYS_ON_DEFAULT: '1' }))
  const { project } = await engine.createProject('demo')
  await engine.addComputeService(project.id, 'web')
  await engine.addDbService(project.id, 'db', {})
  await engine.addManagedService(project.id, 'redis', 'cache', {})
  await engine.createBranch(project.id, 'feat', 'main')
  const branches = (): { main: Branch; feat: Branch } => {
    const all = engine.listBranches(project.id)
    return { main: all.find((b) => b.isDefault)!, feat: all.find((b) => b.name === 'feat')! }
  }
  const on = (branch: Branch, sid: string): boolean => engine.effectiveAlwaysOn(engine.getProject(project.id)!, branch, sid)

  // No setting: production is always-on, the preview clone is not, and postgres scales to zero.
  expect(on(branches().main, 'cp-web')).toBe(true)
  expect(on(branches().feat, 'cp-web')).toBe(false)
  expect(on(branches().main, 'pg-db')).toBe(false)
  // A managed database follows the compute default, not postgres's: up on main, asleep on a clone.
  expect(on(branches().main, 'rd-cache')).toBe(true)
  expect(on(branches().feat, 'rd-cache')).toBe(false)
  // The toggle: switched to scale-to-zero, main sleeps like any other service...
  await engine.setAlwaysOn(project.id, 'cp-web', false)
  expect(on(branches().main, 'cp-web')).toBe(false)
  // ...and explicitly always-on, it holds on every branch, clones included.
  await engine.setAlwaysOn(project.id, 'cp-web', true)
  expect(on(branches().main, 'cp-web')).toBe(true)
  expect(on(branches().feat, 'cp-web')).toBe(true)
  // null clears the setting: back to the default on both kinds of branch, so switching a service
  // on and back is not a one-way pin on every clone.
  await engine.setAlwaysOn(project.id, 'cp-web', null)
  expect(on(branches().main, 'cp-web')).toBe(true)
  expect(on(branches().feat, 'cp-web')).toBe(false)
  expect(engine.getProject(project.id)!.serviceSettings?.['cp-web']?.alwaysOn).toBeUndefined()
  // A managed database's create reports what the branch it lands on will do, as compute's does.
  expect((await engine.addManagedService(project.id, 'redis', 'queue', {})).always_on).toBe(true)
  expect((await engine.addManagedService(project.id, 'redis', 'scratch', { branch: 'feat' })).always_on).toBe(false)
})

test('every branch row carries created_at (the console’s Environments Created column)', async () => {
  app = buildServer(makeEngine(testConfig()))
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  const branches = (await get(`/projects/${id}/branches`)).json().branches as Array<{ name: string; created_at?: string }>
  expect(branches.map((b) => b.name).sort()).toEqual(['feat', 'main'])
  for (const b of branches) expect(Number.isNaN(Date.parse(b.created_at ?? '')), b.name).toBe(false)
})

test('every service row carries created_at, the time the service was created (the console’s Created column)', async () => {
  const engine = makeEngine(testConfig())
  const { project } = await engine.createProject('demo')
  await engine.addComputeService(project.id, 'web')
  await engine.addManagedService(project.id, 'redis', 'cache', {})
  const rows = await engine.services(project.id)
  expect(rows.map((r) => r.type).sort()).toEqual(expect.arrayContaining(['compute', 'redis']))
  for (const row of rows) {
    expect(typeof row.created_at, `${row.type} ${row.name}`).toBe('string')
    expect(Number.isNaN(Date.parse(row.created_at!)), `${row.type} ${row.name}`).toBe(false)
  }
})

test('PUT always-on takes null to follow the default again, and refuses anything else that is not a boolean', async () => {
  const cfg = testConfig({ INSTA_OSS_ALWAYS_ON_DEFAULT: '1' })
  const engine = makeEngine(cfg)
  const a = buildServer(engine, cfg)
  const { project } = await engine.createProject('demo')
  await engine.addComputeService(project.id, 'web')
  const setOn = async (enabled: unknown) =>
    a.inject({ method: 'PUT', url: `/projects/${project.id}/services/cp-web/always-on`, payload: { enabled } })
  expect((await setOn(false)).json().service.always_on).toBe(false)
  expect((await setOn(null)).json().service.always_on).toBe(true)
  const bad = await setOn('yes')
  expect(bad.statusCode).toBe(400)
  expect(bad.json().error).toBe('enabled must be a boolean, or null to follow the default')
})

test('at the shipped default the sweep keeps main up and sleeps a clone, and wakes main once it is back on the default', async () => {
  // The suites pin INSTA_OSS_ALWAYS_ON_DEFAULT off, so no other sweep test runs the shipped
  // default with no explicit setting: that is the case every fresh install is in.
  const engine = makeEngine(testConfig({
    INSTA_OSS_ALWAYS_ON_DEFAULT: '1', INSTA_OSS_IDLE_COMPUTE_SEC: '1', INSTA_OSS_IDLE_DB_SEC: '1', INSTA_OSS_CREATE_GRACE_SEC: '0',
  }))
  app = buildServer(engine)
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'feat', port: 3000 })
  await new Promise((r) => { setTimeout(r, 1_100) })
  calls.length = 0
  await engine.scheduler.sweep()
  expect(calls).not.toContain('runtime.stop:io-demo-main-app-default:10')
  expect(calls).toContain('runtime.stop:io-demo-feat-app-default:10')

  // Switched to scale-to-zero, main sleeps like the clone did...
  await put(`/projects/${id}/services/cp-default/always-on`, { enabled: false })
  await new Promise((r) => { setTimeout(r, 1_100) })
  calls.length = 0
  await engine.scheduler.sweep()
  expect(calls).toContain('runtime.stop:io-demo-main-app-default:10')

  // ...and put back on the default, the next sweep starts it: no request needed.
  await put(`/projects/${id}/services/cp-default/always-on`, { enabled: null })
  calls.length = 0
  await engine.scheduler.sweep()
  for (let i = 0; i < 40 && !calls.includes('runtime.start:io-demo-main-app-default'); i++) {
    await new Promise((r) => { setTimeout(r, 50) })
  }
  expect(calls).toContain('runtime.start:io-demo-main-app-default')
  expect(calls).not.toContain('runtime.start:io-demo-feat-app-default')
}, 20_000)

test('adding compute reports the always-on the NAMED branch will actually have', async () => {
  // The 201 used to report the daemon-wide default, so an untouched create on a preview branch
  // answered always_on: true while that branch's services list, and its scheduler, said false.
  const cfg = testConfig({ INSTA_OSS_ALWAYS_ON_DEFAULT: '1' })
  const engine = makeEngine(cfg)
  const a = buildServer(engine, cfg)
  const { project } = await engine.createProject('demo')
  await engine.createBranch(project.id, 'feat', 'main')
  const add = async (body: Record<string, unknown>) =>
    (await a.inject({ method: 'POST', url: `/projects/${project.id}/services`, payload: { type: 'compute', ...body } })).json().service
  // On the preview branch, untouched: it will scale to zero there, and the 201 says so.
  expect((await add({ name: 'web', branch: 'feat' })).always_on).toBe(false)
  const featRows = (await a.inject({ method: 'GET', url: `/projects/${project.id}/services?branch=feat` })).json().services
  expect(featRows.find((r: { name: string }) => r.name === 'web').always_on).toBe(false)
  // On the default branch (named or not), the same untouched create is always-on.
  expect((await add({ name: 'api' })).always_on).toBe(true)
  expect((await add({ name: 'worker', branch: 'main' })).always_on).toBe(true)
  // An explicit value is reported as given, wherever it is created.
  expect((await add({ name: 'pinned', branch: 'feat', alwaysOn: true })).always_on).toBe(true)
})

test('database management wakes a sleeping instance; observability answers 503 and runs no SQL', async () => {
  const { engine, id } = await wp3Project()
  const bid = await branchId(id)
  const pgKey = keyFor(bid, 'pg-db')
  expect(await engine.sleep(pgKey, 'idle')).toBe(true)

  calls.length = 0
  for (const [method, url] of [['GET', 'metrics'], ['GET', 'activity'], ['GET', 'query-stats'], ['GET', 'insight']] as const) {
    const r = await app.inject({ method, url: `/projects/${id}/database/${url}` })
    expect(r.statusCode, url).toBe(503)
    expect(r.json().error).toBe('database is sleeping: it wakes on the next connection')
  }
  expect(calls.filter((c) => c.startsWith('db.query'))).toEqual([])
  expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])

  // Management is an explicit operation: it starts the container first, then runs its SQL. Every
  // route decision 48 calls management does it, not just the first one.
  const management: Array<[string, string, unknown]> = [
    ['GET', 'databases', undefined],
    ['GET', 'extensions', undefined],
    ['POST', 'password', { password: 'pw-rotate' }],
  ]
  for (const [method, path, payload] of management) {
    await engine.sleep(pgKey, 'idle')
    calls.length = 0
    const r = await app.inject({ method: method as 'GET', url: `/projects/${id}/database/${path}`, payload })
    expect(r.statusCode, path).toBe(200)
    expect(calls.indexOf('runtime.start:io-demo-main-pg-db'), path).toBeGreaterThanOrEqual(0)
    expect(calls.findIndex((c) => c.startsWith('db.query')), path).toBeGreaterThan(calls.indexOf('runtime.start:io-demo-main-pg-db'))
  }
  // ...and now that it is awake, the observability pages answer again.
  expect((await get(`/projects/${id}/database/metrics`)).statusCode).toBe(200)
})

test('redis key browser: keys + value routes, typed refusals, and the sleeping 503', async () => {
  const { engine, id } = await wp3Project()
  expect((await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })).statusCode).toBe(201)

  const keys = await get(`/projects/${id}/services/rd-cache/redis/keys`)
  expect(keys.statusCode).toBe(200)
  expect(keys.json()).toEqual({ dbs: [{ db: 0, keys: 2 }], keys: ['user:1', 'user:2'] })
  const value = await get(`/projects/${id}/services/rd-cache/redis/value?key=user:1`)
  expect(value.statusCode).toBe(200)
  expect(value.json()).toEqual({ type: 'string', ttl: -1, value: '{"name":"ada"}' })
  // A hash reads through HSCAN's bounded page, never HGETALL.
  const hash = await get(`/projects/${id}/services/rd-cache/redis/value?key=session:9`)
  expect(hash.json()).toEqual({ type: 'hash', ttl: -1, value: { token: 'abc', ttl: '60' } })
  expect(calls.some((c) => c.includes('HGETALL'))).toBe(false)
  expect(calls.some((c) => c.startsWith('md.cmd:io-demo-main-rd-cache:'))).toBe(true)
  // The REAL adapter keeps the password out of argv (the fake replaces command() wholesale, so
  // asserting on ITS recording proved nothing — review round 3's negative control): call
  // LocalManagedDb.command against the mocked docker seam and read the argv it actually builds.
  const { LocalManagedDb } = await import('../src/adapters/manageddb')
  vi.mocked(dockerFn).mockClear()
  await new LocalManagedDb().command('c1', 'hunter2xyz', ['GET', 'k'])
  const [argv, execOpts] = vi.mocked(dockerFn).mock.calls.at(-1)! as unknown as [string[], { env?: Record<string, string> } | undefined]
  expect(argv.join(' ')).not.toContain('hunter2xyz')
  expect(argv).toContain('REDISCLI_AUTH')
  expect(execOpts?.env?.REDISCLI_AUTH).toBe('hunter2xyz')
  // Governed reads land on the audit timeline (coalesced through touchLater — a browse must not
  // pay a synchronous full-state save), op only — never key names or values.
  flushTouchLater()
  const reads = loadState().events.filter((e) => e.kind === 'db.read')
  expect(reads.length).toBeGreaterThanOrEqual(2)
  expect(reads.every((e) => !JSON.stringify(e.payload).includes('user:1'))).toBe(true)

  // Stats: the INFO counters picked into the console's shape.
  const stats = await get(`/projects/${id}/services/rd-cache/redis/stats`)
  expect(stats.statusCode).toBe(200)
  expect(stats.json()).toMatchObject({
    version: '7.2.14', uptimeSec: 120, connectedClients: 2, usedMemoryBytes: 1048576,
    totalCommands: 42, keyspaceHits: 9, keyspaceMisses: 1,
  })

  // Typed refusals: a non-redis target, an out-of-range logical db, a missing key.
  expect((await get(`/projects/${id}/services/pg-db/redis/keys`)).statusCode).toBe(400)
  expect((await get(`/projects/${id}/services/rd-cache/redis/keys?db=16`)).statusCode).toBe(400)
  expect((await get(`/projects/${id}/services/rd-cache/redis/value`)).statusCode).toBe(400)

  // A sleeping instance answers 503 (the dashboard's wake gate keys on it) and runs NO command.
  const bid = await branchId(id)
  expect(await engine.sleep(keyFor(bid, 'rd-cache'), 'idle')).toBe(true)
  calls.length = 0
  const asleep = await get(`/projects/${id}/services/rd-cache/redis/keys`)
  expect(asleep.statusCode).toBe(503)
  expect(asleep.json().error).toMatch(/sleeping/)
  expect(calls.filter((c) => c.startsWith('md.cmd'))).toEqual([])
})

test('the *SCAN page parsers hold the 200-entry bound however large the page the server hands back', async () => {
  const { scanPageToHash, scanPageMembers } = await import('../src/manageddb')
  const big: string[] = []
  for (let i = 0; i < 600; i++) big.push(`f${i}`, `v${i}`)
  expect(Object.keys(scanPageToHash(['0', big])).length).toBe(200)
  expect(scanPageMembers(['0', big]).length).toBe(200)
  // Garbage shapes answer empty, never throw.
  expect(scanPageToHash('nope')).toEqual({})
  expect(scanPageMembers(null)).toEqual([])
})

test('POST /database/query: rows for a select, a command tag otherwise, 503 asleep, gated db.query', async () => {
  const { engine, id } = await wp3Project()
  // Every statement executes EXACTLY once, whatever the classifier decides.
  const queriesRun = () => calls.filter((c) => c.startsWith('db.query:')).length
  const one = async (sql: string) => {
    const before = queriesRun()
    const r = await post(`/projects/${id}/database/query`, { sql })
    expect(queriesRun() - before, sql).toBe(1)
    return r
  }

  const r = await one('select 1 as one')
  expect(r.statusCode).toBe(200)
  // Values travel as TEXT: a bigint past 2^53 survives un-rounded, null stays null.
  expect(r.json()).toMatchObject({ columns: ['one', 'two'], rows: [['1', 'b'], ['9007199254740993', null]], rowCount: 2 })

  // A non-select runs as written and reports the command tag ('' from the fake reads as OK).
  expect((await one('create table t (a int)')).json()).toMatchObject({ status: 'OK' })
  // A leading comment does not demote a SELECT to a command…
  expect((await one('-- note\nselect 1 as one')).json()).toMatchObject({ columns: ['one', 'two'] })
  // …nor does a terminal semicolon shadowed by a trailing comment break the wrapper…
  expect('columns' in (await one('select 1 as one; -- done')).json()).toBe(true)
  // …a `;` inside a string literal does not either…
  expect('columns' in (await one("select 'a;b' as v")).json()).toBe(true)
  // …SHOW runs as written (a utility statement the wrapper cannot host)…
  expect('status' in (await one('show search_path')).json()).toBe(true)
  expect(calls.some((c) => c === 'db.query:show search_path')).toBe(true)
  // …several statements are REFUSED (one statement per request), executing nothing…
  const beforeMulti = queriesRun()
  const multi = await post(`/projects/${id}/database/query`, { sql: 'select 1; select 2' })
  expect(multi.statusCode).toBe(400)
  expect(multi.json().error).toContain('one statement per request')
  expect(queriesRun() - beforeMulti).toBe(0)
  // …a WITH ending in SELECT is row-shaped, one ending in UPDATE runs as a command…
  expect('columns' in (await one('with a as (select 1) select * from a')).json()).toBe(true)
  expect((await one('with d as (select 1) update t set a = 1')).json()).toMatchObject({ status: 'OK' })
  // …a parenthesized query expression is row-shaped, bare or after a WITH…
  expect('columns' in (await one('(select 1 as n)')).json()).toBe(true)
  expect('columns' in (await one('with x as (select 7 as n) (select * from x)')).json()).toBe(true)
  // …and psql meta-commands are refused before anything executes (over stdin they would RUN:
  // a backslash outside literals is never SQL).
  const beforeMeta = queriesRun()
  const metaG = await post(`/projects/${id}/database/query`, { sql: 'select 1 \\g select 2 \\g' })
  expect(metaG.statusCode).toBe(400)
  const meta = await post(`/projects/${id}/database/query`, { sql: 'select 1 \\watch 1' })
  expect(meta.statusCode).toBe(400)
  expect(meta.json().error).toContain('meta-commands')
  expect(queriesRun() - beforeMeta).toBe(0)
  expect('columns' in (await one("select 'literal \\watch is fine' as v")).json()).toBe(true)
  // The row transport is server-bounded: a statement timeout and a row cap ride every call.
  expect(calls.some((c) => c.startsWith('db.query:select json_build_object'))).toBe(true)

  // Every successful statement lands on the audit timeline (coalesced through touchLater) —
  // action metadata only, never SQL text.
  flushTouchLater()
  const audited = loadState().events.filter((e) => e.kind === 'db.query')
  expect(audited.length).toBeGreaterThanOrEqual(7)
  expect(audited.every((e) => (e.payload as { service?: string }).service === 'pg-db')).toBe(true)
  expect(audited.every((e) => !JSON.stringify(e.payload).includes('select'))).toBe(true)

  expect((await post(`/projects/${id}/database/query`, {})).statusCode).toBe(400)
  expect((await post(`/projects/${id}/database/query`, { sql: '  ' })).statusCode).toBe(400)

  // Asleep: 503 and no SQL runs (decision 48 — a dashboard read never wakes the database).
  const bid = await branchId(id)
  expect(await engine.sleep(keyFor(bid, 'pg-db'), 'idle')).toBe(true)
  calls.length = 0
  expect((await post(`/projects/${id}/database/query`, { sql: 'select 1' })).statusCode).toBe(503)
  expect(calls.filter((c) => c.startsWith('db.query'))).toEqual([])

  // The action is governable on its own: deny db.query and the route answers 403.
  await put(`/projects/${id}/policy/db.query`, { decision: 'deny' })
  expect((await post(`/projects/${id}/database/query`, { sql: 'select 1' })).statusCode).toBe(403)
})

test('PATCH database/settings: scaleToZero, idleTimeout and the cpu/memory grid, echoed by the instance', async () => {
  const { id } = await wp3Project()
  const before = (await get(`/projects/${id}/database/instance`)).json()
  expect(before.scaleToZero).toBe(true)
  expect(before.idleTimeoutSecs).toBe(600)
  expect(before.routeKey).toBe('pg-db-demo-main')

  const r = await patch(`/projects/${id}/database/settings`, { scaleToZero: false, idleTimeout: 120 })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toMatchObject({ scaleToZero: false, idleTimeoutSecs: 120 })
  expect((await get(`/projects/${id}/database/instance`)).json()).toMatchObject({ scaleToZero: false, idleTimeoutSecs: 120 })
  // scaleToZero off is what always-on means for a database.
  expect((await get(`/projects/${id}/events`)).json().events.some((e: { kind: string; payload: { service: string } }) =>
    e.kind === 'service.alwaysOn' && e.payload.service === 'pg-db')).toBe(true)

  calls.length = 0
  const sized = await patch(`/projects/${id}/database/settings`, { cpu: '2', memory: '4Gi' })
  expect(sized.statusCode).toBe(200)
  expect(sized.json()).toMatchObject({ cpuMilli: 2000, memoryMib: 4096 })
  expect(calls).toContain('runtime.update:io-demo-main-pg-db:2/4096')
  // The same grid as compute: 4 GiB does not fit on 1 vCPU, and junk quantities are refused.
  expect((await patch(`/projects/${id}/database/settings`, { cpu: '1', memory: '4Gi' })).statusCode).toBe(400)
  expect((await patch(`/projects/${id}/database/settings`, { memory: 'lots' })).statusCode).toBe(400)
  expect((await patch(`/projects/${id}/database/settings`, { idleTimeout: -5 })).statusCode).toBe(400)
  // 0 disables sleep for this instance without touching the always-on flag.
  expect((await patch(`/projects/${id}/database/settings`, { idleTimeout: 0 })).json().idleTimeoutSecs).toBe(0)
})

test('the sweep sleeps an idle service read out of state.json, and always-on takes it out again', async () => {
  // A real projection: the idle window comes from the config, the create grace from the ROW, and
  // always-on from the service setting. One second of real time is cheaper than faking the clock
  // around Fastify's own timers.
  const engine = makeEngine(testConfig({ INSTA_OSS_IDLE_COMPUTE_SEC: '1', INSTA_OSS_IDLE_DB_SEC: '1', INSTA_OSS_CREATE_GRACE_SEC: '0' }))
  app = buildServer(engine)
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await new Promise((r) => { setTimeout(r, 1_100) })

  calls.length = 0
  await engine.scheduler.sweep()
  expect(calls).toContain('runtime.stop:io-demo-main-app-default:10')
  expect(calls).toContain('runtime.stop:io-demo-main-pg-db:30')
  expect((await get(`/projects/${id}/services`)).json().services.find((x: { id: string }) => x.id === 'cp-default').runtime).toBe('asleep')

  // Always-on, and the very same sweep leaves it alone.
  await post(`/projects/${id}/services/cp-default/start`)
  await put(`/projects/${id}/services/cp-default/always-on`, { enabled: true })
  await patch(`/projects/${id}/database/settings`, { scaleToZero: false })
  await new Promise((r) => { setTimeout(r, 1_100) })
  calls.length = 0
  await engine.scheduler.sweep()
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
}, 20_000)

test('a redeploy leaves the runtime view agreeing with the standing intent, suspend included', async () => {
  const { id } = await wp3Project()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  // A suspended service's replacement is STARTED (docker cannot pause a created container) and then
  // paused by the re-assert, so the view has to follow the pause, not the start.
  await post(`/projects/${id}/services/cp-default/suspend`)
  await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'main', port: 3000 })
  expect((await get(`/projects/${id}/services/cp-default/state`)).json()).toEqual({ desiredState: 'suspended', state: 'suspended' })
  expect((await get(`/projects/${id}/services`)).json().services.find((x: { id: string }) => x.id === 'cp-default').runtime).toBe('suspended')

  await post(`/projects/${id}/services/cp-default/stop`)
  await post(`/projects/${id}/deploy`, { image: 'app:3', branch: 'main', port: 3000 })
  expect((await get(`/projects/${id}/services/cp-default/state`)).json()).toEqual({ desiredState: 'stopped', state: 'stopped' })
})

test('GET /policy lists service.upgrade, the action PUT limits gates on', async () => {
  const { id } = await wp3Project()
  expect(Object.keys((await get(`/projects/${id}/policy`)).json().policy)).toContain('service.upgrade')
})
// ---- end region WP3 ----

// ---- region WP4 (data dir) ----
// ---- end region WP4 ----

// ---- region WP5 (templates/parity) ----

// Two postgres services, `db` (older) and `analytics`: the suffix-plus-alias rule of the platform's
// secretNames, computed at READ time so removing the alias holder shifts it.
test('two postgres services: DATABASE_URL aliases the oldest, both carry a suffixed name', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics' })
  const secrets = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  // Lane form (contract §10), one lane per service, and the alias follows the oldest.
  expect(secrets.DATABASE_URL_DB).toBe((await get(`/projects/${id}/services/pg-db/credentials`)).json().credentials.DATABASE_URL)
  expect(secrets.DATABASE_URL_ANALYTICS).toBe((await get(`/projects/${id}/services/pg-analytics/credentials`)).json().credentials.DATABASE_URL)
  expect(secrets.DATABASE_URL_DB).toMatch(/^postgres:\/\/postgres:pw@127\.0\.0\.1:2\d{4}\/app$/)
  expect(secrets.DATABASE_URL_ANALYTICS).not.toBe(secrets.DATABASE_URL_DB)
  expect(secrets.DATABASE_URL).toBe(secrets.DATABASE_URL_DB)
  // A deploy carries the identical set.
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  expect(calls.some((c) => c.startsWith('deploy:demo-main:default:app:1'))).toBe(true)
  // The inventory lists both services, each under its own name.
  const tree = (await get(`/projects/${id}/secrets/tree`)).json()
  const pgServices = tree.branches[0].services.filter((x: { type: string }) => x.type === 'postgres')
  expect(pgServices.map((x: { name: string }) => x.name).sort()).toEqual(['analytics', 'db'])
  expect(pgServices.find((x: { name: string }) => x.name === 'analytics').secrets).toEqual(['DATABASE_URL_ANALYTICS'])

  // Removing the alias holder shifts the canonical name onto the survivor.
  await app.inject({ method: 'DELETE', url: `/projects/${id}/services/pg-db` })
  const after = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  expect(after.DATABASE_URL).toBe(after.DATABASE_URL_ANALYTICS)
  expect(after.DATABASE_URL_DB).toBeUndefined()
})

test('database routes over several postgres services: ?group=, the 400 and the 404 hint', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics' })
  const ambiguous = await get(`/projects/${id}/database/instance`)
  expect(ambiguous.statusCode).toBe(400)
  expect(ambiguous.json().error).toBe('multiple postgres services - specify one: analytics, db')
  // WP3: which service the row describes is `id`/`name`/`routeKey`; `host`/`port` are its lane.
  expect((await get(`/projects/${id}/database/instance?group=analytics`)).json())
    .toMatchObject({ id: 'pg-analytics', name: 'analytics', routeKey: 'pg-analytics-demo-main', host: '127.0.0.1' })
  expect((await get(`/projects/${id}/database/instance?group=nope`)).statusCode).toBe(404)
  // runtime-health has one row per postgres service.
  const health = (await get(`/projects/${id}/runtime-health`)).json().services
  expect(health.filter((r: { serviceId: string }) => r.serviceId.startsWith('pg-')).map((r: { serviceId: string }) => r.serviceId).sort())
    .toEqual(['pg-analytics', 'pg-db'])
  // ...and with no postgres at all the error names the command that adds one.
  await app.inject({ method: 'DELETE', url: `/projects/${id}/services/pg-db` })
  await app.inject({ method: 'DELETE', url: `/projects/${id}/services/pg-analytics` })
  const none = await get(`/projects/${id}/database/instance`)
  expect(none.statusCode).toBe(404)
  expect(none.json().error).toBe('no postgres service in this project (add one with `insta services add postgres <name>`)')
})

test('branch create forks every postgres and clones every bucket, and copies bindings', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics' })
  await post(`/projects/${id}/services`, { type: 'storage', name: 'blobs' })
  await post(`/projects/${id}/services`, { type: 'compute', name: 'web' })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'web' })
  calls.length = 0
  expect((await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })).statusCode).toBe(201)
  expect(calls).toContain('db.fork:io-demo-main-pg-db->io-demo-feat-pg-db')
  expect(calls).toContain('db.fork:io-demo-main-pg-analytics->io-demo-feat-pg-analytics')
  expect(calls).toContain('st.clone:io-demo-main-store->io-demo-feat-store')
  expect(calls).toContain('st.clone:io-demo-main-blobs->io-demo-feat-blobs')
})

// Decision 49: the CLI reads an id off `?branch=<b>` and calls the follow-up route with NO branch,
// so the id itself has to name the branch off the default one.
test('branch-qualified service ids resolve their own branch on credentials, state and stop', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'web' })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'web' })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  const featId = (await get(`/projects/${id}/branches`)).json().branches.find((b: { name: string }) => b.name === 'feat').id

  const main = (await get(`/projects/${id}/services`)).json().services
  expect(main.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(['pg-db', 'cp-web']))
  const feat = (await get(`/projects/${id}/services?branch=feat`)).json().services
  expect(feat.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([`${featId}:pg-db`, `${featId}:cp-web`]))
  // ?branch=main is the default branch, so its ids stay bare (byte-identical to today).
  expect((await get(`/projects/${id}/services?branch=main`)).json().services.map((x: { id: string }) => x.id))
    .toEqual(expect.arrayContaining(['pg-db', 'cp-web']))

  // Credentials with NO query answer for FEAT, not main.
  const featDsn = (await get(`/projects/${id}/services/${featId}:pg-db/credentials`)).json().credentials.DATABASE_URL
  const mainDsn = (await get(`/projects/${id}/services/pg-db/credentials`)).json().credentials.DATABASE_URL
  expect(featDsn).not.toBe(mainDsn)
  expect(featDsn).toContain('127.0.0.1:')

  // ...and so do state and stop, leaving main's intent untouched.
  expect((await get(`/projects/${id}/services/${featId}:cp-web/state`)).statusCode).toBe(200)
  expect((await post(`/projects/${id}/services/${featId}:cp-web/stop`)).statusCode).toBe(200)
  expect(calls).toContain('compute.stop:demo-feat:web')
  const mainWeb = (await get(`/projects/${id}/services`)).json().services.find((x: { id: string }) => x.id === 'cp-web')
  expect(mainWeb.desired_state).toBe('running')

  // A qualifier naming a branch that is gone is a 404, never a silent fall-through to main.
  await app.inject({ method: 'DELETE', url: `/projects/${id}/branches/${featId}` })
  expect((await get(`/projects/${id}/services/${featId}:pg-db/credentials`)).statusCode).toBe(404)
})

test('credentials: the postgres DSN, the five storage keys, the managed bundle, nothing for compute', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/services`, { type: 'compute', name: 'web' })

  const pg = (await get(`/projects/${id}/services/pg-db/credentials`)).json().credentials
  expect(Object.keys(pg)).toEqual(['DATABASE_URL'])
  const st = (await get(`/projects/${id}/services/st-store/credentials`)).json().credentials
  expect(Object.keys(st).sort()).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_ENDPOINT_URL_S3', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'BUCKET_NAME'])
  const rd = (await get(`/projects/${id}/services/rd-cache/credentials`)).json().credentials
  expect(rd.REDIS_URL).toMatch(/^redis:\/\/default:.+@127\.0\.0\.1:2\d{4}\/0$/)
  expect((await get(`/projects/${id}/services/cp-web/credentials`)).json().credentials).toEqual({})
  expect((await get(`/projects/${id}/services/pg-nope/credentials`)).statusCode).toBe(404)

  // Gated secrets.read, like every other credential read.
  await put(`/projects/${id}/policy/secrets.read`, { decision: 'approve' })
  expect((await get(`/projects/${id}/services/pg-db/credentials`)).statusCode).toBe(202)
})

test('the per-type cap is the cloud message with the env var named', async () => {
  const two = buildServer(makeEngine(testConfig({ INSTA_OSS_MAX_SERVICES_PER_TYPE: '2' })))
  const r = await two.inject({ method: 'POST', url: '/orgs/local/projects', payload: { name: 'demo' } })
  const id = r.json().project.id
  const add = (name: string) => two.inject({ method: 'POST', url: `/projects/${id}/services`, payload: { type: 'postgres', name } })
  expect((await add('db')).statusCode).toBe(201)
  expect((await add('analytics')).statusCode).toBe(201)
  const third = await add('reports')
  expect(third.statusCode).toBe(400)
  expect(third.json().error).toBe("branch has reached this plan's limit of 2 postgres services (INSTA_OSS_MAX_SERVICES_PER_TYPE)")
  await two.close()
})

// The cap is per BRANCH: the message says so, and so do the contract and COMPATIBILITY. Under the
// old fan-out the branch's load and the project's registration count were the same number, so
// counting registrations was right by accident; branch-scoped it refuses a branch its first
// service because some OTHER branch filled the quota.
test('the per-type cap counts what the BRANCH carries, not the project registrations', async () => {
  const two = buildServer(makeEngine(testConfig({ INSTA_OSS_MAX_SERVICES_PER_TYPE: '2' })))
  const id = (await two.inject({ method: 'POST', url: '/orgs/local/projects', payload: { name: 'demo' } })).json().project.id
  const add = (type: string, name: string, branch?: string) => two.inject({
    method: 'POST', url: `/projects/${id}/services`, payload: { type, name, ...(branch ? { branch } : {}) },
  })
  // feat is cut before anything exists, so it carries nothing at all.
  expect((await two.inject({ method: 'POST', url: `/projects/${id}/branches`, payload: { name: 'feat', from: 'main' } })).statusCode).toBe(201)
  expect((await add('postgres', 'db')).statusCode).toBe(201)
  expect((await add('postgres', 'analytics')).statusCode).toBe(201)
  expect((await add('postgres', 'reports')).statusCode).toBe(400)          // main is full

  // feat carries none of them, so it gets its own two...
  expect((await add('postgres', 'db', 'feat')).statusCode).toBe(201)
  expect((await add('postgres', 'reports', 'feat')).statusCode).toBe(201)
  // ...and then it is full too, including for a name the project already has registered, which
  // the old check skipped entirely because the registration existed.
  const full = await add('postgres', 'analytics', 'feat')
  expect(full.statusCode).toBe(400)
  expect(full.json().error).toBe("branch has reached this plan's limit of 2 postgres services (INSTA_OSS_MAX_SERVICES_PER_TYPE)")

  // Storage counts the same way, on its own quota.
  expect((await add('storage', 'a')).statusCode).toBe(201)
  expect((await add('storage', 'b')).statusCode).toBe(201)
  expect((await add('storage', 'c')).statusCode).toBe(400)
  expect((await add('storage', 'c', 'feat')).statusCode).toBe(201)
  await two.close()
})

// Decision 51: name and lane reservations happen in one synchronous mutate before provisioning
// awaits, so two concurrent adds on two projects both succeed and neither sees the other's half.
test('two concurrent service adds on two projects both succeed', async () => {
  const a = await createProject('alpha')
  const b = await createProject('beta')
  const [ra, rb] = await Promise.all([
    post(`/projects/${a}/services`, { type: 'postgres', name: 'shared' }),
    post(`/projects/${b}/services`, { type: 'postgres', name: 'shared' }),
  ])
  expect([ra.statusCode, rb.statusCode]).toEqual([201, 201])
  expect(calls).toContain('db.provision:io-alpha-main-pg-shared')
  expect(calls).toContain('db.provision:io-beta-main-pg-shared')
  const lanes = [
    (await get(`/projects/${a}/services/pg-shared/credentials`)).json().credentials.DATABASE_URL,
    (await get(`/projects/${b}/services/pg-shared/credentials`)).json().credentials.DATABASE_URL,
  ]
  expect(new Set(lanes).size).toBe(2) // distinct lane ports, never the same one twice
})

// The app's published host port and the database lanes share ONE loopback port space. `deployLocked`
// picks the host port, THEN builds the container env, and building DATABASE_URL is what allocates
// the lane: with nothing reserving the pick, both allocators answered the lowest free port and
// `docker start` died with "address already in use". Reachable on the first deploy of any project
// whose DSN has not been read yet, which is the plain `services add` then `deploy` order.
test('a first deploy never takes the port the database lane is about to be given', async () => {
  const id = (await post('/orgs/local/projects', { name: 'ports' })).json().project.id
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'db' })
  await post(`/projects/${id}/services`, { type: 'compute', name: 'job' })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 80, group: 'job' })
  const line = calls.find((c) => c.startsWith('deploy:ports-main:job:'))
  expect(line).toBeDefined()
  const hostPort = Number(line!.slice(line!.lastIndexOf('->') + 2))
  expect(Number.isFinite(hostPort)).toBe(true)
  const dsn = (await get(`/projects/${id}/services/pg-db/credentials`)).json().credentials.DATABASE_URL
  const lanePort = Number(/@[^:@/]+:(\d+)\//.exec(dsn)?.[1])
  expect(Number.isFinite(lanePort)).toBe(true)
  expect(lanePort).not.toBe(hostPort)
})

// Stock dockerd hands out 31 user-defined networks and every branch is one, so this is the failure
// a busy box hits first: the documented 507, not a bare 409.
test('a docker network pool exhaustion is the documented 507', async () => {
  const id = await createProject()
  vi.mocked(dockerFn).mockImplementationOnce(async () => {
    throw new Error('Error response from daemon: could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network')
  })
  const r = await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect(r.statusCode).toBe(507)
  expect(r.json().error).toBe('docker has no free network subnets; see docs/self-hosting/install (default-address-pools)')
})

test('storage rename re-keys the id only; the bucket handle is immutable', async () => {
  const id = await createProject()
  const r = await post(`/projects/${id}/services/st-store/rename`, { name: 'assets' })
  expect(r.statusCode).toBe(200)
  expect(r.json().service).toMatchObject({ id: 'st-assets', type: 'storage', name: 'assets' })
  const row = (await get(`/projects/${id}/services`)).json().services.find((x: { type: string }) => x.type === 'storage')
  expect(row.id).toBe('st-assets')
  // The bucket keeps its original handle: it is baked into every object URL and into the key
  // scoped to it, exactly like the cloud.
  expect((await get(`/projects/${id}/services/st-assets/credentials`)).json().credentials.BUCKET_NAME).toBe('io-demo-main-store')
  // ...and the minted env names follow the NEW name.
  expect((await get(`/projects/${id}/secrets?branch=main`)).json().secrets.BUCKET_NAME_ASSETS).toBe('io-demo-main-store')
})

// ---- services are branch-scoped, like the cloud's -------------------------------------------
// The hosted control plane made a service branch-owned in migration 0022_branch_scoped_services
// ("it becomes branch-owned so add/remove stay local and branches diverge"): POST /services takes
// an optional `branch`, resolves it to the default branch when absent, and writes ONE row on ONE
// branch with no fan-out. insta-oss used to materialise every registration on every branch, so
// `insta services add postgres db --branch feat` also built a database, with its own credentials,
// on main. The registration stays project-level here (a service id is the project's namespace and
// has to be stable across branches, decision 49); the SERVICE is the row on the branch.
const names = (rows: Array<{ name: string }>): string[] => rows.map((s) => s.name).sort()
const listOn = async (id: string, branch: string): Promise<Array<{ id: string; name: string; type: string }>> =>
  (await get(`/projects/${id}/services?branch=${branch}`)).json().services

test('a service added with ?branch lands on that branch ONLY, and nothing is built on the others', async () => {
  const id = await createProject()
  expect((await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })).statusCode).toBe(201)
  calls.length = 0

  expect((await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics', branch: 'feat' })).statusCode).toBe(201)
  expect((await post(`/projects/${id}/services`, { type: 'storage', name: 'uploads', branch: 'feat' })).statusCode).toBe(201)
  expect((await post(`/projects/${id}/services`, { type: 'redis', name: 'cache', branch: 'feat' })).statusCode).toBe(201)

  // Exactly one container/bucket each, on feat's ref. Nothing was provisioned against main's.
  expect(calls).toContain('db.provision:io-demo-feat-pg-analytics')
  expect(calls).toContain('st.provision:demo-feat:uploads')
  expect(calls).toContain('md.provision:io-demo-feat-rd-cache')
  expect(calls.filter((c) => c.includes('demo-main'))).toEqual([])

  // The rows exist on feat and on no other branch, so no credentials were minted on main.
  const mainB = await branchOf(id), featB = await branchOf(id, 'feat')
  expect(Object.keys(loadState().branches[featB].databases ?? {}).sort()).toEqual(['pg-analytics', 'pg-db'])
  expect(Object.keys(loadState().branches[mainB].databases ?? {})).toEqual(['pg-db'])
  expect(loadState().branches[mainB].buckets?.['st-uploads']).toBeUndefined()
  expect(loadState().branches[mainB].managed?.['rd-cache']).toBeUndefined()

  // ...and the listing agrees, per branch.
  expect(names(await listOn(id, 'feat'))).toEqual(['analytics', 'cache', 'db', 'store', 'uploads'])
  expect(names(await listOn(id, 'main'))).toEqual(['db', 'store'])
})

test('a service added with no branch lands on the default branch only', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  calls.length = 0
  expect((await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics' })).statusCode).toBe(201)
  expect(calls.filter((c) => c.startsWith('db.provision:'))).toEqual(['db.provision:io-demo-main-pg-analytics'])
  expect(names(await listOn(id, 'main'))).toEqual(['analytics', 'db', 'store'])
  expect(names(await listOn(id, 'feat'))).toEqual(['db', 'store'])
})

test('an unknown ?branch on a service add is a 404, not a silent write to the default branch', async () => {
  const id = await createProject()
  calls.length = 0
  const r = await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics', branch: 'nope' })
  expect(r.statusCode).toBe(404)
  expect(r.json().error).toBe('branch "nope" not found')
  expect(calls.filter((c) => c.startsWith('db.provision:'))).toEqual([])
  expect(names(await listOn(id, 'main'))).toEqual(['db', 'store'])
})

test('an unknown ?branch on a compute add is a 404 too, and registers no project-wide group', async () => {
  const id = await createProject()
  const r = await post(`/projects/${id}/services`, { type: 'compute', name: 'web', branch: 'nope' })
  expect(r.statusCode).toBe(404)
  expect(r.json().error).toBe('branch "nope" not found')
  expect(names(await listOn(id, 'main'))).toEqual(['db', 'store'])
})

test('the same name is addable on a second branch, and refused on a branch that already carries it', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  // main already carries `db` from the fixture, so a second add there is the conflict...
  const dup = await post(`/projects/${id}/services`, { type: 'postgres', name: 'db', branch: 'main' })
  expect(dup.statusCode).toBe(409)
  expect(dup.json().error).toBe('service already exists on this branch')
  // ...while `analytics`, added on feat only, can still be added to main afterwards: one
  // registration, one row per branch, each with its own container and its own data directory.
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics', branch: 'feat' })
  calls.length = 0
  expect((await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics', branch: 'main' })).statusCode).toBe(201)
  expect(calls).toContain('db.provision:io-demo-main-pg-analytics')
  // One registration, not two.
  expect(loadState().projects[id].dbServices?.filter((d) => d.name === 'analytics')).toHaveLength(1)
  expect(names(await listOn(id, 'main'))).toEqual(['analytics', 'db', 'store'])
})

test('a new branch forks what its SOURCE carries, not every registration the project ever made', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  // Added to feat only, AFTER main was branched.
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics', branch: 'feat' })

  // A branch cut from main does not inherit feat's service...
  expect((await post(`/projects/${id}/branches`, { name: 'from-main', from: 'main' })).statusCode).toBe(201)
  expect(names(await listOn(id, 'from-main'))).toEqual(['db', 'store'])
  // ...and one cut from feat does.
  expect((await post(`/projects/${id}/branches`, { name: 'from-feat', from: 'feat' })).statusCode).toBe(201)
  expect(names(await listOn(id, 'from-feat'))).toEqual(['analytics', 'db', 'store'])
  expect(loadState().branches[await branchOf(id, 'from-feat')].databases?.['pg-analytics']).toBeDefined()
})

test('branch merge creates on the target every service the source has and it lacks, empty', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics', branch: 'feat' })
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache', branch: 'feat' })
  calls.length = 0

  const r = await post(`/projects/${id}/branches/main/merge`, { from: 'feat' })
  expect(r.statusCode).toBe(200)
  const { created, skipped } = r.json()
  expect(created).toEqual(expect.arrayContaining([{ type: 'postgres', name: 'analytics' }, { type: 'redis', name: 'cache' }]))
  // The two the target already had are reported as skipped, not rebuilt.
  expect(skipped).toEqual(expect.arrayContaining([{ type: 'postgres', name: 'db', reason: 'exists' }, { type: 'storage', name: 'store', reason: 'exists' }]))
  expect(calls.filter((c) => c.startsWith('db.provision:'))).toEqual(['db.provision:io-demo-main-pg-analytics'])
  expect(names(await listOn(id, 'main'))).toEqual(['analytics', 'cache', 'db', 'store'])
  // Structural only: the merge provisions a fresh empty database, it never forks feat's data.
  expect(calls.filter((c) => c.startsWith('db.fork:'))).toEqual([])
})

// Adding a managed database was the one registration path outside the engine-wide provision
// chain, so its `existing` check and the append that follows it straddled every provisioning
// await. Driven on the engine, not through inject: inject dispatches on a macrotask, so the first
// request runs to completion in microtasks and the second never overlaps it.
test('two concurrent first adds of one managed service on two branches: ONE registration', async () => {
  const engine = makeEngine()
  const { project } = await engine.createProject('demo')
  await engine.createBranch(project.id, 'feat')
  calls.length = 0

  const settled = await Promise.allSettled([
    engine.addManagedService(project.id, 'redis', 'cache', { branch: 'main' }),
    engine.addManagedService(project.id, 'redis', 'cache', { branch: 'feat' }),
  ])
  // Both are legitimate: the same name on two branches is two services under ONE registration,
  // because a service id has to stay stable across branches (decision 49).
  expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
  expect(loadState().projects[project.id].managedServices?.map((m) => m.id)).toEqual(['rd-cache'])
  expect(calls.filter((c) => c.startsWith('md.provision:')).sort())
    .toEqual(['md.provision:io-demo-feat-rd-cache', 'md.provision:io-demo-main-rd-cache'])
  // One row per branch, each with its own password, and no reservation left standing.
  const rows = engine.listBranches(project.id).map((b) => loadState().branches[b.id].managed?.['rd-cache'])
  expect(rows.filter(Boolean)).toHaveLength(2)
  expect(rows[0]!.password).not.toBe(rows[1]!.password)
  expect(loadState().hostReservations ?? {}).toEqual({})
})

test('two concurrent adds of one managed service on ONE branch: one wins, the other is the conflict', async () => {
  const engine = makeEngine()
  const { project } = await engine.createProject('demo')
  calls.length = 0

  const settled = await Promise.allSettled([
    engine.addManagedService(project.id, 'redis', 'kv'),
    engine.addManagedService(project.id, 'redis', 'kv'),
  ])
  expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const lost = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult
  expect(String(lost.reason)).toContain('redis service "kv" already exists')
  // One registration, one container. Both calls hold the SAME host-reservation owner string
  // (`<projectId>:<serviceId>`), so `assertHostFree` waves the loser through: the chain is what
  // stops it, and it stops it before the loser provisions anything.
  expect(loadState().projects[project.id].managedServices?.map((m) => m.id)).toEqual(['rd-kv'])
  expect(calls.filter((c) => c.startsWith('md.provision:'))).toEqual(['md.provision:io-demo-main-rd-kv'])
  expect(loadState().hostReservations ?? {}).toEqual({})
})

// A branch reserves ONE lane port per database it will actually run. Reserving one per project
// registration eats the configured range on ports nothing will ever listen on, and leaves the
// surplus behind as lane state no branch row supersedes.
test('branch create reserves lanes for the services it will carry, not every registration', async () => {
  // Six ports in the whole range, so an over-reservation cannot hide.
  const engine = makeEngine(testConfig({ INSTA_OSS_LANE_PORT_RANGE: '20000-20005' }))
  const { project } = await engine.createProject('demo')
  await engine.addDbService(project.id, 'db')
  const feat = await engine.createBranch(project.id, 'feat')           // carries `db` only
  for (const name of ['a', 'b', 'c']) await engine.addDbService(project.id, name)   // main only
  // Reading the bundle allocates main's three later lanes, so five of the six ports are live.
  engine.secrets(project.id, 'main')
  const main = engine.listBranches(project.id).find((b) => b.isDefault)!
  expect(Object.keys(main.lanes ?? {}).sort()).toEqual(['pg-a', 'pg-b', 'pg-c', 'pg-db'])
  expect(Object.keys(feat.lanes ?? {})).toEqual(['pg-db'])

  // A branch cut from feat carries one database, so it needs the one port that is left. Asking
  // for four is `no free lane port left in 20000-20005` on a create that needs one.
  const clone = await engine.createBranch(project.id, 'feat2', 'feat')
  expect(Object.keys(clone.lanes ?? {})).toEqual(['pg-db'])
  const ports = new Set(engine.listBranches(project.id).flatMap((b) => Object.values(b.lanes ?? {})))
  expect(ports.size).toBe(6)
  // Nothing surplus is left claimed: the row supersedes every reservation the create took.
  expect(loadState().laneReservations ?? {}).toEqual({})
})

// Every branch-scoped READ owes the same answer the list gives: a registration is the project's
// namespace entry for a NAME, never proof that this branch has the thing. Advertising a service
// the branch does not carry hands out a domain, an endpoint and a health verdict for something
// that is not there, and the credential route said so with a successful empty object.
test('a branch-scoped read never advertises a service the branch does not carry', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics', branch: 'feat' })
  await post(`/projects/${id}/services`, { type: 'storage', name: 'uploads', branch: 'feat' })
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache', branch: 'feat' })

  // credentials: a 404 that names the branch, not a 200 carrying `{}`.
  const cred = await get(`/projects/${id}/services/pg-analytics/credentials`)
  expect(cred.statusCode).toBe(404)
  expect(cred.json().error).toBe('service not found on branch "main"')
  expect((await get(`/projects/${id}/services/st-uploads/credentials?branch=main`)).statusCode).toBe(404)
  expect((await get(`/projects/${id}/services/rd-cache/credentials`)).statusCode).toBe(404)
  // ...and on the branch that carries them it is still the bundle.
  const featSid = (await listOn(id, 'feat')).find((x) => x.name === 'analytics')!.id
  expect((await get(`/projects/${id}/services/${featSid}/credentials`)).json().credentials.DATABASE_URL).toMatch(/^postgres:\/\//)

  // runtime-health: no row at all here. One was reported, against a container docker has never
  // heard of, which reads as `crashed` for a service that simply lives elsewhere.
  const rows = (r: { services: Array<{ serviceId: string }> }): string[] => r.services.map((x) => x.serviceId).sort()
  expect(rows((await get(`/projects/${id}/runtime-health`)).json())).toEqual(['pg-db'])
  expect(rows((await get(`/projects/${id}/runtime-health?branch=feat`)).json())).toEqual(['pg-analytics', 'pg-db', 'rd-cache'])

  // the names-only inventory, per branch, and the single service's name list
  const tree = (await get(`/projects/${id}/secrets/tree`)).json()
  const svcOf = (branch: string): string[] => tree.branches.find((b: { name: string }) => b.name === branch)
    .services.map((x: { name: string }) => x.name).sort()
  expect(svcOf('main')).toEqual(['db', 'store'])
  expect(svcOf('feat')).toEqual(['analytics', 'cache', 'db', 'store', 'uploads'])
  expect((await get(`/projects/${id}/services/rd-cache/secrets`)).statusCode).toBe(404)
  expect((await get(`/projects/${id}/services/rd-cache/secrets?branch=feat`)).statusCode).toBe(200)

  // the project detail's resource list
  const mainId = await branchOf(id, 'main')
  const mine = (await get(`/projects/${id}`)).json().resources.filter((r: { branchId: string }) => r.branchId === mainId)
  expect(mine.map((r: { name: string }) => r.name).sort()).toEqual(['db', 'store'])

  // storage actions on a bucket this branch has no credentials for: a 404, never a call signed
  // with an empty env.
  calls.length = 0
  expect((await get(`/projects/${id}/services/st-uploads/objects`)).statusCode).toBe(404)
  expect((await put(`/projects/${id}/services/st-uploads/access`, { public: true })).statusCode).toBe(404)
  expect(calls).toEqual([])

  // ...and the database routes resolve inside the branch: main carries exactly one postgres, so
  // it is not ambiguous, while feat really does carry two.
  const inst = await get(`/projects/${id}/database/instance`)
  expect(inst.statusCode).toBe(200)
  expect(inst.json()).toMatchObject({ id: 'pg-db' })
  expect((await get(`/projects/${id}/database/instance?group=analytics`)).statusCode).toBe(404)
  const both = await get(`/projects/${id}/database/instance?branch=feat`)
  expect(both.statusCode).toBe(400)
  expect(both.json().error).toBe('multiple postgres services - specify one: analytics, db')
})

// Two readers left over from the same sweep: the unsuffixed alias belongs to the oldest service
// of its type the BRANCH carries (that is how the values are assembled), and a user secret bound
// to a service is stored per branch, so it can only bind to a service that branch has.
test('the alias holder, and what a secret can bind to, are per branch as well', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics' })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  const featSid = (name: string) => listOn(id, 'feat').then((rows) => rows.find((x) => x.name === name)!.id)
  await del_(`/projects/${id}/services/${await featSid('db')}`)   // feat now carries `analytics` only

  // The bundle gives feat's unsuffixed DATABASE_URL to `analytics`, the oldest it carries...
  const featSecrets = (await get(`/projects/${id}/secrets?branch=feat`)).json().secrets
  expect(featSecrets.DATABASE_URL).toBe(featSecrets.DATABASE_URL_ANALYTICS)
  // ...so the names-only views have to say the same thing, per branch.
  const tree = (await get(`/projects/${id}/secrets/tree`)).json()
  const secretsOf = (branch: string, name: string): string[] => tree.branches
    .find((b: { name: string }) => b.name === branch).services
    .find((x: { name: string }) => x.name === name).secrets
  expect(secretsOf('feat', 'analytics')).toEqual(['DATABASE_URL', 'DATABASE_URL_ANALYTICS'])
  expect(secretsOf('main', 'analytics')).toEqual(['DATABASE_URL_ANALYTICS'])
  expect(secretsOf('main', 'db')).toContain('DATABASE_URL')
  expect((await get(`/projects/${id}/services/${await featSid('analytics')}/secrets`)).json().secrets)
    .toEqual(['DATABASE_URL', 'DATABASE_URL_ANALYTICS'])
  expect((await get(`/projects/${id}/services/pg-analytics/secrets`)).json().secrets).toEqual(['DATABASE_URL_ANALYTICS'])

  // And a secret bound to a service feat does not have is refused, not stored where nothing can
  // read it: user secrets are per branch, and the branch-scoped inventory would not list it.
  const bind = await put(`/projects/${id}/secrets/APP_TOKEN`, { value: 't', branch: 'feat', service: 'postgres/db' })
  expect(bind.statusCode).toBe(400)
  expect(bind.json().error).toBe('service not found: postgres/db')
  expect((await put(`/projects/${id}/secrets/APP_TOKEN`, { value: 't', branch: 'feat', service: 'postgres/analytics' })).statusCode).toBe(200)
  expect((await put(`/projects/${id}/secrets/APP_TOKEN`, { value: 't', branch: 'main', service: 'postgres/db' })).statusCode).toBe(200)
})

// Removal is the other half of the same model: the cloud made a service branch-owned so that
// "add/remove stay local and branches diverge". Tearing every branch's copy down meant deleting
// the service you added on `feat` also destroyed main's database and its bytes.
test('removing a service on one branch leaves every other branch its service AND its data', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'postgres', name: 'analytics' })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  const mainDsn = (await get(`/projects/${id}/services/pg-analytics/credentials`)).json().credentials.DATABASE_URL as string
  const featSid = (await listOn(id, 'feat')).find((x) => x.name === 'analytics')!.id
  calls.length = 0

  expect((await del_(`/projects/${id}/services/${featSid}`)).statusCode).toBe(200)
  // Exactly feat's container and feat's bytes. Main's were what the project-wide sweep destroyed.
  expect(calls.filter((c) => c.startsWith('db.destroy:'))).toEqual(['db.destroy:io-demo-feat-pg-analytics'])
  expect(calls.some((c) => c.startsWith('data.remove:') && c.includes('demo-feat'))).toBe(true)
  expect(calls.filter((c) => c.startsWith('data.remove:') && c.includes('demo-main'))).toEqual([])
  // main still HAS the service, and the DSN it had before still names the same live container.
  expect(names(await listOn(id, 'main'))).toEqual(['analytics', 'db', 'store'])
  expect(names(await listOn(id, 'feat'))).toEqual(['db', 'store'])
  expect((await get(`/projects/${id}/services/pg-analytics/credentials`)).json().credentials.DATABASE_URL).toBe(mainDsn)
  expect(loadState().branches[await branchOf(id, 'main')].databases?.['pg-analytics']).toBeDefined()
  // The registration is the project's namespace entry (decision 49): it survives while main carries it.
  expect(loadState().projects[id].dbServices?.map((d) => d.id).sort()).toEqual(['pg-analytics', 'pg-db'])

  // ...and it retires with the LAST branch that carries the name.
  expect((await del_(`/projects/${id}/services/pg-analytics`)).statusCode).toBe(200)
  expect(calls).toContain('db.destroy:io-demo-main-pg-analytics')
  expect(loadState().projects[id].dbServices?.map((d) => d.id)).toEqual(['pg-db'])
  expect((await get(`/projects/${id}/services/pg-analytics/credentials`)).statusCode).toBe(404)
})

test('remove resolves its branch like add: ?branch, and a branch that does not carry it is a 404', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  await post(`/projects/${id}/services`, { type: 'storage', name: 'uploads', branch: 'feat' })
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache', branch: 'feat' })
  calls.length = 0

  // main never carried either, so removing them there destroys nothing and says why.
  const missing = await del_(`/projects/${id}/services/st-uploads`)
  expect(missing.statusCode).toBe(404)
  expect(missing.json().error).toBe('service not found on branch "main"')
  expect((await del_(`/projects/${id}/services/rd-cache?branch=main`)).statusCode).toBe(404)
  expect(calls).toEqual([])

  // On feat both go, and each registration retires behind its last carrier.
  expect((await del_(`/projects/${id}/services/st-uploads?branch=feat`)).statusCode).toBe(200)
  expect(calls).toContain('st.destroy:io-demo-feat-uploads')
  expect((await del_(`/projects/${id}/services/rd-cache?branch=feat`)).statusCode).toBe(200)
  expect(calls).toContain('md.destroy:io-demo-feat-rd-cache')
  expect(calls.filter((c) => c.includes('demo-main'))).toEqual([])
  expect(loadState().projects[id].storageServices?.map((x) => x.name)).toEqual(['store'])
  expect(loadState().projects[id].managedServices).toEqual([])
  expect(names(await listOn(id, 'feat'))).toEqual(['db', 'store'])
})
// ---- end region WP5 ----

test('a compute service answers its source locally — it always runs an image; the repo routes stay cloud-only', async () => {
  const id = await createProject('source-demo')
  await app.inject({ method: 'POST', url: `/projects/${id}/services`, payload: { type: 'compute', name: 'web' } })
  const r = await app.inject({ method: 'GET', url: `/projects/${id}/services/cp-web/source` })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({ source: { type: 'image', image: null } })
  expect((await app.inject({ method: 'GET', url: `/projects/${id}/services/cp-nope/source` })).statusCode).toBe(404)
  expect((await app.inject({ method: 'GET', url: `/projects/${id}/services/pg-db/source` })).statusCode).toBe(400)
})
