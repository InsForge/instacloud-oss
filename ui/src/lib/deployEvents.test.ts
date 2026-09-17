import { describe, expect, it } from 'vitest'
import { deployEventRows, serviceIdFor, type DeployEvent } from './deployEvents'

const at = (min: number) => new Date(Date.UTC(2026, 8, 17, 12, min)).toISOString()
const WINDOW = { fromMs: Date.UTC(2026, 8, 17, 12, 0), toMs: Date.UTC(2026, 8, 17, 13, 0) }
const ev = (kind: string, payload: unknown, created = at(10), source = 'resource'): DeployEvent =>
  ({ id: `${kind}:${created}`, branch: 'main', source, kind, payload, created_at: created })

describe('serviceIdFor', () => {
  it('uses the daemon prefixes', () => {
    expect(serviceIdFor('compute', 'web')).toBe('cp-web')
    expect(serviceIdFor('postgres', 'db')).toBe('pg-db')
    expect(serviceIdFor('redis', 'cache')).toBe('rd-cache')
  })
})

describe('deployEventRows', () => {
  it('keeps a compute group\'s deploys, restarts and sleep/wake, newest first', () => {
    const rows = deployEventRows([
      ev('deploy', { image: 'app:1', group: 'web', url: 'http://x' }, at(1)),
      ev('service.restart', { service: 'cp-web' }, at(2)),
      ev('service.wake', { service: 'cp-web', door: 'api', ms: 1200 }, at(3)),
    ], { type: 'compute', name: 'web' }, WINDOW)
    expect(rows.map((r) => r.kind)).toEqual(['service.wake', 'service.restart', 'deploy'])
    expect(rows[2].detail).toContain('app:1')
  })

  it('never hands one service another\'s events', () => {
    const rows = deployEventRows([
      ev('deploy', { image: 'app:1', group: 'other' }),
      ev('service.restart', { service: 'cp-other' }),
      ev('service.sleep', { service: 'pg-db', reason: 'idle' }),
    ], { type: 'compute', name: 'web' }, WINDOW)
    expect(rows).toEqual([])
  })

  it('matches a branch-qualified service id and registration events by {type,name}', () => {
    const rows = deployEventRows([
      ev('service.suspend', { service: 'abc123:pg-db' }, at(1)),
      ev('service.added', { type: 'postgres', name: 'db' }, at(2)),
      ev('service.rename', { type: 'postgres', from: 'db', to: 'db2' }, at(3)),
      ev('service.added', { type: 'redis', name: 'db' }, at(4)), // same name, other type
    ], { type: 'postgres', name: 'db' }, WINDOW)
    expect(rows.map((r) => r.kind)).toEqual(['service.rename', 'service.added', 'service.suspend'])
  })

  it('drops events outside the window and unparsable times', () => {
    const rows = deployEventRows([
      ev('service.restart', { service: 'cp-web' }, new Date(WINDOW.fromMs - 1).toISOString()),
      ev('service.restart', { service: 'cp-web' }, 'not-a-date'),
    ], { type: 'compute', name: 'web' }, WINDOW)
    expect(rows).toEqual([])
  })
})
