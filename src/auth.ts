// Identity routes and the request guard (contract 00 sections 9 and 11; plan 01 sections 3 to 5, 8).
// Server mode: a bearer-or-signed-cookie guard on every route outside the allowlist, the cloud's
// Better Auth mount paths (/api/auth/*), its /auth/login|refresh|logout wrappers for `insta login
// --email`, /me as PublicUser + via, and /tokens minting `insta_` keys. Local mode registers exactly
// today's /me and the three /tokens 501s and no hook, so the local surface stays byte-identical.
// No endpoint here is missing on the cloud (contract 00 section 9, WP1 rows).
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from './config'
import { isApiPath } from './server'
import { acquireLock, initStatePath, loadState, mutate, releaseLock, type State } from './state'
import {
  AdminExists, DeviceCodeStore, DUMMY_HASH, HttpError, SignInLimiter, apiTokenOut, betterAuthUser, checkPassword, clearCookieHeader, clock,
  createAdmin, findSession, hashPassword, mintSession, mintToken, normalizeEmail, publicUser, readSessionCookie, revokeSession,
  revokeToken, sessionOut, setCookieHeader, verifyPassword, verifyToken, type AdminRow, type SessionRow,
} from './identity'

/** Who a request acts as, set by the guard on every non-public route in server mode. */
export interface Actor { userId: string; via: 'jwt' | 'api'; scopes?: string[]; source: 'bearer' | 'cookie' }

declare module 'fastify' {
  interface FastifyRequest { actor?: Actor | null }
}

const LOCAL_USER = { id: 'local', email: null, name: 'local' }

/** Server-mode allowlist (decision 9): /healthz, the Better Auth mount, the /auth wrappers, GET /templates*, and any GET outside the API prefixes (static assets and the SPA shell). */
export function isPublicPath(method: string, path: string): boolean {
  if (path === '/healthz') return true
  if (path.startsWith('/api/auth/')) return true
  if (path.startsWith('/auth/')) return true
  // Git push-to-deploy webhooks authenticate with a per-binding HMAC over the body, not the guard.
  if (path.startsWith('/webhooks/')) return true
  if (method === 'GET' && (path === '/templates' || path.startsWith('/templates/'))) return true
  if (method === 'GET' && !isApiPath(path)) return true
  return false
}

const body = (req: FastifyRequest): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>
const ua = (req: FastifyRequest): string => String(req.headers['user-agent'] ?? '')
const pathOf = (req: FastifyRequest): string => req.url.split('?')[0]

const unauthorized = (reply: FastifyReply): FastifyReply =>
  reply.header('WWW-Authenticate', 'Bearer realm="insta-oss"').code(401).send({ error: 'unauthorized' })

type Resolved = { actor: Actor; token: string; session?: SessionRow; admin: AdminRow }

/** Plan 01 section 4: a Bearer `insta_` key verifies as a token and NEVER falls through to the session lookup; any other bearer is a session token; no bearer means the signed cookie. Every actor requires the admin to exist and to own the session (covers --reset-admin). */
function resolveActor(req: FastifyRequest, cfg: Config, s: State): Resolved | null {
  const admin = s.identity?.admin
  if (!admin) return null
  const header = req.headers.authorization
  const bearer = typeof header === 'string' ? /^Bearer\s+(.*)$/i.exec(header.trim()) : null
  if (bearer) {
    const t = bearer[1].trim()
    if (!t) return null
    if (t.startsWith('insta_')) {
      const row = verifyToken(s, t)
      return row ? { actor: { userId: admin.id, via: 'api', scopes: row.scopes, source: 'bearer' }, token: t, admin } : null
    }
    const session = findSession(s, cfg.auth, t)
    return session && session.userId === admin.id ? { actor: { userId: session.userId, via: 'jwt', source: 'bearer' }, token: t, session, admin } : null
  }
  const ct = readSessionCookie(cfg.auth, req.headers.cookie)
  if (!ct) return null
  const session = findSession(s, cfg.auth, ct)
  return session && session.userId === admin.id ? { actor: { userId: session.userId, via: 'jwt', source: 'cookie' }, token: ct, session, admin } : null
}

