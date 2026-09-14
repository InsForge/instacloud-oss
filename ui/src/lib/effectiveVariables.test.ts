import { describe, expect, it } from 'vitest'
import type { SecretTree } from '../api'
import { effectiveVariables } from './effectiveVariables'

type Branch = SecretTree['branches'][number]

const branch = (over: Partial<Branch> = {}): Branch => ({
  name: 'main', isDefault: true, services: [], unbound: [], ...over,
})

describe('effectiveVariables', () => {
  it('shows one row per name when the branch shadows the project', () => {
    const tree: SecretTree = { projectWide: ['API_KEY', 'ONLY_PROJECT'], branches: [] }
    const b = branch({ unbound: ['API_KEY', 'ONLY_BRANCH'] })
    const rows = effectiveVariables(tree, b, { type: 'compute', name: 'app' })
    expect(rows.filter((r) => r.name === 'API_KEY')).toHaveLength(1)
    // The branch wins: it is applied after project-wide in engine.envFor.
    expect(rows.find((r) => r.name === 'API_KEY')?.source).toBe('Branch')
    expect(rows.find((r) => r.name === 'ONLY_PROJECT')?.source).toBe('Project')
    expect(rows.find((r) => r.name === 'ONLY_BRANCH')?.source).toBe('Branch')
  })

  it('lets a secret bound to this group shadow both the project and the branch', () => {
    const tree: SecretTree = { projectWide: ['API_KEY'], branches: [] }
    const b = branch({
      unbound: ['API_KEY'],
      services: [{ type: 'compute', name: 'app', secrets: ['API_KEY'], minted: [], bindings: [] }],
    })
    const rows = effectiveVariables(tree, b, { type: 'compute', name: 'app' })
    expect(rows.filter((r) => r.name === 'API_KEY')).toHaveLength(1)
    expect(rows[0]?.source).toBe('This service')
  })

  it('lets a user secret shadow a minted credential name', () => {
    const tree: SecretTree = { projectWide: [], branches: [] }
    const b = branch({
      unbound: ['REDIS_URL'],
      services: [{ type: 'redis', name: 'cache', secrets: [], minted: ['REDIS_URL'], bindings: [] }],
    })
    const rows = effectiveVariables(tree, b, { type: 'compute', name: 'app' })
    expect(rows.filter((r) => r.name === 'REDIS_URL')).toHaveLength(1)
    expect(rows[0]?.source).toBe('Branch')
  })

  // A BINDING is platform-owned and reads from another service: `envFor` applies bindings last,
  // so the value in the container is that service's credential, not anything set on this group.
  // Reporting it as "This service" pointed at the wrong place entirely.
  it('names the SOURCE service for a bound variable, not this one', () => {
    const tree: SecretTree = { projectWide: [], branches: [] }
    const b = branch({
      services: [
        { type: 'postgres', name: 'db', secrets: ['DATABASE_URL'], minted: ['DATABASE_URL'], bindings: [] },
        {
          type: 'compute', name: 'app', secrets: ['APP_DB_URL', 'MY_OWN'], minted: [],
          bindings: [{ envName: 'APP_DB_URL', source: 'postgres/db', sourceName: 'DATABASE_URL' }],
        },
      ],
    })
    const rows = effectiveVariables(tree, b, { type: 'compute', name: 'app' })
    // The bare service name, matching the minted rows: ONE convention per column.
    expect(rows.find((r) => r.name === 'APP_DB_URL')?.source).toBe('db')
    // A genuine service-bound user secret is still this service's.
    expect(rows.find((r) => r.name === 'MY_OWN')?.source).toBe('This service')
  })

  // A binding wins over a user secret of the same name, because envFor applies it last.
  it('lets a binding shadow a user secret of the same name', () => {
    const tree: SecretTree = { projectWide: ['SHARED'], branches: [] }
    const b = branch({
      unbound: ['SHARED'],
      services: [{
        type: 'compute', name: 'app', secrets: ['SHARED'], minted: [],
        bindings: [{ envName: 'SHARED', source: 'redis/cache', sourceName: 'REDIS_URL' }],
      }],
    })
    const rows = effectiveVariables(tree, b, { type: 'compute', name: 'app' })
    expect(rows.filter((r) => r.name === 'SHARED')).toHaveLength(1)
    expect(rows[0]?.source).toBe('cache')
  })

  // The property, not just the two cases: whatever a row's source is, it reads like the service
  // names used for minted rows, never a `<type>/<name>` id.
  it('uses ONE naming convention in the source column', () => {
    const tree: SecretTree = { projectWide: [], branches: [] }
    const b = branch({
      services: [
        { type: 'redis', name: 'cache', secrets: ['REDIS_URL'], minted: ['REDIS_URL'], bindings: [] },
        {
          type: 'compute', name: 'app', secrets: ['BOUND'], minted: [],
          bindings: [{ envName: 'BOUND', source: 'redis/cache', sourceName: 'REDIS_URL', shadowsUserSecret: false }],
        },
      ],
    })
    const rows = effectiveVariables(tree, b, { type: 'compute', name: 'app' })
    expect(rows.find((r) => r.name === 'REDIS_URL')?.source).toBe('cache')
    expect(rows.find((r) => r.name === 'BOUND')?.source).toBe('cache')
    for (const r of rows) expect(r.source, r.name).not.toContain('/')
  })

  it('never carries a secret bound to another compute group', () => {
    const tree: SecretTree = { projectWide: [], branches: [] }
    const b = branch({
      services: [
        { type: 'compute', name: 'app', secrets: ['MINE'], minted: [], bindings: [] },
        { type: 'compute', name: 'worker', secrets: ['THEIRS'], minted: [], bindings: [] },
      ],
    })
    const rows = effectiveVariables(tree, b, { type: 'compute', name: 'app' })
    expect(rows.map((r) => r.name)).toEqual(['MINE'])
  })

  it('shows a non-compute service only what it mints and what is bound to it', () => {
    const tree: SecretTree = { projectWide: ['API_KEY'], branches: [] }
    const b = branch({
      unbound: ['ENV_ONLY'],
      services: [{ type: 'redis', name: 'cache', secrets: ['REDIS_URL', 'TUNING'], minted: ['REDIS_URL'], bindings: [] }],
    })
    const rows = effectiveVariables(tree, b, { type: 'redis', name: 'cache' })
    expect(rows).toEqual([
      { name: 'REDIS_URL', source: 'cache' },
      { name: 'TUNING', source: 'cache' },
    ])
  })

  it('is empty before the tree loads or for a branch that is not in it', () => {
    expect(effectiveVariables(undefined, branch(), { type: 'compute', name: 'app' })).toEqual([])
    expect(effectiveVariables({ projectWide: ['A'], branches: [] }, undefined, { type: 'compute', name: 'app' })).toEqual([])
  })
})
