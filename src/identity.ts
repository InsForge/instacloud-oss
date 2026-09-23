// Identity primitives for server mode (contract 00 sections 5 and 9; plan 01 section 2). Functions
// over the IdentityState carried in state.json plus node:crypto, nothing else: scrypt passwords with
// a fixed dummy hash for unknown-email timing parity, Better Auth shaped sessions and signed cookies,
// `insta_` API keys, the output mappers the cloud's routes emit, and the per-IP sign-in failure
// limiter. Callers pass the State they are mutating (inside `mutate`) or a fresh `loadState()` clone;
// the low-rate audit fields (session slide, token lastUsedAt) go through `touchLater`, looked up by
// id, never through captured references.
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Config } from './config'
import { EMPTY_IDENTITY, touchLater, type IdentityState, type State } from './state'

export type AdminRow = NonNullable<IdentityState['admin']>
export type SessionRow = IdentityState['sessions'][number]
export type TokenRow = IdentityState['tokens'][number]
export type AuthConfig = Config['auth']

/** Injectable clock: tests override `clock.now`. Every timestamp in this module comes from it. */
export const clock = { now: (): number => Date.now() }
const iso = (ms: number): string => new Date(ms).toISOString()
const sha256hex = (v: string): string => createHash('sha256').update(v).digest('hex')

// ---- random strings ----

/** Better Auth's `generateId` alphabet (session tokens, the admin id). */
export const SESSION_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
/** The api-key plugin's default alphabet (the 64 chars after `insta_`). */
export const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** `n` uniformly random characters of `alphabet` by rejection sampling over randomBytes (no modulo bias). */
export function randomAlpha(n: number, alphabet: string): string {
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  while (out.length < n) {
    for (const b of randomBytes(n - out.length + 8)) {
      if (b >= limit) continue
      out += alphabet[b % alphabet.length]
      if (out.length === n) break
    }
  }
  return out
}

// ---- errors ----

/** A failure with the exact status and JSON body the route sends. */
export class HttpError extends Error {
  constructor(public readonly status: number, public readonly body: Record<string, unknown>) {
    super(typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `http ${status}`)
  }
}
const betterAuthError = (status: number, code: string, message: string): HttpError => new HttpError(status, { code, message })

/** Thrown by createAdmin when the daemon already has its one admin (route: 422 USER_ALREADY_EXISTS). */
export class AdminExists extends Error {
  constructor() { super('an admin already exists on this daemon; sign in instead') }
}

// ---- passwords ----

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEY_LEN = 64
const scryptMaxmem = (N: number, r: number): number => Math.max(64 * 1024 * 1024, 128 * N * r * 2)

/** `scrypt$<N>$<r>$<p>$<salt b64url>$<key b64url>`; NFKC-normalised input, 16-byte salt, 64-byte key. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16)
  const key = scryptSync(pw.normalize('NFKC'), salt, SCRYPT_KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: scryptMaxmem(SCRYPT_N, SCRYPT_R) })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

/** Recomputes with the stored parameters and compares in constant time; malformed or foreign hashes are false, never a throw. */
export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > (1 << 20) || r > 32 || p > 16) return false
  const salt = Buffer.from(parts[4], 'base64url')
  const key = Buffer.from(parts[5], 'base64url')
  if (salt.length === 0 || key.length === 0) return false
  let derived: Buffer
  try { derived = scryptSync(pw.normalize('NFKC'), salt, key.length, { N, r, p, maxmem: scryptMaxmem(N, r) }) }
  catch { return false }
  return derived.length === key.length && timingSafeEqual(derived, key)
}

/** Verified against on an unknown email so a sign-in attempt costs one scrypt whether or not the email exists. */
export const DUMMY_HASH: string = hashPassword(randomBytes(16).toString('hex'))

// ---- input policy (Better Auth's codes) ----

export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 256
export const NAME_MAX = 100
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 8..256 chars, else 400 PASSWORD_TOO_SHORT | PASSWORD_TOO_LONG. */
export function checkPassword(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < PASSWORD_MIN) throw betterAuthError(400, 'PASSWORD_TOO_SHORT', 'Password too short')
  if (raw.length > PASSWORD_MAX) throw betterAuthError(400, 'PASSWORD_TOO_LONG', 'Password too long')
  return raw
}

