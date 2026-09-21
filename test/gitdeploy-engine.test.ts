// The two behaviours a webhook build depends on but a mocked-docker route test cannot prove, driven
// through the real Engine over the fake adapters: (1) a git redeploy PRESERVES the service's
// configured port instead of resetting it to 8080, and (2) a build that finishes after its target
// was removed does NOT re-materialise the group — deployFromGit returns null under the service lock.
import { test, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { calls, makeEngine, resetFakes, runtime, testConfig } from './fakes'
import { loadState, mutate } from '../src/state'
import { newBinding } from '../src/gitdeploy'
import { buildServer } from '../src/server'
import type { Engine } from '../src/engine'

// Service removal runs `docker rm`, then proves the container gone before it drops the row (same
// pattern as metrics-incarnation.test.ts): a faked `docker rm` really removes it from FakeRuntime,
// and `docker ps` answers an empty listing so the proof sees it gone. `docker build` is also stubbed
// (the connect route fires an initial build) so no real git fetch/build is attempted. Deploy uses the
// fake compute adapter, not docker.
function fakeDocker(args: string[]): Promise<Buffer> {
  if (args[0] === 'rm') for (const a of args.slice(1)) if (!a.startsWith('-')) runtime.drop(a)
  return Promise.resolve(Buffer.from(''))
}
vi.mock('../src/docker', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/docker')>()
  return {
    ...orig,
    docker: (args: string[], opts?: { input?: Buffer; mergeStderr?: boolean }) =>
      args[0] === 'rm' || args[0] === 'ps' || args[0] === 'build' ? fakeDocker(args) : orig.docker(args, opts),
  }
})

let engine: Engine
let cfg: ReturnType<typeof testConfig>
let projectId: string
let branchId: string

/** Seed a git binding for group `web` on the default branch and return its id. */
function seedBinding(): string {
  const b = newBinding('owner', 'repo', 'main', 'ghp_tok', Date.now())
  mutate((s) => {
    s.gitBindings = { ...(s.gitBindings ?? {}), [b.id]: { binding: b, projectId, branchId, branchName: 'main', group: 'web' } }
  })
  return b.id
}

beforeEach(async () => {
  resetFakes()
  cfg = testConfig()
  engine = makeEngine(cfg)
  // A project name unique to this file: engine tests create a REAL docker network io-<ref>-main, and
  // reusing "demo" collides with the other engine suites when vitest runs files in parallel.
  const { project } = await engine.createProject('gitdep')
  projectId = project.id
  // A service on a NON-8080 port: the whole point of the port-preservation check.
  await engine.deploy(projectId, 'main', { image: 'app:1', port: 3000, group: 'web' })
  branchId = engine.getBranchByName(projectId, 'main')!.id
})

test('a git redeploy preserves the service’s configured port (never resets to 8080)', async () => {
  const bindingId = seedBinding()
  calls.length = 0
  const res = await engine.deployFromGit(projectId, branchId, 'web', bindingId, 'app:2')
  expect(res).toEqual({ deployed: true, port: 3000, branch: 'main' })
  const deployLine = calls.find((c) => c.startsWith('deploy:') && c.includes(':app:2:'))
  expect(deployLine).toBeDefined()
  expect(deployLine).toContain('p=3000->') // preserved, not the deployLocked default of 8080
})

test('a build that finished after its target was removed does not re-materialise the group', async () => {
  const bindingId = seedBinding()
  await engine.removeComputeService(projectId, 'cp-web') // deletes the app AND prunes the binding
  calls.length = 0
  const res = await engine.deployFromGit(projectId, branchId, 'web', bindingId, 'app:2')
  expect(res).toBeNull()
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(false) // no re-create
})

test('the app-row guard alone blocks a redeploy when the group is gone but the binding lingers', async () => {
  // Remove the service (which prunes the binding), then RE-seed a binding so the binding-existence
  // check passes and it is the `if (!app) return null` guard that must stop the redeploy.
  seedBinding()
  await engine.removeComputeService(projectId, 'cp-web')
  const bindingId = seedBinding()
  calls.length = 0
  const res = await engine.deployFromGit(projectId, branchId, 'web', bindingId, 'app:2')
  expect(res).toBeNull()
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(false)
})

test('a stale build for a group that was renamed does not deploy to a recreated same-named group', async () => {
  const bindingId = seedBinding() // bound to group "web"
  await engine.renameComputeService(projectId, 'web', 'api') // moves the binding's group to "api"
  await engine.deploy(projectId, 'main', { image: 'other:1', port: 4000, group: 'web' }) // recreate "web"
  calls.length = 0
  // A build queued for the OLD "web" target: the binding now matches "api", so identity no longer
  // matches "web" and the stale build must not deploy over the freshly recreated group.
  const res = await engine.deployFromGit(projectId, branchId, 'web', bindingId, 'stale:1')
  expect(res).toBeNull()
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(false)
})

test('a redeploy for a binding that no longer exists is a no-op', async () => {
  calls.length = 0
  const res = await engine.deployFromGit(projectId, branchId, 'web', 'no-such-binding', 'app:2')
  expect(res).toBeNull()
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(false)
})

