import { describe, expect, it } from 'vitest'
import { SERVICE_NAME_RE, suggestServiceName, uniqueServiceName, whimsicalBaseName } from './serviceNames'

describe('uniqueServiceName', () => {
  it('keeps a free name and counts up past taken ones', () => {
    expect(uniqueServiceName('redis', new Set())).toBe('redis')
    expect(uniqueServiceName('redis', new Set(['redis']))).toBe('redis-2')
    expect(uniqueServiceName('redis', new Set(['redis', 'redis-2']))).toBe('redis-3')
  })

  it('trims the base so a suffix never pushes past 39 characters', () => {
    const long = 'a'.repeat(39)
    const next = uniqueServiceName(long, new Set([long]))
    expect(next.length).toBeLessThanOrEqual(39)
    expect(SERVICE_NAME_RE.test(next)).toBe(true)
  })
})

describe('whimsicalBaseName', () => {
  it('is an adjective-noun pair that passes the name rule', () => {
    for (const r of [0, 0.5, 0.999]) expect(SERVICE_NAME_RE.test(whimsicalBaseName(() => r))).toBe(true)
  })
})

describe('suggestServiceName', () => {
  it('takes the last path segment without tag or digest', () => {
    expect(suggestServiceName('ghcr.io/acme/web:1.2.3')).toBe('web')
    expect(suggestServiceName('docker.io/insforge/insforge-oss:v2.0.9')).toBe('insforge-oss')
    expect(suggestServiceName('traefik/whoami@sha256:abc')).toBe('whoami')
    expect(suggestServiceName('nginx')).toBe('nginx')
  })

  it('is empty when nothing usable is left', () => {
    expect(suggestServiceName(':latest')).toBe('')
    expect(suggestServiceName('')).toBe('')
  })

  it('lower-kebabs what it keeps', () => {
    expect(suggestServiceName('acme/My_App:1')).toBe('my-app')
  })
})