/** Trimmed, lowercased, shaped like an address, else 400 INVALID_EMAIL. */
export function normalizeEmail(raw: unknown): string {
  const e = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!e || !EMAIL_RE.test(e)) throw betterAuthError(400, 'INVALID_EMAIL', 'Invalid email')
  return e
}

// ---- admin ----

/** `s.identity`, created on first use (absent in local mode and before setup). */
export function ensureIdentity(s: State): IdentityState {
  if (!s.identity) s.identity = structuredClone(EMPTY_IDENTITY)
  return s.identity
}

/** The one admin. Reuses `previousAdminId` after `--reset-admin` so the box keeps one user id; the caller mints the first session in the same mutate (autoSignIn). */
export function createAdmin(s: State, input: { email: string; name?: string; passwordHash: string }): AdminRow {
  const id = ensureIdentity(s)
  if (id.admin) throw new AdminExists()
  const at = iso(clock.now())
  const admin: AdminRow = {
    id: id.previousAdminId ?? randomAlpha(32, SESSION_ALPHABET),
    email: input.email,
    name: input.name?.trim() || input.email.split('@')[0],
    passwordHash: input.passwordHash,
    createdAt: at,
    updatedAt: at,
  }
  id.admin = admin
  return admin
}

// ---- sessions (Better Auth shape: opaque token, sha256 stored, 7 d TTL, 1 d sliding) ----

const DAY_SEC = 86_400

/** New session row; expired rows are garbage-collected on every mint. `rememberMe: false` gives a one-day session and a session cookie (no Max-Age). */
export function mintSession(s: State, auth: AuthConfig, userId: string, ipAddress: string, userAgent: string, rememberMe = true): { token: string; row: SessionRow } {
  const id = ensureIdentity(s)
  const now = clock.now()
  id.sessions = id.sessions.filter((r) => Date.parse(r.expiresAt) > now)
  const token = randomAlpha(32, SESSION_ALPHABET)
  const ttlSec = rememberMe ? auth.sessionTtlSec : DAY_SEC
  const row: SessionRow = {
    id: randomUUID(), tokenHash: sha256hex(token), userId,
    createdAt: iso(now), updatedAt: iso(now), expiresAt: iso(now + ttlSec * 1000),
    ipAddress, userAgent,
  }
  id.sessions.push(row)
  return { token, row }
}

/** The live session for `token`, or null. Expired: deleted through touchLater. Older than `sessionUpdateAgeSec` since its last update: slid (updatedAt = now, expiresAt = now + its original lifetime) on the returned row and through touchLater. */
export function findSession(s: State, auth: AuthConfig, token: string): SessionRow | null {
  const id = s.identity
  if (!id || !token) return null
  const hash = sha256hex(token)
  const row = id.sessions.find((r) => r.tokenHash === hash)
  if (!row) return null
  const now = clock.now()
  const expiresAt = Date.parse(row.expiresAt)
  if (expiresAt <= now) {
    const rowId = row.id
    touchLater((st) => { if (st.identity) st.identity.sessions = st.identity.sessions.filter((r) => r.id !== rowId) })
    return null
  }
  if (now - Date.parse(row.updatedAt) >= auth.sessionUpdateAgeSec * 1000) {
    const lifetimeMs = expiresAt - Date.parse(row.updatedAt)
    const updatedAt = iso(now)
    const newExpiry = iso(now + lifetimeMs)
    const rowId = row.id
    row.updatedAt = updatedAt
    row.expiresAt = newExpiry
    touchLater((st) => {
      const r = st.identity?.sessions.find((x) => x.id === rowId)
      if (r) { r.updatedAt = updatedAt; r.expiresAt = newExpiry }
    })
  }
  return row
}

/** Drop the session `token` names; false when it was not there. */
export function revokeSession(s: State, token: string): boolean {
  const id = s.identity
  if (!id) return false
  const hash = sha256hex(token)
  const before = id.sessions.length
  id.sessions = id.sessions.filter((r) => r.tokenHash !== hash)
  return id.sessions.length !== before
}

export function revokeAllSessions(s: State): void {
  if (s.identity) s.identity.sessions = []
}

// ---- insta_ API keys ----

export const TOKEN_PREFIX = 'insta_'
export const TOKEN_KEY_LEN = 64
/** Cheap shape check before any hash lookup. */
export const TOKEN_RE = /^insta_[A-Za-z]{64}$/
export const TOKEN_MAX_EXPIRES_DAYS = 3650

