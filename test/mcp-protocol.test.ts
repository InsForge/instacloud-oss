import { test, expect } from 'vitest'
import { dispatch, MCP_PROTOCOL_VERSION, type Execute } from '../src/mcp/protocol'
import { MCP_TOOLS } from '../src/mcp/tools'

const noExec: Execute = async () => { throw new Error('should not run') }

test('initialize echoes a known protocol version and advertises tools', async () => {
  const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, noExec)
  expect(r).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'instacloud-oss' } } })
  // With no version asked, the server offers its own.
  const r2 = await dispatch({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }, noExec)
  expect((r2 as { result: { protocolVersion: string } }).result.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
})

test('tools/list returns every catalog tool with its schema', async () => {
  const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, noExec) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } }
  expect(r.result.tools.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort())
  expect(r.result.tools.every((t) => t.inputSchema)).toBe(true)
})

test('a notification (no id) gets no reply', async () => {
  expect(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, noExec)).toBeNull()
})

test('a notification never triggers a request-only method: no id means no reply and no execute', async () => {
  // tools/call as a notification (no id) must be ignored, never run without a response.
  expect(await dispatch({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'insta_whoami', arguments: {} } }, noExec)).toBeNull()
})

test('a malformed envelope is a JSON-RPC error for a request, ignored for a notification', async () => {
  expect(await dispatch({ id: 1, method: 'tools/list' }, noExec)).toMatchObject({ id: 1, error: { code: -32600 } })
  expect(await dispatch({ jsonrpc: '2.0', id: 2 }, noExec)).toMatchObject({ id: 2, error: { code: -32600 } })
  expect(await dispatch({ method: 'tools/list' }, noExec)).toBeNull() // no jsonrpc, no id
})

test('initialize answers its own version when the client asks for one it does not speak', async () => {
  const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, noExec)
  expect((r as { result: { protocolVersion: string } }).result.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
})

test('tools/call rejects a bad argument as an isError result, without executing', async () => {
  const r = await dispatch({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'insta_service_add', arguments: { projectId: 'p1', type: 'storage', name: 'a', public: 'false' } } }, noExec) as { result: { isError?: boolean; content: Array<{ text: string }> } }
  expect(r.result.isError).toBe(true)
  expect(r.result.content[0].text).toMatch(/public must be a boolean/)
})

test('unknown method and unknown tool are JSON-RPC errors', async () => {
  expect(await dispatch({ jsonrpc: '2.0', id: 1, method: 'nope' }, noExec)).toMatchObject({ id: 1, error: { code: -32601 } })
  expect(await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'insta_nope', arguments: {} } }, noExec))
    .toMatchObject({ id: 2, error: { code: -32602 } })
})

test('tools/call runs the tool request and returns its body as text content', async () => {
  const seen: unknown[] = []
  const exec: Execute = async (req) => { seen.push(req); return { status: 200, body: { services: [{ id: 'pg-db' }] } } }
  const r = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'insta_service_list', arguments: { projectId: 'p1' } } }, exec) as { result: { content: Array<{ text: string }>; isError?: boolean } }
  expect(seen).toEqual([{ method: 'GET', path: '/projects/p1/services' }])
  expect(r.result.isError).toBeFalsy()
  expect(JSON.parse(r.result.content[0].text)).toEqual({ services: [{ id: 'pg-db' }] })
})

test('a non-2xx daemon response marks the tool result isError', async () => {
  const exec: Execute = async () => ({ status: 400, body: { error: 'bad' } })
  const r = await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'insta_db_query', arguments: { projectId: 'p1', sql: 'x' } } }, exec) as { result: { isError?: boolean } }
  expect(r.result.isError).toBe(true)
})

test('a 202 approval envelope is surfaced as an error, not a silent success', async () => {
  const exec: Execute = async () => ({ status: 202, body: { status: 'approval_required', action: 'deploy', approvalId: 'a1' } })
  const r = await dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'insta_deploy', arguments: { projectId: 'p1', image: 'x' } } }, exec) as { result: { content: Array<{ text: string }>; isError?: boolean } }
  expect(r.result.isError).toBe(true)
  expect(r.result.content[0].text).toMatch(/[Aa]pproval required/)
  expect(r.result.content[0].text).toContain('deploy')
})

test('a thrown executor becomes a tool error, not a session crash', async () => {
  const exec: Execute = async () => { throw new Error('boom') }
  const r = await dispatch({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'insta_whoami', arguments: {} } }, exec) as { result: { isError?: boolean; content: Array<{ text: string }> } }
  expect(r.result.isError).toBe(true)
  expect(r.result.content[0].text).toContain('boom')
})
