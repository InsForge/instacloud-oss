import { describe, expect, it } from 'vitest'
import { eventDetail, formatLocalDateTime, mapEvents, panelState, pendingFor, type ActivityEvent } from './activity'

describe('eventDetail', () => {
  it('summarizes primitive payload values on one line, as the console card does', () => {
    expect(eventDetail({ name: 'web', port: 80, alwaysOn: true })).toBe('name: web · port: 80 · alwaysOn: true')
  })

  it('skips nested values and keeps only the first four', () => {
    expect(eventDetail({ a: 1, nested: { x: 1 }, list: [1], b: 2, c: 3, d: 4, e: 5 })).toBe('a: 1 · b: 2 · c: 3 · d: 4')
  })

  it('is null for a payload with nothing to show', () => {
    expect(eventDetail(null)).toBeNull()
    expect(eventDetail({})).toBeNull()
    expect(eventDetail([1, 2])).toBeNull()
    expect(eventDetail({ nested: { x: 1 } })).toBeNull()
  })
})

describe('formatLocalDateTime', () => {
  it('reads like the console: month, day, year and a 12-hour time', () => {
    expect(formatLocalDateTime('2026-09-14T21:19:00.000Z', 'UTC')).toMatch(/^Sep 14, 2026, 9:19\sPM$/u)
  })

  it('shows a dash for a missing or unreadable time', () => {
    expect(formatLocalDateTime(undefined)).toBe('—')
    expect(formatLocalDateTime('not a date')).toBe('—')
  })
})

describe('mapEvents', () => {
  it('maps the daemon events in order, with defaults for anything missing', () => {
    const cards = mapEvents([
      { id: 'e2', source: 'agent', kind: 'deploy', payload: { image: 'nginx' }, created_at: '2026-09-14T21:19:00.000Z' },
      { kind: 'project.created' },
    ], 'UTC')
    expect(cards[0]).toMatchObject({ id: 'e2', source: 'agent', kind: 'deploy', detail: 'image: nginx' })
    expect(cards[1]).toEqual({ id: 'event-1', source: 'resource', kind: 'project.created', detail: null, created: '—' })
  })

  it('shows the newest first when the daemon answers in the order the events happened', () => {
    const cards = mapEvents([
      { id: 'created', kind: 'project.created', created_at: '2026-09-14T21:00:00.000Z' },
      { id: 'added', kind: 'service.added', created_at: '2026-09-14T21:05:00.000Z' },
      { id: 'deployed', kind: 'deploy', created_at: '2026-09-14T21:10:00.000Z' },
    ], 'UTC')
    expect(cards.map((c) => c.id)).toEqual(['deployed', 'added', 'created'])
  })

  it('sorts before paging: the newest of a chronological page leads', () => {
    const cards = mapEvents([
      { id: 'a', created_at: '2026-09-14T20:00:00.000Z' },
      { id: 'b', created_at: '2026-09-14T20:01:00.000Z' },
    ])
    expect(cards[0]!.id).toBe('b')
  })

  it('puts the later-recorded of two events at the same instant first', () => {
    const cards = mapEvents([
      { id: 'first', kind: 'service.added', created_at: '2026-09-14T21:00:00.000Z' },
      { id: 'second', kind: 'service.added', created_at: '2026-09-14T21:00:00.000Z' },
    ], 'UTC')
    expect(cards.map((c) => c.id)).toEqual(['second', 'first'])
  })
})

describe('panelState', () => {
  const card = (id: string): ActivityEvent => ({ id, source: 'resource', kind: 'deploy', detail: null, created: '—' })
  const page = (n: number) => Array.from({ length: n }, (_, i) => card(`e${i}`))

  it("never shows another project's events: the poll hook keeps them across a project switch", () => {
    const load = { projectId: 'A', limit: 50, events: page(3) }
    expect(panelState(load, 'B', 50, false)).toEqual({ events: undefined, loadingMore: false, maybeMore: false })
    expect(panelState(load, 'B', 50, true).events).toBeUndefined()
    expect(panelState(load, 'A', 50, false).events).toHaveLength(3)
  })

  it('shows the skeleton before the first load', () => {
    expect(panelState(undefined, 'A', 50, false).events).toBeUndefined()
  })

  it('offers Load more only when a full page came back', () => {
    expect(panelState({ projectId: 'A', limit: 50, events: page(50) }, 'A', 50, false).maybeMore).toBe(true)
    expect(panelState({ projectId: 'A', limit: 50, events: page(12) }, 'A', 50, false).maybeMore).toBe(false)
  })

  it('reads Loading… while a grown window is pending', () => {
    expect(panelState({ projectId: 'A', limit: 50, events: page(50) }, 'A', 100, false)).toMatchObject({ loadingMore: true, maybeMore: true })
  })

  it('lets a failed Load more be retried instead of staying on Loading…', () => {
    expect(panelState({ projectId: 'A', limit: 50, events: page(50) }, 'A', 100, true)).toMatchObject({ loadingMore: false, maybeMore: true })
  })
})

describe('pendingFor', () => {
  it("never badges one project with another's approvals: the poll hook keeps them across a switch", () => {
    const load = { projectId: 'A', statuses: ['pending', 'pending', 'granted', 'denied'] }
    expect(pendingFor(load, 'A')).toBe(2)
    expect(pendingFor(load, 'B')).toBe(0)
  })

  it('is 0 before the first answer', () => {
    expect(pendingFor(undefined, 'A')).toBe(0)
  })
})