/** `insta_` + 64 letters; the row (newest first) stores only the sha256. Scopes are recorded and echoed, never enforced. Throws HttpError 400 with the cloud's texts. */
export function mintToken(s: State, input: { name?: unknown; scopes?: unknown; expiresInDays?: unknown }): { key: string; row: TokenRow } {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new HttpError(400, { error: 'name is required' })
  if (name.length > NAME_MAX) throw new HttpError(400, { error: 'name too long' })
  if (input.scopes !== undefined && input.scopes !== null && !(Array.isArray(input.scopes) && input.scopes.every((x) => typeof x === 'string'))) {
    throw new HttpError(400, { error: 'scopes must be an array of strings' })
  }
  let expiresAt: string | null = null
  if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
    const d = input.expiresInDays
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > TOKEN_MAX_EXPIRES_DAYS) {
      throw new HttpError(400, { error: `expiresInDays must be an integer between 1 and ${TOKEN_MAX_EXPIRES_DAYS}` })
    }
    expiresAt = iso(clock.now() + d * DAY_SEC * 1000)
  }
  const key = TOKEN_PREFIX + randomAlpha(TOKEN_KEY_LEN, KEY_ALPHABET)
  const row: TokenRow = {
    id: randomUUID(), name, prefix: 'insta_', keyHash: sha256hex(key), orgId: null,
    scopes: Array.isArray(input.scopes) ? [...(input.scopes as string[])] : [],
    lastUsedAt: null, expiresAt, revokedAt: null, createdAt: iso(clock.now()),
  }
  ensureIdentity(s).tokens.unshift(row)
  return { key, row }
}

/** The live token row for `key`, or null (malformed keys never reach the hash lookup; revoked and expired rows are null). Stamps lastUsedAt on the returned row and through touchLater. */
export function verifyToken(s: State, key: string): TokenRow | null {
  if (!TOKEN_RE.test(key)) return null
  const id = s.identity
  if (!id) return null
  const hash = sha256hex(key)
  const row = id.tokens.find((r) => r.keyHash === hash)
  if (!row || row.revokedAt) return null
  const now = clock.now()
  if (row.expiresAt && Date.parse(row.expiresAt) <= now) return null
  const at = iso(now)
  const rowId = row.id
  row.lastUsedAt = at
  touchLater((st) => {
    const r = st.identity?.tokens.find((x) => x.id === rowId)
    if (r) r.lastUsedAt = at
  })
  return row
}

/** Sets revokedAt once; false when the id is unknown or already revoked (route: 404). */
export function revokeToken(s: State, id: string): boolean {
  const row = s.identity?.tokens.find((r) => r.id === id)
  if (!row || row.revokedAt) return false
  row.revokedAt = iso(clock.now())
  return true
}

// ---- device authorization (RFC 8628, `insta login --device`) ----

/** The human-typed user code alphabet: no 0/O/1/I/L, so a code read off one screen and typed on
 *  another is unambiguous. */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const DEVICE_CODE_TTL_SEC = 15 * 60
export const DEVICE_POLL_INTERVAL_SEC = 5
/** A hard ceiling on live codes: the issue endpoint is unauthenticated, so without a bound a flood
 *  could grow memory without limit. It also bounds the issuance-time gc scan to O(this). */
const DEVICE_MAX_CODES = 2000
/** Per-IP ceiling on live codes, so one source cannot fill the store or spam issuance. */
const DEVICE_MAX_PER_IP = 20

type DeviceRecord = { userCode: string; ip: string; status: 'pending' | 'approved' | 'denied'; expiresAt: number }
/** null when a store or per-IP cap is hit (the route answers 429). */
export type DeviceStart = { deviceCode: string; userCode: string; expiresIn: number; interval: number } | null
export type DevicePoll = { status: 'approved' | 'pending' | 'denied' | 'expired' | 'unknown' }
export type DeviceApprove = 'ok' | 'not_found' | 'expired' | 'already'

/** In-memory pending codes for the device-authorization flow. Single-node and short-lived (15 min),
 *  so it lives in memory like SignInLimiter: a daemon restart just means the user runs `insta login`
 *  again. Codes are one-time and consumed by the poll that resolves them. No credential is held here:
 *  approval only marks the record, and the token is minted when the CLI COLLECTS an approved code
 *  (mint-on-collection), so an abandoned or expired approval never leaves an orphan key. */
