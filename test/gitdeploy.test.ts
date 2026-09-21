import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { buildContextUrl, dockerBuildSpec, imageTag, newBinding, normalizeRef, parseRepo, pushRef, verifySignature } from '../src/gitdeploy'

describe('parseRepo', () => {
  it('accepts owner/repo and github URLs, strips .git', () => {
    expect(parseRepo('InsForge/instacloud-oss')).toEqual({ owner: 'InsForge', repo: 'instacloud-oss' })
    expect(parseRepo('https://github.com/InsForge/instacloud-oss')).toEqual({ owner: 'InsForge', repo: 'instacloud-oss' })
    expect(parseRepo('https://github.com/InsForge/instacloud-oss.git')).toEqual({ owner: 'InsForge', repo: 'instacloud-oss' })
  })
  it('rejects junk, path traversal and non-github hosts', () => {
    for (const bad of ['', 'nope', 'a/b/c', '../../etc', 'https://evil.com/a/b', 42]) {
      expect(() => parseRepo(bad)).toThrow()
    }
  })
})

describe('normalizeRef', () => {
  it('defaults to main and rejects unsafe refs', () => {
    expect(normalizeRef(undefined)).toBe('main')
    expect(normalizeRef('feature/x')).toBe('feature/x')
    for (const bad of ['a b', 'a..b', 'x;rm', '#{']) expect(() => normalizeRef(bad)).toThrow()
  })
})

describe('buildContextUrl', () => {
  it('carries no credentials and checks out the fragment it is given', () => {
    expect(buildContextUrl({ owner: 'o', repo: 'r' }, 'main')).toBe('https://github.com/o/r.git#main')
  })
  it('pins to the pushed commit sha when that is the fragment', () => {
    // A webhook passes the immutable head sha, not the branch ref, so the built image can never
    // contain a commit other than the one it is tagged for.
    expect(buildContextUrl({ owner: 'o', repo: 'r' }, 'deadbeef0123')).toBe('https://github.com/o/r.git#deadbeef0123')
  })
})

describe('dockerBuildSpec', () => {
  it('a public repo needs no secret and puts nothing sensitive in argv', () => {
    const spec = dockerBuildSpec({ owner: 'o', repo: 'r', token: '' }, 'img:1', 'main')
    expect(spec.args).toEqual(['build', '--pull', '-t', 'img:1', 'https://github.com/o/r.git#main'])
    expect(spec.env).toEqual({ DOCKER_BUILDKIT: '1' })
  })
  it('a private repo hands the PAT to BuildKit via the env-secret — never on the command line', () => {
    const spec = dockerBuildSpec({ owner: 'o', repo: 'r', token: 'ghp_SECRET123' }, 'img:1', 'deadbeef')
    // The token is in the child ENV, consumed as the GIT_AUTH_TOKEN secret; argv only names the secret.
    expect(spec.env).toEqual({ DOCKER_BUILDKIT: '1', GIT_AUTH_TOKEN: 'ghp_SECRET123' })
    expect(spec.args).toEqual(['build', '--pull', '--secret', 'id=GIT_AUTH_TOKEN,env=GIT_AUTH_TOKEN', '-t', 'img:1', 'https://github.com/o/r.git#deadbeef'])
    expect(spec.args.join(' ')).not.toContain('ghp_SECRET123')
  })
})

describe('imageTag', () => {
  it('derives a stable, docker-safe tag from binding id + sha', () => {
    expect(imageTag('11112222-3333-4444-5555-666677778888', 'abcdef1234567890')).toBe('io-git-11112222:abcdef123456')
    expect(imageTag('11112222-3333-4444-5555-666677778888')).toBe('io-git-11112222:manual')
  })
})

describe('verifySignature', () => {
  const secret = 'whsec'
  const body = Buffer.from('{"hello":"world"}')
  const good = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  it('accepts a correct signature', () => { expect(verifySignature(secret, body, good)).toBe(true) })
  it('rejects a wrong secret, tampered body, and malformed headers', () => {
    expect(verifySignature('other', body, good)).toBe(false)
    expect(verifySignature(secret, Buffer.from('{"hello":"mars"}'), good)).toBe(false)
    for (const bad of [undefined, '', 'sha256=zzz', 'sha1=' + 'a'.repeat(40), good.slice(0, -1)]) {
      expect(verifySignature(secret, body, bad)).toBe(false)
    }
  })
})

describe('pushRef', () => {
  it('extracts branch + sha + commit time from a push to a branch', () => {
    // Explicit receipt time well after the fixture, so the clamp is a no-op regardless of the wall clock.
    const now = Date.parse('2030-01-01T00:00:00Z')
    expect(pushRef('push', { ref: 'refs/heads/main', after: 'a'.repeat(40), head_commit: { timestamp: '2026-01-02T03:04:05Z' } }, now))
      .toEqual({ branch: 'main', sha: 'a'.repeat(40), ts: Date.parse('2026-01-02T03:04:05Z') })
  })
  it('falls back to receipt time when the payload has no usable commit timestamp', () => {
    expect(pushRef('push', { ref: 'refs/heads/main', after: 'a'.repeat(40) }, 1234)).toEqual({ branch: 'main', sha: 'a'.repeat(40), ts: 1234 })
    expect(pushRef('push', { ref: 'refs/heads/main', after: 'a'.repeat(40), head_commit: { timestamp: 'not-a-date' } }, 1234).ts).toBe(1234)
  })
  it('clamps a future-dated commit timestamp to receipt time (no key can exceed arrival)', () => {
    // A skewed committer clock must never persist as the newest key and wedge later pushes.
    const future = pushRef('push', { ref: 'refs/heads/main', after: 'a'.repeat(40), head_commit: { timestamp: '2099-01-01T00:00:00Z' } }, 1234)
    expect(future!.ts).toBe(1234)
  })
  it('ignores non-push events, tag pushes, deletes and zero shas', () => {
    expect(pushRef('ping', {})).toBeNull()
    expect(pushRef('push', { ref: 'refs/tags/v1', after: 'a'.repeat(40) })).toBeNull()
    expect(pushRef('push', { ref: 'refs/heads/main', deleted: true, after: 'a'.repeat(40) })).toBeNull()
    expect(pushRef('push', { ref: 'refs/heads/main', after: '0'.repeat(40) })).toBeNull()
  })
})

describe('newBinding', () => {
  it('mints an id and a long webhook secret', () => {
    const b = newBinding('o', 'r', 'main', 'tok', Date.now())
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(b.webhookSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(b.token).toBe('tok')
  })
})
