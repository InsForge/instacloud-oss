// WP1 identity primitives (plan 01 section 2): scrypt passwords with a fixed dummy hash, Better
// Auth shaped sessions, insta_ API keys, the signed cookie and the per-IP sign-in limiter.
// Pure: no Docker, no server, no HTTP.
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initStatePath, loadState, type State } from '../src/state'
import * as id from '../src/identity'
import { serverConfig } from './fakes'

const auth = serverConfig().auth
const DAY = 86_400_000
let now = Date.UTC(2026, 0, 1)
let s: State

beforeEach(() => {
  initStatePath(join(mkdtempSync(join(tmpdir(), 'io-id-')), 'state.json'))
  now = Date.UTC(2026, 0, 1)
  id.clock.now = () => now
  s = loadState()
})
afterEach(() => { id.clock.now = () => Date.now() })

const mkAdmin = (): id.AdminRow => id.createAdmin(s, { email: 'a@b.test', passwordHash: id.hashPassword('correct horse') })

test('hashPassword round trips, a wrong password is false, and the dummy hash never throws', () => {
  const h = id.hashPassword('correct horse')
  expect(h.startsWith('scrypt$16384$8$1$')).toBe(true)
  expect(id.verifyPassword('correct horse', h)).toBe(true)
  expect(id.verifyPassword('correct horse ', h)).toBe(false)
  expect(id.verifyPassword('', h)).toBe(false)
  expect(id.verifyPassword('anything', id.DUMMY_HASH)).toBe(false)
  expect(id.verifyPassword('anything', 'not-a-hash')).toBe(false)
  expect(id.hashPassword('x')).not.toBe(id.hashPassword('x'))
})

test('password and email policy carry the Better Auth codes', () => {
  expect(() => id.checkPassword('short')).toThrowError(/Password too short/)
  expect(() => id.checkPassword('x'.repeat(257))).toThrowError(/Password too long/)
  expect(id.checkPassword('12345678')).toBe('12345678')
  expect(id.normalizeEmail('  A@B.TEST ')).toBe('a@b.test')
  expect(() => id.normalizeEmail('nope')).toThrowError(/Invalid email/)
  try { id.checkPassword('x') } catch (e) { expect((e as id.HttpError).body.code).toBe('PASSWORD_TOO_SHORT') }
  try { id.normalizeEmail('x') } catch (e) { expect((e as id.HttpError).body.code).toBe('INVALID_EMAIL') }
})

test('createAdmin mints one admin and reuses previousAdminId after a reset', () => {
  const a = mkAdmin()
  expect(a.name).toBe('a')
  expect(a.id).toHaveLength(32)
  expect(() => mkAdmin()).toThrowError(id.AdminExists)
  const keep = a.id
  s.identity!.previousAdminId = keep
  s.identity!.admin = null
  expect(mkAdmin().id).toBe(keep)
})

test('mintToken shape and verifyToken by hash', () => {
  const a = mkAdmin()
  const { key, row } = id.mintToken(s, { name: '  laptop  ' })
  expect(key).toMatch(/^insta_[A-Za-z]{64}$/)
  expect(row.name).toBe('laptop')
  expect(row.prefix).toBe('insta_')
  expect(row.orgId).toBeNull()
  expect(row.expiresAt).toBeNull()
  expect(row.keyHash).not.toContain(key)
  expect(id.verifyToken(s, key)?.id).toBe(row.id)
  expect(id.verifyToken(s, key)?.lastUsedAt).not.toBeNull()
  expect(a.id).toBeTruthy()
})

test('newest token first, and revoked, expired or malformed keys never verify', () => {
  mkAdmin()
  const first = id.mintToken(s, { name: 'one' })
  const second = id.mintToken(s, { name: 'two', expiresInDays: 30 })
  expect(s.identity!.tokens[0].id).toBe(second.row.id)
  expect(Date.parse(second.row.expiresAt!) - now).toBe(30 * DAY)
  expect(id.revokeToken(s, first.row.id)).toBe(true)
  expect(id.revokeToken(s, first.row.id)).toBe(false)
  expect(id.revokeToken(s, 'nope')).toBe(false)
  expect(id.verifyToken(s, first.key)).toBeNull()
  now += 31 * DAY
  expect(id.verifyToken(s, second.key)).toBeNull()
  expect(id.verifyToken(s, 'insta_short')).toBeNull()
  expect(id.verifyToken(s, 'nope')).toBeNull()
})

test('mintToken validates name and expiresInDays', () => {
  mkAdmin()
  expect(() => id.mintToken(s, {})).toThrowError(/name is required/)
  expect(() => id.mintToken(s, { name: 'x'.repeat(101) })).toThrowError(/name too long/)
  expect(() => id.mintToken(s, { name: 'k', expiresInDays: 0 })).toThrowError(/between 1 and 3650/)
  expect(() => id.mintToken(s, { name: 'k', expiresInDays: 3651 })).toThrowError(/between 1 and 3650/)
  expect(() => id.mintToken(s, { name: 'k', scopes: [1] as unknown as string[] })).toThrowError(/array of strings/)
})

