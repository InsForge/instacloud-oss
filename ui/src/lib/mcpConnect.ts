// The MCP connect config the Quick Start pill's "MCP" chip copies. Pure, so it runs under the root
// vitest config: every input is a parameter. The daemon serves MCP over Streamable HTTP at
// `<apiUrl>/mcp` (server mode authenticates the `insta_` token as a Bearer header; local mode trusts
// loopback and needs none), so connecting an agent is a URL plus, in server mode, a token.

/** The MCP endpoint URL: the daemon's api origin plus `/mcp`, with any trailing slash removed. */
export function mcpEndpoint(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/mcp`
}

/** An `mcp.json`-style config (Claude Code, Cursor, Windsurf, and other clients that read an
 *  mcpServers map). Server mode carries the Authorization header from the env var (never an inlined
 *  key, which is shown once); local mode carries just the URL. */
export function mcpJsonConfig(apiUrl: string, mode: 'local' | 'server'): string {
  const server: Record<string, unknown> = { url: mcpEndpoint(apiUrl) }
  if (mode === 'server') server.headers = { Authorization: 'Bearer $INSTA_API_TOKEN' }
  return JSON.stringify({ mcpServers: { insta: server } }, null, 2)
}
