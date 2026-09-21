import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { redactDockerArgs } from '../src/docker'
import { buildContextUrl, imageTag, newBinding, normalizeRef, parseRepo, pushRef, verifySignature } from '../src/gitdeploy'

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

describe('buildContextUrl + redaction', () => {
  it('public repo carries no token, and checks out the fragment it is given', () => {
    expect(buildContextUrl({ owner: 'o', repo: 'r', token: '' }, 'main')).toBe('https://github.com/o/r.git#main')
  })
  it('pins to the pushed commit sha when that is the fragment', () => {
    // A webhook passes the immutable head sha, not the branch ref, so the built image can never
    // contain a commit other than the one it is tagged for.
    expect(buildContextUrl({ owner: 'o', repo: 'r', token: '' }, 'deadbeef0123')).toBe('https://github.com/o/r.git#deadbeef0123')
  })
  it('private repo embeds the token in the DSN-redactable form', () => {
    const url = buildContextUrl({ owner: 'o', repo: 'r', token: 'ghp_SECRET123' }, 'dev')
    expect(url).toBe('https://x-access-token:ghp_SECRET123@github.com/o/r.git#dev')
    // the existing docker-arg redactor must strip the token from any logged command
    const redacted = redactDockerArgs(['build', url, '-t', 'img'])
    expect(redacted).not.toContain('ghp_SECRET123')
    expect(redacted).toContain('x-access-token:[redacted]@github.com/o/r.git#dev')
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
  it('extracts branch + sha from a push to a branch', () => {
    expect(pushRef('push', { ref: 'refs/heads/main', after: 'a'.repeat(40) })).toEqual({ branch: 'main', sha: 'a'.repeat(40) })
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
