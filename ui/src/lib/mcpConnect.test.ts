import { describe, expect, it } from 'vitest'
import { claudeCodeAdd, mcpConnectPrompt, mcpEndpoint, mcpJsonConfig, MCP_TOOL_GROUPS } from './mcpConnect'

describe('mcpEndpoint', () => {
  it('appends /mcp and strips a trailing slash', () => {
    expect(mcpEndpoint('https://api.example.io')).toBe('https://api.example.io/mcp')
    expect(mcpEndpoint('https://api.example.io/')).toBe('https://api.example.io/mcp')
    expect(mcpEndpoint('http://127.0.0.1:4611')).toBe('http://127.0.0.1:4611/mcp')
  })
})

describe('claudeCodeAdd', () => {
  it('server mode carries the Authorization header from the env var', () => {
    expect(claudeCodeAdd('https://api.x.io', 'server'))
      .toBe('claude mcp add --transport http insta https://api.x.io/mcp --header "Authorization: Bearer $INSTA_API_TOKEN"')
  })
  it('local mode omits the header', () => {
    expect(claudeCodeAdd('http://127.0.0.1:4611', 'local'))
      .toBe('claude mcp add --transport http insta http://127.0.0.1:4611/mcp')
  })
})

describe('mcpJsonConfig', () => {
  it('server mode includes the Authorization header, local mode just the url', () => {
    expect(JSON.parse(mcpJsonConfig('https://api.x.io', 'server'))).toEqual({
      mcpServers: { insta: { url: 'https://api.x.io/mcp', headers: { Authorization: 'Bearer $INSTA_API_TOKEN' } } },
    })
    expect(JSON.parse(mcpJsonConfig('http://127.0.0.1:4611', 'local'))).toEqual({
      mcpServers: { insta: { url: 'http://127.0.0.1:4611/mcp' } },
    })
  })
})

describe('mcpConnectPrompt', () => {
  it('names the endpoint and the token step in server mode, and no-token in local', () => {
    expect(mcpConnectPrompt('https://api.x.io', 'server', 'https://console.x.io/'))
      .toContain('https://api.x.io/mcp')
    expect(mcpConnectPrompt('https://api.x.io', 'server', 'https://console.x.io/'))
      .toContain('https://console.x.io/account/tokens')
    expect(mcpConnectPrompt('http://127.0.0.1:4611', 'local', 'http://127.0.0.1:4611'))
      .toMatch(/No token is needed/)
  })
})

describe('MCP_TOOL_GROUPS', () => {
  it('never previews a cloud-only tool name', () => {
    const all = MCP_TOOL_GROUPS.flatMap((g) => g.tools)
    expect(all.length).toBeGreaterThan(0)
    for (const t of all) expect(t).not.toMatch(/usage|billing|scale|upgrade|github/)
  })
})
