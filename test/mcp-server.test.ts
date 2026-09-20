// The /mcp route end-to-end through the real server pipeline (fake adapters, no Docker): a
// tools/call re-enters the daemon's own API via app.inject, so the result is the API's real
// response shape.
import { test, expect, beforeEach, vi } from 'vitest'
import { docker as dockerFn } from '../src/docker'
import { buildServer } from '../src/server'
import { makeEngine, resetFakes } from './fakes'

vi.mock('../src/docker', () => ({
  docker: vi.fn(() => Promise.resolve(Buffer.from(''))),
  dockerCall: () => ({ done: Promise.resolve(Buffer.from('')), kill: () => {} }),
}))

let app: ReturnType<typeof buildServer>
beforeEach(() => {
  resetFakes()
  vi.mocked(dockerFn).mockImplementation(() => Promise.resolve(Buffer.from('')))
  app = buildServer(makeEngine())
})

const rpc = (body: unknown) => app.inject({ method: 'POST', url: '/mcp', payload: body })

test('initialize + tools/list over POST /mcp', async () => {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  expect(init.statusCode).toBe(200)
  expect(init.json()).toMatchObject({ id: 1, result: { serverInfo: { name: 'instacloud-oss' } } })

  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tools = list.json().result.tools as Array<{ name: string }>
  expect(tools.some((t) => t.name === 'insta_service_list')).toBe(true)
  expect(tools.some((t) => t.name === 'insta_deploy')).toBe(true)
})

test('a notification POST is accepted with no body', async () => {
  const r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  expect(r.statusCode).toBe(202)
})

test('GET /mcp is a clean 405 (no SSE stream)', async () => {
  const r = await app.inject({ method: 'GET', url: '/mcp' })
  expect(r.statusCode).toBe(405)
})

test('tools/call re-enters the API: create a project, then list it through MCP', async () => {
  const created = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'insta_project_create', arguments: { name: 'mcp-demo' } } })
  const createText = created.json().result.content[0].text
  const id = JSON.parse(createText).project.id
  expect(id).toBeTruthy()

  const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'insta_project_list', arguments: {} } })
  const projects = JSON.parse(listed.json().result.content[0].text).projects as Array<{ id: string; name: string }>
  expect(projects.some((p) => p.id === id && p.name === 'mcp-demo')).toBe(true)

  // A whoami tool answers the local identity.
  const who = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'insta_whoami', arguments: {} } })
  expect(JSON.parse(who.json().result.content[0].text).user.id).toBe('local')
})

test('a tool that maps to a daemon 400 is reported as isError, not a crash', async () => {
  // service_add with an unknown type is a 400 at the route; the tool surfaces it.
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'insta_service_add', arguments: { projectId: 'nope', type: 'weird', name: 'x' } } })
  expect(r.statusCode).toBe(200) // JSON-RPC envelope is 200
  expect(r.json().result.isError).toBe(true)
})