test('sessions: mint, find, slide after a day, expire after the ttl, revoke', () => {
  const a = mkAdmin()
  const { token, row } = id.mintSession(s, auth, a.id, '10.0.0.1', 'curl')
  expect(token).toHaveLength(32)
  expect(row.tokenHash).not.toContain(token)
  expect(Date.parse(row.expiresAt) - now).toBe(auth.sessionTtlSec * 1000)
  expect(id.findSession(s, auth, token)?.id).toBe(row.id)
  expect(id.findSession(s, auth, 'other')).toBeNull()
  const before = row.expiresAt
  now += DAY
  const slid = id.findSession(s, auth, token)!
  expect(Date.parse(slid.updatedAt)).toBe(now)
  expect(Date.parse(slid.expiresAt)).toBeGreaterThan(Date.parse(before))
  now += auth.sessionTtlSec * 1000
  expect(id.findSession(s, auth, token)).toBeNull()
})

test('revokeSession and revokeAllSessions, and expired rows are collected on the next mint', () => {
  const a = mkAdmin()
  const one = id.mintSession(s, auth, a.id, '10.0.0.1', 'curl')
  expect(id.revokeSession(s, one.token)).toBe(true)
  expect(id.revokeSession(s, one.token)).toBe(false)
  const two = id.mintSession(s, auth, a.id, '10.0.0.1', 'curl')
  now += (auth.sessionTtlSec + 1) * 1000
  id.mintSession(s, auth, a.id, '10.0.0.1', 'curl')
  expect(s.identity!.sessions.some((r) => r.id === two.row.id)).toBe(false)
  id.revokeAllSessions(s)
  expect(s.identity!.sessions).toHaveLength(0)
})

test('cookie: Secure name under https, token.hmac value, tampered signature reads as absent', () => {
  expect(auth.cookieName).toBe('__Secure-better-auth.session_token')
  expect(auth.cookieSecure).toBe(true)
  const header = id.setCookieHeader(auth, 'tok123')
  expect(header).toContain('Path=/')
  expect(header).toContain('HttpOnly')
  expect(header).toContain('SameSite=Lax')
  expect(header).toContain('Secure')
  expect(header).toContain(`Max-Age=${auth.sessionTtlSec}`)
  expect(id.setCookieHeader(auth, 'tok123', false)).not.toContain('Max-Age')
  expect(id.clearCookieHeader(auth)).toContain('Max-Age=0')
})

test('readSessionCookie accepts the signed value and rejects a tampered one', () => {
  const value = id.signCookieValue(auth.secret, 'tok123')
  expect(decodeURIComponent(value).startsWith('tok123.')).toBe(true)
  expect(id.readSessionCookie(auth, `${auth.cookieName}=${value}`)).toBe('tok123')
  expect(id.readSessionCookie(auth, `better-auth.session_token=${value}`)).toBe('tok123')
  expect(id.readSessionCookie(auth, `other=1; ${auth.cookieName}=${value}`)).toBe('tok123')
  expect(id.readSessionCookie(auth, `${auth.cookieName}=${value}x`)).toBeNull()
  expect(id.readSessionCookie(auth, `${auth.cookieName}=tok123.zzz`)).toBeNull()
  expect(id.readSessionCookie(auth, `${auth.cookieName}=tok123`)).toBeNull()
  expect(id.readSessionCookie(auth, undefined)).toBeNull()
})

test('output mappers never leak a hash', () => {
  const a = mkAdmin()
  expect(id.publicUser(a)).toEqual({ id: a.id, email: 'a@b.test', name: 'a', avatarUrl: null, emailVerified: true })
  const ba = id.betterAuthUser(a)
  expect(ba.image).toBeNull()
  expect(ba.emailVerified).toBe(true)
  expect(JSON.stringify(ba)).not.toContain('scrypt')
  const { token, row } = id.mintSession(s, auth, a.id, '10.0.0.1', 'curl')
  expect(id.sessionOut(row, token).token).toBe(token)
  expect(JSON.stringify(id.sessionOut(row, token))).not.toContain(row.tokenHash)
  const t = id.mintToken(s, { name: 'k', scopes: ['a'] })
  expect(JSON.stringify(id.apiTokenOut(t.row))).not.toContain(t.row.keyHash)
  expect(id.apiTokenOut(t.row).scopes).toEqual(['a'])
})

test('sign-in limiter blocks the eleventh failure in the window and a success resets it', () => {
  const lim = new id.SignInLimiter()
  for (let i = 0; i < 9; i++) lim.fail('1.2.3.4')
  expect(lim.blocked('1.2.3.4')).toBe(false)
  lim.fail('1.2.3.4')
  expect(lim.blocked('1.2.3.4')).toBe(true)
  expect(lim.blocked('5.6.7.8')).toBe(false)
  lim.clear('1.2.3.4')
  expect(lim.blocked('1.2.3.4')).toBe(false)
})

test('limiter forgets a stale window and stays bounded under a scan', () => {
  const lim = new id.SignInLimiter(1000, 3, 5)
  lim.fail('a')
  lim.fail('a')
  lim.fail('a')
  expect(lim.blocked('a')).toBe(true)
  now += 2000
  expect(lim.blocked('a')).toBe(false)
  for (let i = 0; i < 50; i++) lim.fail(`ip-${i}`)
  expect(lim.size).toBeLessThanOrEqual(5)
})

test('randomAlpha draws only from its alphabet', () => {
  expect(id.randomAlpha(200, id.KEY_ALPHABET)).toMatch(/^[A-Za-z]{200}$/)
  expect(id.randomAlpha(200, id.SESSION_ALPHABET)).toMatch(/^[A-Za-z0-9]{200}$/)
  expect(id.randomAlpha(0, id.KEY_ALPHABET)).toBe('')
})