/** CSRF belt (decision 59): a cookie-authenticated write is cross-site when a PRESENT Origin (else Referer) names another host, or Sec-Fetch-Site says so; with none of the three headers (curl, the headless setup recipe) it passes. */
export function isCrossSite(headers: { origin?: string; referer?: string; host?: string; 'sec-fetch-site'?: string }): boolean {
  const presented = headers.origin ?? headers.referer
  if (presented !== undefined) {
    let host: string | null = null
    try { host = new URL(presented).host.toLowerCase() } catch { host = null }
    if (!host || host !== String(headers.host ?? '').trim().toLowerCase()) return true
  }
  return headers['sec-fetch-site'] === 'cross-site'
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function sendError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof HttpError) return reply.code(e.status).send(e.body)
  if (e instanceof AdminExists) return reply.code(422).send({ code: 'USER_ALREADY_EXISTS', message: e.message })
  throw e
}

const authResult = (token: string, session: SessionRow, admin: AdminRow) => ({
  accessToken: token,
  refreshToken: token,
  expiresIn: Math.max(0, Math.floor((Date.parse(session.expiresAt) - clock.now()) / 1000)),
  user: publicUser(admin),
})

type SignIn =
  | { ok: true; token: string; session: SessionRow; admin: AdminRow }
  | { ok: false; reason: 'invalid_email' | 'invalid_credentials' | 'too_many' }

/** Twelve hours: long enough for a working session, short enough that a leaked receipt ages out. */
const AGENT_SESSION_TTL_SEC = 12 * 60 * 60

/**
 * POST /agent/sessions, in BOTH run modes. The CLI enrols itself as an agent whenever it detects
 * one around it (CLAUDECODE, CODEX_THREAD_ID, CURSOR_AGENT) and then mints a session before its
 * FIRST authenticated call, so a daemon without this route answers 404 and every command from an
 * agent shell dies there, `insta login` included.
 *
 * The receipt is not a credential here. One box has one admin, the bearer already carries its full
 * access, and this daemon does not verify the Ed25519 assertion the CLI signs with the returned id:
 * the session identifies the client, it never widens or narrows what the caller can already do. In
 * server mode the route sits behind the same guard as the rest of the API, so an agent still needs
 * a valid `insta_` token or session to obtain one.
 */
function registerAgentSessions(app: FastifyInstance): void {
  app.post('/agent/sessions', async (req, reply) => {
    const b = body(req)
    const projectId = typeof b.projectId === 'string' && b.projectId ? b.projectId : null
    // Exactly the cloud's four response keys and its `cache-control` (platform govern/agent-routes.ts
    // `issueAgentSession`, openapi.yaml `/agent/sessions`). Its schema strips anything else, so a
    // fifth key here would be a shape only this daemon emits; the CLI reads `client` off its own
    // detection, never off the answer.
    return reply.header('cache-control', 'no-store').code(201).send({
      token: `agsess_${randomUUID().replace(/-/g, '')}`,
      agentSessionId: randomUUID(),
      projectId,
      expiresAt: new Date(clock.now() + AGENT_SESSION_TTL_SEC * 1000).toISOString(),
    })
  })
}

