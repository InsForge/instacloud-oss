import { describe, expect, it } from 'vitest'
import { bareServiceId, deriveStatus, healthFor } from './status'

const compute = { type: 'compute', desired_state: 'running' }

describe('deriveStatus', () => {
  it('a wake in flight wins over everything', () => {
    expect(deriveStatus(compute, { status: 'standby' }, true).kind).toBe('waking')
    expect(deriveStatus(compute, { status: 'healthy' }, true).label).toBe('Waking')
    expect(deriveStatus(compute, { status: 'crashed' }, true).wakeable).toBe(false)
  })

  it('healthy -> Online', () => {
    expect(deriveStatus(compute, { status: 'healthy' })).toMatchObject({ kind: 'online', label: 'Online', wakeable: false })
  })

  it('starting -> Starting', () => {
    expect(deriveStatus(compute, { status: 'starting' })).toMatchObject({ kind: 'starting', label: 'Starting' })
  })

  it('crashed -> Crashed with the logs hint', () => {
    const s = deriveStatus(compute, { status: 'crashed' })
    expect(s.kind).toBe('crashed')
    expect(s.title).toBe('Not answering on its port; check Logs')
  })

  it('none -> Not deployed', () => {
    expect(deriveStatus({ type: 'compute' }, { status: 'none' })).toMatchObject({ kind: 'none', label: 'Not deployed' })
  })

  it('standby on a compute row whose desired state is stopped -> Stopped', () => {
    expect(deriveStatus({ type: 'compute', desired_state: 'stopped' }, { status: 'standby' }).kind).toBe('stopped')
  })

  it('standby with desired state suspended -> Suspended', () => {
    expect(deriveStatus({ type: 'compute', desired_state: 'suspended' }, { status: 'standby' }).kind).toBe('suspended')
  })

  it('standby otherwise -> Sleeping; only compute is wakeable', () => {
    const c = deriveStatus(compute, { status: 'standby' })
    expect(c).toMatchObject({ kind: 'sleeping', label: 'Sleeping', wakeable: true })
    expect(c.title).toBe('Idle; wakes on the next request')
    for (const type of ['postgres', 'redis', 'mysql', 'mongodb']) {
      const d = deriveStatus({ type }, { status: 'standby' })
      expect(d.kind).toBe('sleeping')
      expect(d.wakeable).toBe(false)
      expect(d.title).toBe('Idle; wakes on the next connection')
    }
  })

  it('a database row with desired_state stopped is still Sleeping (desired state is compute-only)', () => {
    expect(deriveStatus({ type: 'postgres', desired_state: 'stopped' }, { status: 'standby' }).kind).toBe('sleeping')
  })

  it('no health row falls back to the services runtime column (storage rows)', () => {
    expect(deriveStatus({ type: 'storage', runtime: 'online' }).kind).toBe('online')
    expect(deriveStatus({ type: 'storage', runtime: 'stopped' }).kind).toBe('stopped')
    expect(deriveStatus({ type: 'storage' })).toMatchObject({ kind: 'unknown', wakeable: false })
  })

  it('unknown health falls back to runtime the same way', () => {
    expect(deriveStatus({ type: 'compute', runtime: 'online' }, { status: 'unknown' }).kind).toBe('online')
    expect(deriveStatus({ type: 'compute', runtime: 'asleep' }, { status: 'unknown' })).toMatchObject({ kind: 'sleeping', wakeable: true })
    expect(deriveStatus({ type: 'compute', runtime: 'none' }, { status: 'unknown' }).kind).toBe('none')
    expect(deriveStatus({ type: 'compute', runtime: 'suspended' }, { status: 'unknown' }).kind).toBe('suspended')
    expect(deriveStatus({ type: 'compute' }, { status: 'unknown' }).kind).toBe('unknown')
  })

  it('an unrecognised health status never throws', () => {
    expect(deriveStatus({ type: 'compute', runtime: 'online' }, { status: 'weird' }).kind).toBe('online')
    expect(deriveStatus({ type: 'compute' }, { status: 'weird' }).kind).toBe('unknown')
  })
})

describe('bareServiceId / healthFor', () => {
  it('strips a branch qualifier and leaves a bare id alone', () => {
    expect(bareServiceId('cp-web')).toBe('cp-web')
    expect(bareServiceId('3f2a9c1e-0000-4000-8000-000000000000:cp-web')).toBe('cp-web')
  })

  it('matches a health row by exact id first, then by bare id on either side', () => {
    const rows = [{ serviceId: 'cp-web', status: 'healthy' }, { serviceId: 'b1:pg-db', status: 'standby' }]
    expect(healthFor(rows, 'cp-web')?.status).toBe('healthy')
    expect(healthFor(rows, 'b1:cp-web')?.status).toBe('healthy')
    expect(healthFor(rows, 'pg-db')?.status).toBe('standby')
    expect(healthFor(rows, 'st-store')).toBeUndefined()
    expect(healthFor(undefined, 'cp-web')).toBeUndefined()
  })
})
