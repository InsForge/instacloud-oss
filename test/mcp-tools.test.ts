import { test, expect } from 'vitest'
import { MCP_TOOLS, findTool, validateArgs } from '../src/mcp/tools'

test('every tool has a name, description and an object inputSchema; names are unique and insta_-prefixed', () => {
  const names = MCP_TOOLS.map((t) => t.name)
  expect(new Set(names).size).toBe(names.length)
  for (const t of MCP_TOOLS) {
    expect(t.name, t.name).toMatch(/^insta_[a-z_]+$/)
    expect(t.description.length, t.name).toBeGreaterThan(0)
    expect((t.inputSchema as { type?: string }).type, t.name).toBe('object')
  }
})

test('build() produces the right method/path/body, encoding ids and skipping empty params', () => {
  expect(findTool('insta_project_get')!.build({ projectId: 'p 1/x' }))
    .toEqual({ method: 'GET', path: '/projects/p%201%2Fx' })
  expect(findTool('insta_service_list')!.build({ projectId: 'p1' }))
    .toEqual({ method: 'GET', path: '/projects/p1/services' })
  expect(findTool('insta_service_list')!.build({ projectId: 'p1', branch: 'feat' }))
    .toEqual({ method: 'GET', path: '/projects/p1/services?branch=feat' })
  expect(findTool('insta_service_add')!.build({ projectId: 'p1', type: 'postgres', name: 'db' }))
    .toEqual({ method: 'POST', path: '/projects/p1/services', body: { type: 'postgres', name: 'db' } })
  expect(findTool('insta_deploy')!.build({ projectId: 'p1', image: 'nginx:alpine', group: 'web', port: 80 }))
    .toEqual({ method: 'POST', path: '/projects/p1/deploy', body: { image: 'nginx:alpine', group: 'web', port: 80 } })
  expect(findTool('insta_secrets_set')!.build({ projectId: 'p1', name: 'API_KEY', value: 'v', service: 'postgres/db' }))
    .toEqual({ method: 'PUT', path: '/projects/p1/secrets/API_KEY', body: { value: 'v', service: 'postgres/db' } })
  expect(findTool('insta_db_query')!.build({ projectId: 'p1', sql: 'select 1' }))
    .toEqual({ method: 'POST', path: '/projects/p1/database/query', body: { sql: 'select 1' } })
})

test('secrets_list reads NAMES only (the tree route), never the values route', () => {
  expect(findTool('insta_secrets_list')!.build({ projectId: 'p1' }).path).toBe('/projects/p1/secrets/tree')
})

test('branch_create only sends excludeServices/from when given', () => {
  expect(findTool('insta_branch_create')!.build({ projectId: 'p1', name: 'feat' }).body).toEqual({ name: 'feat' })
  expect(findTool('insta_branch_create')!.build({ projectId: 'p1', name: 'x', from: 'main', excludeServices: true }).body)
    .toEqual({ name: 'x', from: 'main', excludeServices: true })
})

test('validateArgs enforces the schema so no truthiness coercion can flip a flag', () => {
  const add = findTool('insta_service_add')!
  // A well-formed call passes.
  expect(validateArgs(add, { projectId: 'p1', type: 'storage', name: 'assets', public: false })).toBeNull()
  // The P1 bug: a string "false" must be REJECTED, not coerced to a truthy public:true.
  expect(validateArgs(add, { projectId: 'p1', type: 'storage', name: 'assets', public: 'false' }))
    .toMatch(/public must be a boolean/)
  // build() then never forwards the bad value even if reached directly.
  expect(add.build({ projectId: 'p1', type: 'storage', name: 'assets', public: 'false' as unknown as boolean }).body)
    .toEqual({ type: 'storage', name: 'assets' })
  // A value outside the enum is rejected.
  expect(validateArgs(add, { projectId: 'p1', type: 'weird', name: 'x' })).toMatch(/type must be one of/)
  // A missing required argument is rejected.
  expect(validateArgs(add, { type: 'postgres', name: 'db' })).toMatch(/missing required argument: projectId/)
  // An unknown argument is rejected (additionalProperties:false).
  expect(validateArgs(add, { projectId: 'p1', type: 'postgres', name: 'db', bogus: 1 })).toMatch(/unknown argument: bogus/)
  // A non-number where a number is required is rejected.
  expect(validateArgs(findTool('insta_deploy')!, { projectId: 'p1', image: 'nginx', port: '80' })).toMatch(/port must be a number/)
})

test('no tool maps to a cloud-only route (billing/usage/scale/upgrade/github/backups)', () => {
  for (const t of MCP_TOOLS) {
    const p = t.build(Object.fromEntries(
      // give every declared property a dummy value so build() runs
      Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).map((k) => [k, 'x']),
    )).path
    expect(p, t.name).not.toMatch(/\/(usage|billing|backups|scale|upgrade|github|deploy-token)\b/)
  }
})
