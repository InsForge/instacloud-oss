// WP1 server-mode identity over the fake adapters (plan 01 tests): the 401 sweep, the Better Auth
// mount, the cloud /auth wrappers, /me, /tokens, the CSRF belt and the SPA shell injection.
// No Docker: docker() is mocked exactly as test/server.test.ts mocks it.
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/docker', () => ({
  docker: vi.fn(async () => Buffer.from('')),
  dockerCall: () => ({ done: Promise.resolve(Buffer.from('')), kill: () => {} }),
}))

import { buildServer } from '../src/server'
import { resetAdmin } from '../src/auth'
import { clock } from '../src/identity'
import { loadState, mutate } from '../src/state'
import type { Config } from '../src/config'
import { makeEngine, serverConfig } from './fakes'

const EMAIL = 'admin@example.test'
const PASSWORD = 'hunter2hunter2'
let cfg: Config
let app: ReturnType<typeof buildServer>

beforeEach(() => {
  cfg = serverConfig()
  app = buildServer(makeEngine(cfg), cfg)
})
afterEach(() => { clock.now = () => Date.now() })

type Res = Awaited<ReturnType<typeof app.inject>>
const send = (method: string, url: string, opts: Record<string, unknown> = {}): Promise<Res> =>
  app.inject({ method: method as 'GET', url, ...opts })

/** The name=value pair of the session cookie the response set, for a Cookie header. */
function cookieOf(res: Res): string {
  const raw = res.headers['set-cookie']
  const first = Array.isArray(raw) ? raw[0] : String(raw ?? '')
  return first.split(';')[0]
}

const signUp = (email = EMAIL, password = PASSWORD, name?: string): Promise<Res> =>
  send('POST', '/api/auth/sign-up/email', { payload: { email, password, name } })
const signIn = (email = EMAIL, password = PASSWORD, extra: Record<string, unknown> = {}): Promise<Res> =>
  send('POST', '/api/auth/sign-in/email', { payload: { email, password, ...extra } })

/** Every (method, path) Fastify has registered, read back from printRoutes so a route added by a
 *  later package is swept automatically (the integrator reruns this after every merge). */
function registeredRoutes(tree: string): Array<{ method: string; path: string }> {
  const stack: string[] = []
  const out: Array<{ method: string; path: string }> = []
  for (const line of tree.split(chr10)) {
    const at = line.indexOf(marker)
    if (at === -1) continue
    const depth = Math.floor(at / 4)
    let label = line.slice(at + marker.length)
    let methods = ''
    const open = label.lastIndexOf(' (')
    if (open !== -1 && label.endsWith(')')) {
      methods = label.slice(open + 2, -1)
      label = label.slice(0, open)
    }
    stack.length = depth
    stack.push(label)
    if (!methods) continue
    const path = stack.join('')
    for (const m of methods.split(', ')) out.push({ method: m, path })
  }
  return out
}

const chr10 = '\n'
const marker = '── '

/** The contract allowlist (decision 9), spelled out here rather than imported, so the test
 *  fails if the implementation widens it. */
const API_OWNED = ['/projects', '/orgs', '/me', '/tokens', '/healthz', '/regions', '/images', '/invitations', '/api', '/auth', '/tls', '/templates', '/template-deployments']
const apiOwned = (p: string): boolean => API_OWNED.some((x) => p === x || p.startsWith(`${x}/`))
function publicRoute(method: string, path: string): boolean {
  if (path === '/healthz') return true
  if (path.startsWith('/api/auth/')) return true
  if (path.startsWith('/auth/')) return true
  if (path.startsWith('/webhooks/')) return true // git push-to-deploy webhooks verify by HMAC, not the guard
  if (method === 'GET' && (path === '/templates' || path.startsWith('/templates/'))) return true
  return method === 'GET' && !apiOwned(path)
}

const fill = (path: string): string =>
  path.split('/').map((seg) => (seg.startsWith(':') ? 'x' : seg)).join('/')

