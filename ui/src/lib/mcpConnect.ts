// The MCP connect config the Quick Start pill's "MCP" chip copies. Pure, so it runs under the root
// vitest config: every input is a parameter. The daemon serves MCP over Streamable HTTP at
// `<apiUrl>/mcp` (server mode authenticates the `insta_` token as a Bearer header; local mode trusts
// loopback and needs none), so connecting an agent is a URL plus, in server mode, a token.

/** The MCP endpoint URL: the daemon's api origin plus `/mcp`, with any trailing slash removed. */
export function mcpEndpoint(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/mcp`
}

/** An `mcp.json`-style config (Claude Code, Cursor, Windsurf, and other clients that read an
 *  mcpServers map). Server mode carries an Authorization header with an obvious replace-me
 *  placeholder rather than `$INSTA_API_TOKEN`: this is JSON, not a shell, and most clients do NOT
 *  expand `$VAR` here, so a literal env-var name would be sent verbatim and fail to authenticate.
 *  The user substitutes their real token; the value is never inlined for them (it is shown once). */
export const MCP_TOKEN_PLACEHOLDER = '<YOUR_INSTA_API_TOKEN>'
export function mcpJsonConfig(apiUrl: string, mode: 'local' | 'server'): string {
  const server: Record<string, unknown> = { url: mcpEndpoint(apiUrl) }
  if (mode === 'server') server.headers = { Authorization: `Bearer ${MCP_TOKEN_PLACEHOLDER}` }
  return JSON.stringify({ mcpServers: { insta: server } }, null, 2)
}
