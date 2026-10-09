import { describe, expect, it } from 'vitest'
import { metricChartsView } from './metricChartsView'

// The states usePoll produces, in order: nothing yet; a success; a later poll that failed (data kept,
// error set); and a success again (error cleared).
describe('metricChartsView (regression: stale charts shown as current after a total failure)', () => {
  it('shows skeletons before the first answer', () => {
    expect(metricChartsView({ hasData: false, error: undefined })).toBe('loading')
  })

  it('shows the cards once a poll succeeds', () => {
    expect(metricChartsView({ hasData: true, error: undefined })).toBe('cards')
  })

  it('shows unavailable when the latest poll failed, even though an earlier one left data behind', () => {
    const afterSuccess = metricChartsView({ hasData: true, error: undefined })
    const afterFailure = metricChartsView({ hasData: true, error: new Error('daemon unreachable') })
    expect(afterSuccess).toBe('cards')
    expect(afterFailure).toBe('unavailable')
  })

  it('returns to the cards when a poll succeeds again', () => {
    expect(metricChartsView({ hasData: true, error: undefined })).toBe('cards')
  })

  it('shows unavailable when the very first poll failed', () => {
    expect(metricChartsView({ hasData: false, error: new Error('daemon unreachable') })).toBe('unavailable')
  })

  it("shows the daemon's note instead of cards when nothing is chartable", () => {
    expect(metricChartsView({ hasData: true, error: undefined, note: 'nothing deployed on this branch' })).toBe('note')
  })

  it('shows loading, never the previous service, while a switch from service A to B loads', () => {
    const A = JSON.stringify(['p', 'main', 'compute', 'web'])
    const B = JSON.stringify(['p', 'main', 'compute', 'worker'])
    // A's data is still held (usePoll keeps it across the dependency change, and a late A request can land after B began).
    expect(metricChartsView({ hasData: true, error: undefined, fetchedFor: A, scope: B })).toBe('loading')
    // B's own answer arrives.
    expect(metricChartsView({ hasData: true, error: undefined, fetchedFor: B, scope: B })).toBe('cards')
  })

  it('does not let an old note hide a failed latest poll', () => {
    expect(metricChartsView({ hasData: true, error: new Error('x'), note: 'nothing deployed on this branch' })).toBe('unavailable')
  })
})
