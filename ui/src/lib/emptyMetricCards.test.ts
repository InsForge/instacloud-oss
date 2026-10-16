import { describe, expect, it } from 'vitest'
import { emptyMetricCards, seriesStats } from './metrics'

describe('emptyMetricCards', () => {
  it("draws each component's always-present cards with no lines", () => {
    expect(emptyMetricCards('compute')).toHaveLength(3)
    expect(emptyMetricCards('compute').map((c) => c.title).slice(0, 2)).toEqual(['CPU Usage', 'Memory Usage'])
    expect(emptyMetricCards('db').map((c) => c.title)).toEqual(['CPU Usage', 'Memory Usage'])
    for (const card of [...emptyMetricCards('compute'), ...emptyMetricCards('redis')]) expect(card.lines).toEqual([])
  })
  it('reads "—" as the current value, never a made-up zero', () => {
    for (const card of emptyMetricCards('compute')) expect(seriesStats(card).latest).toBe('—')
  })
})
