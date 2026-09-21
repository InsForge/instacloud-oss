import { describe, expect, it } from 'vitest'
import { mcpEndpoint, mcpJsonConfig } from './mcpConnect'

describe('mcpEndpoint', () => {
  it('appends /mcp and strips a trailing slash', () => {
    expect(mcpEndpoint('https://api.example.io')).toBe('https://api.example.io/mcp')
    expect(mcpEndpoint('https://api.example.io/')).toBe('https://api.example.io/mcp')
    expect(mcpEndpoint('http://127.0.0.1:4611')).toBe('http://127.0.0.1:4611/mcp')
  })
})

describe('mcpJsonConfig', () => {
  it('server mode includes the Authorization header, local mode just the url', () => {
    expect(JSON.parse(mcpJsonConfig('https://api.x.io', 'server'))).toEqual({
      mcpServers: { insta: { url: 'https://api.x.io/mcp', headers: { Authorization: 'Bearer <YOUR_INSTA_API_TOKEN>' } } },
    })
    expect(JSON.parse(mcpJsonConfig('http://127.0.0.1:4611', 'local'))).toEqual({
      mcpServers: { insta: { url: 'http://127.0.0.1:4611/mcp' } },
    })
  })

  it('uses a replace-me placeholder, not a shell $VAR that a JSON client would send verbatim', () => {
    const cfg = mcpJsonConfig('https://api.x.io', 'server')
    expect(cfg).toContain('<YOUR_INSTA_API_TOKEN>')
    expect(cfg).not.toContain('$INSTA_API_TOKEN')
  })
})
