import { describe, expect, it } from 'vitest'
import type { SecretTree, Service } from '../api'
import { linksFromSecretTree } from './serviceLinks'

const svc = (id: string, type: Service['type'], name: string): Service => ({ id, type, name, status: 'ready' })
const SERVICES = [svc('pg-store', 'postgres', 'store'), svc('rd-cache', 'redis', 'cache'), svc('cp-app', 'compute', 'app'), svc('cp-worker', 'compute', 'worker')]
const binding = (envName: string, source: string) => ({ envName, source, sourceName: 'DATABASE_URL', shadowsUserSecret: false })
const tree = (services: SecretTree['branches'][number]['services'], name = 'main'): SecretTree => ({
  projectWide: [],
  branches: [{ name, isDefault: name === 'main', services, unbound: [] }],
})
const target = (name: string, bindings: ReturnType<typeof binding>[]) => ({ type: 'compute', name, secrets: [], minted: [], bindings })

describe('linksFromSecretTree — the canvas edges, from the daemon secret tree', () => {
  it('joins a `<type>/<name>` source to the compute service it binds into, by service id', () => {
    expect(linksFromSecretTree(tree([target('app', [binding('DATABASE_URL', 'postgres/store')])]), 'main', SERVICES))
      .toEqual([{ sourceId: 'pg-store', targetId: 'cp-app' }])
  })

  it('draws one wire per source → target pair, however many variables it binds', () => {
    const links = linksFromSecretTree(tree([
      target('app', [binding('DATABASE_URL', 'postgres/store'), binding('PGHOST', 'postgres/store'), binding('REDIS_URL', 'redis/cache')]),
      target('worker', [binding('DATABASE_URL', 'postgres/store')]),
    ]), 'main', SERVICES)
    expect(links).toEqual([
      { sourceId: 'pg-store', targetId: 'cp-app' },
      { sourceId: 'rd-cache', targetId: 'cp-app' },
      { sourceId: 'pg-store', targetId: 'cp-worker' },
    ])
  })

  it("reads only the environment on screen, not another branch's bindings", () => {
    expect(linksFromSecretTree(tree([target('app', [binding('DATABASE_URL', 'postgres/store')])], 'preview'), 'main', SERVICES)).toEqual([])
  })

  it('draws nothing for a binding whose source or target is not a service row here', () => {
    expect(linksFromSecretTree(tree([
      target('app', [binding('DATABASE_URL', 'postgres/deleted')]),
      target('gone', [binding('DATABASE_URL', 'postgres/store')]),
    ]), 'main', SERVICES)).toEqual([])
  })

  it('does not confuse two services of different types that share a name', () => {
    const services = [...SERVICES, svc('cp-store', 'compute', 'store')]
    expect(linksFromSecretTree(tree([target('app', [binding('DATABASE_URL', 'postgres/store')])]), 'main', services))
      .toEqual([{ sourceId: 'pg-store', targetId: 'cp-app' }])
  })

  it('has no edges without a tree (still loading, or refused for want of secrets.read)', () => {
    expect(linksFromSecretTree(undefined, 'main', SERVICES)).toEqual([])
  })
})
