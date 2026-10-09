import { describe, expect, it } from 'vitest'
import { deployEventRows, serviceIdFor, type DeployEvent } from './deployEvents'

const at = (min: number) => new Date(Date.UTC(2026, 8, 17, 12, min)).toISOString()
const WINDOW = { fromMs: Date.UTC(2026, 8, 17, 12, 0), toMs: Date.UTC(2026, 8, 17, 13, 0) }
const ev = (kind: string, payload: unknown, created = at(10), branch: string | null = 'main', source = 'resource'): DeployEvent =>
  ({ id: `${kind}:${created}:${branch}`, branch, source, kind, payload, created_at: created })

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
    ], { type: 'compute', name: 'web' }, WINDOW, 'main')
    expect(rows.map((r) => r.kind)).toEqual(['service.wake', 'service.restart', 'deploy'])
    expect(rows[2].detail).toContain('app:1')
  })

  it('never hands one service another\'s events', () => {
    const rows = deployEventRows([
      ev('deploy', { image: 'app:1', group: 'other' }),
      ev('service.restart', { service: 'cp-other' }),
      ev('service.sleep', { service: 'pg-db', reason: 'idle' }),
    ], { type: 'compute', name: 'web' }, WINDOW, 'main')
    expect(rows).toEqual([])
  })

  it('keeps project-scoped (branch null) registration events, drops other branches\'', () => {
    const rows = deployEventRows([
      // Compute registration and rename are emitted with branch NULL — the reason the caller
      // fetches the project stream instead of a server-side ?branch filter.
      ev('service.added', { type: 'compute', name: 'web' }, at(1), null),
      ev('service.rename', { type: 'compute', from: 'web', to: 'web' }, at(2), null),
      ev('service.restart', { service: 'cp-web' }, at(3), 'feat'),
    ], { type: 'compute', name: 'web' }, WINDOW, 'main')
    expect(rows.map((r) => r.kind)).toEqual(['service.rename', 'service.added'])
  })

  it('shows only deployment-shaped kinds: governed reads naming the service stay off the log', () => {
    const rows = deployEventRows([
      ev('db.read', { service: 'rd-cache', op: 'keys', db: 0 }),
      ev('db.query', { service: 'pg-db', mode: 'rows' }),
      ev('storage.objects.list', { service: 'st-files', prefix: null }),
      ev('service.setAccess', { service: 'st-files', public: true }),
    ], { type: 'redis', name: 'cache' }, WINDOW, 'main')
    expect(rows).toEqual([])
  })

  it('matches a branch-qualified service id and registration events by {type,name}', () => {
    const rows = deployEventRows([
      ev('service.suspend', { service: 'abc123:pg-db' }, at(1)),
      ev('service.added', { type: 'postgres', name: 'db' }, at(2)),
      ev('service.rename', { type: 'postgres', from: 'db', to: 'db2' }, at(3)),
      ev('service.added', { type: 'redis', name: 'db' }, at(4)), // same name, other type
    ], { type: 'postgres', name: 'db' }, WINDOW, 'main')
    expect(rows.map((r) => r.kind)).toEqual(['service.rename', 'service.added', 'service.suspend'])
  })

  it('holds the window inclusively at both edges, drops beyond them and unparsable times', () => {
    const edge = (ms: number) => new Date(ms).toISOString()
    const rows = deployEventRows([
      ev('service.restart', { service: 'cp-web' }, edge(WINDOW.fromMs)),
      ev('service.restart', { service: 'cp-web' }, edge(WINDOW.toMs)),
      ev('service.restart', { service: 'cp-web' }, edge(WINDOW.fromMs - 1)),
      ev('service.restart', { service: 'cp-web' }, edge(WINDOW.toMs + 1)),
      ev('service.restart', { service: 'cp-web' }, 'not-a-date'),
    ], { type: 'compute', name: 'web' }, WINDOW, 'main')
    expect(rows.map((r) => r.created)).toEqual([edge(WINDOW.toMs), edge(WINDOW.fromMs)])
  })
})