test('401 sweep: every route outside the allowlist answers 401 unauthorized with a challenge', async () => {
  await app.ready()
  const routes = registeredRoutes(app.printRoutes({ commonPrefix: false }))
  expect(routes.length).toBeGreaterThan(50)
  const guarded = routes.filter((r) => r.method !== 'HEAD' && !publicRoute(r.method, r.path))
  expect(guarded.length).toBeGreaterThan(40)
  for (const r of guarded) {
    const res = await send(r.method, fill(r.path), { payload: {} })
    expect(`${r.method} ${r.path} -> ${res.statusCode}`).toBe(`${r.method} ${r.path} -> 401`)
    expect(res.json()).toEqual({ error: 'unauthorized' })
    expect(res.headers['www-authenticate']).toBe('Bearer realm="insta-oss"')
  }
})

test('healthz and the auth mounts stay public, and GET / serves the shell', async () => {
  expect((await send('GET', '/healthz')).statusCode).toBe(200)
  expect((await send('POST', '/api/auth/sign-in/email', { payload: {} })).statusCode).toBe(400)
  expect((await send('POST', '/auth/login', { payload: {} })).statusCode).toBe(400)
  expect((await send('GET', '/some/spa/route')).statusCode).not.toBe(401)
})

test('sign-up creates the one admin, sets the session cookie, and refuses a second', async () => {
  const res = await signUp()
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.token).toHaveLength(32)
  expect(body.user).toMatchObject({ email: EMAIL, name: 'admin', emailVerified: true, image: null })
  expect(body.user.passwordHash).toBeUndefined()
  expect(cookieOf(res).startsWith('__Secure-better-auth.session_token=')).toBe(true)
  const again = await signUp()
  expect(again.statusCode).toBe(422)
  expect(again.json().code).toBe('USER_ALREADY_EXISTS')
})

test('sign-up validates the Better Auth way', async () => {
  expect((await signUp('nope', PASSWORD)).json().code).toBe('INVALID_EMAIL')
  expect((await signUp(EMAIL, 'short')).json().code).toBe('PASSWORD_TOO_SHORT')
  expect((await signUp(EMAIL, 'x'.repeat(257))).json().code).toBe('PASSWORD_TOO_LONG')
  expect(loadState().identity?.admin ?? null).toBeNull()
})

test('sign-in: wrong password 401, right password 200 with the set-auth-token header', async () => {
  await signUp()
  const bad = await signIn(EMAIL, 'wrong password')
  expect(bad.statusCode).toBe(401)
  expect(bad.json().code).toBe('INVALID_EMAIL_OR_PASSWORD')
  const unknown = await signIn('other@example.test', PASSWORD)
  expect(unknown.statusCode).toBe(401)
  expect(unknown.json().code).toBe('INVALID_EMAIL_OR_PASSWORD')
  const ok = await signIn()
  expect(ok.statusCode).toBe(200)
  expect(ok.json()).toMatchObject({ redirect: false })
  expect(ok.json().url).toBeUndefined()
  expect(ok.headers['set-auth-token']).toBe(ok.json().token)
})

test('sign-in rate limit: the eleventh attempt from one ip is 429', async () => {
  await signUp()
  for (let i = 0; i < 10; i++) expect((await signIn(EMAIL, 'wrong')).statusCode).toBe(401)
  const blocked = await signIn(EMAIL, PASSWORD)
  expect(blocked.statusCode).toBe(429)
  expect(blocked.json().code).toBe('TOO_MANY_REQUESTS')
})

