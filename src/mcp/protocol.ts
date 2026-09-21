// The MCP wire protocol (JSON-RPC 2.0), hand-rolled — no SDK dependency, matching this repo's
// habit of writing the small, stable thing itself. Transport is Streamable HTTP in its simplest
// form: the client POSTs one JSON-RPC message and gets one JSON response (no SSE, because every
// tool here is request/response). Pure: `dispatch` takes an `execute` that runs a tool's HTTP
// request, so the whole protocol is unit-tested with a fake executor and no network.
//
// Implements the three methods a tools-only server needs: `initialize`, `tools/list`, `tools/call`
// (plus the `notifications/initialized` notification, which gets no reply). Anything else is a
// JSON-RPC "method not found".

import { findTool, MCP_TOOLS, validateArgs, type McpToolRequest } from './tools'

/** Whatever running a tool's HTTP request yielded: the daemon's status + parsed JSON body. */
export type ExecResult = { status: number; body: unknown }
export type Execute = (req: McpToolRequest) => Promise<ExecResult>

export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const SERVER_INFO = { name: 'instacloud-oss', version: 'daemon' } as const

/** Protocol versions this server will speak if a client asks for one of them; anything else is
 *  answered with the server's own version (spec-compliant negotiation, never a blind echo). */
const SUPPORTED_PROTOCOL_VERSIONS = new Set<string>([MCP_PROTOCOL_VERSION])

type JsonRpcId = string | number | null
type JsonRpcRequest = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, unknown> }

/** A JSON-RPC response, or `null` for a notification (no `id`) that takes no reply. */
export type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId; result: unknown } | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string } }

const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })
const err = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } })

/** A tool result as MCP content: the daemon's JSON as text, with `isError` set for non-2xx so the
 *  agent sees a failure rather than a success carrying an error body. A 202 is an approval gate,
 *  not a success — it is reported as an error so the agent surfaces it and the human can approve. */
function toolContent(r: ExecResult): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2)
  if (r.status === 202) {
    const action = (r.body as { action?: string })?.action ?? 'this action'
    return { content: [{ type: 'text', text: `Approval required: ${action} is governed and needs a human decision in the console before it runs.\n${text}` }], isError: true }
  }
  return { content: [{ type: 'text', text }], isError: r.status >= 400 }
}

/** Dispatch one JSON-RPC message. Returns the response, or null for a notification. */
export async function dispatch(msg: JsonRpcRequest, execute: Execute): Promise<JsonRpcResponse | null> {
  const isNotification = msg == null || typeof msg !== 'object' || msg.id === undefined
  const id = (msg != null && typeof msg === 'object' ? msg.id : undefined) ?? null

  // Validate the envelope before doing anything with it. A notification (no id) can never be
  // replied to, so a malformed one is ignored rather than answered with an error on id=null.
  if (msg == null || typeof msg !== 'object') return isNotification ? null : err(id, -32600, 'invalid request')
  if (msg.jsonrpc !== '2.0') return isNotification ? null : err(id, -32600, 'invalid request: jsonrpc must be "2.0"')
  if (typeof msg.method !== 'string') return isNotification ? null : err(id, -32600, 'invalid request: method must be a string')
  const method = msg.method

  // Notifications (no id) are acknowledged by silence, whatever their method, so a missing id can
  // never let a request-only method (e.g. tools/call) run without a reply.
  if (msg.id === undefined) return null

  if (method === 'initialize') {
    // Answer with the client's protocol version only when the server actually speaks it; otherwise
    // the server's own (never a blind echo of an arbitrary string). Capabilities advertise tools only.
    const asked = msg.params?.protocolVersion
    const protocolVersion = typeof asked === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(asked) ? asked : MCP_PROTOCOL_VERSION
    return ok(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'Tools act on this self-hosted InstaCloud daemon. Project-scoped tools take projectId; branch-scoped take an optional branch (default the project default).',
    })
  }

  if (method === 'tools/list') {
    return ok(id, { tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
  }

  if (method === 'tools/call') {
    const name = String(msg.params?.name ?? '')
    const tool = findTool(name)
    if (!tool) return err(id, -32602, `unknown tool: ${name}`)
    const rawArgs = msg.params?.arguments
    if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
      return ok(id, { content: [{ type: 'text', text: 'invalid arguments: expected an object' }], isError: true })
    }
    const args = (rawArgs as Record<string, unknown>) ?? {}
    // Validate against the tool's schema before building the request: a bad argument is a tool
    // error (isError content), the same shape the 202 approval and transport-failure paths use, so
    // the agent reads the reason and retries rather than the session erroring out.
    const invalid = validateArgs(tool, args)
    if (invalid) return ok(id, { content: [{ type: 'text', text: `invalid arguments: ${invalid}` }], isError: true })
    let req: McpToolRequest
    try { req = tool.build(args) } catch (e) { return err(id, -32602, `invalid arguments: ${e instanceof Error ? e.message : String(e)}`) }
    try {
      const r = await execute(req)
      return ok(id, toolContent(r))
    } catch (e) {
      // A transport failure (the daemon call threw) is a tool error, surfaced in content so the
      // agent sees it rather than the whole session erroring out.
      return ok(id, { content: [{ type: 'text', text: `tool call failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true })
    }
  }

  return err(id, -32601, `method not found: ${method}`)
}
