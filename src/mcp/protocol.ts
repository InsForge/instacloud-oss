// The MCP wire protocol (JSON-RPC 2.0), hand-rolled — no SDK dependency, matching this repo's
// habit of writing the small, stable thing itself. Transport is Streamable HTTP in its simplest
// form: the client POSTs one JSON-RPC message and gets one JSON response (no SSE, because every
// tool here is request/response). Pure: `dispatch` takes an `execute` that runs a tool's HTTP
// request, so the whole protocol is unit-tested with a fake executor and no network.
//
// Implements the three methods a tools-only server needs: `initialize`, `tools/list`, `tools/call`
// (plus the `notifications/initialized` notification, which gets no reply). Anything else is a
// JSON-RPC "method not found".

import { findTool, MCP_TOOLS, type McpToolRequest } from './tools'

/** Whatever running a tool's HTTP request yielded: the daemon's status + parsed JSON body. */
export type ExecResult = { status: number; body: unknown }
export type Execute = (req: McpToolRequest) => Promise<ExecResult>

export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const SERVER_INFO = { name: 'instacloud-oss', version: 'daemon' } as const

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
  const id = msg.id ?? null
  const method = msg.method ?? ''

  // Notifications (no id) are acknowledged by silence.
  if (msg.id === undefined || msg.id === null) {
    if (method.startsWith('notifications/')) return null
    // A request that forgot its id still gets an error back on id=null.
  }

  if (method === 'initialize') {
    // Echo the client's protocol version when it names one the server understands; otherwise the
    // server's own. Capabilities advertise tools only.
    const asked = (msg.params?.protocolVersion as string) || MCP_PROTOCOL_VERSION
    return ok(id, {
      protocolVersion: asked,
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
    const args = (msg.params?.arguments as Record<string, unknown>) ?? {}
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