export class DeviceCodeStore {
  private byDevice = new Map<string, DeviceRecord>()
  private byUser = new Map<string, string>()

  /** Fold the console's grouped, lower/upper input (e.g. "abcd-efgh") to the stored key form. */
  private normalize(userCode: string): string { return userCode.toUpperCase().replace(/[^A-Z0-9]/g, '') }

  /** Drop expired records. Called only at issuance, so the O(n) scan stays off the poll hot path and
   *  is bounded by DEVICE_MAX_CODES; poll/approve/deny check the one record's own expiry inline. */
  private gc(): void {
    const now = clock.now()
    for (const [dc, r] of this.byDevice) if (r.expiresAt <= now) { this.byDevice.delete(dc); this.byUser.delete(r.userCode) }
  }

  private consume(deviceCode: string, rec: DeviceRecord): void { this.byDevice.delete(deviceCode); this.byUser.delete(rec.userCode) }

  private find(userCode: string): DeviceRecord | undefined {
    const dc = this.byUser.get(this.normalize(userCode))
    return dc ? this.byDevice.get(dc) : undefined
  }

  /** Issue a fresh pending pair for `ip`, or null when the store or the per-IP cap is full. The
   *  device code is opaque (the CLI holds it); the user code is the short one the human approves. */
  start(ip: string): DeviceStart {
    this.gc()
    if (this.byDevice.size >= DEVICE_MAX_CODES) return null
    let perIp = 0
    for (const r of this.byDevice.values()) if (r.ip === ip && ++perIp >= DEVICE_MAX_PER_IP) return null
    const deviceCode = randomAlpha(40, SESSION_ALPHABET)
    let userCode = randomAlpha(8, USER_CODE_ALPHABET)
    while (this.byUser.has(userCode)) userCode = randomAlpha(8, USER_CODE_ALPHABET)
    this.byDevice.set(deviceCode, { userCode, ip, status: 'pending', expiresAt: clock.now() + DEVICE_CODE_TTL_SEC * 1000 })
    this.byUser.set(userCode, deviceCode)
    return { deviceCode, userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`, expiresIn: DEVICE_CODE_TTL_SEC, interval: DEVICE_POLL_INTERVAL_SEC }
  }

  /** The console (an authenticated admin) approves a user code. No token is minted here; the record
   *  is marked, and the token is issued when the CLI collects it (see the route's poll handler). */
  approve(userCode: string): DeviceApprove {
    const rec = this.find(userCode)
    if (!rec) return 'not_found'
    if (rec.expiresAt <= clock.now()) return 'expired'
    if (rec.status !== 'pending') return 'already'
    rec.status = 'approved'
    return 'ok'
  }

  /** The console denies a code; the CLI's next poll then stops with access_denied. */
  deny(userCode: string): boolean {
    const rec = this.find(userCode)
    if (!rec || rec.expiresAt <= clock.now() || rec.status !== 'pending') return false
    rec.status = 'denied'
    return true
  }

  /** The CLI polls with its device code; any terminal status consumes the record. `approved` tells
   *  the route to mint the token now, so an approval the CLI never collects mints no key. */
  poll(deviceCode: string): DevicePoll {
    const rec = this.byDevice.get(deviceCode)
    if (!rec) return { status: 'unknown' }
    if (rec.expiresAt <= clock.now()) { this.consume(deviceCode, rec); return { status: 'expired' } }
    if (rec.status === 'approved') { this.consume(deviceCode, rec); return { status: 'approved' } }
    if (rec.status === 'denied') { this.consume(deviceCode, rec); return { status: 'denied' } }
    return { status: 'pending' }
  }
}

// ---- signed cookie (Better Auth's format: `<token>.<base64 hmac-sha256>`, URL-encoded) ----

const hmacB64 = (secret: string, token: string): string => createHmac('sha256', secret).update(token).digest('base64')

export function signCookieValue(secret: string, token: string): string {
  return encodeURIComponent(`${token}.${hmacB64(secret, token)}`)
}

/** `Set-Cookie` value for a fresh session: HttpOnly, SameSite=Lax, Path=/, Max-Age (unless `rememberMe` is false), Secure under https. */
export function setCookieHeader(auth: AuthConfig, token: string, rememberMe = true): string {
  const attrs = [`${auth.cookieName}=${signCookieValue(auth.secret, token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (rememberMe) attrs.push(`Max-Age=${auth.sessionTtlSec}`)
  if (auth.cookieSecure) attrs.push('Secure')
  return attrs.join('; ')
}

/** `Set-Cookie` value that removes the session cookie. */
export function clearCookieHeader(auth: AuthConfig): string {
  const attrs = [`${auth.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (auth.cookieSecure) attrs.push('Secure')
  return attrs.join('; ')
}

/** The session token carried by a validly signed cookie (the `__Secure-` and the bare name are both accepted), else null. Splits at the LAST dot; a tampered signature reads as absent. */
export function readSessionCookie(auth: AuthConfig, cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null
  const bare = auth.cookieName.replace(/^__Secure-/, '')
  const names = new Set([auth.cookieName, bare, `__Secure-${bare}`])
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (!names.has(part.slice(0, eq).trim())) continue
    let raw: string
    try { raw = decodeURIComponent(part.slice(eq + 1).trim()) } catch { continue }
    const dot = raw.lastIndexOf('.')
    if (dot <= 0) continue
    const token = raw.slice(0, dot)
    const sig = Buffer.from(raw.slice(dot + 1))
    const expected = Buffer.from(hmacB64(auth.secret, token))
    if (sig.length === expected.length && timingSafeEqual(sig, expected)) return token
  }
  return null
}

// ---- output mappers (the cloud's shapes) ----

/** PublicUser (openapi PublicUser; platform auth/service.ts authToPublicUser). */
export const publicUser = (a: AdminRow): { id: string; email: string; name: string; avatarUrl: null; emailVerified: true } =>
  ({ id: a.id, email: a.email, name: a.name, avatarUrl: null, emailVerified: true })

/** Better Auth's user record as its mount returns it. */
export const betterAuthUser = (a: AdminRow): { id: string; name: string; email: string; emailVerified: true; image: null; createdAt: string; updatedAt: string } =>
  ({ id: a.id, name: a.name, email: a.email, emailVerified: true, image: null, createdAt: a.createdAt, updatedAt: a.updatedAt })

/** Better Auth's session record for get-session (the presented token, never the hash). */
export const sessionOut = (r: SessionRow, token: string): { id: string; token: string; userId: string; expiresAt: string; createdAt: string; updatedAt: string; ipAddress: string; userAgent: string } =>
  ({ id: r.id, token, userId: r.userId, expiresAt: r.expiresAt, createdAt: r.createdAt, updatedAt: r.updatedAt, ipAddress: r.ipAddress, userAgent: r.userAgent })

/** ApiToken (openapi ApiToken; platform accounts/service.ts PublicApiToken): never the hash. */
export const apiTokenOut = (r: TokenRow): { id: string; name: string; orgId: null; prefix: string; scopes: string[]; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string } =>
  ({ id: r.id, name: r.name, orgId: r.orgId, prefix: r.prefix, scopes: r.scopes, lastUsedAt: r.lastUsedAt, expiresAt: r.expiresAt, revokedAt: r.revokedAt, createdAt: r.createdAt })

// ---- sign-in failure limiter (in memory; never in state.json) ----

/** Per-IP failure timestamps inside a window; `max` or more block the next attempt BEFORE scrypt runs. Bounded: stale IPs are pruned on every insert and the map is capped at `maxIps` (oldest dropped), so a scan against a public api.<domain> cannot grow it without bound. */
export class SignInLimiter {
  private readonly failures = new Map<string, number[]>()

  constructor(private readonly windowMs = 15 * 60_000, private readonly max = 10, private readonly maxIps = 10_000) {}

  blocked(ip: string): boolean { return this.recent(ip).length >= this.max }

  fail(ip: string): void {
    const now = clock.now()
    const list = this.recent(ip)
    list.push(now)
    this.failures.delete(ip)
    this.failures.set(ip, list)
    this.prune(now)
  }

  clear(ip: string): void { this.failures.delete(ip) }

  get size(): number { return this.failures.size }

  private recent(ip: string): number[] {
    const now = clock.now()
    return (this.failures.get(ip) ?? []).filter((t) => now - t < this.windowMs)
  }

  private prune(now: number): void {
    for (const [ip, list] of this.failures) {
      if (list.length === 0 || now - list[list.length - 1] >= this.windowMs) this.failures.delete(ip)
    }
    while (this.failures.size > this.maxIps) {
      const oldest = this.failures.keys().next().value
      if (oldest === undefined) break
      this.failures.delete(oldest)
    }
  }
}