// ---- ordering: driven through the signed webhook + the real Engine, reading the fake's deploy lines
// and the persisted lastDeployedAt (r2d2's measured cases). ----
const deploys = (): number => calls.filter((c) => c.startsWith('deploy:')).length
const seedWebhookBinding = (): { id: string; secret: string } => {
  const id = seedBinding()
  return { id, secret: loadState().gitBindings![id].binding.webhookSecret }
}
const sendPush = (app: ReturnType<typeof buildServer>, id: string, secret: string, sha: string, tsMs?: number): ReturnType<typeof app.inject> => {
  const body: Record<string, unknown> = { ref: 'refs/heads/main', after: sha }
  if (tsMs !== undefined) body.head_commit = { timestamp: new Date(tsMs).toISOString() }
  const payload = JSON.stringify(body)
  return app.inject({ method: 'POST', url: `/webhooks/git/${id}`, headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex') }, payload })
}
const lastAt = (id: string): number | undefined => loadState().gitBindings![id].binding.lastDeployedAt

test('webhook ordering: an out-of-order older commit does not overwrite a newer deployment', async () => {
  const app = buildServer(engine, cfg)
  const { id, secret } = seedWebhookBinding()
  calls.length = 0
  await sendPush(app, id, secret, 'a'.repeat(40), 2_000_000)
  await vi.waitFor(() => expect(lastAt(id)).toBe(2_000_000)) // deployed + recorded
  expect(deploys()).toBe(1)
  await sendPush(app, id, secret, 'b'.repeat(40), 1_000_000) // older commit, arrives later
  await new Promise((r) => setTimeout(r, 20))
  expect(deploys()).toBe(1) // skipped, not rolled back
})

test('webhook ordering: an equal-timestamp later push is skipped (<=, not <)', async () => {
  const app = buildServer(engine, cfg)
  const { id, secret } = seedWebhookBinding()
  calls.length = 0
  await sendPush(app, id, secret, 'a'.repeat(40), 5_000_000)
  await vi.waitFor(() => expect(lastAt(id)).toBe(5_000_000))
  await sendPush(app, id, secret, 'b'.repeat(40), 5_000_000) // same one-second timestamp, different sha
  await new Promise((r) => setTimeout(r, 20))
  expect(deploys()).toBe(1)
})

test('webhook ordering: a redelivery of the deployed commit is skipped', async () => {
  const app = buildServer(engine, cfg)
  const { id, secret } = seedWebhookBinding()
  calls.length = 0
  await sendPush(app, id, secret, 'a'.repeat(40), 3_000_000)
  await vi.waitFor(() => expect(lastAt(id)).toBe(3_000_000))
  await sendPush(app, id, secret, 'a'.repeat(40), 9_000_000) // same sha redelivered with a newer stamp
  await new Promise((r) => setTimeout(r, 20))
  expect(deploys()).toBe(1)
})

test('webhook ordering: a future-dated commit is clamped and never permanently wedges the binding', async () => {
  const app = buildServer(engine, cfg)
  const { id, secret } = seedWebhookBinding()
  calls.length = 0
  const before = Date.now()
  await sendPush(app, id, secret, 'a'.repeat(40), Date.parse('2099-01-01T00:00:00Z'))
  await vi.waitFor(() => expect(lastAt(id)).not.toBeUndefined())
  expect(deploys()).toBe(1)
  // The recorded key is clamped to ~arrival time, NOT the year 2099.
  expect(lastAt(id)!).toBeLessThanOrEqual(Date.now())
  expect(lastAt(id)!).toBeGreaterThanOrEqual(before)
  // …so an honest later push still deploys — the binding is not bricked.
  await sendPush(app, id, secret, 'b'.repeat(40)) // no timestamp -> receipt time (now), which is newer
  await vi.waitFor(() => expect(deploys()).toBe(2))
})

test('connect → GET → DELETE happy path over the HTTP routes', async () => {
  const app = buildServer(engine, cfg) // local mode: loopback trust, no auth guard
  const inject = (method: string, opts: Record<string, unknown> = {}): ReturnType<typeof app.inject> =>
    app.inject({ method: method as 'GET', url: `/projects/${projectId}/services/cp-web/git`, ...opts })

  calls.length = 0
  const connect = await inject('POST', { payload: { repo: 'owner/repo', ref: 'main', token: 'ghp_tok' } })
  expect(connect.statusCode).toBe(202)
  const body = connect.json() as { binding: { repo: string; group: string; private: boolean }; webhook: { url: string; secret: string } }
  expect(body.binding).toMatchObject({ repo: 'owner/repo', group: 'web', private: true })
  expect(body.webhook.url).toContain('/webhooks/git/')
  expect(body.webhook.secret).toBeTruthy()
  // Let the detached initial build finish before we mutate, so nothing writes state after the test.
  await vi.waitFor(() => expect(calls.some((c) => c.startsWith('deploy:'))).toBe(true))

  const got = await inject('GET')
  expect(got.statusCode).toBe(200)
  expect((got.json() as { binding: { repo: string } }).binding.repo).toBe('owner/repo')

  const del = await inject('DELETE')
  expect(del.statusCode).toBe(200)
  const gone = await inject('GET')
  expect(gone.statusCode).toBe(404)
})
