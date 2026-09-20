// The "connect your agent over MCP" config builders. Pure, so they run under the root vitest
// config: every input is a parameter. The daemon serves MCP over Streamable HTTP at `<apiUrl>/mcp`
// (server mode authenticates the `insta_` token as a Bearer header; local mode trusts loopback and
// needs none), so connecting an agent is a URL plus, in server mode, a token — nothing to install.

/** The MCP endpoint URL: the daemon's api origin plus `/mcp`, with any trailing slash removed. */
export function mcpEndpoint(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/mcp`
}

/** The `claude mcp add` command for Claude Code. Server mode adds the Authorization header; local
 *  mode omits it (the daemon trusts loopback). The placeholder is the env var, never an inlined
 *  key — a token is shown once, and a literal `<token>` pasted unedited would be wrong. */
export function claudeCodeAdd(apiUrl: string, mode: 'local' | 'server'): string {
  const base = `claude mcp add --transport http insta ${mcpEndpoint(apiUrl)}`
  return mode === 'server' ? `${base} --header "Authorization: Bearer $INSTA_API_TOKEN"` : base
}

/** An `mcp.json`-style config (Cursor, Windsurf, and other clients that read an mcpServers map).
 *  Server mode carries the Authorization header; local mode carries just the URL. */
export function mcpJsonConfig(apiUrl: string, mode: 'local' | 'server'): string {
  const server: Record<string, unknown> = { url: mcpEndpoint(apiUrl) }
  if (mode === 'server') server.headers = { Authorization: 'Bearer $INSTA_API_TOKEN' }
  return JSON.stringify({ mcpServers: { insta: server } }, null, 2)
}

/** A one-line prompt handing a coding agent everything it needs to connect over MCP. */
export function mcpConnectPrompt(apiUrl: string, mode: 'local' | 'server', consoleUrl: string): string {
  const url = mcpEndpoint(apiUrl)
  const token = mode === 'server'
    ? ` Create an API token at ${consoleUrl.replace(/\/+$/, '')}/account/tokens (ask me for it) and send it as the header "Authorization: Bearer <token>".`
    : ' No token is needed (the daemon trusts loopback in local mode).'
  return `Connect to my self-hosted InstaCloud over MCP at ${url} (Streamable HTTP transport).${token} Then use the insta_* tools to manage this project.`
}

/** The tool families an agent gets, for the onboarding UI to preview. Grouping only. */
export const MCP_TOOL_GROUPS: ReadonlyArray<{ label: string; tools: string[] }> = [
  { label: 'Projects & branches', tools: ['insta_project_list', 'insta_project_get', 'insta_project_create', 'insta_branch_list', 'insta_branch_create', 'insta_manifest'] },
  { label: 'Services & deploys', tools: ['insta_service_list', 'insta_service_add', 'insta_service_remove', 'insta_deploy'] },
  { label: 'Secrets', tools: ['insta_secrets_list', 'insta_secrets_set', 'insta_secrets_unset'] },
  { label: 'Data & observability', tools: ['insta_db_query', 'insta_logs', 'insta_metrics', 'insta_events'] },
]
