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

  it('does not let an old note hide a failed latest poll', () => {
    expect(metricChartsView({ hasData: true, error: new Error('x'), note: 'nothing deployed on this branch' })).toBe('unavailable')
  })
})
