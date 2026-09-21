// Git push-to-deploy routes over the fake adapters: the HMAC-verified webhook (the security boundary)
// and the connect route's auth guard + validation. Docker is mocked exactly as the other server tests
// mock it, so a build "succeeds" instantly; the connect happy path (which needs a real compute group)
// is covered by the on-box e2e, not here.
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
  const buildArgs = dockerMock.mock.calls.map((c) => (c[0] as string[])).find((a) => a[0] === 'build')
  expect(buildArgs).toBeDefined()
  expect(buildArgs!.some((a) => a.endsWith(`.git#${sha}`))).toBe(true)
  expect(buildArgs!.some((a) => a.endsWith('.git#main'))).toBe(false)
})

test('webhook: a push to an untracked branch never triggers a build', async () => {
  seedBranch()
  const rec = seedBinding({ ref: 'main' })
  const other = signed(rec.binding.webhookSecret, { ref: 'refs/heads/feature', after: 'd'.repeat(40) })
  const r = await send('POST', `/webhooks/git/${rec.binding.id}`, {
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': other.sig }, payload: other.payload,
  })
  expect(r.statusCode).toBe(200)
  // Give any (erroneously) dispatched build a chance to land before asserting it did not.
  await new Promise((res) => setTimeout(res, 20))
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
