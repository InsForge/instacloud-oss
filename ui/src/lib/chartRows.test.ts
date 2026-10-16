import { describe, expect, it } from 'vitest'
import { chartRows } from './chartRows'

const points = (...pairs: Array<[number, number]>) => pairs.map(([t, value]) => ({ t, value }))

describe('chartRows (regression: a daemon outage was drawn as a continuous line)', () => {
  it('leaves every slot of a multi-bucket outage without a value, so the line breaks there', () => {
    // Samples at 0 and 60, the daemon down for 120..240, samples again from 300.
    const rows = chartRows([{ key: 'cpu', points: points([0, 0.2], [60, 0.3], [300, 0.4]) }], { from: 0, to: 300, step: 60 })
    expect(rows.map((r) => r.t)).toEqual([0, 60, 120, 180, 240, 300])
    expect(rows.filter((r) => r.cpu === undefined).map((r) => r.t)).toEqual([120, 180, 240])
    expect(rows.find((r) => r.t === 300)!.cpu).toBe(0.4)
  })

  it('keeps each line to its own samples: an idle line flat at zero everywhere, a real one broken by its gap', () => {
    const zero = points([0, 0], [60, 0], [120, 0], [180, 0])
    const rows = chartRows([
      { key: 'idle', points: zero },
      { key: 'web', points: points([0, 1], [180, 2]) },
    ], { from: 0, to: 180, step: 60 })
    expect(rows.every((r) => r.idle === 0)).toBe(true)
    expect(rows.filter((r) => r.web === undefined).map((r) => r.t)).toEqual([60, 120])
  })

  it('keeps a point that is off the grid, such as a fresh daemon\'s single live reading', () => {
    const rows = chartRows([{ key: 'cpu', points: points([95, 0.1]) }], { from: 0, to: 120, step: 60 })
    expect(rows.map((r) => r.t)).toEqual([0, 60, 95, 120])
    expect(rows.find((r) => r.t === 95)!.cpu).toBe(0.1)
  })

  it('without a window step, draws only the sampled timestamps (the console behavior)', () => {
    const rows = chartRows([{ key: 'cpu', points: points([0, 1], [300, 2]) }])
    expect(rows).toEqual([{ t: 0, cpu: 1 }, { t: 300, cpu: 2 }])
  })
})
