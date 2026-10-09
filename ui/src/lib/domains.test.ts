import { describe, expect, it } from 'vitest'
import { HOSTNAME_RE, domainStage, normalizeHostInput, stageHint } from './domains'

const base = { hostname: 'shop.example.com', flyApp: 'io-shop-main-app-web', service: 'web', region: 'local' }

describe('domainStage (envelopes carry no ssl key)', () => {
  it('active = configured and ready', () => {
    const r = { ...base, configured: true, status: 'ready', dns: [{ type: 'CNAME', name: 'shop.example.com', value: 'api.x.test', status: 'ok' }] }
    expect(domainStage(r)).toBe('active')
    expect(stageHint(r)).toBe('Serving over HTTPS.')
  })

  it('verifying = a dns record is ok while not configured yet (certificate pending)', () => {
    const r = { ...base, configured: false, status: 'pending', dns: [{ type: 'CNAME', name: 'shop.example.com', value: 'api.x.test', status: 'ok' }] }
    expect(domainStage(r)).toBe('verifying')
    expect(stageHint(r)).toMatch(/certificate is being issued/)
  })

  it('needs-records for missing, mismatch and unchecked records', () => {
    for (const status of ['missing', 'mismatch', 'unchecked']) {
      const r = { ...base, configured: false, status: 'pending', dns: [{ type: 'CNAME', name: 'shop.example.com', value: 'api.x.test', status }] }
      expect(domainStage(r)).toBe('needs-records')
    }
    expect(stageHint({ ...base, configured: false, status: 'pending', dns: [] })).toMatch(/Create the DNS records/)
  })

  it('needs-records when the daemon reports not added or an empty dns list', () => {
    expect(domainStage({ ...base, configured: false, status: 'not added', dns: [] })).toBe('needs-records')
    expect(domainStage({ hostname: 'x.example.com' })).toBe('needs-records')
  })

  it('error when status is error or an errorReason is present', () => {
    expect(domainStage({ ...base, configured: false, status: 'error', dns: [] })).toBe('error')
    const r = { ...base, configured: true, status: 'ready', dns: [], errorReason: 'issuance failed' }
    expect(domainStage(r)).toBe('error')
    expect(stageHint(r)).toBe('issuance failed')
  })

  it('a ready status without configured is not active', () => {
    expect(domainStage({ ...base, configured: false, status: 'ready', dns: [] })).toBe('needs-records')
  })
})

describe('HOSTNAME_RE', () => {
  it('accepts dotted lower-case hostnames', () => {
    for (const h of ['shop.example.com', 'a.b.c.example.io', 'x1-y2.example.co.uk', 'app.203-0-113-7.sslip.io']) {
      expect(HOSTNAME_RE.test(h)).toBe(true)
    }
  })
  it('rejects bare labels, upper case, IPs, leading or trailing hyphens and schemes', () => {
    for (const h of ['localhost', 'Shop.Example.com', '203.0.113.7', '-a.example.com', 'a-.example.com', 'https://a.example.com', 'a..example.com', 'a.example.c0m', '']) {
      expect(HOSTNAME_RE.test(h)).toBe(false)
    }
  })
  it('rejects a label over 63 chars and a name over 253 chars', () => {
    expect(HOSTNAME_RE.test(`${'a'.repeat(64)}.example.com`)).toBe(false)
    expect(HOSTNAME_RE.test(`${'a'.repeat(63)}.example.com`)).toBe(true)
    const long = Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.')
    expect(HOSTNAME_RE.test(`${long}.com`)).toBe(false)
  })
})

describe('normalizeHostInput', () => {
  it('lower-cases and strips scheme, path, query, port and trailing dot', () => {
    expect(normalizeHostInput('  HTTPS://Shop.Example.com/path?x=1#f  ')).toBe('shop.example.com')
    expect(normalizeHostInput('shop.example.com.')).toBe('shop.example.com')
    expect(normalizeHostInput('shop.example.com:8443')).toBe('shop.example.com')
    expect(normalizeHostInput('http://shop.example.com:443/')).toBe('shop.example.com')
  })
  it('leaves an already clean hostname alone', () => {
    expect(normalizeHostInput('shop.example.com')).toBe('shop.example.com')
  })
})
