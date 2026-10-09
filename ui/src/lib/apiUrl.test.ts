import { describe, expect, it } from 'vitest'
import { apiUrlForCli, cliLoginLine } from './apiUrl'

describe('apiUrlForCli', () => {
  it('replaces a leading console. label with api. keeping protocol and port', () => {
    expect(apiUrlForCli('https://console.203-0-113-7.sslip.io')).toBe('https://api.203-0-113-7.sslip.io')
    expect(apiUrlForCli('http://console.example.test:8443')).toBe('http://api.example.test:8443')
    expect(apiUrlForCli('https://console.example.test/')).toBe('https://api.example.test')
  })

  it('leaves a raw IP, localhost and a LAN name unchanged (local mode)', () => {
    expect(apiUrlForCli('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(apiUrlForCli('http://localhost:5173')).toBe('http://localhost:5173')
    expect(apiUrlForCli('http://mybox.lan:8080')).toBe('http://mybox.lan:8080')
  })

  it('does not rewrite console appearing elsewhere in the hostname', () => {
    expect(apiUrlForCli('https://myconsole.example.test')).toBe('https://myconsole.example.test')
    expect(apiUrlForCli('https://api.console.example.test')).toBe('https://api.console.example.test')
  })

  it('returns a non-URL unchanged instead of throwing', () => {
    expect(apiUrlForCli('not a url')).toBe('not a url')
    expect(apiUrlForCli('')).toBe('')
  })
})

describe('cliLoginLine', () => {
  it('prints the exact insta login line', () => {
    expect(cliLoginLine('insta_abc', 'https://api.x.test')).toBe('insta login --api-key insta_abc --api-url https://api.x.test')
  })
})