/** Registers the identity surface for `cfg.mode`; call right after the content-type parser. */
export function registerAuth(app: FastifyInstance, cfg: Config): void {
  registerAgentSessions(app)
  if (!cfg.auth.enabled) {
    // Local mode: byte-identical to the pre-identity daemon (contract 00 section 11).
    const notCloud = (reply: FastifyReply, what: string) =>
      reply.code(501).send({ error: `${what} is cloud-only — InstaCloud OSS is a single-tenant local runtime` })
    app.get('/me', async () => ({ user: LOCAL_USER }))
    app.get('/tokens', async (_req, reply) => notCloud(reply, 'agent tokens'))
    app.post('/tokens', async (_req, reply) => notCloud(reply, 'agent tokens'))
    app.delete('/tokens/:tid', async (_req, reply) => notCloud(reply, 'agent tokens'))
    return
  }

  app.decorateRequest('actor', null)
  const limiter = new SignInLimiter()
  const devices = new DeviceCodeStore()

  // ---- guard (plan 01 section 3) ----
  app.addHook('onRequest', async (req, reply) => {
    const path = pathOf(req)
    if (isPublicPath(req.method, path)) return
    const r = resolveActor(req, cfg, loadState())
    if (!r) return unauthorized(reply)
    if (r.actor.source === 'cookie' && !SAFE_METHODS.has(req.method) && isCrossSite(req.headers as Record<string, string | undefined>)) {
      return reply.code(403).send({ error: 'cross-site request rejected' })
    }
    req.actor = r.actor
  })

  /** Shared by /api/auth/sign-in/email and /auth/login: limiter first, one scrypt either way, failures recorded per IP. */
  const signIn = (req: FastifyRequest, b: Record<string, unknown>, rememberMe: boolean): SignIn => {
    const ip = req.ip
    if (limiter.blocked(ip)) return { ok: false, reason: 'too_many' }
    let email: string
    try { email = normalizeEmail(b.email) } catch { return { ok: false, reason: 'invalid_email' } }
    const password = typeof b.password === 'string' ? b.password : ''
    const admin = loadState().identity?.admin
    if (!admin || admin.email !== email) {
      verifyPassword(password, DUMMY_HASH)
      limiter.fail(ip)
      return { ok: false, reason: 'invalid_credentials' }
    }
    if (!verifyPassword(password, admin.passwordHash)) {
      limiter.fail(ip)
      return { ok: false, reason: 'invalid_credentials' }
    }
    limiter.clear(ip)
    const { token, row } = mutate((s) => mintSession(s, cfg.auth, admin.id, ip, ua(req), rememberMe))
    return { ok: true, token, session: row, admin }
  }

  // ---- Better Auth mount (the dashboard's client) ----
  app.post('/api/auth/sign-up/email', async (req, reply) => {
    const b = body(req)
    try {
      const email = normalizeEmail(b.email)
      const password = checkPassword(b.password)
      const name = typeof b.name === 'string' ? b.name : undefined
      if (loadState().identity?.admin) throw new AdminExists()
      const passwordHash = hashPassword(password)
      const { admin, token } = mutate((s) => {
        const admin = createAdmin(s, { email, name, passwordHash })
        const { token } = mintSession(s, cfg.auth, admin.id, req.ip, ua(req), true)
        return { admin, token }
      })
      reply.header('set-cookie', setCookieHeader(cfg.auth, token, true))
      return { token, user: betterAuthUser(admin) }
    } catch (e) { return sendError(reply, e) }
  })

  app.post('/api/auth/sign-in/email', async (req, reply) => {
    const b = body(req)
    const rememberMe = b.rememberMe !== false
    const r = signIn(req, b, rememberMe)
    if (!r.ok) {
      if (r.reason === 'too_many') return reply.code(429).send({ code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please try again later.' })
      if (r.reason === 'invalid_email') return reply.code(400).send({ code: 'INVALID_EMAIL', message: 'Invalid email' })
      return reply.code(401).send({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' })
    }
    reply.header('set-cookie', setCookieHeader(cfg.auth, r.token, rememberMe))
    reply.header('set-auth-token', r.token)
    return { redirect: false, token: r.token, user: betterAuthUser(r.admin) }
  })

  app.get('/api/auth/get-session', async (req, reply) => {
    const r = resolveActor(req, cfg, loadState())
    if (!r || r.actor.via !== 'jwt' || !r.session) return reply.type('application/json').send('null')
    return { session: sessionOut(r.session, r.token), user: betterAuthUser(r.admin) }
  })

  app.post('/api/auth/sign-out', async (req, reply) => {
    const r = resolveActor(req, cfg, loadState())
    if (r?.session) mutate((s) => revokeSession(s, r.token))
    reply.header('set-cookie', clearCookieHeader(cfg.auth))
    return { success: true }
  })

  // ---- device authorization (RFC 8628): `insta login --device` against a self-hosted box ----
  // The daemon has no cloud IdP, so the second factor is the console: the admin is already signed in
  // there, and approving the short user code mints an `insta_` key for the CLI. Both endpoints are
  // under /api/auth/ (public allowlist) because a login flow is by definition pre-auth; the approval
  // step (POST /device/approve) is a separate, guarded route.
  app.post('/api/auth/device/code', async (req, reply) => {
    // Bounded and per-IP capped: this endpoint is unauthenticated, so a null means a flood cap was hit.
    const d = devices.start(req.ip)
    if (!d) return reply.code(429).send({ error: 'too many device logins in progress; try again shortly' })
    const verificationUri = `${cfg.consoleUrl}/device`
    return reply.header('cache-control', 'no-store').send({
      device_code: d.deviceCode,
      user_code: d.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(d.userCode)}`,
      expires_in: d.expiresIn,
      interval: d.interval,
    })
  })

  // The CLI polls this with its device_code. RFC 8628 semantics: pending/expired/denied ride on a 400
  // body `{error}`; success is 200 `{access_token, token_type}`. The `insta_` key is minted HERE, when
  // an approved code is collected, so an approval the CLI abandons leaves no orphan key behind.
  app.post('/api/auth/device/token', async (req, reply) => {
    const b = body(req)
    const deviceCode = typeof b.device_code === 'string' ? b.device_code : ''
    const r = devices.poll(deviceCode)
    if (r.status === 'approved') {
      const name = `CLI device login (${new Date(clock.now()).toISOString().slice(0, 10)})`
      const key = mutate((s) => mintToken(s, { name }).key)
      return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send({ access_token: key, token_type: 'Bearer' })
    }
    const error = r.status === 'pending' ? 'authorization_pending' : r.status === 'denied' ? 'access_denied' : 'expired_token'
    return reply.code(400).send({ error })
  })

  // ---- the cloud's /auth wrappers (the CLI's `insta login --email`) ----
  app.post('/auth/login', async (req, reply) => {
    const r = signIn(req, body(req), true)
    if (!r.ok) {
      if (r.reason === 'too_many') return reply.code(429).send({ error: 'too many attempts' })
      if (r.reason === 'invalid_email') return reply.code(400).send({ error: 'invalid email' })
      return reply.code(401).send({ error: 'invalid credentials' })
    }
    return authResult(r.token, r.session, r.admin)
  })

  app.post('/auth/refresh', async (req, reply) => {
    const t = body(req).refreshToken
    if (typeof t !== 'string' || !t) return reply.code(400).send({ error: 'refreshToken is required' })
    const s = loadState()
    const admin = s.identity?.admin
    if (!admin || t.startsWith('insta_')) return reply.code(401).send({ error: 'invalid refresh token' })
    const session = findSession(s, cfg.auth, t)
    if (!session || session.userId !== admin.id) return reply.code(401).send({ error: 'invalid refresh token' })
    return authResult(t, session, admin)
  })

  app.post('/auth/logout', async (req) => {
    const t = body(req).refreshToken
    if (typeof t === 'string' && t && !t.startsWith('insta_')) mutate((s) => revokeSession(s, t))
    return { ok: true }
  })

  app.post('/auth/signup', async (_req, reply) =>
    reply.code(501).send({ error: `email-verification signup is cloud-only; create the admin at ${cfg.consoleUrl}/setup` }))

  // ---- account ----
  app.get('/me', async (req, reply) => {
    const admin = loadState().identity?.admin
    const a = req.actor
    if (!admin || !a) return unauthorized(reply)
    return { user: publicUser(admin), via: a.via }
  })

  app.get('/tokens', async () => ({ tokens: (loadState().identity?.tokens ?? []).map(apiTokenOut) }))

  // `scopes` is accepted, stored and echoed, and never enforced: any valid `insta_` key is a full
  // actor. That is the cloud's behaviour too, not a local shortcut (platform accounts/service.ts
  // stashes scopes in the api key's metadata, auth/service.ts reads them onto the Actor, and no
  // route ever consults the field), so the wire shape stays identical and a CLI that sends scopes
  // to both keeps working. What the cloud does NOT do is tell you, and a caller who sets
  // `scopes: ['read']` and believes it has a read-only key has a full-power one. So a request that
  // supplies scopes gets that said back to it. A request that sends none is byte-identical to the
  // cloud's response.
  const SCOPES_NOTE = 'scopes are recorded and returned for your own bookkeeping, never enforced: this daemon has one admin, and every valid token acts as that admin. Revoke a token to take its access away.'

  app.post('/tokens', async (req, reply) => {
    const b = body(req)
    if (b.orgId !== undefined && b.orgId !== null) return reply.code(400).send({ error: 'orgId must be omitted on a single-tenant daemon' })
    try {
      const { key, row } = mutate((s) => mintToken(s, { name: b.name, scopes: b.scopes, expiresInDays: b.expiresInDays }))
      return reply.code(201).send({
        token: key, record: apiTokenOut(row),
        ...(row.scopes.length ? { warning: SCOPES_NOTE } : {}),
      })
    } catch (e) { return sendError(reply, e) }
  })

  app.delete('/tokens/:tokenId', async (req, reply) => {
    const { tokenId } = req.params as { tokenId: string }
    const live = loadState().identity?.tokens.some((r) => r.id === tokenId && !r.revokedAt) ?? false
    if (!live || !mutate((s) => revokeToken(s, tokenId))) return reply.code(404).send({ error: 'token not found' })
    return { ok: true }
  })

  // ---- device approval (the console page the admin opens to finish `insta login --device`) ----
  // Gated: /device is NOT in the public allowlist, so the onRequest hook has already established that
  // this is the signed-in admin. Approving marks the pending code; the `insta_` key is minted when the
  // CLI collects it at /api/auth/device/token, and then shows up under Account > API Tokens, revocable.
  const deviceUserCode = (req: FastifyRequest): string => {
    const b = body(req)
    return typeof b.user_code === 'string' ? b.user_code : typeof b.userCode === 'string' ? b.userCode : ''
  }
  app.post('/device/approve', async (req, reply) => {
    if (!deviceUserCode(req).trim()) return reply.code(400).send({ error: 'user_code is required' })
    const outcome = devices.approve(deviceUserCode(req))
    if (outcome === 'ok') return { ok: true }
    if (outcome === 'not_found') return reply.code(404).send({ error: 'that code was not found; check it and try again' })
    if (outcome === 'expired') return reply.code(410).send({ error: 'that code has expired; start the login again' })
    return reply.code(409).send({ error: 'that code was already used' })
  })
  app.post('/device/deny', async (req, reply) => {
    if (!deviceUserCode(req).trim()) return reply.code(400).send({ error: 'user_code is required' })
    return devices.deny(deviceUserCode(req)) ? { ok: true } : reply.code(404).send({ error: 'that code was not found' })
  })
}

/** `instad --reset-admin` (plan 01 section 8): takes the data-dir lock like a boot (so a running daemon can never serve a deleted admin from its cache), removes the admin and every session, keeps the `insta_` tokens, and remembers the admin id so the next sign-up reuses it. Returns the exit code. */
export function resetAdmin(cfg: Config, out: { log(msg: string): void; error(msg: string): void } = console): number {
  if (!cfg.auth.enabled) {
    out.error('--reset-admin applies to server mode only (local mode has no admin)')
    return 1
  }
  initStatePath(cfg.statePath)
  try { acquireLock(cfg.dataDir, { timeoutMs: 0 }) }
  catch (e) {
    out.error(`${e instanceof Error ? e.message : String(e)}\nstop the daemon first (docker compose stop instad) then re-run`)
    return 1
  }
  try {
    if (!loadState().identity?.admin) {
      out.log('no admin exists')
      return 0
    }
    mutate((s) => {
      const id = s.identity
      if (!id?.admin) return
      id.previousAdminId = id.admin.id
      id.admin = null
      id.sessions = []
    })
    out.log(`admin removed; open ${cfg.consoleUrl}/setup to create a new one (existing insta_ tokens keep working once it exists)`)
    return 0
  } finally { releaseLock() }
}
