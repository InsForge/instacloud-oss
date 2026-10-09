import { describe, expect, it } from 'vitest'
import type { SecretTree } from '../api'
import { filterAndSort, groupSecrets, serviceSecretRows } from './secretRows'

type Branch = SecretTree['branches'][number]
const branch = (over: Partial<Branch> = {}): Branch => ({ name: 'main', isDefault: true, services: [], unbound: [], ...over })

const tree: SecretTree = {
  projectWide: ['GLOBAL_KEY'],
  branches: [branch({
    unbound: ['BRANCH_KEY'],
    services: [
      { type: 'postgres', name: 'db', secrets: ['DATABASE_URL'], minted: ['DATABASE_URL'], bindings: [] },
      {
        type: 'compute', name: 'api', secrets: ['API_KEY', 'APP_DB_URL', 'DATABASE_URL'], minted: [],
        bindings: [
          { envName: 'APP_DB_URL', source: 'postgres/db', sourceName: 'DATABASE_URL', shadowsUserSecret: false },
          { envName: 'DATABASE_URL', source: 'postgres/db', sourceName: 'DATABASE_URL', shadowsUserSecret: true },
        ],
      },
      { type: 'compute', name: 'worker', secrets: ['WORKER_KEY'], minted: [], bindings: [] },
    ],
  })],
}

describe('groupSecrets', () => {
  it('badges minted names Managed, bindings Binding, and the rest User', () => {
    const { services } = groupSecrets(tree, 'main')
    const api = services.find((g) => g.key === 'compute/api')!.rows
    expect(api.find((r) => r.name === 'API_KEY')).toMatchObject({ kind: 'user', scope: 'env', service: 'compute/api' })
    expect(api.find((r) => r.name === 'APP_DB_URL')).toMatchObject({ kind: 'binding', from: 'postgres/db.DATABASE_URL', shadowed: false })
    expect(api.find((r) => r.name === 'DATABASE_URL')).toMatchObject({ kind: 'binding', shadowed: true })
    expect(services.find((g) => g.key === 'postgres/db')!.rows[0]).toMatchObject({ name: 'DATABASE_URL', kind: 'managed' })
  })

  it('puts project-wide and unbound branch secrets in the shared rows', () => {
    expect(groupSecrets(tree, 'main').shared).toEqual([
      { name: 'GLOBAL_KEY', kind: 'user', scope: 'project' },
      { name: 'BRANCH_KEY', kind: 'user', scope: 'env' },
    ])
  })
})

describe('serviceSecretRows', () => {
  it("lists only this service's rows, as its Variables tab does: no shared secrets, no other service's", () => {
    const names = serviceSecretRows(tree, 'main', { type: 'compute', name: 'api' }).map((r) => r.name)
    expect(names).toEqual(['API_KEY', 'APP_DB_URL', 'DATABASE_URL'])
    expect(names).not.toContain('GLOBAL_KEY')
    expect(names).not.toContain('BRANCH_KEY')
    expect(names).not.toContain('WORKER_KEY')
  })

  it('is empty before the tree loads, for another branch, or for a service with no group', () => {
    expect(serviceSecretRows(undefined, 'main', { type: 'compute', name: 'api' })).toEqual([])
    expect(serviceSecretRows(tree, 'feature', { type: 'compute', name: 'api' })).toEqual([])
    expect(serviceSecretRows(tree, 'main', { type: 'redis', name: 'api' })).toEqual([])
  })
})

describe('filterAndSort', () => {
  const rows = serviceSecretRows(tree, 'main', { type: 'compute', name: 'api' })

  it('matches names case-insensitively and never values', () => {
    expect(filterAndSort(rows, 'db', 'az').map((r) => r.name)).toEqual(['APP_DB_URL'])
    expect(filterAndSort(rows, 'key', 'az').map((r) => r.name)).toEqual(['API_KEY'])
  })

  it('sorts A to Z or Z to A', () => {
    expect(filterAndSort(rows, '', 'az').map((r) => r.name)).toEqual(['API_KEY', 'APP_DB_URL', 'DATABASE_URL'])
    expect(filterAndSort(rows, '', 'za').map((r) => r.name)).toEqual(['DATABASE_URL', 'APP_DB_URL', 'API_KEY'])
  })
})