test('a forged X-Forwarded-For cannot buy a fresh rate-limit bucket', async () => {
  await signUp()
  // The edge appends the peer it saw, so the chain the daemon reads is `<whatever the client
  // wrote>, <the real client>`. Trusting the whole chain would read the leftmost entry, and the
  // attacker below would get one bucket per attempt and never be limited at all.
  const attempt = (i: number): Promise<Res> => send('POST', '/api/auth/sign-in/email', {
    payload: { email: EMAIL, password: 'wrong' },
    headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` },
  })
  for (let i = 0; i < 10; i++) expect((await attempt(i)).statusCode).toBe(401)
  const blocked = await attempt(99)
  expect(blocked.statusCode).toBe(429)
  expect(blocked.json().code).toBe('TOO_MANY_REQUESTS')
  // And the address the session records is the one the edge observed, not the one it was handed.
  const other = await send('POST', '/api/auth/sign-in/email', {
    payload: { email: EMAIL, password: PASSWORD },
    headers: { 'x-forwarded-for': '10.0.0.1, 198.51.100.4' },
  })
  expect(other.statusCode).toBe(200)
  expect(loadState().identity?.sessions.at(-1)?.ipAddress).toBe('198.51.100.4')
})

test('rememberMe false gives a session cookie with no Max-Age', async () => {
  await signUp()
  const res = await signIn(EMAIL, PASSWORD, { rememberMe: false })
  const raw = res.headers['set-cookie']
  expect(String(Array.isArray(raw) ? raw[0] : raw)).not.toContain('Max-Age')
})

test('get-session answers for a cookie and a bearer session, and null otherwise', async () => {
  const up = await signUp()
  const cookie = cookieOf(up)
  const token = up.json().token
  const viaCookie = await send('GET', '/api/auth/get-session', { headers: { cookie } })
  expect(viaCookie.statusCode).toBe(200)
  expect(viaCookie.json().session.token).toBe(token)
  expect(viaCookie.json().user.email).toBe(EMAIL)
  const viaBearer = await send('GET', '/api/auth/get-session', { headers: { authorization: `Bearer ${token}` } })
  expect(viaBearer.json().session.userId).toBe(viaCookie.json().user.id)
  expect((await send('GET', '/api/auth/get-session')).body).toBe('null')
  const key = (await send('POST', '/tokens', { headers: { cookie }, payload: { name: 'cli' } })).json().token
  const viaKey = await send('GET', '/api/auth/get-session', { headers: { authorization: `Bearer ${key}` } })
  expect(viaKey.body).toBe('null')
})

test('sign-out clears the cookie and invalidates the token', async () => {
  const up = await signUp()
  const cookie = cookieOf(up)
  const out = await send('POST', '/api/auth/sign-out', { headers: { cookie } })
  expect(out.statusCode).toBe(200)
  expect(out.json()).toEqual({ success: true })
  expect(cookieOf(out)).toBe('__Secure-better-auth.session_token=')
  expect((await send('GET', '/me', { headers: { cookie } })).statusCode).toBe(401)
  expect((await send('POST', '/api/auth/sign-out')).json()).toEqual({ success: true })
})

test('me: PublicUser plus via jwt for a session and via api for an insta_ key', async () => {
  const up = await signUp()
  const cookie = cookieOf(up)
  const mine = await send('GET', '/me', { headers: { cookie } })
  expect(mine.statusCode).toBe(200)
  expect(mine.json()).toEqual({ user: { id: up.json().user.id, email: EMAIL, name: 'admin', avatarUrl: null, emailVerified: true }, via: 'jwt' })
  const key = (await send('POST', '/tokens', { headers: { cookie }, payload: { name: 'cli' } })).json().token
  const byKey = await send('GET', '/me', { headers: { authorization: `Bearer ${key}` } })
  expect(byKey.json().via).toBe('api')
  expect(byKey.json().user.email).toBe(EMAIL)
  expect((await send('GET', '/me', { headers: { authorization: 'Bearer insta_nope' } })).statusCode).toBe(401)
  expect((await send('GET', '/me', { headers: { authorization: 'Bearer ' } })).statusCode).toBe(401)
})

test('tokens: create, list newest first, delete once, and reject orgId', async () => {
  const cookie = cookieOf(await signUp())
  const h = { cookie }
  const one = await send('POST', '/tokens', { headers: h, payload: { name: 'one' } })
  expect(one.statusCode).toBe(201)
  expect(one.json().token).toMatch(/^insta_[A-Za-z]{64}$/)
  expect(one.json().record.keyHash).toBeUndefined()
  const two = await send('POST', '/tokens', { headers: h, payload: { name: 'two', expiresInDays: 30 } })
  const list = await send('GET', '/tokens', { headers: h })
  expect(list.json().tokens.map((t: { name: string }) => t.name)).toEqual(['two', 'one'])
  const expiresAt = Date.parse(two.json().record.expiresAt)
  expect(expiresAt - Date.now()).toBeGreaterThan(29 * 86_400_000)
  expect(expiresAt - Date.now()).toBeLessThan(31 * 86_400_000)
  const id = one.json().record.id
  expect((await send('DELETE', `/tokens/${id}`, { headers: h })).json()).toEqual({ ok: true })
  const gone = await send('DELETE', `/tokens/${id}`, { headers: h })
  expect(gone.statusCode).toBe(404)
  expect(gone.json()).toEqual({ error: 'token not found' })
  const bad = await send('POST', '/tokens', { headers: h, payload: { name: 'x', orgId: 'x' } })
  expect(bad.statusCode).toBe(400)
  expect(bad.json().error).toContain('orgId must be omitted')
})

// Scopes are accepted and echoed because that is the cloud's wire shape (it stashes them on the
// api key's metadata and reads them onto its Actor), and neither plane enforces them: any valid
// `insta_` key is a full actor on every route. Rejecting them would break a CLI that talks to
// both, so the daemon takes them and says plainly what they are worth.
test('token scopes are informational: echoed, warned about, and NOT a permission boundary', async () => {
  const cookie = cookieOf(await signUp())
  const h = { cookie }
  const scoped = await send('POST', '/tokens', { headers: h, payload: { name: 'ro', scopes: ['read'] } })
  expect(scoped.statusCode).toBe(201)
  expect(scoped.json().record.scopes).toEqual(['read'])
  expect(scoped.json().warning).toMatch(/never enforced/)

  // A create with no scopes carries no warning: that response stays the cloud's shape byte for byte.
  const plain = await send('POST', '/tokens', { headers: h, payload: { name: 'full' } })
  expect(plain.json().record.scopes).toEqual([])
  expect(plain.json().warning).toBeUndefined()

  // The claim the warning makes is true: a `read`-scoped key performs a WRITE, and mints another
  // token while it is at it.
  const key = scoped.json().token
  const bearer = { authorization: `Bearer ${key}` }
  const created = await send('POST', '/orgs/local/projects', { headers: bearer, payload: { name: 'written-by-ro' } })
  expect(created.statusCode).toBe(201)
  expect((await send('POST', '/tokens', { headers: bearer, payload: { name: 'minted-by-ro' } })).statusCode).toBe(201)
  // ...and revoking it is what actually stops it, since the scope never did.
  await send('DELETE', `/tokens/${scoped.json().record.id}`, { headers: h })
  expect((await send('GET', '/me', { headers: bearer })).statusCode).toBe(401)
})

test('a revoked key and an expired key both stop authenticating', async () => {
  const cookie = cookieOf(await signUp())
  const h = { cookie }
  const live = await send('POST', '/tokens', { headers: h, payload: { name: 'live' } })
  const short = await send('POST', '/tokens', { headers: h, payload: { name: 'short', expiresInDays: 1 } })
  const bearer = (key: string) => send('GET', '/me', { headers: { authorization: `Bearer ${key}` } })
  expect((await bearer(live.json().token)).statusCode).toBe(200)
  await send('DELETE', `/tokens/${live.json().record.id}`, { headers: h })
  expect((await bearer(live.json().token)).statusCode).toBe(401)
  clock.now = () => Date.now() + 2 * 86_400_000
  expect((await bearer(short.json().token)).statusCode).toBe(401)
})

test('auth/login returns the AuthResult the CLI reads, and refresh keeps the same token', async () => {
  await signUp()
  const res = await send('POST', '/auth/login', { payload: { email: EMAIL, password: PASSWORD } })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.accessToken).toBe(body.refreshToken)
  expect(body.expiresIn).toBeGreaterThan(0)
  expect(body.user).toMatchObject({ email: EMAIL, avatarUrl: null, emailVerified: true })
  expect(res.headers['set-cookie']).toBeUndefined()
  const again = await send('POST', '/auth/refresh', { payload: { refreshToken: body.refreshToken } })
  expect(again.json().accessToken).toBe(body.refreshToken)
  expect((await send('POST', '/auth/logout', { payload: { refreshToken: body.refreshToken } })).json()).toEqual({ ok: true })
  expect((await send('POST', '/auth/logout', { payload: {} })).json()).toEqual({ ok: true })
  expect((await send('POST', '/auth/refresh', { payload: { refreshToken: body.refreshToken } })).statusCode).toBe(401)
})

test('auth/login error texts are the ones the CLI prints, and refresh rejects an insta_ key', async () => {
  const cookie = cookieOf(await signUp())
  const bad = await send('POST', '/auth/login', { payload: { email: EMAIL, password: 'wrong' } })
  expect(bad.statusCode).toBe(401)
  expect(bad.json()).toEqual({ error: 'invalid credentials' })
  const unknown = await send('POST', '/auth/login', { payload: { email: 'no@example.test', password: PASSWORD } })
  expect(unknown.json()).toEqual({ error: 'invalid credentials' })
  const malformed = await send('POST', '/auth/login', { payload: { email: 'nope', password: PASSWORD } })
  expect(malformed.statusCode).toBe(400)
  expect(malformed.json()).toEqual({ error: 'invalid email' })
  const key = (await send('POST', '/tokens', { headers: { cookie }, payload: { name: 'cli' } })).json().token
  expect((await send('POST', '/auth/refresh', { payload: { refreshToken: key } })).statusCode).toBe(401)
})

test('email-verification signup stays cloud-only (501)', async () => {
  const signup = await send('POST', '/auth/signup', { payload: {} })
  expect(signup.statusCode).toBe(501)
  expect(signup.json().error).toBe(`email-verification signup is cloud-only; create the admin at ${cfg.consoleUrl}/setup`)
})

test('device login: code -> pending -> the admin approves in the console -> the CLI polls out an insta_ key', async () => {
  const cookie = cookieOf(await signUp())

  // Step A: the CLI initiates. Shape is RFC 8628 / what the CLI reads.
  const code = await send('POST', '/api/auth/device/code', { payload: { client_id: 'insta-cli' } })
  expect(code.statusCode).toBe(200)
  const start = code.json()
  expect(typeof start.device_code).toBe('string')
  expect(start.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  expect(start.verification_uri).toBe(`${cfg.consoleUrl}/device`)
  expect(start.verification_uri_complete).toBe(`${cfg.consoleUrl}/device?code=${encodeURIComponent(start.user_code)}`)
  expect(start.expires_in).toBeGreaterThan(0)
  expect(start.interval).toBe(5)

  // Step B, before approval: the poll is authorization_pending on a 400 (the CLI keeps waiting).
  const pending = await send('POST', '/api/auth/device/token', { payload: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: start.device_code, client_id: 'insta-cli' } })
  expect(pending.statusCode).toBe(400)
  expect(pending.json()).toEqual({ error: 'authorization_pending' })

  // Approval is guarded: no session -> 401 (a stranger cannot approve a code).
  const anon = await send('POST', '/device/approve', { payload: { user_code: start.user_code } })
  expect(anon.statusCode).toBe(401)

  // The signed-in admin approves (the grouped code with its dash is accepted).
  const approve = await send('POST', '/device/approve', { headers: { cookie }, payload: { user_code: start.user_code } })
  expect(approve.statusCode).toBe(200)
  expect(approve.json()).toEqual({ ok: true })

  // Mint-on-collection: approval alone mints no key; it appears only when the CLI collects the code.
  const before = (await send('GET', '/tokens', { headers: { cookie } })).json().tokens.length

  // Step B, after approval: 200 with the minted insta_ key and its OAuth token_type.
  const granted = await send('POST', '/api/auth/device/token', { payload: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: start.device_code, client_id: 'insta-cli' } })
  expect(granted.statusCode).toBe(200)
  const accessToken = granted.json().access_token as string
  expect(accessToken).toMatch(/^insta_[A-Za-z]{64}$/)
  expect(granted.json().token_type).toBe('Bearer')
  const after = (await send('GET', '/tokens', { headers: { cookie } })).json().tokens.length
  expect(after).toBe(before + 1)

  // The key authenticates like any other bearer, as the admin.
  const me = await send('GET', '/me', { headers: { authorization: `Bearer ${accessToken}` } })
  expect(me.statusCode).toBe(200)
  expect(me.json().via).toBe('api')

  // The code is one-time: a second poll is spent.
  const again = await send('POST', '/api/auth/device/token', { payload: { device_code: start.device_code } })
  expect(again.statusCode).toBe(400)
  expect(again.json()).toEqual({ error: 'expired_token' })
})

test('device login edges: unknown code, unauthorized approve target, and deny', async () => {
  const cookie = cookieOf(await signUp())

  // An unknown device_code polls as expired_token (the CLI stops rather than looping forever).
  const unknown = await send('POST', '/api/auth/device/token', { payload: { device_code: 'nope' } })
  expect(unknown.statusCode).toBe(400)
  expect(unknown.json()).toEqual({ error: 'expired_token' })

  // Approving a code that was never issued is a 404, not a minted key.
  const noSuch = await send('POST', '/device/approve', { headers: { cookie }, payload: { user_code: 'ZZZZ-ZZZZ' } })
  expect(noSuch.statusCode).toBe(404)

  // Deny turns a pending code into access_denied on the next poll.
  const start = (await send('POST', '/api/auth/device/code', { payload: {} })).json()
  expect((await send('POST', '/device/deny', { headers: { cookie }, payload: { user_code: start.user_code } })).json()).toEqual({ ok: true })
  const denied = await send('POST', '/api/auth/device/token', { payload: { device_code: start.device_code } })
  expect(denied.statusCode).toBe(400)
  expect(denied.json()).toEqual({ error: 'access_denied' })
})

test('device login: a code expires after its TTL, on both the poll and a late approval', async () => {
  const cookie = cookieOf(await signUp())
  const t0 = Date.now()
  clock.now = () => t0
  const a = (await send('POST', '/api/auth/device/code', { payload: {} })).json()
  const b = (await send('POST', '/api/auth/device/code', { payload: {} })).json()
  // Jump past the 15-minute TTL. gc runs only at issuance, so both records are still present and each
  // op checks its own expiry inline: the poll on A is expired_token, and a late approval of B is 410.
  clock.now = () => t0 + 16 * 60 * 1000
  const poll = await send('POST', '/api/auth/device/token', { payload: { device_code: a.device_code } })
  expect(poll.statusCode).toBe(400)
  expect(poll.json()).toEqual({ error: 'expired_token' })
  const approve = await send('POST', '/device/approve', { headers: { cookie }, payload: { user_code: b.user_code } })
  expect(approve.statusCode).toBe(410)
})

test('device login: the unauthenticated issue endpoint is per-IP capped (429, no unbounded store)', async () => {
  await signUp()
  // The in-process inject uses one client IP, so the per-IP cap is what a flood from one source hits.
  let capped = false
  for (let i = 0; i < 40; i++) {
    const r = await send('POST', '/api/auth/device/code', { payload: {} })
    if (r.statusCode === 429) { capped = true; break }
    expect(r.statusCode).toBe(200)
  }
  expect(capped).toBe(true)
})

test('CSRF belt: a cookie write is rejected only when a presented Origin is foreign', async () => {
  const cookie = cookieOf(await signUp())
  const write = (headers: Record<string, string>) => send('POST', '/tokens', { headers: { cookie, ...headers }, payload: { name: 'k' } })
  expect((await write({})).statusCode).toBe(201)
  expect((await write({ origin: 'https://console.example.test', host: 'console.example.test' })).statusCode).toBe(201)
  const foreign = await write({ origin: 'https://evil.test', host: 'console.example.test' })
  expect(foreign.statusCode).toBe(403)
  expect(foreign.json()).toEqual({ error: 'cross-site request rejected' })
  expect((await write({ referer: 'https://evil.test/page', host: 'console.example.test' })).statusCode).toBe(403)
  expect((await write({ 'sec-fetch-site': 'cross-site', host: 'console.example.test' })).statusCode).toBe(403)
  expect((await write({ 'sec-fetch-site': 'same-origin', host: 'console.example.test' })).statusCode).toBe(201)
})

test('a bearer request ignores Origin, and a cookie GET is never blocked', async () => {
  const cookie = cookieOf(await signUp())
  const key = (await send('POST', '/tokens', { headers: { cookie }, payload: { name: 'cli' } })).json().token
  const withKey = await send('POST', '/tokens', { headers: { authorization: `Bearer ${key}`, origin: 'https://evil.test', host: 'console.example.test' }, payload: { name: 'from-agent' } })
  expect(withKey.statusCode).toBe(201)
  const read = await send('GET', '/tokens', { headers: { cookie, origin: 'https://evil.test', host: 'console.example.test' } })
  expect(read.statusCode).toBe(200)
})

test('the SPA shell carries window.__INSTA_OSS__ and setupRequired flips after sign-up', async () => {
  const uiDist = mkdtempSync(join(tmpdir(), 'io-ui-'))
  writeFileSync(join(uiDist, 'index.html'), '<!doctype html><html><head><title>t</title></head><body></body></html>')
  const c = serverConfig({ INSTA_OSS_UI_DIST: uiDist })
  const a = buildServer(makeEngine(c), c)
  const before = await a.inject({ method: 'GET', url: '/' })
  expect(before.statusCode).toBe(200)
  expect(before.headers['content-type']).toContain('text/html')
  expect(before.body).toContain('window.__INSTA_OSS__=')
  expect(before.body).toContain('"setupRequired":true')
  expect(before.body).toContain('"mode":"server"')
  expect(before.body).toContain(`"consoleUrl":"${c.consoleUrl}"`)
  // The dashboard's always-on switch starts from the daemon's default, so the shell carries it:
  // off here (the suites pin it off), on for a daemon on its own default.
  expect(before.body).toContain('"alwaysOnDefault":false')
  const on = serverConfig({ INSTA_OSS_UI_DIST: uiDist, INSTA_OSS_ALWAYS_ON_DEFAULT: '1' })
  expect((await buildServer(makeEngine(on), on).inject({ method: 'GET', url: '/' })).body).toContain('"alwaysOnDefault":true')
  await a.inject({ method: 'POST', url: '/api/auth/sign-up/email', payload: { email: EMAIL, password: PASSWORD } })
  const after = await a.inject({ method: 'GET', url: '/' })
  expect(after.body).toContain('"setupRequired":false')
  const spa = await a.inject({ method: 'GET', url: '/services/whatever' })
  expect(spa.statusCode).toBe(200)
  expect(spa.body).toContain('window.__INSTA_OSS__=')
})

test('resetAdmin clears the admin and sessions, keeps the keys, and reuses the user id', async () => {
  const cookie = cookieOf(await signUp())
  const key = (await send('POST', '/tokens', { headers: { cookie }, payload: { name: 'cli' } })).json().token
  const firstId = loadState().identity!.admin!.id
  expect(resetAdmin(cfg, { log: () => {}, error: () => {} })).toBe(0)
  expect(loadState().identity!.admin).toBeNull()
  expect(loadState().identity!.sessions).toHaveLength(0)
  expect(loadState().identity!.tokens).toHaveLength(1)
  expect((await send('GET', '/me', { headers: { cookie } })).statusCode).toBe(401)
  expect((await send('GET', '/me', { headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401)
  const second = await signUp('new@example.test', PASSWORD)
  expect(second.statusCode).toBe(200)
  expect(second.json().user.id).toBe(firstId)
  const revived = await send('GET', '/me', { headers: { authorization: `Bearer ${key}` } })
  expect(revived.statusCode).toBe(200)
  expect(revived.json().via).toBe('api')
})

test('the allowlist keeps GET /templates public once WP5 registers it', () => {
  expect(publicRoute('GET', '/templates')).toBe(true)
  expect(publicRoute('GET', '/templates/next-postgres')).toBe(true)
  expect(publicRoute('POST', '/templates')).toBe(false)
  expect(publicRoute('GET', '/projects/x/services')).toBe(false)
  expect(publicRoute('GET', '/assets/app.js')).toBe(true)
})

test('a foreign session token and a stale admin id never authenticate', async () => {
  const up = await signUp()
  const token = up.json().token
  mutate((s) => { s.identity!.admin!.id = 'someone-else' })
  expect((await send('GET', '/me', { headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401)
})

test('an agent enrols itself: POST /agent/sessions needs the bearer and returns a usable receipt', async () => {
  const cookie = cookieOf(await signUp())
  const key = (await send('POST', '/tokens', { headers: { cookie }, payload: { name: 'cli' } })).json().token
  const res = await send('POST', '/agent/sessions', {
    headers: { authorization: `Bearer ${key}` },
    payload: { projectId: 'p1', client: 'claude-code', publicKey: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n' },
  })
  expect(res.statusCode).toBe(201)
  const out = res.json()
  expect(out.agentSessionId).toEqual(expect.any(String))
  expect(out.token).toMatch(/^agsess_/)
  expect(out.projectId).toBe('p1')
  expect(Date.parse(out.expiresAt)).toBeGreaterThan(Date.now())
  // The cloud's response schema is exactly these four keys and it strips the rest, so a receipt
  // this daemon shaped differently would be a surface only insta-oss has.
  expect(Object.keys(out).sort()).toEqual(['agentSessionId', 'expiresAt', 'projectId', 'token'])
  // A minted bearer is never cached by anything between here and the CLI.
  expect(res.headers['cache-control']).toBe('no-store')
  // The bootstrap call the CLI makes before it knows a project carries no projectId.
  const boot = await send('POST', '/agent/sessions', { headers: { authorization: `Bearer ${key}` }, payload: { client: 'codex' } })
  expect(boot.statusCode).toBe(201)
  expect(boot.json().projectId).toBeNull()
  expect(boot.json().agentSessionId).not.toBe(out.agentSessionId)
})
