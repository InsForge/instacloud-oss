// Git push-to-deploy routes over the fake adapters: the HMAC-verified webhook (the security
// boundary), the connect route's auth guard + validation, SHA pinning, governance, and stale-push
// ordering. Docker is mocked here so a build "succeeds" instantly. The connect happy path + GET/DELETE
// and the deploy-side guarantees (port preservation, removal race) need a REAL compute group, so they
// live in gitdeploy-engine.test.ts (real Engine over the fake adapters); the on-box e2e covers the
// real docker build.
import { test, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'

vi.mock('../src/docker', () => ({
  docker: vi.fn(async () => Buffer.from('')),
  dockerCall: () => ({ done: Promise.resolve(Buffer.from('')), kill: () => {} }),
  redactDockerArgs: (a: string[]) => a.join(' '),
}))

import { buildServer } from '../src/server'
import { loadState, mutate } from '../src/state'
import type { Config } from '../src/config'
import { docker } from '../src/docker'
import * as govern from '../src/govern'
import { newBinding, type GitBindingRecord } from '../src/gitdeploy'
import { makeEngine, serverConfig } from './fakes'

const EMAIL = 'admin@example.test'
const PASSWORD = 'hunter2hunter2'
let cfg: Config
let app: ReturnType<typeof buildServer>
const dockerMock = vi.mocked(docker)

beforeEach(() => {
  cfg = serverConfig()
  app = buildServer(makeEngine(cfg), cfg)
  dockerMock.mockClear()
})

/** Seed a compute branch straight into state so `doGitDeploy`'s revalidation resolves a live target
 *  (branch id b1, group web) and the webhook actually reaches the build step. */
function seedBranch(): void {
  mutate((s) => {
    s.branches = {
      ...(s.branches ?? {}),
      b1: { id: 'b1', projectId: 'p1', name: 'main', isDefault: true, status: 'ready', network: 'io-p1-main', cloneOf: null, createdAt: Date.now(), apps: { web: { image: 'seed:1', port: 8080, url: 'http://web' } } },
    }
  })
}

type Res = Awaited<ReturnType<typeof app.inject>>
const send = (method: string, url: string, opts: Record<string, unknown> = {}): Promise<Res> =>
  app.inject({ method: method as 'GET', url, ...opts })
const cookieOf = (res: Res): string => {
  const raw = res.headers['set-cookie']
  return (Array.isArray(raw) ? raw[0] : String(raw ?? '')).split(';')[0]
}
const signUp = (): Promise<Res> => send('POST', '/api/auth/sign-up/email', { payload: { email: EMAIL, password: PASSWORD } })

/** Inject a binding straight into state and return it. */
function seedBinding(over: Partial<GitBindingRecord['binding']> = {}): GitBindingRecord {
  const rec: GitBindingRecord = {
    binding: { ...newBinding('owner', 'repo', 'main', 'ghp_tok', Date.now()), ...over },
    projectId: 'p1', branchId: 'b1', branchName: 'main', group: 'web',
  }
  mutate((s) => { s.gitBindings = { ...(s.gitBindings ?? {}), [rec.binding.id]: rec } })
  return rec
}

const signed = (secret: string, bodyObj: unknown): { payload: string; sig: string } => {
  const payload = JSON.stringify(bodyObj)
  return { payload, sig: 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex') }
}

test('the connect route is behind the auth guard', async () => {
  const r = await send('POST', '/projects/p1/services/cp-web/git', { payload: { repo: 'o/r' } })
  expect(r.statusCode).toBe(401)
})

test('connect: bad inputs are rejected (project missing -> 404)', async () => {
  const cookie = cookieOf(await signUp())
  const r = await send('POST', '/projects/nope/services/cp-web/git', { headers: { cookie }, payload: { repo: 'o/r' } })
  expect(r.statusCode).toBe(404)
})

test('webhook: unknown binding is a 404', async () => {
  const r = await send('POST', '/webhooks/git/does-not-exist', { headers: { 'content-type': 'application/json', 'x-github-event': 'push' }, payload: {} })
  expect(r.statusCode).toBe(404)
})

test('webhook: a wrong signature is rejected 401, a correct one is accepted', async () => {
  const rec = seedBinding()
  const push = { ref: 'refs/heads/main', after: 'a'.repeat(40) }
  const { payload, sig } = signed(rec.binding.webhookSecret, push)

  const bad = await send('POST', `/webhooks/git/${rec.binding.id}`, {
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, payload,
  })
  expect(bad.statusCode).toBe(401)

  const good = await send('POST', `/webhooks/git/${rec.binding.id}`, {
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig }, payload,
  })
  expect(good.statusCode).toBe(202)
  expect(good.json()).toEqual({ ok: true, building: 'a'.repeat(40) })
})

test('webhook: ping pongs, and a push to another branch is ignored', async () => {
  const rec = seedBinding({ ref: 'main' })
  const ping = signed(rec.binding.webhookSecret, { zen: 'hi' })
  const pong = await send('POST', `/webhooks/git/${rec.binding.id}`, {
    headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': ping.sig }, payload: ping.payload,
  })
  expect(pong.statusCode).toBe(200)
  expect(pong.json()).toMatchObject({ ok: true, pong: true })

  const other = signed(rec.binding.webhookSecret, { ref: 'refs/heads/feature', after: 'b'.repeat(40) })
  const r = await send('POST', `/webhooks/git/${rec.binding.id}`, {
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': other.sig }, payload: other.payload,
  })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toMatchObject({ ok: true })
  expect((r.json() as { ignored?: string }).ignored).toContain('feature')
})

test('webhook: the build is pinned to the pushed commit sha, not the branch ref', async () => {
  seedBranch()
  const rec = seedBinding() // branchId b1, group web, ref main
  const sha = 'c'.repeat(40)
  const { payload, sig } = signed(rec.binding.webhookSecret, { ref: 'refs/heads/main', after: sha })
  const r = await send('POST', `/webhooks/git/${rec.binding.id}`, {
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig }, payload,
  })
  expect(r.statusCode).toBe(202)
  // The build runs detached; wait for it, then assert the git context URL checks out the SHA (so an
  // image tagged for this commit can never contain a later one), never the mutable "main" ref.
  await vi.waitFor(() => expect(dockerMock).toHaveBeenCalled())
  const buildCall = dockerMock.mock.calls.find((c) => (c[0] as string[])[0] === 'build')!
  const buildArgs = buildCall[0] as string[]
  const buildEnv = (buildCall[1] as { env?: Record<string, string> } | undefined)?.env ?? {}
  expect(buildArgs.some((a) => a.endsWith(`.git#${sha}`))).toBe(true)
  expect(buildArgs.some((a) => a.endsWith('.git#main'))).toBe(false)
  // The PAT is handed to BuildKit via the env-secret, so it must NOT appear anywhere in argv.
  expect(buildArgs.join(' ')).not.toContain('ghp_tok')
  expect(buildArgs).toContain('--secret')
  expect(buildEnv.GIT_AUTH_TOKEN).toBe('ghp_tok')
})

test('webhook: a push to an untracked branch never triggers a build', async () => {
  seedBranch()
  const rec = seedBinding({ ref: 'main' })
  const other = signed(rec.binding.webhookSecret, { ref: 'refs/heads/feature', after: 'd'.repeat(40) })
  const r = await send('POST', `/webhooks/git/${rec.binding.id}`, {
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': other.sig }, payload: other.payload,
  })
  expect(r.statusCode).toBe(200)
  // Dispatch is synchronous with the handler (runGitDeploy → the async IIFE runs to its first await,
  // which is the docker build), and the wrong-branch path returns BEFORE dispatch, so if a build were
  // going to happen the mock would already record it by the time the response resolves. Assert now —
  // no wall-clock wait, so the negative is deterministic. A microtask flush guards a future refactor.
  await Promise.resolve()
  expect(dockerMock.mock.calls.some((c) => (c[0] as string[])[0] === 'build')).toBe(false)
})

test('webhook: a push is held (not built) when the deploy policy is not "allow"', async () => {
  seedBranch()
  const rec = seedBinding()
  govern.setPolicy('p1', 'deploy', 'deny') // push-to-deploy honours the project's deploy governance
  const { payload, sig } = signed(rec.binding.webhookSecret, { ref: 'refs/heads/main', after: 'e'.repeat(40) })
  const r = await send('POST', `/webhooks/git/${rec.binding.id}`, {
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig }, payload,
  })
  expect(r.statusCode).toBe(202)
  await Promise.resolve() // the policy check precedes any build and is synchronous
  expect(dockerMock.mock.calls.some((c) => (c[0] as string[])[0] === 'build')).toBe(false)
  // No pending approval is created either — a webhook could never resume one.
  expect(loadState().approvals?.length ?? 0).toBe(0)
})

test('webhook: an approval-required deploy policy also holds the push, and creates no approval', async () => {
  // The N-1 that shipped broken twice: an approval_required project must NOT auto-deploy pushes, and
  // (because effectivePolicy is a pure read) must not accrue a pending approval a webhook can't resume.
  seedBranch()
  const rec = seedBinding()
  govern.setPolicy('p1', 'deploy', 'approval_required')
  const { payload, sig } = signed(rec.binding.webhookSecret, { ref: 'refs/heads/main', after: 'f'.repeat(40) })
  const r = await send('POST', `/webhooks/git/${rec.binding.id}`, {
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig }, payload,
  })
  expect(r.statusCode).toBe(202)
  await Promise.resolve()
  expect(dockerMock.mock.calls.some((c) => (c[0] as string[])[0] === 'build')).toBe(false)
  expect(loadState().approvals?.length ?? 0).toBe(0)
})

test('webhook: a redelivered or out-of-order older push is skipped, never rebuilt', async () => {
  seedBranch()
  const deployed = 'a'.repeat(40)
  const rec = seedBinding({ lastDeployedSha: deployed, lastDeployedAt: 1_000_000 })
  const push = (sha: string, tsMs: number): { payload: string; sig: string } =>
    signed(rec.binding.webhookSecret, { ref: 'refs/heads/main', after: sha, head_commit: { timestamp: new Date(tsMs).toISOString() } })
  // A redelivery of the commit already deployed (same sha, even with a newer wall-clock stamp)…
  const dup = push(deployed, 2_000_000)
  await send('POST', `/webhooks/git/${rec.binding.id}`, { headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': dup.sig }, payload: dup.payload })
  // …and an out-of-order OLDER commit (different sha, timestamp before the current deployment).
  const older = push('b'.repeat(40), 500_000)
  await send('POST', `/webhooks/git/${rec.binding.id}`, { headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': older.sig }, payload: older.payload })
  await Promise.resolve()
  expect(dockerMock.mock.calls.some((c) => (c[0] as string[])[0] === 'build')).toBe(false)
})

test('the binding never leaks its token or webhook secret through what a route echoes', async () => {
  const rec = seedBinding()
  // The token IS stored (needed to fetch a private repo), but bindingOut — the only shape any route
  // returns — must never carry the token or the webhook secret.
  expect(loadState().gitBindings?.[rec.binding.id]?.binding.token).toBe('ghp_tok')
  const shown = JSON.stringify({ binding: (await import('../src/gitdeploy')).bindingOut(rec) })
  expect(shown).not.toContain('ghp_tok')
  expect(shown).not.toContain(rec.binding.webhookSecret)
})
